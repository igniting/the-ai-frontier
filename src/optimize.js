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

// ------------------------------------------------- frame zeroing elision --
// The prologue zeroes a function's shadow-stack slots so the collector never
// sees a stale pointer in one. That is only necessary for a slot that some
// path can reach a GC point with before writing it. GC points are calls
// that can reach the allocator: any call_indirect, any call to compiled
// code, and calls to the runtime functions that (transitively) allocate.

// The runtime functions (and host imports) that can never collect.
export function nonCollecting(mod) {
  const byName = new Map(mod.funcs.map((f) => [f.name, f]));
  const may = new Map();
  const visit = (name) => {
    if (may.has(name)) return may.get(name);
    const f = byName.get(name);
    if (!f) { const r = !name.startsWith('$host:'); may.set(name, r); return r; } // imports cannot call back
    may.set(name, false); // provisional, for recursion
    const r = f.body.some(([op, arg]) => op === 'call_indirect' || op === 'return_call_indirect' || op === 'memory.grow'
      || ((op === 'call' || op === 'return_call') && (arg === '$rt:gc' || visit(arg))));
    may.set(name, r);
    return r;
  };
  const safe = new Set();
  for (const f of mod.funcs) if (f.name.startsWith('$rt:') && !visit(f.name)) safe.add(f.name);
  for (const im of mod.imports) safe.add(im.name);
  return safe;
}

// Which of `candidates` (slot numbers) can be live-but-unwritten at a GC
// point, scanning `body` from `start`. Writes are the frame-slot stores
// codegen tagged with `frameSlot`. Control flow is handled conservatively:
// writes inside a block, loop or if are forgotten at its end, and an else
// branch starts from the state before the if.
export function slotsNeedingZero(body, start, candidates, safeCallees) {
  const need = new Set();
  let written = new Set();
  const saved = [];
  for (let i = start; i < body.length; i++) {
    const [op, arg] = body[i];
    if (op === 'block' || op === 'loop' || op === 'if') saved.push(new Set(written));
    else if (op === 'else') written = new Set(saved[saved.length - 1]);
    else if (op === 'end') written = saved.pop() ?? written;
    else if (op === 'call_indirect' || (op === 'call' && !safeCallees.has(arg))) {
      for (const s of candidates) if (!written.has(s)) need.add(s);
    } else if (op === 'i32.store' && body[i].frameSlot !== undefined) written.add(body[i].frameSlot);
  }
  return need;
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
