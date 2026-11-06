#!/usr/bin/env node
// Lumen 2 against C on the same problems.
//
//   node bench/run.js [--quick] [--runs N] [name ...]
//
// Each program in this directory exists twice: name.lm (Lumen 2) and name.c.
// The Lumen 2 program is compiled to WebAssembly by the self-hosted compiler
// and run in Node. The C program is compiled natively (cc -O2) and, when
// clang can target wasm32-wasi, to WebAssembly too, run in the same Node:
// that column separates what WebAssembly costs from what Lumen 2 costs.
// Every run is a fresh process; the time is the best of N runs, measured
// inside the process around the program's run (not compiling or loading it).
// Both WebAssembly columns run code from V8's optimizing compiler.
// The outputs of all versions must be identical.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);

// The programs, with the size used for timing and a small one for --quick.
const BENCH = [
  { name: 'fannkuch', n: 11, quick: 7, what: 'permutations and flips (arrays updated in place)' },
  { name: 'binarytrees', n: 18, quick: 8, what: 'allocating and freeing trees' },
  { name: 'nqueens', n: 13, quick: 6, what: 'backtracking search' },
  { name: 'editdist', n: 30000, quick: 300, what: 'dynamic programming over arrays' },
];

// Child modes: run one module and report the time on stderr.
const [mode, file, arg] = process.argv.slice(2);
if (mode === '--run-lumen') {
  const { runWasm } = await import('../src/api.js');
  const mod = new WebAssembly.Module(readFileSync(file));
  const t = performance.now();
  const r = runWasm(mod, { input: arg });
  const ms = performance.now() - t;
  process.stdout.write(r.output);
  if (r.error) { process.stderr.write(`error: ${r.error}\n`); process.exit(1); }
  process.stderr.write(`${ms}\n`);
  process.exit(0);
}
if (mode === '--run-wasi') {
  const { WASI } = await import('node:wasi');
  const wasi = new WASI({ version: 'preview1', args: ['prog', arg], env: {}, returnOnExit: true });
  const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(file)), wasi.getImportObject());
  const t = performance.now();
  const code = wasi.start(inst);
  const ms = performance.now() - t;
  process.stderr.write(`${ms}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const runsAt = args.indexOf('--runs');
const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : (quick ? 1 : 3);
const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs');
const chosen = BENCH.filter(b => only.length === 0 || only.includes(b.name));

const { compileSource } = await import('../src/api.js');
const tmp = mkdtempSync(join(tmpdir(), 'lumen2-bench-'));
const ok = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8' }).status === 0;

// Best of `runs` timings; each run returns { output, ms }.
function best(run) {
  let out = null, ms = Infinity;
  for (let i = 0; i < runs; i++) {
    const r = run();
    if (out !== null && r.output !== out) throw new Error('the output changed between runs');
    out = r.output; ms = Math.min(ms, r.ms);
  }
  return { output: out, ms };
}
function child(flag, path, n) {
  // --no-liftoff: V8 compiles every function with its optimizing compiler up
  // front (before the clock starts). Otherwise a C program, which spends its
  // whole run in one call to main, would run baseline code throughout, since
  // V8 only swaps in optimized code for the next call of a function.
  const r = spawnSync(process.execPath, ['--no-warnings', '--no-liftoff', '--stack-size=65500', self, flag, path, String(n)], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${flag} ${path} failed: ${r.stderr}`);
  return { output: r.stdout, ms: Number(r.stderr.trim().split('\n').pop()) };
}
function native(path, n) {
  const t = process.hrtime.bigint();
  const r = spawnSync(path, [String(n)], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (r.status !== 0) throw new Error(`${path} failed: ${r.stderr}`);
  return { output: r.stdout, ms };
}

const rows = [];
let failed = false;
try {
  for (const b of chosen) {
    const n = quick ? b.quick : b.n;
    const src = readFileSync(join(here, `${b.name}.lm`), 'utf8');
    const c = compileSource(src, { grants: ['input', 'output'] });
    if (!c.ok) throw new Error(`${b.name}.lm: ${c.errors[0].message}`);
    const lw = join(tmp, `${b.name}.lumen.wasm`);
    writeFileSync(lw, c.bytes);
    const lumen = best(() => child('--run-lumen', lw, n));

    const cfile = join(here, `${b.name}.c`);
    const exe = join(tmp, b.name);
    const cn = ok('cc', ['-O2', '-o', exe, cfile]) ? best(() => native(exe, n)) : null;
    const cw = join(tmp, `${b.name}.c.wasm`);
    const cwasm = ok('clang', ['--target=wasm32-wasi', '-O2', '-o', cw, cfile]) ? best(() => child('--run-wasi', cw, n)) : null;

    for (const [label, r] of [['C', cn], ['C (wasm)', cwasm]]) {
      if (r && r.output !== lumen.output) {
        failed = true;
        console.error(`${b.name}: ${label} printed\n${r.output}\nbut Lumen 2 printed\n${lumen.output}`);
      }
    }
    rows.push({ b, n, lumen, cn, cwasm });
    console.error(`${b.name} ${n}: ${lumen.output.trim().split('\n').pop()}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const fmt = ms => ms === undefined ? 'n/a' : ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
const ratio = (a, b) => (a && b ? `${(a.ms / b.ms).toFixed(2)}×` : 'n/a');
console.log(`| Program | n | C, native | C, WebAssembly | Lumen 2 | Lumen 2 / C native | Lumen 2 / C WebAssembly |`);
console.log(`| --- | --- | --- | --- | --- | --- | --- |`);
for (const { b, n, lumen, cn, cwasm } of rows) {
  console.log(`| ${b.name} (${b.what}) | ${n} | ${fmt(cn?.ms)} | ${fmt(cwasm?.ms)} | ${fmt(lumen.ms)} | ${ratio(lumen, cn)} | ${ratio(lumen, cwasm)} |`);
}
if (failed) process.exit(1);
