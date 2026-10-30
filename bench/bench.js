// Benchmarks the compiler's output.
//
//   node bench/bench.js [--runs N] [--only a,b] [--record LABEL] [--configs base,O]
//
// For every program and configuration it reports
//   * instructions: wasm instructions executed (deterministic; counted by
//     an instrumented build — the campaign's primary metric),
//   * time: best wall-clock time of N runs of the uninstrumented build,
//   * bytes: size of the uninstrumented binary (and memory: final linear memory size),
// and checks that every configuration prints exactly what the baseline does.
// --record LABEL appends the -O results to bench/history.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { compile, runWasm } from '../src/compiler.js';
import { buildSource } from '../selfhost/build.js';
import { PRELUDE } from '../src/prelude.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const RUNS = +opt('runs', 5);
const only = opt('only', null)?.split(',');
const record = opt('record', null);
const CONFIGS = { base: {}, O: { optimize: true } };
const configs = opt('configs', 'base,O').split(',');

const enc = (s) => new TextEncoder().encode(s);
function lumencInput() {
  const self = enc(buildSource().source), prelude = enc(PRELUDE);
  const header = enc(`wasm ${prelude.length}\n`);
  const input = new Uint8Array(header.length + prelude.length + self.length);
  input.set(header, 0); input.set(prelude, header.length); input.set(self, header.length + prelude.length);
  return input;
}

export const PROGRAMS = [
  { name: 'lumenc', what: 'the self-hosted compiler compiling itself', source: () => buildSource().source, input: lumencInput },
  ...['fib', 'sort', 'strings'].map((n) => ({ name: n, what: `bench/programs/${n}.lm`, source: () => readFileSync(`bench/programs/${n}.lm`, 'utf8') })),
  ...['gc_torture', 'red_black_tree', 'tail_calls', 'nqueens', 'life', 'mandelbrot', 'huffman'].map((n) => ({ name: n, what: `examples/${n}.lm`, source: () => readFileSync(`examples/${n}.lm`, 'utf8') })),
];


export function benchProgram(p, config, runs = RUNS) {
  const src = p.source();
  const input = p.input ? p.input() : '';
  const counted = compile(src, { ...CONFIGS[config], countInstructions: true });
  if (!counted.ok) throw new Error(`${p.name}: ${counted.errors[0].message}`);
  const c = runWasm(counted.wasm, { input });
  const plain = compile(src, CONFIGS[config]);
  const times = [];
  let output = null;
  for (let i = 0; i < runs; i++) {
    const r = runWasm(plain.wasm, { input });
    if (r.error) throw new Error(`${p.name} (${config}): ${r.error}`);
    if (output !== null && r.output !== output) throw new Error(`${p.name} (${config}): nondeterministic output`);
    output = r.output;
    times.push(r.timeMs);
  }
  if (c.output !== output) throw new Error(`${p.name} (${config}): the instrumented build printed something else`);
  return { instructions: c.stats.instructions, ms: +Math.min(...times).toFixed(2), bytes: plain.wasm.length, memory: c.stats.memoryBytes, output };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = {};
  const fmt = (n) => n.toLocaleString('en');
  const pct = (a, b) => `${((a / b - 1) * 100).toFixed(1).padStart(6)}%`;
  console.log(`${'program'.padEnd(15)}${configs.map((c) => `${c.padStart(16)} instr ${'ms'.padStart(8)} ${'bytes'.padStart(7)}`).join('   ')}`);
  for (const p of PROGRAMS) {
    if (only && !only.includes(p.name)) continue;
    const row = {};
    for (const config of configs) row[config] = benchProgram(p, config);
    for (const config of configs) {
      if (row[config].output !== row[configs[0]].output) throw new Error(`${p.name}: ${config} output differs from ${configs[0]}`);
    }
    for (const config of configs) delete row[config].output;
    results[p.name] = row;
    const base = row[configs[0]];
    console.log(p.name.padEnd(15) + configs.map((c) => {
      const r = row[c];
      return `${fmt(r.instructions).padStart(16)}${c === configs[0] ? '        ' : pct(r.instructions, base.instructions)} ${r.ms.toFixed(1).padStart(8)} ${String(r.bytes).padStart(7)}`;
    }).join('   '));
  }
  if (configs.length > 1) {
    const [a, b] = configs;
    const geo = (key) => Math.exp(Object.values(results).reduce((s, r) => s + Math.log(r[b][key] / r[a][key]), 0) / Object.keys(results).length);
    console.log(`\ngeometric mean ${b} vs ${a}: instructions ${((geo('instructions') - 1) * 100).toFixed(1)}%, time ${((geo('ms') - 1) * 100).toFixed(1)}%, size ${((geo('bytes') - 1) * 100).toFixed(1)}%, memory ${((geo('memory') - 1) * 100).toFixed(1)}%`);
  }
  if (record) {
    const file = 'bench/history.json';
    const history = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    let commit = null;
    try { commit = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a checkout */ }
    history.push({ label: record, commit, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v[configs[configs.length - 1]]])), base: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v[configs[0]]])) });
    writeFileSync(file, JSON.stringify(history, null, 1) + '\n');
    console.log(`recorded "${record}" in ${file}`);
  }
}
