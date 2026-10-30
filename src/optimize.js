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

// ---------------------------------------------- frame-slot load forwarding --
// Traced variables live in shadow-stack slots and are reloaded on every use
// (`local.get $fp; i32.load offset=4k`). Between GC points a slot cannot
// change except by our own stores, so a loaded or stored value can be kept
// in a local ($slotk) and reused. This is a forward dataflow analysis over
// the structured control flow: the state maps each slot whose cache local
// is known to hold its value to the set of instructions that may have put
// it there; at a block's end the states of all incoming edges are
// intersected. A first pass finds which loads can reuse a cached value and
// which loads and stores must therefore tee into the cache; the second
// rewrites. Calls that may collect, loops (back edges) and anything not
// understood clear the state.
export function forwardSlotLoads(f, safeCallees) {
  const body = f.body;
  const isSlotLoad = (i) => body[i][0] === 'local.get' && body[i][1] === '$fp' && body[i + 1]?.[0] === 'i32.load';
  const reuse = new Set(); // index of a `local.get $fp` whose load is served from the cache
  const needed = new Set(); // instruction indices that must tee into the cache

  const meet = (a, b) => {
    if (a === null) return b && new Map(b);
    if (b === null) return a;
    const out = new Map();
    for (const [k, sites] of a) if (b.has(k)) out.set(k, new Set([...sites, ...b.get(k)]));
    return out;
  };
  let state = new Map(); // null: unreachable
  const frames = []; // open constructs: { kind, label, entry, merged }
  const branchTo = (label) => {
    for (let j = frames.length - 1; j >= 0; j--) {
      if (frames[j].label !== label) continue;
      if (frames[j].kind !== 'loop') frames[j].merged = meet(frames[j].merged, state);
      return true;
    }
    return false;
  };
  for (let i = 0; i < body.length; i++) {
    const ins = body[i], [op, arg] = ins;
    if (state && isSlotLoad(i)) {
      const k = body[i + 1][1] / 4;
      if (state.has(k)) { reuse.add(i); for (const site of state.get(k)) needed.add(site); } else state.set(k, new Set([i]));
      i++;
      continue;
    }
    switch (op) {
      case 'block': case 'if':
        frames.push({ kind: op, label: arg, entry: state && new Map(state), merged: null });
        break;
      case 'loop':
        frames.push({ kind: op, label: arg, entry: null, merged: null });
        state = state && new Map();
        break;
      case 'else': {
        const fr = frames[frames.length - 1];
        fr.merged = meet(fr.merged, state);
        fr.sawElse = true;
        state = fr.entry && new Map(fr.entry);
        break;
      }
      case 'end': {
        const fr = frames.pop();
        if (!fr) break;
        if (fr.kind === 'if' && !fr.sawElse) fr.merged = meet(fr.merged, fr.entry);
        state = meet(fr.merged, state);
        break;
      }
      case 'br': case 'br_if':
        if (state && !branchTo(arg)) state = new Map(); // unknown target: be safe
        if (op === 'br') state = null;
        break;
      case 'br_table': case 'return': case 'unreachable': case 'return_call': case 'return_call_indirect':
        if (op === 'br_table') for (const l of [...(arg ?? [])]) branchTo(l);
        state = null;
        break;
      case 'call':
        if (state && !safeCallees.has(arg)) state = new Map();
        break;
      case 'call_indirect': case 'memory.fill': case 'memory.copy':
        if (state) state = new Map();
        break;
      case 'i32.store':
        if (state && ins.frameSlot !== undefined) state.set(ins.frameSlot, new Set([i]));
        break;
      case 'local.set': case 'local.tee':
        if (arg === '$fp' && state) state = new Map();
        break;
    }
  }

  const out = [];
  let added = false;
  for (let i = 0; i < body.length; i++) {
    if (reuse.has(i)) { out.push(['local.get', `$slot${body[i + 1][1] / 4}`]); i++; added = true; continue; }
    if (needed.has(i) && isSlotLoad(i)) { out.push(body[i], body[i + 1], ['local.tee', `$slot${body[i + 1][1] / 4}`]); i++; continue; }
    if (needed.has(i)) out.push(['local.tee', `$slot${body[i].frameSlot}`]); // a store: keep the stored value
    out.push(body[i]);
  }
  if (added) {
    const slots = new Set(out.filter(([op, a]) => op.startsWith('local.') && a.startsWith('$slot')).map(([, a]) => a));
    for (const name of slots) f.locals.push({ name, type: 'i32' });
  }
  f.body = out;
}

// Locals that no instruction mentions any more.
function dropUnusedLocals(f) {
  const used = new Set(f.body.filter(([op]) => op.startsWith('local.')).map(([, arg]) => arg));
  f.locals = f.locals.filter((l) => used.has(l.name));
}

// The passes that run before the superoptimizer's rules (the rules are
// mined from code in exactly this shape: see superopt/corpus.js).
export function prePasses(mod) {
  const funcs = mod.funcs.filter((f) => f.oddLocals);
  const safeCallees = nonCollecting(mod);
  for (const f of funcs) forwardSlotLoads(f, safeCallees);
  for (const f of funcs) forwardTemps(f);
  return funcs;
}

export function optimize(mod) {
  const funcs = prePasses(mod);
  const peephole = applyRules(mod, RULES);
  for (const f of funcs) dropUnusedLocals(f);
  return peephole;
}
