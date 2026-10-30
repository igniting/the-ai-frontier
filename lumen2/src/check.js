// Type and effect inference.
//
// Hindley–Milner with row-polymorphic effects. Every expression is checked
// against an *ambient* effect row: the effects the enclosing function may
// perform. Calling a function unifies the callee's effect row with the
// ambient row, so effects flow outwards; `print` adds `io`, while `/`, `%`,
// array indexing and `panic` add `fail`. An effect annotation on a function
// (`! {}`, `! io`, `! {io, fail}`) closes its row, so an undeclared effect is
// a compile error at the call that causes it.
//
// Top-level functions are polymorphic, in types and in effects; they are
// checked in dependency order (strongly connected components of the call
// graph) and generalized after each component. Local bindings and local
// functions are monomorphic, which keeps monomorphization in the back end
// simple.

import { parse } from './parser.js';
import { PRELUDE } from './prelude.js';
import { LumenError } from './diagnostics.js';
import { makeExhaustiveness } from './exhaust.js';
import {
  GENERIC, newVar, newRowVar, tcon, tfun, ttuple, row, prune, pruneRow, makeUnifier, UnifyError, EffectError,
  generalize, instantiate, openEffect, substParams, TypePrinter, INT, BOOL, STRING, UNIT, LABELS,
} from './types.js';

// ---------------------------------------------------------------- builtins --
// Each builtin: its type (with generic variables) and how the back end treats
// its arguments (consumed or borrowed), used by reference counting.
function builtinTable() {
  const a = () => { const v = newVar(GENERIC); return v; };
  const fn = (params, ret, labels = []) => tfun(params, ret, row(labels));
  const t = {};
  const A = a();
  t.print = fn([STRING], UNIT, ['io']);
  t.println = fn([STRING], UNIT, ['io']);
  t.read_input = fn([], STRING, ['io']);
  t.int_to_string = fn([INT], STRING);
  t.string_length = fn([STRING], INT);
  t.substring = fn([STRING, INT, INT], STRING);
  t.char_code_at = fn([STRING, INT], INT, ['fail']);
  t.char_from_code = fn([INT], STRING);
  t.panic = fn([STRING], A, ['fail']);
  const B = a();
  t.array_make = fn([INT, B], tcon('Array', [B]), ['fail']);
  const C = a();
  t.array_empty = fn([], tcon('Array', [C]));
  const D = a();
  t.array_get = fn([tcon('Array', [D]), INT], D, ['fail']);
  const E = a();
  t.array_set = fn([tcon('Array', [E]), INT, E], tcon('Array', [E]), ['fail']);
  const F = a();
  t.array_length = fn([tcon('Array', [F])], INT);
  const G = a();
  t.array_push = fn([tcon('Array', [G]), G], tcon('Array', [G]));
  return t;
}
export const BUILTIN_NAMES = Object.keys(builtinTable());

const EFFECT_WORDS = { io: 'perform io', fail: 'fail' };

// ------------------------------------------------------------------ check --
export function check(source) {
  const preludeAst = parse(PRELUDE);
  let userAst;
  userAst = parse(source);
  const builtins = builtinTable();

  const adts = new Map(); // name -> { name, params, ctors: [{ name, key, idx, fieldTypes, adt }] }
  const ctors = { prelude: new Map(), user: new Map() };
  const BUILTIN_TYPES = new Map([['Int', 0], ['Bool', 0], ['String', 0], ['Unit', 0], ['Array', 1]]);
  const { unify, unifyRows, requireCmp } = makeUnifier(adts);
  const exhaust = makeExhaustiveness(adts);
  const warnings = [];
  let nextId = 0;
  const freshId = () => nextId++;

  const show = (t) => new TypePrinter().show(t);

  // --------------------------------------------------------- declarations --
  function declareTypes(decls, scope) {
    for (const d of decls) {
      if (adts.has(d.name) || BUILTIN_TYPES.has(d.name)) throw new LumenError(`type \`${d.name}\` is already defined`, d.nameSpan);
      adts.set(d.name, { name: d.name, params: d.params, ctors: null, span: d.span });
    }
    for (const d of decls) {
      const decl = adts.get(d.name);
      decl.ctors = d.ctors.map((c, idx) => {
        if (ctors.prelude.has(c.name) || ctors.user.has(c.name)) throw new LumenError(`constructor \`${c.name}\` is already defined`, c.span);
        const info = { name: c.name, key: `${d.name}.${c.name}`, idx, adt: d.name, fieldTypes: c.fields.map((f) => declType(f, d.params)) };
        ctors[scope].set(c.name, info);
        return info;
      });
    }
  }

  function declType(te, params) {
    switch (te.k) {
      case 'tvar':
        if (!params.includes(te.name)) throw new LumenError(`unknown type variable \`${te.name}\` (declare it as a parameter of the type)`, te.span);
        return { k: 'param', name: te.name };
      case 'tcon': return tcon(checkTypeName(te), te.args.map((a) => declType(a, params)));
      case 'ttuple': return ttuple(te.elems.map((a) => declType(a, params)));
      case 'tfun':
        if (te.eff?.tail) throw new LumenError('effect variables are not allowed in type declarations', te.eff.span);
        return tfun(te.params.map((a) => declType(a, params)), declType(te.ret, params), row(te.eff?.labels ?? []));
      default: throw new Error(te.k);
    }
  }

  function checkTypeName(te) {
    const arity = BUILTIN_TYPES.has(te.name) ? BUILTIN_TYPES.get(te.name) : adts.get(te.name)?.params.length;
    if (arity === undefined) throw new LumenError(`unknown type \`${te.name}\``, te.span);
    if (arity !== te.args.length) throw new LumenError(`type \`${te.name}\` takes ${arity} type argument${arity === 1 ? '' : 's'}, found ${te.args.length}`, te.span);
    return te.name;
  }

  checkEffectLabels(preludeAst); checkEffectLabels(userAst);
  declareTypes(preludeAst.types, 'prelude');
  declareTypes(userAst.types, 'user');

  // Type annotations inside a function: lowercase names are type variables
  // shared across the whole declaration.
  function sigType(te, ctx) {
    switch (te.k) {
      case 'tvar':
        if (!ctx.tvars.has(te.name)) ctx.tvars.set(te.name, newVar(ctx.level));
        return ctx.tvars.get(te.name);
      case 'tcon': return tcon(checkTypeName(te), te.args.map((a) => sigType(a, ctx)));
      case 'ttuple': return ttuple(te.elems.map((a) => sigType(a, ctx)));
      case 'tfun': return tfun(te.params.map((a) => sigType(a, ctx)), sigType(te.ret, ctx), sigEffect(te.eff, ctx));
      default: throw new Error(te.k);
    }
  }
  function sigEffect(ee, ctx) {
    if (!ee) return row([]);
    let tail = null;
    if (ee.tail) {
      if (!ctx.rvars.has(ee.tail)) ctx.rvars.set(ee.tail, newRowVar(ctx.level));
      tail = ctx.rvars.get(ee.tail);
    }
    return row(ee.labels, tail);
  }

  // ------------------------------------------------------- functions & SCC --
  const globals = { prelude: new Map(), user: new Map() };
  const allFns = [];
  for (const f of preludeAst.fns) {
    if (globals.prelude.has(f.name)) throw new LumenError(`function \`${f.name}\` is defined twice`, f.nameSpan);
    f.key = f.name; f.scope = 'prelude';
    globals.prelude.set(f.name, f);
    allFns.push(f);
  }
  for (const f of userAst.fns) {
    if (globals.user.has(f.name)) throw new LumenError(`function \`${f.name}\` is defined twice`, f.nameSpan);
    f.key = globals.prelude.has(f.name) || f.name in builtins ? `${f.name}'` : f.name;
    f.scope = 'user';
    globals.user.set(f.name, f);
    allFns.push(f);
  }
  const main = globals.user.get('main');
  if (!main) throw new LumenError('the program has no `main` function', { s: 0, e: 0 });
  if (main.params.length) throw new LumenError('`main` takes no parameters', main.nameSpan);

  const resolveGlobal = (name, scope) => (scope === 'user' && globals.user.get(name)) || globals.prelude.get(name) || null;

  // Call graph over top-level functions (over-approximated by names used).
  function namesUsed(node, out = new Set()) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => namesUsed(n, out)); return out; }
    if (node.k === 'var') out.add(node.name);
    for (const [key, v] of Object.entries(node)) if (key !== 'span' && key !== 'ty' && v && typeof v === 'object') namesUsed(v, out);
    return out;
  }
  const edges = new Map(allFns.map((f) => [f, [...namesUsed(f.body)].map((n) => resolveGlobal(n, f.scope)).filter(Boolean)]));
  const sccs = tarjan(allFns, (f) => edges.get(f));

  // ----------------------------------------------------------- inference --
  const deferred = []; // exhaustiveness checks run once all types are known

  function unifyAt(expected, found, span, what = null) {
    try { unify(expected, found); } catch (e) {
      if (!(e instanceof UnifyError)) throw e;
      const p = new TypePrinter();
      if (e instanceof EffectError) {
        throw new LumenError(`${what ?? 'type mismatch'}: expected ${p.show(expected)}, found ${p.show(found)}`, span,
          `the two differ in their effects (${e.labels.join(', ')})`);
      }
      if (e.message === 'functions cannot be compared') throw new LumenError('functions cannot be compared', span, 'equality and ordering need a type without functions in it');
      if (e.message === 'infinite type') throw new LumenError(`${what ?? 'type mismatch'}: this would need an infinite type`, span);
      throw new LumenError(`${what ? `${what}: ` : ''}expected ${p.show(expected)}, found ${p.show(found)}`, span);
    }
  }

  // The current function may perform the effects in `labels` (because of the expression at `span`).
  function perform(labels, ctx, span, cause) {
    try { unifyRows(row(labels, newRowVar(ctx.level)), ctx.eff); } catch (e) {
      if (!(e instanceof UnifyError)) throw e;
      throw effectViolation(e.labels ?? labels, ctx, span, cause);
    }
  }
  function effectViolation(labels, ctx, span, cause) {
    const words = labels.map((l) => EFFECT_WORDS[l] ?? l).join(' and ');
    return new LumenError(`${cause} can ${words}, but ${ctx.owner} is declared without \`${labels.join(', ')}\``, span,
      `add the effect to the signature (for example \`! {${[...new Set([...pruneRow(ctx.eff).labels, ...labels])].sort().join(', ')}}\`), or remove the cause`);
  }

  function lookup(name, ctx) {
    for (let s = ctx.scope; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
    const g = resolveGlobal(name, ctx.scopeName);
    if (g) return { k: 'global', fn: g };
    if (name in builtins) return { k: 'builtin', name };
    return null;
  }

  function bindLocal(ctx, name, ty, span) {
    const b = { k: 'local', id: freshId(), name, ty, span };
    if (name !== '_') ctx.scope.vars.set(name, b);
    return b;
  }

  function infer(e, ctx) {
    const t = inferInner(e, ctx);
    e.ty = t;
    return t;
  }

  function inferInner(e, ctx) {
    switch (e.k) {
      case 'int': return INT;
      case 'str': return STRING;
      case 'bool': return BOOL;
      case 'unit': return UNIT;
      case 'var': {
        const b = lookup(e.name, ctx);
        if (!b) throw new LumenError(`unknown variable \`${e.name}\``, e.span);
        if (b.k === 'local') { e.ref = { k: 'local', id: b.id }; return openEffect(b.ty, ctx.level); }
        const inst = new Map();
        if (b.k === 'global') {
          e.ref = { k: 'global', key: b.fn.key };
          if (!b.fn.scheme) {
            // A call inside the function's own component: monomorphic use of its type.
            e.inst = inst;
            return openEffect(b.fn.ty, ctx.level);
          }
          const ty = instantiate(b.fn.scheme, ctx.level, inst);
          e.inst = inst;
          return openEffect(ty, ctx.level);
        }
        e.ref = { k: 'builtin', name: b.name };
        const ty = instantiate(builtins[b.name], ctx.level, inst);
        e.inst = inst;
        return openEffect(ty, ctx.level);
      }
      case 'ctor': {
        const info = ctorInfo(e.name, e.list, ctx, e.span);
        e.ctor = info;
        const decl = adts.get(info.adt);
        const sub = new Map(decl.params.map((p) => [p, newVar(ctx.level)]));
        const result = tcon(decl.name, decl.params.map((p) => sub.get(p)));
        const fields = info.fieldTypes.map((f) => substParams(f, sub));
        if (e.args === null) {
          if (!fields.length) return result;
          return tfun(fields, result, row([], newRowVar(ctx.level)));
        }
        if (e.args.length !== fields.length) throw new LumenError(`constructor \`${e.name}\` takes ${fields.length} argument${fields.length === 1 ? '' : 's'}, found ${e.args.length}`, e.span);
        e.args.forEach((a, i) => unifyAt(fields[i], infer(a, ctx), a.span, `argument ${i + 1} of \`${e.name}\``));
        return result;
      }
      case 'call': {
        const fnTy = openEffect(infer(e.fn, ctx), ctx.level);
        const argTys = e.args.map((a) => infer(a, ctx));
        const f = prune(fnTy);
        const what = e.fn.k === 'var' ? `\`${e.fn.name}\`` : 'this function';
        if (f.k === 'fun') {
          if (f.params.length !== argTys.length) throw new LumenError(`${what} takes ${f.params.length} argument${f.params.length === 1 ? '' : 's'}, found ${argTys.length}`, e.span);
          argTys.forEach((a, i) => unifyAt(f.params[i], a, e.args[i].span, `argument ${i + 1} of ${what}`));
          callEffects(f.eff, ctx, e.span, `calling ${what}`);
          return f.ret;
        }
        if (f.k !== 'var') throw new LumenError(`${what} is not a function (its type is ${show(f)})`, e.fn.span);
        const ret = newVar(ctx.level);
        unifyAt(fnTy, tfun(argTys, ret, ctx.eff), e.span);
        return ret;
      }
      case 'binop': return inferBinop(e, ctx);
      case 'unop': {
        const t = infer(e.e, ctx);
        if (e.op === '-') { unifyAt(INT, t, e.e.span, 'operand of `-`'); return INT; }
        unifyAt(BOOL, t, e.e.span, 'operand of `!`');
        return BOOL;
      }
      case 'lambda': {
        const inner = { ...ctx, scope: { vars: new Map(), parent: ctx.scope }, eff: row([], newRowVar(ctx.level)), owner: 'this function' };
        const params = e.params.map((p) => {
          const ty = p.ann ? sigType(p.ann, ctx) : newVar(ctx.level);
          const b = bindLocal(inner, p.name, ty, p.span);
          p.id = b.id; p.ty = ty;
          return ty;
        });
        const body = infer(e.body, inner);
        return tfun(params, body, inner.eff);
      }
      case 'block': {
        const inner = { ...ctx, scope: { vars: new Map(), parent: ctx.scope } };
        for (const st of e.stmts) {
          if (st.k === 'let') {
            const vt = infer(st.value, inner);
            if (st.ann) unifyAt(sigType(st.ann, ctx), vt, st.value.span, 'let binding');
            checkPattern(st.pat, vt, inner);
            deferred.push(() => {
              const r = exhaust.checkMatch(vt, [{ pat: st.pat }]);
              if (r.missing) throw new LumenError(`this pattern can fail to match: \`${r.missing}\` is not covered`, st.pat.span, 'use `match` for patterns that can fail');
            });
          } else if (st.k === 'expr') infer(st.e, inner);
          else inferLocalFn(st.fn, inner);
        }
        return e.result ? infer(e.result, inner) : UNIT;
      }
      case 'if': {
        unifyAt(BOOL, infer(e.cond, ctx), e.cond.span, 'condition of `if`');
        const t = infer(e.then, ctx);
        if (!e.else) { unifyAt(UNIT, t, e.then.span, 'an `if` without `else` must have type ()'); return UNIT; }
        unifyAt(t, infer(e.else, ctx), e.else.span, '`if` branches differ');
        return t;
      }
      case 'match': {
        const st = infer(e.scrut, ctx);
        const result = newVar(ctx.level);
        for (const arm of e.arms) {
          const inner = { ...ctx, scope: { vars: new Map(), parent: ctx.scope } };
          checkPattern(arm.pat, st, inner);
          if (arm.guard) unifyAt(BOOL, infer(arm.guard, inner), arm.guard.span, 'match guard');
          unifyAt(result, infer(arm.body, inner), arm.body.span, '`match` arms differ');
        }
        deferred.push(() => {
          const r = exhaust.checkMatch(st, e.arms);
          if (r.missing) throw new LumenError(`non-exhaustive match: \`${r.missing}\` is not covered`, e.scrut.span, 'add an arm for it, or a wildcard `_ ->` arm');
          for (const i of r.redundant) warnings.push(new LumenError('this arm can never match', e.arms[i].pat.span));
        });
        return result;
      }
      case 'tuple': return ttuple(e.elems.map((x) => infer(x, ctx)));
      default: throw new Error(`infer: ${e.k}`);
    }
  }

  function callEffects(eff, ctx, span, cause) {
    try { unifyRows(eff, ctx.eff); } catch (err) {
      if (!(err instanceof UnifyError)) throw err;
      throw effectViolation(err.labels ?? [], ctx, span, cause);
    }
  }

  function inferBinop(e, ctx) {
    const l = infer(e.l, ctx);
    const r = infer(e.r, ctx);
    switch (e.op) {
      case '+': case '-': case '*':
        unifyAt(INT, l, e.l.span, `left operand of \`${e.op}\``); unifyAt(INT, r, e.r.span, `right operand of \`${e.op}\``);
        return INT;
      case '/': case '%':
        unifyAt(INT, l, e.l.span, `left operand of \`${e.op}\``); unifyAt(INT, r, e.r.span, `right operand of \`${e.op}\``);
        perform(['fail'], ctx, e.span, `\`${e.op}\` (division by zero)`);
        return INT;
      case '&&': case '||':
        unifyAt(BOOL, l, e.l.span, `left operand of \`${e.op}\``); unifyAt(BOOL, r, e.r.span, `right operand of \`${e.op}\``);
        return BOOL;
      case '++':
        unifyAt(STRING, l, e.l.span, '`++` joins Strings'); unifyAt(STRING, r, e.r.span, '`++` joins Strings');
        return STRING;
      default: // comparisons
        unifyAt(l, r, e.r.span, `both sides of \`${e.op}\` must have the same type`);
        try { requireCmp(l); } catch (err) {
          if (!(err instanceof UnifyError)) throw err;
          throw new LumenError(`values of type ${show(l)} cannot be compared`, e.span, 'equality and ordering need a type without functions in it');
        }
        return BOOL;
    }
  }

  function ctorInfo(name, list, ctx, span) {
    const info = list || ctx.scopeName === 'prelude' ? ctors.prelude.get(name) : ctors.user.get(name) ?? ctors.prelude.get(name);
    if (!info) throw new LumenError(`unknown constructor \`${name}\``, span);
    return info;
  }

  function checkPattern(p, t, ctx, seen = new Set()) {
    p.ty = t;
    switch (p.k) {
      case 'pwild': return;
      case 'pvar': {
        if (seen.has(p.name)) throw new LumenError(`\`${p.name}\` is bound twice in this pattern`, p.span);
        seen.add(p.name);
        p.id = bindLocal(ctx, p.name, t, p.span).id;
        return;
      }
      case 'pint': return unifyAt(t, INT, p.span, 'pattern');
      case 'pstr': return unifyAt(t, STRING, p.span, 'pattern');
      case 'pbool': return unifyAt(t, BOOL, p.span, 'pattern');
      case 'punit': return unifyAt(t, UNIT, p.span, 'pattern');
      case 'ptuple': {
        const elems = p.elems.map(() => newVar(ctx.level));
        unifyAt(t, ttuple(elems), p.span, 'pattern');
        p.elems.forEach((q, i) => checkPattern(q, elems[i], ctx, seen));
        return;
      }
      case 'pctor': {
        const info = ctorInfo(p.name, p.list, ctx, p.span);
        p.ctorInfo = info;
        const decl = adts.get(info.adt);
        const sub = new Map(decl.params.map((q) => [q, newVar(ctx.level)]));
        unifyAt(t, tcon(decl.name, decl.params.map((q) => sub.get(q))), p.span, 'pattern');
        if (p.args.length !== info.fieldTypes.length) throw new LumenError(`constructor \`${p.name}\` has ${info.fieldTypes.length} field${info.fieldTypes.length === 1 ? '' : 's'}, found ${p.args.length}`, p.span);
        p.args.forEach((q, i) => checkPattern(q, substParams(info.fieldTypes[i], sub), ctx, seen));
        return;
      }
      default: throw new Error(p.k);
    }
  }

  // A local function: monomorphic, may call itself.
  function inferLocalFn(f, ctx) {
    const self = bindLocal(ctx, f.name, newVar(ctx.level), f.nameSpan);
    f.id = self.id;
    const ty = fnType(f, ctx, `\`${f.name}\``);
    unifyAt(self.ty, ty, f.nameSpan);
    f.ty = self.ty;
  }

  // Infers a function declaration's type in its own scope and ambient effect.
  function fnType(f, ctx, owner) {
    const inner = { ...ctx, scope: { vars: new Map(), parent: ctx.scope }, owner };
    inner.eff = f.eff ? sigEffect(f.eff, ctx) : row([], newRowVar(ctx.level));
    const params = f.params.map((p) => {
      const ty = p.ann ? sigType(p.ann, ctx) : newVar(ctx.level);
      p.id = bindLocal(inner, p.name, ty, p.span).id;
      p.ty = ty;
      return ty;
    });
    const body = infer(f.body, inner);
    if (f.ret) unifyAt(sigType(f.ret, ctx), body, f.body.result?.span ?? f.body.span, `\`${f.name}\` returns`);
    return tfun(params, body, inner.eff);
  }

  for (const comp of sccs) {
    const level = 1;
    for (const f of comp) {
      f.ctx = { level, tvars: new Map(), rvars: new Map(), scope: null, scopeName: f.scope, owner: `\`${f.name}\`` };
      f.ty = newVar(level);
    }
    for (const f of comp) unifyAt(f.ty, fnType(f, f.ctx, `\`${f.name}\``), f.nameSpan);
    for (const f of comp) { generalize(f.ty, 0); f.scheme = f.ty; }
  }
  // `main` may perform any effect.
  for (const run of deferred) run();

  const printer = (f) => new TypePrinter().signature(f.scheme);
  const signatures = userAst.fns.map((f) => ({ name: f.name, type: printer(f), span: f.nameSpan }));
  return {
    adts, fns: allFns, main, builtins, signatures, warnings,
    preludeFns: preludeAst.fns, userFns: userAst.fns,
  };
}

function checkEffectLabels(ast) {
  const visit = (te) => {
    if (!te || typeof te !== 'object') return;
    if (Array.isArray(te)) { te.forEach(visit); return; }
    if (te.labels) for (const l of te.labels) if (!LABELS.includes(l)) throw new LumenError(`unknown effect \`${l}\` (the effects are io and fail)`, te.span);
    for (const [k, v] of Object.entries(te)) if (k !== 'span' && v && typeof v === 'object') visit(v);
  };
  visit(ast);
}

// Tarjan's strongly connected components, in dependency order (callees first).
function tarjan(nodes, succ) {
  let index = 0;
  const stack = [], onStack = new Set(), idx = new Map(), low = new Map(), out = [];
  const visit = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of succ(v)) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      out.push(comp);
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  return out;
}
