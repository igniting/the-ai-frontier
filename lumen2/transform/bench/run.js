#!/usr/bin/env node
// node transform/bench/run.js [ROWS] [--runs N] [--threads N]
// The orders transform (transform/examples/orders.lm) on ROWS rows of
// generated orders (default 2,000,000, about 100 MB), run five ways:
//   Lumen 2      lumen2 transform: checked, on 1 thread and on N (default 4)
//   C            the same function in C (orders.c), OpenMP, 1 and N threads
//   JavaScript   the same function in JavaScript (orders.js), in a node:vm
//                context, and without one (as with eval)
//   Python       the same function in Python (orders.py), run with exec
// Every way must print the same output, byte for byte. Times are wall-clock,
// the best of --runs (default 3), for the whole command: starting it,
// checking and compiling the transform (Lumen 2, --no-cache), reading,
// transforming and writing. C is compiled beforehand, and that is not timed;
// nor is Lumen 2's in the row "compiled before", which runs the transform
// lumen2 transform compiled and kept in its cache on an earlier, untimed run.

import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, openSync, closeSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const rows = Number(args.find((a) => /^\d+$/.test(a) && args[args.indexOf(a) - 1] !== '--runs' && args[args.indexOf(a) - 1] !== '--threads') ?? 2000000);
const runs = Number(opt('--runs', 3));
const threads = Number(opt('--threads', 4));

const here = new URL('.', import.meta.url).pathname;
const root = join(here, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'lumen2-transform-'));
const data = join(dir, 'orders.csv');
const out = join(dir, 'out');

const sh = (cmd, argv, env = {}) => {
  const fd = openSync(data, 'r');
  const ofd = openSync(out, 'w');
  const t = process.hrtime.bigint();
  const r = spawnSync(cmd, argv, { stdio: [fd, ofd, 'pipe'], env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  closeSync(fd); closeSync(ofd);
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed: ${r.stderr}`);
  return { ms, hash: createHash('sha256').update(readFileSync(out)).digest('hex') };
};
const best = (f) => { let b = null; for (let i = 0; i < runs; i++) { const r = f(); if (!b || r.ms < b.ms) b = r; } return b; };

try {
  process.stderr.write(`generating ${rows.toLocaleString('en')} rows... `);
  const fd = openSync(data, 'w');
  spawnSync(process.execPath, [join(here, 'gen-orders.js'), String(rows)], { stdio: ['ignore', fd, 'inherit'] });
  closeSync(fd);
  process.stderr.write('done\n');
  const udf = join(dir, 'udf');
  execFileSync('cc', ['-O2', '-fopenmp', join(here, 'udf.c'), join(here, 'orders.c'), '-o', udf]);

  const lumen2 = [join(root, 'bin', 'lumen2.js'), 'transform', join(root, 'transform', 'examples', 'orders.lm')];
  const ways = [
    ['Lumen 2', '1 thread', 'checked', () => sh(process.execPath, [...lumen2, '--threads', '1', '--no-cache'])],
    ['Lumen 2', `${threads} threads`, 'checked', () => sh(process.execPath, [...lumen2, '--threads', String(threads), '--no-cache'])],
    ['Lumen 2', `${threads} threads`, 'checked, compiled before', () => sh(process.execPath, [...lumen2, '--threads', String(threads)], { XDG_CACHE_HOME: join(dir, 'cache') }), 'warm'],
    ['C', '1 thread', 'none', () => sh(udf, [], { OMP_NUM_THREADS: '1' })],
    ['C', `${threads} threads`, 'none', () => sh(udf, [], { OMP_NUM_THREADS: String(threads) })],
    ['JavaScript', '1 thread', 'node:vm', () => sh(process.execPath, [join(here, 'udf-vm.js'), join(here, 'orders.js')])],
    ['JavaScript', '1 thread', 'none', () => sh(process.execPath, [join(here, 'udf-vm.js'), join(here, 'orders.js'), '--no-vm'])],
    ['Python', '1 thread', 'none (exec)', () => sh('python3', [join(here, 'udf.py'), join(here, 'orders.py')])],
  ];
  const results = [];
  for (const [lang, th, isolation, f, warm] of ways) {
    process.stderr.write(`${lang}, ${th}, ${isolation}... `);
    if (warm) f(); // an untimed run first, which compiles the transform into the cache
    const r = best(f);
    process.stderr.write(`${(r.ms / 1000).toFixed(2)} s\n`);
    results.push({ lang, th, isolation, ...r });
  }
  const ref = results[0];
  const same = results.every((r) => r.hash === ref.hash);
  const mb = readFileSync(data).length / 1e6;
  console.log(`\n${rows.toLocaleString('en')} rows (${mb.toFixed(0)} MB), best of ${runs}; output identical in every way: ${same ? 'yes' : 'NO'}\n`);
  console.log('| Language   | Threads   | Isolation of the user code | Time    | Rows/s     |');
  console.log('|------------|-----------|----------------------------|---------|------------|');
  for (const r of results) {
    console.log(`| ${r.lang.padEnd(10)} | ${r.th.padEnd(9)} | ${r.isolation.padEnd(26)} | ${(r.ms / 1000).toFixed(2).padStart(5)} s | ${Math.round(rows / (r.ms / 1000)).toLocaleString('en').padStart(10)} |`);
  }
  if (!same) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
