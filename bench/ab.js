// A/B wall-clock comparison of two checkouts of the compiler, in one
// process, alternating runs so that machine noise hits both equally.
//
//   node bench/ab.js <dirA> <dirB> [--programs a,b] [--runs N] [--flags O|base]
//                    [--flagsA O|base --flagsB O|base]   (e.g. `. . --flagsA base --flagsB O`)

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dirA, dirB] = process.argv.slice(2, 4).map((d) => resolve(d));
const args = process.argv.slice(4);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const runs = +opt('runs', 11);
const names = opt('programs', 'lumenc,sort,red_black_tree,tail_calls,gc_torture').split(',');
const results = {};
const flags = (f) => (f === 'O' ? { optimize: true } : {});
const [optsA, optsB] = [flags(opt('flagsA', opt('flags', 'O'))), flags(opt('flagsB', opt('flags', 'O')))];

const load = async (dir) => ({
  compiler: await import(pathToFileURL(`${dir}/src/compiler.js`).href),
  programs: (await import(pathToFileURL(`${dir}/bench/bench.js`).href)).PROGRAMS,
});
const [A, B] = [await load(dirA), await load(dirB)];
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

for (const name of names) {
  const p = A.programs.find((q) => q.name === name);
  const src = p.source(), input = p.input ? p.input() : '';
  const wa = A.compiler.compile(src, optsA).wasm, wb = B.compiler.compile(src, optsB).wasm;
  const ta = [], tb = [];
  for (let i = 0; i < runs; i++) {
    for (const [w, c, t] of i % 2 ? [[wa, A, ta], [wb, B, tb]] : [[wb, B, tb], [wa, A, ta]]) {
      const r = c.compiler.runWasm(w, { input });
      t.push(r.timeMs);
    }
  }
  const [ma, mb] = [median(ta), median(tb)];
  results[name] = { a: +ma.toFixed(2), b: +mb.toFixed(2) };
  console.log(`${name.padEnd(15)} A ${ma.toFixed(1).padStart(7)} ms   B ${mb.toFixed(1).padStart(7)} ms   B/A ${((mb / ma - 1) * 100).toFixed(1).padStart(6)}%   (median of ${runs}; min A ${Math.min(...ta).toFixed(1)}, B ${Math.min(...tb).toFixed(1)})`);
}

const out = opt('json', null);
if (out) (await import('node:fs')).writeFileSync(out, JSON.stringify(results, null, 1) + '\n');
