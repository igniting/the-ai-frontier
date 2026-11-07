#!/usr/bin/env node
// node transform/bench/incremental.js [ROWS] [--function match|orders] [--runs N] [--threads N] [--sample N [--estimate-over S]]
// A function run over a file, and run again after the file changes a little.
// lumen2 transform --incremental transforms only the lines that changed;
// every other way runs the function over the whole file again: C (1 and N
// threads), Lumen 2 without --incremental, JavaScript (with and without a
// node:vm context) and Python. Each way's output, and each incremental
// run's, must be exactly C's for the same file, byte for byte.
//
// --function: match (default: transform/examples/match.lm, which matches
// each company name to the closest of 64 known names, in about 40
// microseconds of C a row) or orders (transform/examples/orders.lm, a
// fraction of a microsecond). ROWS: default 500,000 for match and 2,000,000
// for orders. Times are wall-clock for the whole command, the best of
// --runs (default 3). --sample N: the ways that would take more than a
// minute (or --estimate-over S seconds) are timed on the first N rows
// instead, and their time is scaled to ROWS (and marked as estimated).

import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const fn = opt('--function', 'match');
const valued = new Set(['--runs', '--threads', '--sample', '--function', '--estimate-over']);
const rows = Number(args.find((a, i) => /^\d+$/.test(a) && !valued.has(args[i - 1])) ?? (fn === 'match' ? 500000 : 2000000));
const runs = Number(opt('--runs', 3));
const threads = Number(opt('--threads', 4));
const sample = opt('--sample', null) === null ? null : Number(opt('--sample'));
const estimateOver = Number(opt('--estimate-over', 60)) * 1000;

const here = new URL('.', import.meta.url).pathname;
const root = join(here, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'lumen2-incremental-'));
const gen = fn === 'match' ? 'gen-companies.js' : 'gen-orders.js';
const generate = (n, seed) => spawnSync(process.execPath, [join(here, gen), String(n), String(seed)], { encoding: 'latin1', maxBuffer: 1 << 30 }).stdout;
const digest = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

// Runs a command with the file as standard input; its output goes to out.
const sh = (data, cmd, argv, env = {}) => {
  const fd = openSync(data, 'r'), ofd = openSync(join(dir, 'out'), 'w');
  const t = process.hrtime.bigint();
  const r = spawnSync(cmd, argv, { stdio: [fd, ofd, 'pipe'], env: { ...process.env, ...env } });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  closeSync(fd); closeSync(ofd);
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed: ${r.stderr}`);
  return { ms, hash: digest(join(dir, 'out')), stderr: r.stderr.toString() };
};
const best = (f, n = runs) => { let b = null; for (let i = 0; i < n; i++) { const r = f(); if (!b || r.ms < b.ms) b = r; } return b; };
const secs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(2)} s`);

try {
  process.stderr.write(`generating ${rows.toLocaleString('en')} rows (${fn})... `);
  const base = generate(rows, 1);
  const lines = base.split('\n').slice(0, -1);
  const pool = generate(Math.max(1000, Math.ceil(rows / 50)), 2).split('\n').slice(1, -1);
  const data = join(dir, 'data.csv');
  writeFileSync(data, base, 'latin1');
  process.stderr.write(`done (${(base.length / 1e6).toFixed(0)} MB)\n`);
  const udf = join(dir, 'udf');
  execFileSync('cc', ['-O2', '-fopenmp', join(here, 'udf.c'), join(here, `${fn}.c`), '-o', udf]);
  const lm = join(root, 'transform', 'examples', `${fn}.lm`);
  const cache = { XDG_CACHE_HOME: join(dir, 'cache') };
  const lumen2 = (file, ...more) => sh(file, process.execPath, [join(root, 'bin', 'lumen2.js'), 'transform', lm, '--threads', String(threads), ...more], cache);

  // Running the function over the whole file.
  const ways = [
    ['C', '1 thread', (file) => sh(file, udf, [], { OMP_NUM_THREADS: '1' })],
    ['C', `${threads} threads`, (file) => sh(file, udf, [], { OMP_NUM_THREADS: String(threads) })],
    ['Lumen 2', `${threads} threads`, (file) => lumen2(file)],
    ['JavaScript', '1 thread', (file) => sh(file, process.execPath, [join(here, 'udf-vm.js'), join(here, `${fn}.js`), '--no-vm'])],
    ['JavaScript, node:vm', '1 thread', (file) => sh(file, process.execPath, [join(here, 'udf-vm.js'), join(here, `${fn}.js`)])],
    ['Python', '1 thread', (file) => sh(file, 'python3', [join(here, 'udf.py'), join(here, `${fn}.py`)])],
  ];
  // Untimed: compiling the transform into the cache, both ways.
  lumen2(data);
  const tiny = join(dir, 'tiny.csv');
  writeFileSync(tiny, `${lines.slice(0, 2).join('\n')}\n`, 'latin1');
  lumen2(tiny, '--incremental', '--input', tiny, '--state', join(dir, 'tiny-state'));
  const reference = sh(data, udf, [], { OMP_NUM_THREADS: String(threads) }).hash;
  // With --sample, each way runs on the sample first; one that would take
  // more than a minute in full is not run in full, and its time is the
  // sample's, scaled.
  const small = sample !== null && sample < rows ? join(dir, 'sample.csv') : null;
  if (small) writeFileSync(small, `${lines.slice(0, sample + 1).join('\n')}\n`, 'latin1');
  const smallReference = small ? sh(small, udf, [], { OMP_NUM_THREADS: String(threads) }).hash : null;
  const full = [];
  for (const [lang, th, f] of ways) {
    process.stderr.write(`full run: ${lang}, ${th}... `);
    if (small) {
      const r = f(small);
      if (r.hash !== smallReference) throw new Error(`${lang} printed something else`);
      const estimate = (r.ms * rows) / sample;
      if (estimate > estimateOver) {
        full.push({ lang, th, ms: estimate, estimated: true });
        process.stderr.write(`${secs(r.ms)} on ${sample.toLocaleString('en')} rows, so about ${secs(estimate)}\n`);
        continue;
      }
    }
    const r = best(() => f(data));
    if (r.hash !== reference) throw new Error(`${lang} printed something else`);
    full.push({ lang, th, ms: r.ms, estimated: false });
    process.stderr.write(`${secs(r.ms)}\n`);
  }

  // The changes. Each is made to the original file; the state the
  // incremental run starts from is the original file's.
  let seed = 11n;
  const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return Number(seed >> 11n) % n; };
  const row = () => pool[rnd(pool.length)];
  // k different rows (not the header), each replaced by a row from the pool.
  const scattered = (k) => (ls) => {
    const at = new Set();
    while (at.size < k) at.add(1 + rnd(ls.length - 1));
    for (const i of at) { let r; do r = row(); while (r === ls[i]); ls[i] = r; }
    return ls;
  };
  const pct = (x) => Math.max(1, Math.round(rows * x));
  const changes = [
    ['nothing changed', (ls) => ls],
    ['1 row changed', scattered(1)],
    [`${pct(0.001).toLocaleString('en')} rows changed (0.1%), scattered`, scattered(pct(0.001))],
    [`${pct(0.01).toLocaleString('en')} rows changed (1%), scattered`, scattered(pct(0.01))],
    [`${pct(0.001).toLocaleString('en')} rows appended (0.1%)`, (ls) => { for (let j = 0; j < pct(0.001); j++) ls.push(row()); return ls; }],
    ['10 rows inserted and 10 deleted, scattered', (ls) => { for (let j = 0; j < 10; j++) { ls.splice(1 + rnd(ls.length - 1), 0, row()); ls.splice(1 + rnd(ls.length - 1), 1); } return ls; }],
  ];
  // The first run with --incremental transforms every line and writes the
  // state; the state the changes start from is the original file's.
  const state0 = join(dir, 'state0');
  const firstRun = best(() => {
    rmSync(state0, { recursive: true, force: true });
    return lumen2(data, '--incremental', '--input', data, '--state', state0);
  });
  if (firstRun.hash !== reference) throw new Error('lumen2 transform --incremental printed something else');
  process.stderr.write(`incremental, the first run (no state): ${secs(firstRun.ms)}\n`);
  const incremental = [];
  for (const [name, change] of changes) {
    const file = join(dir, 'changed.csv');
    writeFileSync(file, `${change(lines.slice()).join('\n')}\n`, 'latin1');
    const expect = sh(file, udf, [], { OMP_NUM_THREADS: String(threads) }).hash;
    const r = best(() => {
      rmSync(join(dir, 'state'), { recursive: true, force: true });
      cpSync(state0, join(dir, 'state'), { recursive: true });
      return lumen2(file, '--incremental', '--input', file, '--state', join(dir, 'state'), '--stats');
    });
    if (r.hash !== expect) throw new Error(`lumen2 transform --incremental printed something else after: ${name}`);
    const done = /transformed ([\d,]+) of/.exec(r.stderr)[1];
    incremental.push({ name, ms: r.ms, done });
    process.stderr.write(`incremental, ${name}: ${secs(r.ms)}, ${done} rows transformed\n`);
  }

  console.log(`\n${fn}: ${rows.toLocaleString('en')} rows (${(base.length / 1e6).toFixed(0)} MB), best of ${runs}; every output identical to C's: yes\n`);
  console.log('Running the function over the whole file again:\n');
  console.log('| Language | Threads | Time |');
  console.log('|---|---|---|');
  for (const f of full) console.log(`| ${f.lang} | ${f.th} | ${f.estimated ? 'about ' : ''}${secs(f.ms)} |`);
  const by = (lang, th) => full.find((f) => f.lang === lang && f.th === th);
  const cols = [['C', `${threads} threads`], ['C', '1 thread'], ['Lumen 2', `${threads} threads`], ['JavaScript', '1 thread'], ['Python', '1 thread']];
  console.log(`\nlumen2 transform --incremental, on ${threads} threads: its first run (which writes the state) took ${secs(firstRun.ms)}, against ${secs(by('Lumen 2', `${threads} threads`).ms)} without --incremental. After the original file's run, and how many times as fast it is as each full run:\n`);
  console.log(`| Change | Rows transformed | Time | ${cols.map(([l, t]) => `vs ${l}${l === 'Lumen 2' || l === 'C' ? `, ${t}` : ''}`).join(' | ')} |`);
  console.log(`|---|---|---|${cols.map(() => '---').join('|')}|`);
  const times = (x) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));
  for (const r of incremental) console.log(`| ${r.name} | ${r.done} | ${secs(r.ms)} | ${cols.map(([l, t]) => `${times(by(l, t).ms / r.ms)}×`).join(' | ')} |`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
