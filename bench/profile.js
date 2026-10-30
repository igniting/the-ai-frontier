// Where do the executed instructions go? Gives every straight-line segment
// its own counter, runs the program, and reports dynamic instruction counts
// per function and per opcode.
//
//   node bench/profile.js <program> [-O] [--top N]      (program: a bench name or a .lm file)

import { readFileSync } from 'node:fs';
import { parse } from '../src/parser.js';
import { typecheck } from '../src/typecheck.js';
import { PRELUDE } from '../src/prelude.js';
import { lower } from '../src/lower.js';
import { codegen } from '../src/codegen.js';
import { runWasm } from '../src/compiler.js';
import { PROGRAMS } from './bench.js';

const args = process.argv.slice(2);
const target = args[0];
const topAt = args.indexOf('--top');
const TOP = topAt >= 0 ? +args[topAt + 1] : 25;
const p = PROGRAMS.find((q) => q.name === target) ?? { name: target, source: () => readFileSync(target, 'utf8') };

const { mod } = codegen(lower(typecheck(parse(PRELUDE), parse(p.source()))), { optimize: args.includes('-O') });
const ENDS = new Set(['block', 'loop', 'if', 'else', 'end', 'br', 'br_if', 'br_table', 'return', 'unreachable', 'call', 'call_indirect', 'return_call', 'return_call_indirect']);
const segments = [];
for (const f of mod.funcs) {
  const out = [];
  let start = 0, ops = [];
  const close = () => {
    if (ops.length) {
      const g = `$seg${segments.length}`;
      segments.push({ func: f.name, ops, global: g });
      mod.addGlobal(g, 'i64', true, 0, `seg${segments.length - 1}`);
      out.splice(start, 0, ['global.get', g], ['i64.const', 1], ['i64.add'], ['global.set', g]);
    }
    start = out.length;
    ops = [];
  };
  for (const ins of f.body) { out.push(ins); ops.push(ins[0]); if (ENDS.has(ins[0])) close(); }
  close();
  f.body = out;
}
const r = runWasm(mod.encode(), { input: p.input ? p.input() : '' });
if (r.error) throw new Error(r.error);
const byFunc = new Map(), byOp = new Map();
let total = 0;
segments.forEach((s, i) => {
  const n = Number(r.exports[`seg${i}`].value);
  if (!n) return;
  byFunc.set(s.func, (byFunc.get(s.func) ?? 0) + n * s.ops.length);
  for (const op of s.ops) byOp.set(op, (byOp.get(op) ?? 0) + n);
  total += n * s.ops.length;
});
const show = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, TOP)
  .map(([k, v]) => `  ${(v / total * 100).toFixed(1).padStart(5)}%  ${v.toLocaleString('en').padStart(15)}  ${k}`).join('\n');
console.log(`${p.name}: ${total.toLocaleString('en')} instructions executed\n\nby function:\n${show(byFunc)}\n\nby opcode:\n${show(byOp)}`);
