// Lowering: typed syntax tree -> monomorphic IR in A-normal form.
//
// Monomorphization: every polymorphic top-level function is compiled once
// per concrete type it is used at, so each value gets its native
// representation (Int is a 64-bit integer, never boxed) and reference
// counting knows statically which values live on the heap. Trait methods are
// resolved here too: at a concrete type, a method is the impl's function, so
// calls are direct (no dictionaries, no dynamic dispatch).
//
// The IR is a tree. An expression is a chain of `let v = rhs` ending in
// `ret rhs` (the expression's value), with `if` nodes in between; a nested
// expression can itself be a let's right-hand side. Lambdas and local
// functions are lifted to top-level IR functions that take their closure as
// a first `env` parameter. Pattern matches become a chain of arms: an arm's
// tests and guard read the matched value without taking ownership of
// anything (`peek`), so a failed arm leaves nothing to clean up.

import { prune, GENERIC, tcon, tfun, ttuple, row, headOf, substParams, INT, BOOL, STRING, UNIT } from './types.js';

// ------------------------------------------------------------ concrete types --
export function tkey(t) {
  switch (t.k) {
    case 'con': return t.args.length ? `${t.name}<${t.args.map(tkey).join(',')}>` : t.name;
    case 'tuple': return `(${t.elems.map(tkey).join(',')})`;
    case 'fun': return `fn(${t.params.map(tkey).join(',')})->${tkey(t.ret)}`;
    default: throw new Error(`tkey: ${t.k}`);
  }
}
export const valtype = (t) => (t.k === 'con' && t.name === 'Int' ? 'i64' : 'i32');

// options.mutant plants a known bug (see test/fuzz.js).
export function lowerProgram(program, { mutant = null } = {}) {
  const fnsByKey = new Map(program.fns.map((f) => [f.key, f]));
  const out = new Map(); // IR functions by name
  const work = [];
  let tmp = 0;

  // Concrete type under a substitution (generic var -> type); anything left
  // undetermined is irrelevant to the program's behaviour and becomes ().
  function conc(t, S) {
    t = prune(t);
    switch (t.k) {
      case 'var': return S.get(t) ?? UNIT;
      case 'con': return t.args.length ? tcon(t.name, t.args.map((a) => conc(a, S))) : t;
      case 'tuple': return ttuple(t.elems.map((a) => conc(a, S)));
      case 'fun': return tfun(t.params.map((a) => conc(a, S)), conc(t.ret, S), row([]));
      default: throw new Error(t.k);
    }
  }

  function genericVars(t, acc = []) {
    t = prune(t);
    if (t.k === 'var') { if (t.level === GENERIC && !acc.includes(t)) acc.push(t); }
    else if (t.k === 'con') t.args.forEach((a) => genericVars(a, acc));
    else if (t.k === 'tuple') t.elems.forEach((a) => genericVars(a, acc));
    else if (t.k === 'fun') { t.params.forEach((a) => genericVars(a, acc)); genericVars(t.ret, acc); }
    return acc;
  }

  // Binds a scheme's generic variables by matching it against a concrete type.
  function match(scheme, concrete, S) {
    scheme = prune(scheme);
    if (scheme.k === 'var') { if (scheme.level === GENERIC && !S.has(scheme)) S.set(scheme, concrete); return; }
    if (scheme.k === 'con') scheme.args.forEach((a, i) => match(a, concrete.args[i], S));
    else if (scheme.k === 'tuple') scheme.elems.forEach((a, i) => match(a, concrete.elems[i], S));
    else if (scheme.k === 'fun') { scheme.params.forEach((a, i) => match(a, concrete.params[i], S)); match(scheme.ret, concrete.ret, S); }
  }

  // The IR name of a top-level function at a concrete type, queued for lowering.
  function instance(key, useType) {
    const decl = fnsByKey.get(key);
    const S = new Map();
    match(decl.scheme, useType, S);
    const args = genericVars(decl.scheme).map((v) => conc(S.get(v) ?? UNIT, new Map()));
    const name = args.length ? `${key}<${args.map(tkey).join(',')}>` : key;
    if (!out.has(name)) {
      out.set(name, null);
      work.push({ decl, S, name });
    }
    return name;
  }

  // Closure wrappers that let a top-level function, constructor or builtin be used as a value.
  function wrapper(kind, target, ty, extra) {
    const name = `wrap:${kind}:${target}:${tkey(ty)}`;
    if (out.has(name)) return name;
    const params = ty.params.map((p) => ({ v: `a${tmp++}`, ty: p }));
    const args = params.map((p) => ({ k: 'var', v: p.v }));
    let rhs;
    if (kind === 'fn') rhs = { k: 'call', fn: target, args };
    else if (kind === 'ctor') rhs = { k: 'ctor', ty: ty.ret, tag: extra.idx, args };
    else if (kind === 'cmp') { rhs = { k: 'cmp', op: 'three', ty: ty.params[0], args }; registerOrd(ty.params[0]); }
    else if (kind === 'unreachable') rhs = null;
    else rhs = { k: 'builtin', name: target, args, ty: ty.ret, argTys: ty.params };
    const fn = { name, env: true, params: [{ v: 'env', ty: ty }, ...params], ret: ty.ret, body: rhs ? { k: 'ret', rhs } : { k: 'unreachable' }, vars: new Map() };
    fn.params.forEach((p) => fn.vars.set(p.v, p.ty));
    out.set(name, fn);
    return name;
  }

  // A trait method at a concrete type: the impl's function, or for `compare`
  // on a type without an `impl Ord`, the structural comparison.
  function resolveMethod(ref, fty) {
    const self = fty.params[0];
    const impl = program.impls.get(ref.trait)?.get(headOf(self));
    if (impl) return { kind: 'fn', name: instance(impl.keys.get(ref.method), fty) };
    if (ref.trait === 'Ord') return { kind: 'cmp' };
    // Only reachable for a type left undetermined by inference (defaulted to
    // ()), whose values never exist, so the method can never be called.
    return { kind: 'unreachable' };
  }

  // The functions of user `impl Ord`s that structural comparison at type t
  // can reach, by type: comparing a List<Version> calls Version's compare.
  const ordImpls = new Map();
  const ordSeen = new Set();
  function registerOrd(t) {
    const key = tkey(t);
    if (ordSeen.has(key)) return;
    ordSeen.add(key);
    if (t.k === 'tuple') { t.elems.forEach(registerOrd); return; }
    if (t.k !== 'con') return;
    const impl = program.impls.get('Ord')?.get(t.name);
    if (impl) { ordImpls.set(key, instance(impl.keys.get('compare'), tfun([t, t], INT, row([])))); return; }
    t.args.forEach(registerOrd);
    const decl = program.adts.get(t.name);
    if (!decl) return;
    const sub = new Map(decl.params.map((p, i) => [p, t.args[i]]));
    for (const c of decl.ctors) for (const f of c.fieldTypes) registerOrd(substParams(f, sub));
  }

  // ------------------------------------------------------------ functions --
  function lowerFn(decl, S, name) {
    const fn = { name, env: false, params: [], ret: null, vars: new Map(), borrowed: new Set() };
    const ctx = { S, fn, atoms: new Map() };
    const ty = conc(decl.scheme, S);
    fn.params = decl.params.map((p, i) => ({ v: newVar(fn, ty.params[i], `${p.name}`), ty: ty.params[i] }));
    decl.params.forEach((p, i) => ctx.atoms.set(p.id, { k: 'var', v: fn.params[i].v }));
    fn.ret = ty.ret;
    fn.body = lowerTail(decl.body, ctx);
    out.set(name, fn);
  }

  function newVar(fn, ty, hint = 't') {
    const v = `${hint.replace(/[^A-Za-z0-9_]/g, '')}_${tmp++}`;
    fn.vars.set(v, ty);
    return v;
  }

  // Lowers a lambda or local function into a lifted IR function plus a closure value.
  function lowerClosure(node, params, body, ctx, selfId = null) {
    const fnTy = conc(node.ty, ctx.S);
    const captured = freeLocals(node, selfId);
    const name = `lambda${tmp++}:${ctx.fn.name}`;
    const fn = { name, env: true, params: [], ret: fnTy.ret, vars: new Map(), borrowed: new Set(), captures: [] };
    fn.params = [{ v: 'env', ty: fnTy }, ...params.map((p, i) => ({ v: newVar(fn, fnTy.params[i], p.name), ty: fnTy.params[i] }))];
    fn.vars.set('env', fnTy);
    const inner = { S: ctx.S, fn, atoms: new Map() };
    params.forEach((p, i) => inner.atoms.set(p.id, { k: 'var', v: fn.params[i + 1].v }));
    if (selfId !== null) inner.atoms.set(selfId, { k: 'var', v: 'env' });
    // Captured values are loaded from the closure at entry.
    const loads = [];
    captured.forEach((id, i) => {
      const outer = ctx.atoms.get(id);
      const cty = atomType(outer, ctx.fn);
      fn.captures.push(cty);
      const v = newVar(fn, cty, 'cap');
      inner.atoms.set(id, { k: 'var', v });
      loads.push({ v, i, ty: cty });
    });
    let b = lowerTail(body, inner);
    for (let i = loads.length - 1; i >= 0; i--) b = { k: 'let', v: loads[i].v, rhs: { k: 'envfield', i: loads[i].i, ty: loads[i].ty }, body: b };
    fn.body = b;
    out.set(name, fn);
    return { k: 'closure', fn: name, ty: fnTy, captures: captured.map((id) => ctx.atoms.get(id)), captureTys: fn.captures };
  }

  function atomType(a, fn) {
    switch (a.k) {
      case 'var': return fn.vars.get(a.v);
      case 'int': return INT;
      case 'bool': return BOOL;
      case 'unit': return UNIT;
      case 'str': return STRING;
      default: throw new Error(a.k);
    }
  }

  // Local variable ids referenced inside a lambda but bound outside it.
  function freeLocals(node, selfId) {
    const bound = new Set();
    const used = [];
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (n.k === 'var' && n.ref?.k === 'local') { if (!used.includes(n.ref.id)) used.push(n.ref.id); return; }
      if (n.id !== undefined && (n.k === 'pvar' || n.k === 'fn' || n.name !== undefined && n.ann !== undefined)) bound.add(n.id);
      for (const [key, v] of Object.entries(n)) {
        if (key === 'ty' || key === 'span' || key === 'ref' || key === 'ctor' || key === 'ctorInfo' || key === 'inst' || key === 'scheme' || key === 'ctx') continue;
        if (v && typeof v === 'object') visit(v);
      }
    };
    if (node.k === 'lambda') { node.params.forEach((p) => bound.add(p.id)); visit(node.body); }
    else { node.params.forEach((p) => bound.add(p.id)); visit(node.body); }
    return used.filter((id) => !bound.has(id) && id !== selfId);
  }

  // ---------------------------------------------------------- expressions --
  const ret = (a) => ({ k: 'ret', rhs: { k: 'atom', a } });

  // Lowers e in tail position: the result is an IR expression ending in `ret`.
  function lowerTail(e, ctx) {
    switch (e.k) {
      case 'block': return lowerBlock(e, 0, ctx, true);
      case 'if': return lowerValue(e.cond, ctx, (c) => ({ k: 'if', c, t: lowerTail(e.then, ctx), e: e.else ? lowerTail(e.else, ctx) : ret({ k: 'unit' }) }));
      case 'match': return lowerValue(e.scrut, ctx, (x) => lowerMatch(e, x, ctx));
      case 'call': return lowerCall(e, ctx, (rhs) => ({ k: 'ret', rhs }));
      default: return lowerValue(e, ctx, ret);
    }
  }

  // Binds an rhs to a fresh variable and continues with it.
  function bind(rhs, ty, ctx, k, hint) {
    const v = newVar(ctx.fn, ty, hint);
    if (rhs.k === 'peek') ctx.fn.borrowed.add(v);
    return { k: 'let', v, rhs, body: k({ k: 'var', v }) };
  }

  function lowerValues(es, ctx, k, acc = []) {
    if (acc.length === es.length) return k(acc);
    return lowerValue(es[acc.length], ctx, (a) => lowerValues(es, ctx, k, [...acc, a]));
  }

  // Lowers e to an atom and continues with k(atom).
  function lowerValue(e, ctx, k) {
    const ty = () => conc(e.ty, ctx.S);
    switch (e.k) {
      case 'int': return k({ k: 'int', n: e.v });
      case 'bool': return k({ k: 'bool', b: e.v });
      case 'unit': return k({ k: 'unit' });
      case 'str': return k({ k: 'str', s: e.v });
      case 'var': {
        if (e.ref.k === 'local') return k(ctx.atoms.get(e.ref.id));
        const t = ty();
        if (e.ref.k === 'method') {
          const m = resolveMethod(e.ref, t);
          const w = m.kind === 'fn' ? wrapper('fn', m.name, t) : wrapper(m.kind, `${e.ref.trait}.${e.ref.method}`, t);
          return bind({ k: 'staticfn', fn: w, ty: t }, t, ctx, k);
        }
        const target = e.ref.k === 'global' ? instance(e.ref.key, t) : e.ref.name;
        return bind({ k: 'staticfn', fn: wrapper(e.ref.k === 'global' ? 'fn' : 'builtin', target, t), ty: t }, t, ctx, k);
      }
      case 'ctor': {
        const t = ty();
        if (e.args === null && e.ctor.fieldTypes.length) return bind({ k: 'staticfn', fn: wrapper('ctor', e.ctor.key, t, e.ctor), ty: t }, t, ctx, k);
        return lowerValues(e.args ?? [], ctx, (args) => bind({ k: 'ctor', ty: t, tag: e.ctor.idx, args }, t, ctx, k));
      }
      case 'call': return lowerCall(e, ctx, (rhs) => bind(rhs, ty(), ctx, k));
      case 'tuple': return lowerValues(e.elems, ctx, (args) => bind({ k: 'tuple', ty: ty(), args }, ty(), ctx, k));
      case 'unop':
        return lowerValue(e.e, ctx, (a) => bind({ k: 'prim', op: e.op === '-' ? 'neg' : 'not', args: [a] }, ty(), ctx, k));
      case 'binop': return lowerBinop(e, ctx, k);
      case 'lambda': return bind(lowerClosure(e, e.params, e.body, ctx), ty(), ctx, k, 'clo');
      case 'block': case 'if': case 'match':
        return bind({ k: 'expr', e: lowerTail(e, ctx) }, ty(), ctx, k);
      default: throw new Error(`lower: ${e.k}`);
    }
  }

  function lowerCall(e, ctx, k) {
    const f = e.fn;
    if (f.k === 'var' && f.ref.k === 'method') {
      const fty = conc(f.ty, ctx.S);
      const m = resolveMethod(f.ref, fty);
      return lowerValues(e.args, ctx, (args) => {
        if (m.kind === 'fn') return k({ k: 'call', fn: m.name, args });
        if (m.kind === 'cmp') { registerOrd(fty.params[0]); return k({ k: 'cmp', op: 'three', ty: fty.params[0], args }); }
        return { k: 'unreachable' };
      });
    }
    if (f.k === 'var' && f.ref.k === 'global') {
      const name = instance(f.ref.key, conc(f.ty, ctx.S));
      return lowerValues(e.args, ctx, (args) => k({ k: 'call', fn: name, args }));
    }
    if (f.k === 'var' && f.ref.k === 'builtin') {
      const fty = conc(f.ty, ctx.S);
      return lowerValues(e.args, ctx, (args) => k({ k: 'builtin', name: f.ref.name, args, ty: fty.ret, argTys: fty.params }));
    }
    return lowerValue(f, ctx, (fa) => lowerValues(e.args, ctx, (args) => k({ k: 'callc', f: fa, args })));
  }

  function lowerBinop(e, ctx, k) {
    const ty = conc(e.ty, ctx.S);
    if (e.op === '&&' || e.op === '||') {
      // l && r  ==  if l { r } else { false }
      return lowerValue(e.l, ctx, (l) => {
        const rhsTail = lowerTail(e.r, ctx);
        const node = e.op === '&&' ? { k: 'if', c: l, t: rhsTail, e: ret({ k: 'bool', b: false }) } : { k: 'if', c: l, t: ret({ k: 'bool', b: true }), e: rhsTail };
        return bind({ k: 'expr', e: node }, BOOL, ctx, k);
      });
    }
    return lowerValue(e.l, ctx, (l) => lowerValue(e.r, ctx, (r) => {
      const opTy = conc(e.l.ty, ctx.S);
      const OPS = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'rem' };
      if (OPS[e.op]) return bind({ k: 'prim', op: OPS[e.op], args: [l, r] }, ty, ctx, k);
      if (e.op === '++') return bind({ k: 'builtin', name: 'concat', args: [l, r], ty: STRING, argTys: [STRING, STRING] }, ty, ctx, k);
      const CMP = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
      const native = opTy.k === 'con' && ['Int', 'Bool', 'Unit'].includes(opTy.name);
      if (!native) registerOrd(opTy);
      return bind(native ? { k: 'prim', op: CMP[e.op], args: [l, r], ty: opTy } : { k: 'cmp', op: CMP[e.op], ty: opTy, args: [l, r] }, BOOL, ctx, k);
    }));
  }

  function lowerBlock(e, i, ctx, tail) {
    if (i === e.stmts.length) return e.result ? lowerTail(e.result, ctx) : ret({ k: 'unit' });
    const st = e.stmts[i];
    const rest = () => lowerBlock(e, i + 1, ctx, tail);
    if (st.k === 'expr') return lowerValue(st.e, ctx, () => rest());
    if (st.k === 'fndecl') {
      const f = st.fn;
      const clo = lowerClosure(f, f.params, f.body, ctx, f.id);
      const t = conc(f.ty, ctx.S);
      return bind(clo, t, ctx, (a) => { ctx.atoms.set(f.id, a); return rest(); }, f.name);
    }
    return lowerValue(st.value, ctx, (a) => bindPattern(st.pat, a, ctx, rest));
  }

  // Binds an irrefutable pattern's variables (owned projections) and continues.
  function bindPattern(p, a, ctx, k) {
    const binds = [];
    collectBinds(p, [], binds);
    if (!binds.length) return k();
    const go = (j) => {
      if (j === binds.length) return k();
      const { id, path, ty } = binds[j];
      const t = conc(ty, ctx.S);
      if (!path.length) { ctx.atoms.set(id, a); return go(j + 1); }
      const v = newVar(ctx.fn, t, 'p');
      ctx.atoms.set(id, { k: 'var', v });
      return { k: 'let', v, rhs: { k: 'field', x: a, path, ty: t, objTy: conc(p.ty, ctx.S) }, body: go(j + 1) };
    };
    return go(0);
  }

  function collectBinds(p, path, out) {
    switch (p.k) {
      case 'pvar': out.push({ id: p.id, path, ty: p.ty }); break;
      case 'ptuple': p.elems.forEach((q, i) => collectBinds(q, [...path, i], out)); break;
      case 'pctor': p.args.forEach((q, i) => collectBinds(q, [...path, i], out)); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- match --
  function lowerMatch(e, x, ctx) {
    const scrutTy = conc(e.scrut.ty, ctx.S);
    const arms = e.arms;
    const go = (i) => {
      if (i === arms.length) return { k: 'unreachable' };
      const arm = arms[i];
      const tests = [];
      collectTests(arm.pat, [], tests, ctx);
      const binds = [];
      collectBinds(arm.pat, [], binds);
      // The arm's condition (tests, then the guard) reads x through borrowed peeks.
      let cond = null;
      if (tests.length || arm.guard) {
        const guardCtx = { ...ctx, atoms: new Map(ctx.atoms) };
        const peekBinds = (k) => {
          const step = (j) => {
            if (j === binds.length) return k();
            const { id, path, ty } = binds[j];
            if (!path.length) { guardCtx.atoms.set(id, x); return step(j + 1); }
            const t = conc(ty, ctx.S);
            return bind({ k: 'peek', x, path, ty: t, objTy: scrutTy }, t, guardCtx, (a) => { guardCtx.atoms.set(id, a); return step(j + 1); }, 'g');
          };
          return step(0);
        };
        const testChain = (j) => {
          if (j === tests.length) return arm.guard ? peekBinds(() => lowerTail(arm.guard, guardCtx)) : ret({ k: 'bool', b: true });
          return bind(tests[j].rhs, BOOL, ctx, (c) => ({ k: 'if', c, t: testChain(j + 1), e: ret({ k: 'bool', b: false }) }));
        };
        cond = testChain(0);
      }
      const body = () => {
        const armCtx = { ...ctx, atoms: new Map(ctx.atoms) };
        const step = (j) => {
          if (j === binds.length) return lowerTail(arm.body, armCtx);
          const { id, path, ty } = binds[j];
          if (!path.length) { armCtx.atoms.set(id, x); return step(j + 1); }
          const t = conc(mutant === 'lower-bind-type' ? binds[0].ty : ty, ctx.S);
          const v = newVar(ctx.fn, t, 'b');
          armCtx.atoms.set(id, { k: 'var', v });
          return { k: 'let', v, rhs: { k: 'field', x, path, ty: t, objTy: scrutTy }, body: step(j + 1) };
        };
        return step(0);
      };
      // The checker proved the match exhaustive, so the last unguarded arm needs no test.
      if (!cond || (i === arms.length - 1 && !arm.guard)) return body();
      if (tests.length === 1 && !arm.guard) return bind(tests[0].rhs, BOOL, ctx, (c) => ({ k: 'if', c, t: body(), e: go(i + 1) }));
      return bind({ k: 'expr', e: cond }, BOOL, ctx, (c) => ({ k: 'if', c, t: body(), e: go(i + 1) }));
    };
    return go(0);

    function collectTests(p, path, tests, c) {
      const pty = conc(p.ty, c.S);
      switch (p.k) {
        case 'pint': tests.push({ rhs: { k: 'testlit', x, path, objTy: scrutTy, ty: pty, lit: { k: 'int', n: p.v } } }); break;
        case 'pstr': tests.push({ rhs: { k: 'testlit', x, path, objTy: scrutTy, ty: pty, lit: { k: 'str', s: p.v } } }); break;
        case 'pbool': tests.push({ rhs: { k: 'testlit', x, path, objTy: scrutTy, ty: pty, lit: { k: 'bool', b: p.v } } }); break;
        case 'ptuple': p.elems.forEach((q, i) => collectTests(q, [...path, i], tests, c)); break;
        case 'pctor': {
          const decl = program.adts.get(p.ctorInfo.adt);
          if (decl.ctors.length > 1) tests.push({ rhs: { k: 'testtag', x, path, objTy: scrutTy, ty: pty, tag: p.ctorInfo.idx } });
          p.args.forEach((q, i) => collectTests(q, [...path, i], tests, c));
          break;
        }
        default: break;
      }
    }
  }

  // ------------------------------------------------------------------ drive --
  const mainName = instance(program.main.key, conc(program.main.scheme, new Map()));
  while (work.length) {
    const { decl, S, name } = work.shift();
    lowerFn(decl, S, name);
  }
  return { fns: [...out.values()], main: mainName, adts: program.adts, ordImpls };
}
