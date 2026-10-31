// Applies the superoptimizer's rewrite rules (src/rules.js) to the
// WebAssembly the code generator emits: a peephole pass over straight-line
// code. Every rule was found by search and proved equal for all inputs by
// the SAT solver, with the proof checked (superopt/verify.js re-proves them).
//
// A rule's left side is a sequence of instructions with placeholders: x0, x1
// for locals and K0, K1 for constants. A right-side constant can be an
// expression over them (K1-K0), and a rule can carry side conditions on the
// constants (K0 <= K1), checked here before rewriting.

import { RULES } from './rules.js';

const WIDTH = { i32: 32, i64: 64 };

function constExpr(expr, ks, t) {
  let v = 0n;
  for (const m of String(expr).matchAll(/([+-]?)(K\d+|\d+)/g)) {
    const x = m[2][0] === 'K' ? ks[m[2]] : BigInt(m[2]);
    v += m[1] === '-' ? -x : x;
  }
  return BigInt.asIntN(WIDTH[t], v);
}
function holds(cond, ks) {
  const [x, op, y] = cond.split(' ');
  const a = ks[x], b = y[0] === 'K' ? ks[y] : BigInt(y);
  return op === '<=' ? a <= b : op === '<' ? a < b : op === '>=' ? a >= b : op === '!=' ? a !== b : a > b;
}

// Matches a rule at body[i]: returns the bindings, or null.
function match(rule, body, i) {
  if (i + rule.lhs.length > body.length) return null;
  const xs = {}, ks = {};
  for (let j = 0; j < rule.lhs.length; j++) {
    const [op, arg] = rule.lhs[j];
    const [bop, barg] = body[i + j];
    if (op !== bop) return null;
    if (op === 'local.get') {
      if (arg in xs) { if (xs[arg] !== barg) return null; } else xs[arg] = barg;
    } else if (op === 'i32.const' || op === 'i64.const') {
      const v = BigInt.asIntN(WIDTH[op.slice(0, 3)], BigInt(barg));
      if (arg[0] === 'K') { if (arg in ks) { if (ks[arg] !== v) return null; } else ks[arg] = v; } else if (BigInt(arg) !== v) return null;
    }
  }
  return rule.when.every((c) => holds(c, ks)) ? { xs, ks } : null;
}

function instantiate(rule, { xs, ks }) {
  return rule.rhs.map(([op, arg]) => {
    if (op === 'local.get') return [op, xs[arg]];
    if (op === 'i64.const') return [op, constExpr(arg, ks, 'i64')];
    if (op === 'i32.const') return [op, Number(constExpr(arg, ks, 'i32'))];
    return [op];
  });
}

// Rewrites until no rule applies. stats (optional) counts uses per rule.
export function peephole(body, { rules = RULES, stats = null, mutant = null } = {}) {
  const byOp = new Map();
  for (const r of rules) {
    const first = r.lhs[0][0];
    if (!byOp.has(first)) byOp.set(first, []);
    byOp.get(first).push(r);
  }
  const maxLen = Math.max(0, ...rules.map((r) => r.lhs.length));
  let out = body;
  for (let changed = true; changed;) {
    changed = false;
    const next = [];
    for (let i = 0; i < out.length;) {
      let done = false;
      for (const r of byOp.get(out[i][0]) ?? []) {
        const m = match(mutant === 'superopt-ignore-when' ? { ...r, when: [] } : r, out, i);
        if (!m) continue;
        next.push(...instantiate(r, m));
        if (stats) stats.set(r.id, (stats.get(r.id) ?? 0) + 1);
        i += r.lhs.length;
        changed = done = true;
        break;
      }
      if (!done) next.push(out[i++]);
    }
    out = next;
    if (!maxLen) break;
  }
  return out;
}
