// Collects straight-line windows of pure i32 code from the compiler's real
// output (the examples plus random programs), canonicalized so identical
// shapes are counted together. (The examples are also benchmarks; the
// self-hosted compiler, the largest benchmark, is left out: see CAMPAIGN.md.)

import { readFileSync, readdirSync } from 'node:fs';
import { parse } from '../src/parser.js';
import { typecheck } from '../src/typecheck.js';
import { PRELUDE } from '../src/prelude.js';
import { lower } from '../src/lower.js';
import { codegen } from '../src/codegen.js';
import { forwardTemps } from '../src/optimize.js';
import { PURE_OPS, arity } from './bv.js';
import { generateProgram, renderProgram } from '../fuzz/generate.js';

export function corpusModules({ fuzz = 60, options = {} } = {}) {
  const sources = [
    ...readdirSync('examples').filter((f) => f.endsWith('.lm')).map((f) => readFileSync(`examples/${f}`, 'utf8')),
    ...Array.from({ length: fuzz }, (_, k) => renderProgram(generateProgram(90000 + k, { size: 2 }))),
  ];
  const mods = [];
  for (const src of sources) {
    try {
      const checked = typecheck(parse(PRELUDE), parse(src));
      const { mod } = codegen(lower(checked), options);
      // The rules run after -O's earlier passes, so mine code in that shape.
      for (const f of mod.funcs) if (f.oddLocals) forwardTemps(f);
      mods.push(mod);
    } catch { /* error examples */ }
  }
  return mods;
}

// Stack effect of a window: inputs consumed from below it, outputs left.
export function stackShape(code) {
  let depth = 0, min = 0;
  for (const [op] of code) {
    depth -= arity(op);
    min = Math.min(min, depth);
    depth += 1;
  }
  return { inputs: -min, outputs: depth - min };
}

// Renames locals to x0, x1, ... (recording which are known to be odd).
export function canonicalize(code, oddLocals) {
  const names = new Map();
  const odd = [];
  const out = code.map(([op, arg]) => {
    if (op !== 'local.get') return arg === undefined ? [op] : [op, arg];
    if (!names.has(arg)) { names.set(arg, `x${names.size}`); odd.push(oddLocals.has(arg)); }
    return [op, names.get(arg)];
  });
  return { code: out, odd, names };
}

export const keyOf = (code, odd) => code.map((i) => i.join(' ')).join('; ') + ' | ' + odd.map((o) => (o ? 'odd' : '?')).join(',');

export function extractWindows(mods, { minLen = 2, maxLen = 8, maxInputs = 2 } = {}) {
  const windows = new Map();
  for (const mod of mods) {
    for (const f of mod.funcs) {
      if (!f.oddLocals) continue; // runtime functions are hand-written; skip them
      const odd = new Set(f.oddLocals);
      const body = f.body;
      let i = 0;
      while (i < body.length) {
        if (!PURE_OPS.has(body[i][0])) { i++; continue; }
        let j = i;
        while (j < body.length && PURE_OPS.has(body[j][0])) j++;
        for (let a = i; a < j; a++) {
          for (let b = a + minLen; b <= Math.min(j, a + maxLen); b++) {
            const code = body.slice(a, b);
            const shape = stackShape(code);
            if (shape.outputs !== 1 || shape.inputs > maxInputs) continue;
            const canon = canonicalize(code, odd);
            const key = keyOf(canon.code, canon.odd);
            const w = windows.get(key) ?? { code: canon.code, odd: canon.odd, inputs: shape.inputs, count: 0 };
            w.count++;
            windows.set(key, w);
          }
        }
        i = j;
      }
    }
  }
  return [...windows.values()];
}
