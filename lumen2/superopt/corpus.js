// The superoptimizer's corpus: the WebAssembly that Lumen 2 actually emits,
// for the examples, the Schur proof's programs and generated programs. From
// it we collect *windows*: runs of straight-line pure code that consume some
// values from the stack and leave exactly one.

import { readFileSync, readdirSync } from 'node:fs';
import { compileSource } from '../src/api.js';
import { generate } from '../test/fuzz.js';
import { isPure, SIG } from './semantics.js';

const here = (p) => new URL(p, import.meta.url);

// Compiles the corpus. Rules are off, so the corpus is what the code
// generator emits on its own.
export function compileCorpus({ fuzz = 60 } = {}) {
  const sources = [];
  for (const f of readdirSync(here('../examples'))) sources.push({ name: `examples/${f}`, src: readFileSync(here(`../examples/${f}`), 'utf8') });
  for (const f of ['sat.lm', 'schur.lm']) sources.push({ name: `proofs/${f}`, src: readFileSync(here(`../proofs/${f}`), 'utf8') });
  for (let seed = 1; seed <= fuzz; seed++) sources.push({ name: `fuzz:${seed}`, src: generate(seed) });
  const modules = [];
  for (const { name, src } of sources) {
    const c = compileSource(src, { grants: null, superopt: false });
    if (c.ok) modules.push({ name, funcs: c.module.funcs });
  }
  return modules;
}

// The local types of a function, by name.
const localTypes = (f) => Object.fromEntries([...f.params, ...f.locals].map((l) => [l.name, l.type]));

// Puts a window in canonical form: locals renamed x0, x1, ... in order of
// first use; stack inputs inferred. Returns null unless the window leaves
// exactly one value and contains at least one operation.
export function canonical(code, types) {
  const names = new Map();
  const locals = {};
  const inputs = [];
  const st = [];
  const out = [];
  for (const [op, arg] of code) {
    if (op === 'local.get') {
      if (!names.has(arg)) { names.set(arg, `x${names.size}`); locals[names.get(arg)] = types[arg]; }
      out.push([op, names.get(arg)]);
      st.push(types[arg]);
    } else if (op === 'i32.const' || op === 'i64.const') {
      out.push([op, String(BigInt.asIntN(op === 'i32.const' ? 32 : 64, BigInt(arg)))]);
      st.push(op.slice(0, 3));
    } else {
      const sig = SIG[op];
      for (let i = sig.in.length - 1; i >= 0; i--) {
        if (st.length) { if (st.pop() !== sig.in[i]) return null; } else inputs.unshift(sig.in[i]);
      }
      st.push(sig.out);
      out.push([op]);
    }
  }
  if (st.length !== 1 || !code.some(([op]) => op in SIG)) return null;
  return { code: out, inputs, locals, out: st[0], key: `${inputs.join(',')}|${out.map((i) => i.join(' ')).join('; ')}` };
}

// Every window of 2 to maxLen pure instructions, counted across the corpus.
export function mine(modules, { maxLen = 7, minCount = 2 } = {}) {
  const windows = new Map();
  for (const m of modules) {
    for (const f of m.funcs) {
      const types = localTypes(f);
      const body = f.body;
      for (let i = 0; i < body.length; i++) {
        for (let n = 2; n <= maxLen && i + n <= body.length; n++) {
          if (!isPure(body[i + n - 1][0])) break;
          if (!isPure(body[i][0])) break;
          const w = canonical(body.slice(i, i + n), types);
          if (!w) continue;
          const seen = windows.get(w.key);
          if (seen) seen.seen++; else windows.set(w.key, { ...w, seen: 1 });
        }
      }
    }
  }
  return [...windows.values()].filter((w) => w.seen >= minCount).sort((a, b) => b.seen - a.seen);
}
