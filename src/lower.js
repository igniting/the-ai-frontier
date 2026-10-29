// Lowering: typed AST -> IR.
//
// The IR is in A-normal form: the operands of every primitive, call and
// allocation are *atoms* (constants or variables), and all intermediate
// results are bound to named variables. This matters for the garbage
// collector: a heap pointer is never left on the wasm operand stack while an
// allocation can happen, so every live pointer is visible to the GC.
//
// This pass also performs:
//   * closure conversion — lambdas and local functions become top-level IR
//     functions; their free variables are copied into a heap-allocated
//     environment, and capture-free functions get a static closure instead;
//   * pattern-match compilation — each arm becomes a list of tag tests on
//     paths into the scrutinee plus a list of variable bindings;
//   * representation choices driven by types — variables whose type can only
//     hold immediate values (Int, Bool, (), enums) are marked untraced so code
//     generation can keep them out of the GC's root set entirely.
//
// Value representation (shared with codegen and the runtime):
//   Int n              -> immediate (n << 1) | 1
//   false/true/()      -> immediates 1 / 3 / 1
//   nullary ctor #i    -> immediate (i << 1) | 1
//   ctor #i(fields)    -> pointer to [header(kind=i, size=n), field...]
//   tuple              -> pointer to [header(kind=0, size=n), field...]
//   closure            -> pointer to [header(CLOSURE, 1+n), fnIndex, captured...]
//   string             -> pointer to [header(STRING, byteLength), bytes...]

import { prune } from './types.js';
import { BUILTIN_SIGNATURES } from './typecheck.js';

export const imm = (n) => ({ k: 'imm', n: ((n << 1) | 1) | 0 });
export const UNIT_ATOM = imm(0);
export const TRUE_ATOM = imm(1);
export const FALSE_ATOM = imm(0);

// Can a value of this type only ever be an immediate (never a heap pointer)?
export function isImmediateType(type, typeInfos) {
  const t = prune(type);
  if (t.k !== 'con') return false;
  if (t.name === 'Int' || t.name === 'Bool' || t.name === 'Unit') return true;
  const info = typeInfos.get(t.name);
  return !!info && info.ctors.every((c) => c.arity === 0);
}

const CMP_OPS = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
const ARITH_OPS = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'rem', '++': 'concat' };

export function lower(checked) {
  const { typeInfos } = checked;
  const funcs = new Map();
  const strings = [];
  const stringIndex = new Map();
  const knownFns = new Map(); // local fn binding id -> lifted function name
  let varCounter = 0;

  const traced = (type) => !isImmediateType(type, typeInfos);

  function uniqueName(base) {
    let name = base, n = 1;
    while (funcs.has(name)) name = `${base}${++n}`;
    funcs.set(name, null); // reserve
    return name;
  }

  function strAtom(bytes) {
    if (!stringIndex.has(bytes)) {
      stringIndex.set(bytes, strings.length);
      strings.push(bytes);
    }
    return { k: 'str', idx: stringIndex.get(bytes) };
  }

  class FnCtx {
    constructor(parent, name, selfBinding) {
      this.parent = parent;
      this.name = name;
      this.selfBinding = selfBinding;
      this.vars = new Map();
      this.captures = new Map();
      this.captureList = [];
      this.allVars = [];
      this.envVar = null;
    }
    newVar(name, isTraced) {
      const v = { id: varCounter++, name, traced: isTraced };
      this.allVars.push(v);
      return v;
    }
    bind(binding) {
      const v = this.newVar(binding.name, traced(binding.type));
      this.vars.set(binding.id, v);
      return v;
    }
    env() {
      if (!this.envVar) this.envVar = this.newVar('env', true);
      return this.envVar;
    }
  }

  function atomFor(binding, ctx) {
    if (binding.kind === 'global') return { k: 'sclo', fn: binding.internal };
    if (binding.kind === 'builtin') return { k: 'sclo', fn: builtinWrapper(binding.name) };
    const v = ctx.vars.get(binding.id);
    if (v) return { k: 'var', v };
    if (ctx.selfBinding === binding) {
      ctx.env();
      return { k: 'self' };
    }
    if (!ctx.parent) throw new Error(`lower: unbound variable ${binding.name}`);
    if (!ctx.captures.has(binding)) {
      ctx.captures.set(binding, ctx.captureList.length);
      ctx.captureList.push(binding);
    }
    ctx.env();
    return { k: 'envf', i: ctx.captures.get(binding) };
  }

  // ------------------------------------------------- generated wrappers --
  function builtinWrapper(name) {
    const fname = `builtin:${name}`;
    if (!funcs.has(fname)) {
      const ctx = new FnCtx(null, fname, null);
      const arity = BUILTIN_SIGNATURES[name].params.length;
      const params = Array.from({ length: arity }, (_, i) => ctx.newVar(`a${i}`, true));
      funcs.set(fname, { name: fname, params, env: null, vars: ctx.allVars, body: { k: 'builtin', name, args: params.map((v) => ({ k: 'var', v })) } });
    }
    return fname;
  }

  function ctorWrapper(ctor) {
    const fname = `ctor:${ctor.type.display}.${ctor.name}`;
    if (!funcs.has(fname)) {
      const ctx = new FnCtx(null, fname, null);
      const params = ctor.fields.map((_, i) => ctx.newVar(`a${i}`, true));
      funcs.set(fname, { name: fname, params, env: null, vars: ctx.allVars, body: { k: 'alloc', tag: ctor.index, args: params.map((v) => ({ k: 'var', v })) } });
    }
    return fname;
  }

  // ------------------------------------------------------------- atoms --
  function simpleAtom(e, ctx) {
    switch (e.k) {
      case 'int': return imm(e.v);
      case 'bool': return e.v ? TRUE_ATOM : FALSE_ATOM;
      case 'unit': return UNIT_ATOM;
      case 'str': return strAtom(e.v);
      case 'var': return atomFor(e.ref, ctx);
      case 'ctor':
        if (e.args === null && e.ctor.arity === 0) return imm(e.ctor.index);
        if (e.args === null) return { k: 'sclo', fn: ctorWrapper(e.ctor) };
    }
    return null;
  }

  function withAtom(e, ctx, k) {
    const a = simpleAtom(e, ctx);
    if (a) return k(a);
    const rhs = lowerExpr(e, ctx);
    if (rhs.k === 'atom') return k(rhs.a);
    const v = ctx.newVar('t', traced(e.ty));
    return { k: 'let', v, rhs, body: k({ k: 'var', v }) };
  }

  function withAtoms(es, ctx, k, acc = []) {
    if (acc.length === es.length) return k(acc);
    return withAtom(es[acc.length], ctx, (a) => withAtoms(es, ctx, k, [...acc, a]));
  }

  // ------------------------------------------------------- expressions --
  function lowerExpr(e, ctx) {
    const a = simpleAtom(e, ctx);
    if (a) return { k: 'atom', a };
    switch (e.k) {
      case 'ctor':
        return withAtoms(e.args, ctx, (args) => ({ k: 'alloc', tag: e.ctor.index, args }));
      case 'tuple':
        return withAtoms(e.elems, ctx, (args) => ({ k: 'alloc', tag: 0, args }));
      case 'call':
        return lowerCall(e, ctx);
      case 'lambda':
        return lowerFunction(e, ctx, null);
      case 'binop': {
        const { op } = e;
        if (op === '&&') return withAtom(e.l, ctx, (l) => ({ k: 'if', c: l, t: lowerExpr(e.r, ctx), e: { k: 'atom', a: FALSE_ATOM } }));
        if (op === '||') return withAtom(e.l, ctx, (l) => ({ k: 'if', c: l, t: { k: 'atom', a: TRUE_ATOM }, e: lowerExpr(e.r, ctx) }));
        let prim = ARITH_OPS[op];
        if (!prim) prim = CMP_OPS[op] + (isImmediateType(e.operandTy, typeInfos) ? '_imm' : '');
        return withAtom(e.l, ctx, (l) => withAtom(e.r, ctx, (r) => ({ k: 'prim', op: prim, args: [l, r] })));
      }
      case 'unop':
        return withAtom(e.e, ctx, (x) => ({ k: 'prim', op: e.op === '-' ? 'neg' : 'not', args: [x] }));
      case 'if':
        return withAtom(e.c, ctx, (c) => ({
          k: 'if', c, t: lowerExpr(e.t, ctx), e: e.e ? lowerExpr(e.e, ctx) : { k: 'atom', a: UNIT_ATOM },
        }));
      case 'match':
        return withAtom(e.e, ctx, (s) => ({
          k: 'match',
          scrut: s,
          arms: e.arms.map((arm) => {
            const { tests, binds } = compilePattern(arm.pat, ctx);
            return { tests, binds, guard: arm.guard ? lowerExpr(arm.guard, ctx) : null, body: lowerExpr(arm.body, ctx) };
          }),
        }));
      case 'block':
        return lowerBlock(e, 0, ctx);
    }
    throw new Error(`lower: unknown node ${e.k}`);
  }

  function lowerCall(e, ctx) {
    const f = e.fn;
    if (f.k === 'var') {
      const b = f.ref;
      if (b.kind === 'global') return withAtoms(e.args, ctx, (args) => ({ k: 'call', fn: b.internal, env: null, args }));
      if (b.kind === 'builtin') return withAtoms(e.args, ctx, (args) => ({ k: 'builtin', name: b.name, args }));
      if (knownFns.has(b.id)) {
        // Calling a known local function: a direct call that passes its closure as the environment.
        const env = atomFor(b, ctx);
        return withAtoms(e.args, ctx, (args) => ({ k: 'call', fn: knownFns.get(b.id), env, args }));
      }
    }
    return withAtom(f, ctx, (clo) => withAtoms(e.args, ctx, (args) => ({ k: 'callc', clo, args })));
  }

  function lowerFunction(node, ctx, selfBinding) {
    const base = selfBinding ? `${ctx.name}.${node.name}` : `${ctx.name}.lambda`;
    const name = uniqueName(base);
    if (selfBinding) knownFns.set(selfBinding.id, name);
    const inner = new FnCtx(ctx, name, selfBinding);
    const params = node.params.map((p) => inner.bind(p.binding));
    const body = lowerExpr(node.body, inner);
    funcs.set(name, { name, params, env: inner.envVar, vars: inner.allVars, body, captures: inner.captureList.length });
    if (inner.captureList.length === 0) return { k: 'atom', a: { k: 'sclo', fn: name } };
    return { k: 'closure', fn: name, captured: inner.captureList.map((b) => atomFor(b, ctx)) };
  }

  function lowerBlock(block, i, ctx) {
    if (i === block.stmts.length) return block.result ? lowerExpr(block.result, ctx) : { k: 'atom', a: UNIT_ATOM };
    const s = block.stmts[i];
    const rest = () => lowerBlock(block, i + 1, ctx);
    if (s.k === 'expr') return { k: 'seq', first: lowerExpr(s.e, ctx), rest: rest() };
    if (s.k === 'fn') {
      const v = ctx.newVar(s.name, true);
      const clo = lowerFunction(s, ctx, s.binding);
      ctx.vars.set(s.binding.id, v);
      return { k: 'let', v, rhs: clo, body: rest() };
    }
    // let
    if (s.pat.k === 'pvar') {
      const rhs = lowerExpr(s.e, ctx);
      const v = ctx.bind(s.pat.binding);
      return { k: 'let', v, rhs, body: rest() };
    }
    if (s.pat.k === 'pwild') return { k: 'seq', first: lowerExpr(s.e, ctx), rest: rest() };
    return withAtom(s.e, ctx, (scrut) => {
      const { tests, binds } = compilePattern(s.pat, ctx);
      return { k: 'match', scrut, arms: [{ tests, binds, guard: null, body: rest() }] };
    });
  }

  // ---------------------------------------------------------- patterns --
  // Flattens a (nested) pattern into tag tests and bindings, each addressed by
  // a path of field indices from the scrutinee. Tests are emitted in pre-order
  // so a field is only loaded after its parent's constructor has been checked.
  function compilePattern(pat, ctx) {
    const tests = [];
    const binds = [];
    const walk = (p, path) => {
      switch (p.k) {
        case 'pwild':
        case 'punit':
          return;
        case 'pvar':
          binds.push({ v: ctx.bind(p.binding), path });
          return;
        case 'pint':
          tests.push({ k: 'imm', n: imm(p.v).n, path });
          return;
        case 'pbool':
          tests.push({ k: 'imm', n: (p.v ? TRUE_ATOM : FALSE_ATOM).n, path });
          return;
        case 'pstr':
          tests.push({ k: 'str', idx: strAtom(p.v).idx, path });
          return;
        case 'ptuple':
          p.elems.forEach((sub, i) => walk(sub, [...path, i]));
          return;
        case 'pctor': {
          const { ctor } = p;
          const all = ctor.type.ctors;
          const nNullary = all.filter((c) => c.arity === 0).length;
          const nBlock = all.length - nNullary;
          if (ctor.arity === 0) {
            if (all.length > 1) tests.push({ k: 'imm', n: imm(ctor.index).n, path });
          } else {
            if (nNullary > 0) tests.push({ k: 'isblock', path });
            if (nBlock > 1) tests.push({ k: 'tag', tag: ctor.index, path });
          }
          p.args.forEach((sub, i) => walk(sub, [...path, i]));
        }
      }
    };
    walk(pat, []);
    return { tests, binds };
  }

  // --------------------------------------------------------------- run --
  for (const decl of [...checked.preludeFns, ...checked.userFns]) {
    const name = decl.binding.internal;
    funcs.set(name, null);
  }
  for (const decl of [...checked.preludeFns, ...checked.userFns]) {
    const name = decl.binding.internal;
    const ctx = new FnCtx(null, name, null);
    const params = decl.params.map((p) => ctx.bind(p.binding));
    const body = lowerExpr(decl.body, ctx);
    funcs.set(name, { name, params, env: null, vars: ctx.allVars, body, source: decl.origin });
  }

  return { funcs, strings, entry: checked.main.binding.internal };
}

// Functions reachable from the entry point (dead-code elimination, so unused
// prelude functions never reach the binary).
export function reachableFunctions(ir) {
  const seen = new Set();
  const work = [ir.entry];
  const visitAtom = (a) => { if (a?.k === 'sclo') work.push(a.fn); };
  const visit = (e) => {
    if (!e) return;
    switch (e.k) {
      case 'atom': visitAtom(e.a); return;
      case 'let': visit(e.rhs); visit(e.body); return;
      case 'seq': visit(e.first); visit(e.rest); return;
      case 'prim':
      case 'builtin':
      case 'alloc': e.args.forEach(visitAtom); return;
      case 'call': work.push(e.fn); visitAtom(e.env); e.args.forEach(visitAtom); return;
      case 'callc': visitAtom(e.clo); e.args.forEach(visitAtom); return;
      case 'closure': work.push(e.fn); e.captured.forEach(visitAtom); return;
      case 'if': visitAtom(e.c); visit(e.t); visit(e.e); return;
      case 'match':
        visitAtom(e.scrut);
        for (const arm of e.arms) { visit(arm.guard); visit(arm.body); }
    }
  };
  while (work.length) {
    const name = work.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    visit(ir.funcs.get(name).body);
  }
  return [...ir.funcs.values()].filter((f) => seen.has(f.name));
}
