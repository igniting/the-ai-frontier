// Code generation: IR -> WebAssembly module.
//
// Calling convention: every Lumen function becomes a wasm function
//   (param $env i32) (param <args> i32...) (result i32)
// where $env is the closure object it was called through (or 0 for direct
// calls to top-level functions). Closures are called with call_indirect.
//
// Each function gets a *shadow stack frame* holding exactly its traced
// variables (those whose type may contain a heap pointer); the GC scans these
// frames as its root set. Variables of immediate-only types (Int, Bool, ...)
// live in ordinary wasm locals and cost the collector nothing — a function
// like `fib` needs no frame at all. Calls in tail position use the wasm
// tail-call instructions (return_call / return_call_indirect) after popping
// the frame, so tail-recursive loops run in constant stack space.

import { Module } from './wasm.js';
import { reachableFunctions } from './lower.js';
import {
  addRuntime, seq, c, lg, ls, lt, gg, gs, ld, st, call, header, TAG_CLOSURE, TAG_STRING, ERR, BUILTIN_RUNTIME,
} from './runtime.js';
import { optimize, prePasses, nonCollecting, slotsNeedingZero } from './optimize.js';
import { instrumentModule } from './instrument.js';

const o = (name) => [name];
const INLINE_ARRAY_OPS = new Set(['array_get', 'array_set', 'array_length']);

// The functions during whose activation no collection can happen, so they
// need no shadow-stack frame. Two properties are involved:
//   never(g):     calling g can never collect, even through g's tail calls;
//   frameless(f): nothing collects while f is active: no allocation, and
//     every non-tail call is to a `never` function. A tail call may collect
//     (f's activation has ended by then), which is not enough for `never`:
//     a caller of g is still waiting while g's tail callee runs.
// Both are greatest fixed points over the call graph.
export function collectionFree(funcs, safeCallees) {
  const fixpoint = (bad) => {
    const set = new Set(funcs.map((f) => f.name));
    for (let changed = true; changed;) {
      changed = false;
      for (const f of funcs) if (set.has(f.name) && bad(f.body, true, set)) { set.delete(f.name); changed = true; }
    }
    return set;
  };
  // `onCall(fn, tail, set)` decides whether a direct call may collect.
  const walker = (onCall, callcCollects) => {
    const mayCollect = (e, tail, set) => {
      switch (e.k) {
        case 'atom': return false;
        case 'let': return mayCollect(e.rhs, false, set) || mayCollect(e.body, tail, set);
        case 'seq': return mayCollect(e.first, false, set) || mayCollect(e.rest, tail, set);
        case 'prim': return e.op === 'concat';
        case 'builtin': return !safeCallees.has(BUILTIN_RUNTIME[e.name]);
        case 'call': return onCall(e.fn, tail, set);
        case 'callc': return callcCollects(tail);
        case 'if': return mayCollect(e.t, tail, set) || mayCollect(e.e, tail, set);
        case 'match': return e.arms.some((arm) => (arm.guard && mayCollect(arm.guard, false, set)) || mayCollect(arm.body, tail, set));
        default: return true; // alloc, closure, and anything new
      }
    };
    return mayCollect;
  };
  const never = fixpoint(walker((fn, tail, set) => !set.has(fn), () => true));
  return fixpoint(walker((fn, tail) => !tail && !never.has(fn), (tail) => !tail));
}
const align = (n, a) => Math.ceil(n / a) * a;

export const DEFAULTS = {
  stackSize: 1 << 20, // shadow stack: 256K traced slots
  heapSize: 1 << 20, // initial semispace size (grows on demand)
  maxMemoryPages: 32768, // 2 GiB
  gcStress: false,
  fuel: 0, // 0 = unlimited; otherwise max number of function calls
  optimize: false, // -O: the optimization pipeline of src/optimize.js
  rulesOff: false, // with optimize: everything but the superoptimizer's rules (used to mine them)
  countInstructions: false, // export `icount`, the number of wasm instructions executed
};

export function codegen(ir, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (opts.gcStress) opts.heapSize = Math.min(opts.heapSize, 4096);
  const mod = new Module();

  // ------------------------------------------------------------ layout --
  const layout = { SCRATCH_END: 64, STACK_BASE: 1024 };
  layout.STACK_END = layout.STACK_BASE + opts.stackSize;
  layout.STACK_LIMIT = layout.STACK_END - 256; // headroom for runtime helpers' roots
  let staticTop = layout.STACK_END;
  const staticObject = (words, bytes = null, comment = '') => {
    const addr = staticTop;
    const size = words.length * 4 + (bytes ? bytes.length : 0);
    const buf = new Uint8Array(align(size, 4));
    const view = new DataView(buf.buffer);
    words.forEach((w, i) => view.setInt32(i * 4, w, true));
    if (bytes) buf.set(bytes, words.length * 4);
    mod.data.push({ offset: addr, bytes: buf, comment });
    staticTop += buf.length;
    return addr;
  };
  const strBytes = (byteString) => Uint8Array.from(byteString, (ch) => ch.charCodeAt(0));

  layout.EMPTY_STRING = staticObject([header(TAG_STRING, 0)], null, 'the empty string');
  const charTable = new Uint8Array(256 * 8);
  for (let i = 0; i < 256; i++) {
    new DataView(charTable.buffer).setInt32(i * 8, header(TAG_STRING, 1), true);
    charTable[i * 8 + 4] = i;
  }
  layout.CHAR_TABLE = staticObject([], charTable, 'one-byte strings for char_from_code');

  const stringAddrs = new Map();
  const stringAddr = (idx) => {
    if (!stringAddrs.has(idx)) {
      const bytes = strBytes(ir.strings[idx]);
      const preview = ir.strings[idx].slice(0, 40).replace(/[^\x20-\x7e]/g, '?');
      stringAddrs.set(idx, staticObject([header(TAG_STRING, bytes.length)], bytes, `string "${preview}"`));
    }
    return stringAddrs.get(idx);
  };

  const wasmName = (name) => `$${name}`;
  const tableIndex = (fnName) => {
    let i = mod.table.indexOf(wasmName(fnName));
    if (i < 0) {
      i = mod.table.length;
      mod.table.push(wasmName(fnName));
    }
    return i;
  };
  const staticClosures = new Map();
  const staticClosure = (fnName) => {
    if (!staticClosures.has(fnName)) {
      staticClosures.set(fnName, staticObject([header(TAG_CLOSURE, 1), (tableIndex(fnName) << 1) | 1], null, `static closure for ${fnName}`));
    }
    return staticClosures.get(fnName);
  };
  const fnType = (n) => mod.namedType(`$fn${n}`, Array(n + 1).fill('i32'), ['i32']);

  addRuntime(mod, layout, opts);
  const safeCallees = opts.optimize ? nonCollecting(mod) : null;

  // --------------------------------------------------------- functions --
  const funcs = reachableFunctions(ir);
  const gcFree = opts.optimize ? collectionFree(funcs, safeCallees) : new Set();
  for (const f of funcs) genFunction(f);

  mod.addFunc({
    name: '$rt:start', exportName: 'run', params: [], results: [], locals: [],
    body: [c(0), call(wasmName(ir.entry)), o('drop')],
    comment: 'Entry point: calls main().',
  });

  function genFunction(f) {
    const body = [];
    const emit = (...ins) => body.push(...seq(ins));
    const locals = [];
    const storage = new Map();
    const varName = (v) => `$${v.name.replace(/[^A-Za-z0-9_]/g, '_')}_${v.id}`;
    // -O: a function in which no collection can happen needs no shadow-stack
    // frame; its pointers live in wasm locals like everything else.
    const frameless = opts.optimize && gcFree.has(f.name);
    const traced = (v) => v.traced && !frameless;
    let slots = 0;
    if (f.env) storage.set(f.env.id, frameless ? { local: '$env' } : { slot: slots++ });
    for (const v of f.params) if (traced(v)) storage.set(v.id, { slot: slots++ });
    const paramSlots = slots;
    for (const v of f.params) if (!traced(v)) storage.set(v.id, { local: varName(v), odd: !v.traced });
    for (const v of f.vars) {
      if (storage.has(v.id)) continue;
      if (traced(v)) storage.set(v.id, { slot: slots++ });
      else {
        storage.set(v.id, { local: varName(v), odd: !v.traced });
        locals.push({ name: varName(v), type: 'i32' });
      }
    }
    const frameBytes = slots * 4;
    if (frameBytes) locals.push({ name: '$fp', type: 'i32' });
    let needsTmp = false;
    let zeroAt = -1, zeroLen = 0; // where the prologue zeroes the frame
    // Stores to frame slots are tagged for the -O passes that reason about them.
    const slotStore = (slot) => Object.assign(st(slot * 4), { frameSlot: slot });
    let labelCounter = 0;
    const label = (base) => `$${base}${labelCounter++}`;

    // -------------------------------------------------------- prologue --
    // Under -O a self tail call becomes a branch back to `loopAt`, just after
    // the frame is pushed: what follows it (fuel, zeroing, storing the
    // parameters) runs again on every iteration, exactly as on entry.
    const fuelCheck = () => emit(gg('$fuel'), c(1), o('i32.sub'), lt('$fuel_tmp'), gs('$fuel'), lg('$fuel_tmp'), c(0), o('i32.lt_s'),
      ['if', null, null], c(ERR.FUEL), call('$rt:trap'), ['end']);
    if (opts.fuel) locals.push({ name: '$fuel_tmp', type: 'i32' });
    if (opts.fuel && !opts.optimize) fuelCheck();
    if (frameBytes) {
      emit(gg('$sp'), lt('$fp'), c(frameBytes), o('i32.add'), gs('$sp'),
        gg('$sp'), c(layout.STACK_LIMIT), o('i32.gt_u'), ['if', null, null], c(ERR.STACK), call('$rt:trap'), ['end']);
    }
    const loopAt = body.length;
    let selfTail = false;
    if (opts.fuel && opts.optimize) fuelCheck();
    if (frameBytes) {
      if (slots > paramSlots) {
        zeroAt = body.length;
        emit(lg('$fp'), paramSlots ? [c(paramSlots * 4), o('i32.add')] : [], c(0), c((slots - paramSlots) * 4), ['memory.fill']);
        zeroLen = body.length - zeroAt;
      }
      if (f.env) emit(lg('$fp'), lg('$env'), slotStore(storage.get(f.env.id).slot));
      for (const v of f.params) {
        if (traced(v)) emit(lg('$fp'), lg(varName(v)), slotStore(storage.get(v.id).slot));
      }
    }

    // ----------------------------------------------------------- atoms --
    const envPtr = () => { const s = storage.get(f.env.id); return s.local ? lg(s.local) : seq(lg('$fp'), ld(s.slot * 4)); };
    function genAtom(a) {
      switch (a.k) {
        case 'var': {
          const s = storage.get(a.v.id);
          if (s.local) return emit(lg(s.local));
          return emit(lg('$fp'), ld(s.slot * 4));
        }
        case 'imm': return emit(c(a.n));
        case 'str': return emit(c(stringAddr(a.idx)));
        case 'sclo': return emit(c(staticClosure(a.fn)));
        case 'envf': return emit(envPtr(), ld(8 + 4 * a.i));
        case 'self': return emit(envPtr());
      }
      throw new Error(`codegen: unknown atom ${a.k}`);
    }

    function genStore(v, value) {
      const s = storage.get(v.id);
      if (s.local) {
        value();
        emit(ls(s.local));
      } else {
        emit(lg('$fp'));
        value();
        emit(slotStore(s.slot));
      }
    }

    const popFrame = () => {
      if (!frameBytes) return;
      // Paranoid mode: poison the popped frame (0xfefefefe is never a valid root).
      if (opts.optimize && opts.gcStress) emit(lg('$fp'), c(0xfe), c(frameBytes), ['memory.fill']);
      emit(lg('$fp'), gs('$sp'));
    };

    // Allocation: the fields are loaded *after* $rt:alloc returns, because a
    // collection inside alloc may move the objects they point to.
    function genAlloc(hdr, fields) {
      needsTmp = true;
      const bytes = 4 + 4 * fields.length;
      if (opts.optimize && !opts.gcStress) {
        // -O: bump the heap pointer inline; call the runtime only when full.
        emit(gg('$hp'), c(bytes), o('i32.add'), lt('$tmp'), gg('$from_end'), o('i32.gt_u'),
          ['if', null, 'i32'], c(bytes), call('$rt:alloc'),
          ['else'], gg('$hp'), lg('$tmp'), gs('$hp'), ['end'],
          ls('$tmp'), lg('$tmp'), c(hdr), st(0));
      } else emit(c(bytes), call('$rt:alloc'), ls('$tmp'), lg('$tmp'), c(hdr), st(0));
      fields.forEach((a, i) => {
        emit(lg('$tmp'));
        genAtom(a);
        emit(st(4 + 4 * i));
      });
      emit(lg('$tmp'));
    }

    const toBool = () => emit(c(1), o('i32.shl'), c(1), o('i32.or'));

    // -O: array access inline (bounds check, then a load or store) instead of
    // a call into the runtime. Atoms are pure, so re-emitting them is safe.
    let needsIndex = false;
    function genArrayOp(name, [a, i, x]) {
      if (name === 'array_length') { genAtom(a); emit(ld(0), c(9), o('i32.shr_u')); return toBool(); }
      needsIndex = true;
      genAtom(i);
      emit(c(1), o('i32.shr_s'), lt('$ix'));
      genAtom(a);
      emit(ld(0), c(9), o('i32.shr_u'), o('i32.ge_u'), ['if', null, null], c(ERR.INDEX), call('$rt:trap'), ['end']);
      genAtom(a);
      emit(lg('$ix'), c(2), o('i32.shl'), o('i32.add'));
      if (name === 'array_get') return emit(ld(4));
      genAtom(x);
      return emit(st(4), c(1));
    }
    const untagBool = () => emit(c(1), o('i32.shr_u'));

    function genPrim(e) {
      const [a, b] = e.args;
      const both = () => { genAtom(a); genAtom(b); };
      switch (e.op) {
        case 'add': both(); return emit(o('i32.add'), c(1), o('i32.sub'));
        case 'sub': both(); return emit(o('i32.sub'), c(1), o('i32.add'));
        case 'mul':
          genAtom(a); emit(c(1), o('i32.shr_s'));
          genAtom(b); emit(c(1), o('i32.sub'), o('i32.mul'), c(1), o('i32.add'));
          return;
        case 'div':
        case 'rem':
          genAtom(b); emit(c(1), o('i32.eq'), ['if', null, null], c(ERR.DIV_ZERO), call('$rt:trap'), ['end']);
          genAtom(a); emit(c(1), o('i32.shr_s'));
          genAtom(b); emit(c(1), o('i32.shr_s'), o(e.op === 'div' ? 'i32.div_s' : 'i32.rem_s'));
          return toBool();
        case 'neg': emit(c(2)); genAtom(a); return emit(o('i32.sub'));
        case 'not': emit(c(4)); genAtom(a); return emit(o('i32.sub'));
        case 'concat': both(); return emit(call('$rt:concat'));
        case 'eq_imm': both(); emit(o('i32.eq')); return toBool();
        case 'ne_imm': both(); emit(o('i32.ne')); return toBool();
        case 'lt_imm': both(); emit(o('i32.lt_s')); return toBool();
        case 'le_imm': both(); emit(o('i32.le_s')); return toBool();
        case 'gt_imm': both(); emit(o('i32.gt_s')); return toBool();
        case 'ge_imm': both(); emit(o('i32.ge_s')); return toBool();
        case 'eq': both(); emit(call('$rt:eq')); return toBool();
        case 'ne': both(); emit(call('$rt:eq'), o('i32.eqz')); return toBool();
        case 'lt': case 'le': case 'gt': case 'ge':
          both(); emit(call('$rt:compare'), c(0), o(`i32.${e.op}_s`)); return toBool();
      }
      throw new Error(`codegen: unknown primitive ${e.op}`);
    }

    function genPath(scrut, path) {
      genAtom(scrut);
      for (const i of path) emit(ld(4 + 4 * i));
    }

    function genTest(t, scrut) {
      genPath(scrut, t.path);
      switch (t.k) {
        case 'imm': return emit(c(t.n), o('i32.eq'));
        case 'isblock': return emit(c(1), o('i32.and'), o('i32.eqz'));
        case 'tag': return emit(ld(0), c(1), o('i32.shr_u'), c(255), o('i32.and'), c(t.tag), o('i32.eq'));
        case 'str': return emit(c(stringAddr(t.idx)), call('$rt:str_eq'));
      }
    }

    function genMatch(e, tail) {
      const bind = (arm) => arm.binds.forEach((b) => genStore(b.v, () => genPath(e.scrut, b.path)));
      if (e.arms.length === 1 && !e.arms[0].tests.length && !e.arms[0].guard) {
        bind(e.arms[0]);
        return genExpr(e.arms[0].body, tail);
      }
      const done = label('match');
      emit(['block', done, 'i32']);
      let exhaustiveArm = false;
      for (const arm of e.arms) {
        if (!arm.tests.length && !arm.guard) {
          bind(arm);
          genExpr(arm.body, tail);
          emit(['br', done]);
          exhaustiveArm = true;
          break;
        }
        const next = label('arm');
        emit(['block', next, null]);
        for (const t of arm.tests) {
          genTest(t, e.scrut);
          emit(o('i32.eqz'), ['br_if', next]);
        }
        bind(arm);
        if (arm.guard) {
          genExpr(arm.guard, false);
          untagBool();
          emit(o('i32.eqz'), ['br_if', next]);
        }
        genExpr(arm.body, tail);
        emit(['br', done], ['end']);
      }
      if (!exhaustiveArm) emit(o('unreachable'));
      emit(['end']);
    }

    function genExpr(e, tail) {
      switch (e.k) {
        case 'atom': return genAtom(e.a);
        case 'let':
          genStore(e.v, () => genExpr(e.rhs, false));
          return genExpr(e.body, tail);
        case 'seq':
          genExpr(e.first, false);
          emit(o('drop'));
          return genExpr(e.rest, tail);
        case 'prim': return genPrim(e);
        case 'builtin':
          if (opts.optimize && INLINE_ARRAY_OPS.has(e.name)) return genArrayOp(e.name, e.args);
          e.args.forEach(genAtom);
          return emit(call(BUILTIN_RUNTIME[e.name]));
        case 'call':
          if (e.env) genAtom(e.env);
          else emit(c(0));
          e.args.forEach(genAtom);
          if (tail && opts.optimize && e.fn === f.name) {
            // -O: a self tail call reuses the frame: assign the parameters, loop.
            selfTail = true;
            for (const v of [...f.params].reverse()) emit(ls(storage.get(v.id).local ?? varName(v)));
            return emit(ls('$env'), ['br', '$tail']);
          }
          if (tail) {
            popFrame();
            return emit(['return_call', wasmName(e.fn)]);
          }
          return emit(call(wasmName(e.fn)));
        case 'callc':
          genAtom(e.clo);
          e.args.forEach(genAtom);
          genAtom(e.clo);
          emit(ld(4), c(1), o('i32.shr_u'));
          if (tail) {
            popFrame();
            return emit(['return_call_indirect', fnType(e.args.length)]);
          }
          return emit(['call_indirect', fnType(e.args.length)]);
        case 'alloc':
          return genAlloc(header(e.tag, e.args.length), e.args);
        case 'closure':
          return genAlloc(header(TAG_CLOSURE, 1 + e.captured.length),
            [{ k: 'imm', n: (tableIndex(e.fn) << 1) | 1 }, ...e.captured]);
        case 'if':
          genAtom(e.c);
          untagBool();
          emit(['if', null, 'i32']);
          genExpr(e.t, tail);
          emit(['else']);
          genExpr(e.e, tail);
          return emit(['end']);
        case 'match':
          return genMatch(e, tail);
      }
      throw new Error(`codegen: unknown expression ${e.k}`);
    }

    genExpr(f.body, true);
    if (selfTail) {
      body.splice(loopAt, 0, ['loop', '$tail', 'i32']);
      body.push(['end']);
      if (zeroAt >= loopAt) zeroAt++;
    }
    popFrame();
    if (needsTmp) locals.push({ name: '$tmp', type: 'i32' });
    if (needsIndex) locals.push({ name: '$ix', type: 'i32' });
    if (opts.optimize && zeroAt >= 0) {
      // Zero only the slots that a GC point could see before they are written.
      const candidates = Array.from({ length: slots - paramSlots }, (_, k) => paramSlots + k);
      const need = [...slotsNeedingZero(body, zeroAt + zeroLen, candidates, safeCallees)].sort((a, b) => a - b);
      let zero = [];
      if (need.length > 0 && need.length <= 2) zero = need.flatMap((k) => [lg('$fp'), c(0), slotStore(k)]);
      else if (need.length > 2) {
        const lo = need[0], hi = need[need.length - 1];
        zero = seq(lg('$fp'), lo ? [c(lo * 4), o('i32.add')] : [], c(0), c((hi - lo + 1) * 4), ['memory.fill']);
      }
      body.splice(zeroAt, zeroLen, ...zero);
    }

    const params = [{ name: '$env', type: 'i32' }, ...f.params.map((v) => ({ name: storage.get(v.id).local ?? varName(v), type: 'i32' }))];
    // Locals holding untraced variables always contain tagged immediates (odd
    // values); the superoptimizer may rely on that.
    const oddLocals = [...storage.values()].filter((s) => s.odd).map((s) => s.local);
    mod.addFunc({
      name: wasmName(f.name), params, results: ['i32'], locals, body, oddLocals,
      comment: `${f.name}(${f.params.map((v) => v.name).join(', ')})  frame: ${slots} slot${slots === 1 ? '' : 's'}`,
    });
  }

  // ------------------------------------------------------------ globals --
  layout.STATIC_END = staticTop;
  layout.HEAP_BASE = align(staticTop, 8);
  const fromStart = layout.HEAP_BASE;
  const toStart = fromStart + opts.heapSize;
  const memEnd = toStart + opts.heapSize;
  mod.memory.min = Math.ceil(memEnd / 65536);
  mod.memory.max = opts.maxMemoryPages;
  mod.addGlobal('$sp', 'i32', true, layout.STACK_BASE);
  mod.addGlobal('$hp', 'i32', true, fromStart, 'hp');
  mod.addGlobal('$next', 'i32', true, 0);
  mod.addGlobal('$from_start', 'i32', true, fromStart, 'from_start');
  mod.addGlobal('$from_end', 'i32', true, fromStart + opts.heapSize, 'from_end');
  mod.addGlobal('$to_start', 'i32', true, toStart);
  mod.addGlobal('$to_end', 'i32', true, toStart + opts.heapSize);
  mod.addGlobal('$gc_count', 'i32', true, 0, 'gc_count');
  mod.addGlobal('$alloc_bytes', 'i64', true, 0, 'alloc_bytes');
  if (opts.optimize) mod.addGlobal('$alloc_mark', 'i32', true, fromStart, 'alloc_mark');
  if (opts.optimize && opts.gcStress) mod.addGlobal('$heap_base', 'i32', false, layout.HEAP_BASE);
  if (opts.fuel) mod.addGlobal('$fuel', 'i32', true, opts.fuel);

  const peephole = opts.optimize ? (opts.rulesOff ? (prePasses(mod), null) : optimize(mod)) : null;
  mod.prune();
  if (opts.countInstructions) instrumentModule(mod);
  return { mod, layout, functionCount: funcs.length, peephole };
}
