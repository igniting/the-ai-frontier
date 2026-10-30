// The -O pipeline. Each pass rewrites the flat instruction lists of the
// compiler-generated functions (the hand-written runtime is left alone);
// CAMPAIGN.md records why each pass exists and what it bought.

import { optimizeModule as applyRules } from './peephole.js';
import { RULES } from './rules.js';

// A temporary written and immediately read back is just a value on the
// stack: `local.set $t; local.get $t` becomes nothing when that is the only
// use of $t, and `local.tee $t` otherwise.
export function forwardTemps(f) {
  const uses = new Map();
  for (const [op, arg] of f.body) if (op.startsWith('local.')) uses.set(arg, (uses.get(arg) ?? 0) + 1);
  const out = [];
  for (let i = 0; i < f.body.length; i++) {
    const ins = f.body[i], next = f.body[i + 1];
    if (ins[0] === 'local.set' && next && next[0] === 'local.get' && next[1] === ins[1]) {
      if (uses.get(ins[1]) !== 2) out.push(['local.tee', ins[1]]);
      i++;
      continue;
    }
    out.push(ins);
  }
  f.body = out;
}

// Locals that no instruction mentions any more.
function dropUnusedLocals(f) {
  const used = new Set(f.body.filter(([op]) => op.startsWith('local.')).map(([, arg]) => arg));
  f.locals = f.locals.filter((l) => used.has(l.name));
}

export function optimize(mod) {
  const funcs = mod.funcs.filter((f) => f.oddLocals);
  for (const f of funcs) forwardTemps(f);
  const peephole = applyRules(mod, RULES);
  for (const f of funcs) dropUnusedLocals(f);
  return peephole;
}
