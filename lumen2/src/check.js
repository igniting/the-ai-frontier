// The reference front end: type and effect inference, for the reference
// interpreter (interp.js), which walks the typed tree it makes. The compiler
// (compiler/*.lm) has its own front end, which is authoritative: it reports
// the errors, and proves the refinements whose results are passed in here.
//
// Type and effect inference.
//
// Hindley–Milner with row-polymorphic effects. Every expression is checked
// against an *ambient* effect row: the effects the enclosing function may
// perform. Calling a function unifies the callee's effect row with the
// ambient row, so effects flow outwards; `print` adds `output`, `read_input`
// adds `input`, and `/`, `%`, array indexing and `panic` add `fail`. An effect
// annotation on a function (`! {}`, `! output`, `! {output, fail}`) closes its
// row, so an undeclared effect is a compile error at the call that causes it.
//
// Traits: a trait declares method signatures in terms of `Self`; an impl
// gives the methods for one type head. A method's type is its signature with
// `Self` a type variable constrained by the trait, so using a method on a
// type with no impl is a type error, and generic code that uses one is
// generalized with the constraint (`where a: Show`). Impl methods are checked
// against the signature after all ordinary functions. Every type without
// functions in it gets a derived `impl Show` unless the program writes one.
//
// Refinements: a partial operation (`/`, `%`, array indexing) adds `fail`
// unless the compiler proved it cannot fail (options.safeSites), and
// refinement types (`{i: Int | 0 <= i}`) on parameters, results and lets are
// proved by the compiler at every use; here they are only checked to be
// well formed, and kept on the tree for the interpreter to test at run time.
//
// Capabilities: the effects other than `fail` are granted to `main` by
// whoever runs the program. With a grant, `main` is checked as if it were
// annotated with the granted effects, so a program that would use an
// ungranted capability is rejected before it runs, at the call responsible.
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

// The builtins that can fail, and the key of a site where one is called.
export const PARTIAL_BUILTINS = new Set(['array_get', 'array_set', 'char_code_at', 'array_make']);
export const siteKey = (scope, span) => `${scope}:${span.s}:${span.e}`;
import {
  GENERIC, newVar, newRowVar, tcon, tfun, ttuple, row, prune, pruneRow, makeUnifier, UnifyError, EffectError, TraitError,
  generalize, instantiate, openEffect, substParams, TypePrinter, INT, BOOL, STRING, UNIT, LABELS,
} from './types.js';

// ---------------------------------------------------------------- builtins --
// Each builtin's type, with generic variables. (Which arguments the back end
// consumes and which it only borrows is in the compiler, compiler/43-rc.lm.)
function builtinTable() {
  const a = () => { const v = newVar(GENERIC); return v; };
  const fn = (params, ret, labels = []) => tfun(params, ret, row(labels));
  const t = {};
  const A = a();
  t.print = fn([STRING], UNIT, ['output']);
  t.println = fn([STRING], UNIT, ['output']);
  t.read_input = fn([], STRING, ['input']);
  t.read_line = fn([], STRING, ['input']);
  t.clock_ms = fn([], INT, ['clock']);
  t.random_int = fn([INT, INT], INT, ['random']);
  t.int_to_string = fn([INT], STRING);
  t.concat_strings = fn([tcon('List', [STRING])], STRING);
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
const REFINE_WHERE = 'refinement types can annotate the parameters and results of named functions, and let bindings';

const EFFECT_WORDS = { input: 'read input', output: 'write output', clock: 'read the clock', random: 'use randomness', fail: 'fail' };

// ------------------------------------------------------------------ check --
// options.grants: the capabilities granted to `main` (null: no restriction).
// options.entry: the function a run starts from (`main` unless a test harness
// says otherwise). A program made only of properties needs no entry.
// options.safeSites: the sites of partial operations proved safe;
// options.unproved: why the others were not (site -> reason).
export function checkOnce(source, { grants = null, entry = 'main', assumeSafe = false, safeSites = null, unproved = null } = {}) {
  // Whether the partial operation at this span was proved safe.
  const isSafe = (ctx, span) => assumeSafe || !!safeSites?.has(siteKey(ctx.scopeName, span));
  const whyUnsafe = (ctx, span) => unproved?.get(siteKey(ctx.scopeName, span));
  const preludeAst = parse(PRELUDE);
  let userAst;
  userAst = parse(source);
  const builtins = builtinTable();

  const adts = new Map(); // name -> { name, params, ctors: [{ name, key, idx, fieldTypes, adt }] }
  const ctors = { prelude: new Map(), user: new Map() };
  const BUILTIN_TYPES = new Map([['Int', 0], ['Bool', 0], ['String', 0], ['Unit', 0], ['Array', 1]]);
  const impls = new Map(); // trait name -> Map(type head -> impl)
  const { unify, unifyRows, requireTrait } = makeUnifier(adts, impls);
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
      case 'trefine': throw new LumenError(REFINE_WHERE, te.span);
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
      case 'tcon':
        if (te.name === 'Self') {
          if (!ctx.self) throw new LumenError('`Self` can only be used in a trait', te.span);
          return ctx.self;
        }
        return tcon(checkTypeName(te), te.args.map((a) => sigType(a, ctx)));
      case 'ttuple': return ttuple(te.elems.map((a) => sigType(a, ctx)));
      case 'tfun': return tfun(te.params.map((a) => sigType(a, ctx)), sigType(te.ret, ctx), sigEffect(te.eff, ctx));
      case 'trefine': throw new LumenError(REFINE_WHERE, te.span);
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

  // ---------------------------------------------------------------- traits --
  const traits = new Map(); // name -> { name, scope, methods: Map(name -> method) }
  const methods = { prelude: new Map(), user: new Map() }; // method name -> method
  function declareTrait(d, scope) {
    if (traits.has(d.name)) throw new LumenError(`trait \`${d.name}\` is already defined`, d.nameSpan);
    const tr = { name: d.name, scope, methods: new Map() };
    traits.set(d.name, tr);
    impls.set(d.name, new Map());
    for (const m of d.methods) {
      if (methods.prelude.has(m.name) || methods.user.has(m.name)) throw new LumenError(`\`${m.name}\` is already a trait method`, m.nameSpan);
      const ctx = { level: 1, tvars: new Map(), rvars: new Map(), self: newVar(1, new Set([d.name])) };
      if (!m.params.length || m.params.some((p) => !p.ann)) throw new LumenError(`the parameters of trait method \`${m.name}\` need types, and the first must be \`Self\``, m.nameSpan);
      const params = m.params.map((p) => sigType(p.ann, ctx));
      if (params[0] !== ctx.self) throw new LumenError(`the first parameter of trait method \`${m.name}\` must have type \`Self\``, m.params[0].span);
      const ty = tfun(params, m.ret ? sigType(m.ret, ctx) : UNIT, sigEffect(m.eff, ctx));
      generalize(ty, 0);
      const method = { name: m.name, trait: d.name, scheme: ty, self: ctx.self };
      tr.methods.set(m.name, method);
      methods[scope].set(m.name, method);
    }
  }

  // An impl: its trait, its type head and parameters, and its `where` constraints.
  function declareImpl(d, scope) {
    const tr = traits.get(d.trait);
    if (!tr) throw new LumenError(`unknown trait \`${d.trait}\``, d.traitSpan);
    const te = d.forType;
    let head, args, display;
    if (te.k === 'tcon') {
      if (te.name !== 'Self') checkTypeName(te);
      head = te.name; args = te.args;
      display = args.length ? `${te.name}<${args.map((a) => a.name).join(', ')}>` : te.name;
    } else if (te.k === 'ttuple') {
      head = `(${te.elems.length})`; args = te.elems;
      display = `(${args.map((a) => a.name).join(', ')})`;
    } else throw new LumenError('an impl is for a named type or a tuple type', te.span);
    if (head === 'Unit') display = '()';
    const params = args.map((a) => {
      if (a.k !== 'tvar') throw new LumenError('the type in an impl takes distinct type variables as arguments, like `List<a>`', a.span);
      return a.name;
    });
    if (new Set(params).size !== params.length) throw new LumenError('the type variables of an impl must be distinct', te.span);
    const builtin = tr.scope === 'prelude' && scope === 'user' && !(adts.has(head) && ctorsDeclaredIn(head) === 'user');
    if (builtin) throw new LumenError(`only types declared in this program can have their own \`impl ${d.trait}\``, te.span, `${display} already has one`);
    if (impls.get(d.trait).has(head)) throw new LumenError(`\`${display}\` already implements \`${d.trait}\``, te.span);
    const where = new Map();
    for (const w of d.where) {
      if (!params.includes(w.param)) throw new LumenError(`\`${w.param}\` is not a type variable of this impl`, w.span);
      for (const c of w.traits) if (!traits.has(c.name)) throw new LumenError(`unknown trait \`${c.name}\``, c.span);
      where.set(w.param, [...(where.get(w.param) ?? []), ...w.traits.map((c) => c.name)]);
    }
    const given = new Map();
    for (const f of d.methods) {
      if (!tr.methods.has(f.name)) throw new LumenError(`\`${f.name}\` is not a method of \`${d.trait}\``, f.nameSpan);
      if (given.has(f.name)) throw new LumenError(`\`${f.name}\` is defined twice in this impl`, f.nameSpan);
      given.set(f.name, f);
    }
    for (const m of tr.methods.keys()) if (!given.has(m)) throw new LumenError(`\`impl ${d.trait} for ${display}\` is missing the method \`${m}\``, te.span);
    const impl = { trait: d.trait, head, params, where, scope, display, decl: d, keys: new Map([...given.keys()].map((m) => [m, `impl:${d.trait}:${head}:${m}`])) };
    impls.get(d.trait).set(head, impl);
  }
  const ctorsDeclaredIn = (name) => (userAst.types.some((t) => t.name === name) ? 'user' : 'prelude');

  for (const d of preludeAst.traits) declareTrait(d, 'prelude');
  for (const d of userAst.traits) declareTrait(d, 'user');
  for (const d of preludeAst.impls) declareImpl(d, 'prelude');
  for (const d of userAst.impls) declareImpl(d, 'user');

  // Derived `impl Show` for every type without functions in it that does not
  // have one: `Some(3)`, `Node(Leaf, 1, Leaf)`. A type qualifies when all its
  // fields are showable, given the types that qualify (a greatest fixed point).
  const derivedAsts = [];
  {
    const shows = impls.get('Show');
    const derive = new Set([...adts.keys()].filter((n) => !shows.has(n)));
    const showable = (t) => {
      switch (t.k) {
        case 'param': return true;
        case 'fun': return false;
        case 'tuple': {
          const impl = shows.get(`(${t.elems.length})`);
          return !!impl && t.elems.every(showable);
        }
        case 'con': {
          const impl = shows.get(t.name);
          if (impl) return impl.params.every((p, i) => (impl.where.get(p) ?? []).every((c) => c === 'Show') && showable(t.args[i]));
          return derive.has(t.name) && t.args.every(showable);
        }
        default: return false;
      }
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const n of derive) if (adts.get(n).ctors.some((c) => c.fieldTypes.some((f) => !showable(f)))) { derive.delete(n); changed = true; }
    }
    for (const n of derive) {
      const d = adts.get(n);
      const ty = d.params.length ? `${n}<${d.params.join(', ')}>` : n;
      const where = d.params.length ? ` where ${d.params.map((p) => `${p}: Show`).join(', ')}` : '';
      const arms = d.ctors.map((c) => {
        if (!c.fieldTypes.length) return `${c.name} -> "${c.name}"`;
        const xs = c.fieldTypes.map((_, i) => `a${i}`);
        return `${c.name}(${xs.join(', ')}) -> "${c.name}(" ++ ${xs.map((x) => `show(${x})`).join(' ++ ", " ++ ')} ++ ")"`;
      });
      const ast = parse(`impl Show for ${ty}${where} { fn show(x) { match x { ${arms.join(', ')} } } }`);
      derivedAsts.push(ast.impls[0]);
      declareImpl(ast.impls[0], 'derived');
    }
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
  // Properties are functions too (so a test harness can call them), but their
  // parameters need concrete types, they may only fail, and they return Bool.
  for (const f of userAst.properties) {
    for (const p of f.params) if (!p.ann) throw new LumenError(`the parameters of property \`${f.name}\` need types, so that inputs can be generated`, p.span);
    f.presetEff = row(['fail']);
  }
  for (const f of [...userAst.fns, ...userAst.properties]) {
    if (globals.user.has(f.name)) throw new LumenError(`function \`${f.name}\` is defined twice`, f.nameSpan);
    if (methods.user.has(f.name)) throw new LumenError(`\`${f.name}\` is already a method of trait \`${methods.user.get(f.name).trait}\``, f.nameSpan);
    f.key = globals.prelude.has(f.name) || f.name in builtins || methods.prelude.has(f.name) ? `${f.name}'` : f.name;
    f.scope = 'user';
    globals.user.set(f.name, f);
    allFns.push(f);
  }
  const main = globals.user.get(entry) ?? null;
  if (!main && !userAst.properties.length) throw new LumenError(`the program has no \`${entry}\` function`, { s: 0, e: 0 });
  if (main?.property) throw new LumenError(`\`${entry}\` is a property, not a function to run`, main.nameSpan);
  if (main?.params.length) throw new LumenError(`\`${entry}\` takes no parameters`, main.nameSpan);

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
      if (e instanceof TraitError) throw traitError(e, span);
      if (e.message === 'infinite type') throw new LumenError(`${what ?? 'type mismatch'}: this would need an infinite type`, span);
      throw new LumenError(`${what ? `${what}: ` : ''}expected ${p.show(expected)}, found ${p.show(found)}`, span);
    }
  }

  function traitError(e, span) {
    const t = new TypePrinter().show(e.type);
    if (e.trait === 'Ord') return new LumenError(`values of type ${t} cannot be compared`, span, 'equality and ordering need a type without functions in it, or an `impl Ord`');
    return new LumenError(`\`${t}\` does not implement \`${e.trait}\``, span, `add \`impl ${e.trait} for ...\` for it`);
  }

  // The current function may perform the effects in `labels` (because of the expression at `span`).
  function perform(labels, ctx, span, cause, note) {
    try { unifyRows(row(labels, newRowVar(ctx.level)), ctx.eff); } catch (e) {
      if (!(e instanceof UnifyError)) throw e;
      throw effectViolation(e.labels ?? labels, ctx, span, cause, note);
    }
  }
  function effectViolation(labels, ctx, span, cause, why) {
    const words = labels.map((l) => EFFECT_WORDS[l] ?? l).join(' and ');
    if (ctx.granted) {
      return new LumenError(`${cause} can ${words}, but \`main\` was not granted \`${labels.join(', ')}\``, span,
        `grant it when running the program, for example \`lumen2 run --allow ${labels.join(',')}\``);
    }
    return new LumenError(`${cause} can ${words}, but ${ctx.owner} is declared without \`${labels.join(', ')}\``, span,
      why ?? `add the effect to the signature (for example \`! {${[...new Set([...pruneRow(ctx.eff).labels, ...labels])].sort().join(', ')}}\`), or remove the cause`);
  }

  // Names: locals, then the program's functions and methods, then the prelude's, then builtins.
  function lookup(name, ctx) {
    for (let s = ctx.scope; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
    if (ctx.scopeName === 'user') {
      if (globals.user.has(name)) return { k: 'global', fn: globals.user.get(name) };
      if (methods.user.has(name)) return { k: 'method', method: methods.user.get(name) };
    }
    if (globals.prelude.has(name)) return { k: 'global', fn: globals.prelude.get(name) };
    if (methods.prelude.has(name)) return { k: 'method', method: methods.prelude.get(name) };
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
        if (b.k === 'method') {
          e.ref = { k: 'method', trait: b.method.trait, method: b.method.name };
          e.inst = inst;
          return openEffect(instantiate(b.method.scheme, ctx.level, inst), ctx.level);
        }
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
          let eff = f.eff, note;
          if (e.fn.k === 'var' && e.fn.ref?.k === 'builtin' && PARTIAL_BUILTINS.has(e.fn.ref.name)) {
            if (isSafe(ctx, e.span)) {
              const r = pruneRow(f.eff);
              eff = row(r.labels.filter((l) => l !== 'fail'), r.tail);
              if (!assumeSafe) e.safe = true;
            } else note = whyUnsafe(ctx, e.span);
          }
          callEffects(eff, ctx, e.span, `calling ${what}`, note);
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
          if (p.ann?.k === 'trefine') throw new LumenError('the parameters of a lambda cannot be refined; use a named function', p.ann.span);
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
            const refined = st.ann?.k === 'trefine';
            if (hasElemRefine(refined ? st.ann.base : st.ann)) throw new LumenError('element refinements can annotate the parameters and results of named functions', st.ann.span);
            if (st.ann) unifyAt(sigType(refined ? st.ann.base : st.ann, ctx), vt, st.value.span, 'let binding');
            if (refined) {
              if (st.pat.k !== 'pvar') throw new LumenError('a refined let binds one variable', st.pat.span);
              st.refine = checkRefinement(st.ann, vt, inner);
            }
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

  function callEffects(eff, ctx, span, cause, note) {
    try { unifyRows(eff, ctx.eff); } catch (err) {
      if (!(err instanceof UnifyError)) throw err;
      throw effectViolation(err.labels ?? [], ctx, span, cause, note);
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
        if (isSafe(ctx, e.span)) { if (!assumeSafe) e.safe = true; } else perform(['fail'], ctx, e.span, `\`${e.op}\` (division by zero)`, whyUnsafe(ctx, e.span));
        return INT;
      case '&&': case '||':
        unifyAt(BOOL, l, e.l.span, `left operand of \`${e.op}\``); unifyAt(BOOL, r, e.r.span, `right operand of \`${e.op}\``);
        return BOOL;
      case '++':
        unifyAt(STRING, l, e.l.span, '`++` joins Strings'); unifyAt(STRING, r, e.r.span, '`++` joins Strings');
        return STRING;
      default: // comparisons
        unifyAt(l, r, e.r.span, `both sides of \`${e.op}\` must have the same type`);
        try { requireTrait('Ord', l); } catch (err) {
          if (!(err instanceof UnifyError)) throw err;
          throw new LumenError(`values of type ${show(l)} cannot be compared`, e.span, 'equality and ordering need a type without functions in it, or an `impl Ord`');
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

  // A refinement {v: T | p}: v is bound to the refined value; p must be in
  // the decidable fragment refine.js understands.
  function checkRefinement(te, ty, ctx) {
    const base = prune(ty);
    if (base.k !== 'con' || !['Int', 'Array', 'String'].includes(base.name)) throw new LumenError(`only Int, Array and String values can be refined; this one has type ${show(ty)}`, te.span);
    const pctx = { ...ctx, scope: { vars: new Map(), parent: ctx.scope }, eff: row([], newRowVar(ctx.level)) };
    const b = bindLocal(pctx, te.v, ty, te.vSpan);
    unifyAt(BOOL, infer(te.pred, pctx), te.pred.span, 'a refinement must be true or false');
    validatePredicate(te.pred);
    return { vId: b.id, v: te.v, pred: te.pred, span: te.span, predSpan: te.pred.span };
  }
  function validatePredicate(e) {
    const bad = (msg) => { throw new LumenError(msg, e.span, 'refinements use integer constants, variables, +, -, multiplication by a constant, comparisons, &&, ||, !, array_length and string_length'); };
    const isInt = (x) => { const t = prune(x.ty); return t.k === 'con' && t.name === 'Int'; };
    const isLit = (x) => x.k === 'int' || (x.k === 'unop' && x.op === '-' && x.e.k === 'int');
    switch (e.k) {
      case 'int': case 'bool': return;
      case 'var':
        if (e.ref.k !== 'local') bad(`a refinement can only mention variables, not \`${e.name}\``);
        if (!isInt(e) && prune(e.ty).name !== 'Bool') bad(`\`${e.name}\` is not an Int; use array_length or string_length for arrays and strings`);
        return;
      case 'unop': validatePredicate(e.e); return;
      case 'binop':
        if (['/', '%', '++'].includes(e.op)) bad(`\`${e.op}\` cannot be used in a refinement`);
        if (e.op === '*' && !isLit(e.l) && !isLit(e.r)) bad('in a refinement, `*` needs a constant on one side');
        if (['==', '!=', '<', '<=', '>', '>='].includes(e.op) && !isInt(e.l)) bad('a refinement compares integers only');
        validatePredicate(e.l); validatePredicate(e.r);
        return;
      case 'call': {
        const f = e.fn;
        const ok = f.k === 'var' && f.ref?.k === 'builtin' && ['array_length', 'string_length'].includes(f.ref.name) && e.args.length === 1 && e.args[0].k === 'var' && e.args[0].ref.k === 'local';
        if (!ok) bad('the only calls allowed in a refinement are array_length(x) and string_length(x) of a variable');
        return;
      }
      default: bad('this expression cannot be used in a refinement');
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

  // Element refinements: `Array<{x: Int | p}>`, nested to any depth. The type
  // without them is the annotation's type; the refinements become a spec,
  // { refine (of each element), elem (the elements' own elements) }.
  function stripElems(te) {
    if (!te) return te;
    if (te.k === 'trefine') return { ...te, base: stripElems(te.base) };
    if (te.k === 'tcon' && te.name === 'Array' && te.args.length === 1) {
      const a = te.args[0];
      return { ...te, args: [a.k === 'trefine' ? stripElems(a.base) : stripElems(a)] };
    }
    return te;
  }
  const hasElemRefine = (te) => !!te && te.k === 'tcon' && te.name === 'Array' && te.args.length === 1
    && (te.args[0].k === 'trefine' || hasElemRefine(te.args[0]));
  function elemSpec(te, ty, ctx) {
    const arr = te?.k === 'trefine' ? te.base : te;
    if (!hasElemRefine(arr)) return null;
    const elemTy = prune(prune(ty).args[0]);
    const a = arr.args[0];
    return {
      refine: a.k === 'trefine' ? checkRefinement(a, elemTy, ctx) : null,
      elem: elemSpec(a.k === 'trefine' ? a.base : a, elemTy, ctx),
    };
  }

  // Infers a function declaration's type in its own scope and ambient effect.
  function fnType(f, ctx, owner) {
    const inner = { ...ctx, scope: { vars: new Map(), parent: ctx.scope }, owner };
    inner.eff = f.eff ? sigEffect(f.eff, ctx) : f.presetEff ?? row([], newRowVar(ctx.level));
    if (f === main && main && grants && !f.eff) { inner.eff = row([...grants, 'fail']); inner.granted = true; }
    const params = f.params.map((p) => {
      const ann = stripElems(p.ann?.k === 'trefine' ? p.ann.base : p.ann);
      const ty = ann ? sigType(ann, ctx) : newVar(ctx.level);
      p.id = bindLocal(inner, p.name, ty, p.span).id;
      p.ty = ty;
      return ty;
    });
    // Refinements may mention any parameter (and, in a local function, enclosing variables).
    for (const p of f.params) {
      if (p.ann?.k === 'trefine') p.refine = checkRefinement({ ...p.ann, base: stripElems(p.ann.base) }, p.ty, inner);
      p.elemRefine = elemSpec(p.ann, p.ty, inner);
    }
    const body = infer(f.body, inner);
    if (f.ret?.k === 'trefine') {
      unifyAt(sigType(stripElems(f.ret.base), ctx), body, f.body.result?.span ?? f.body.span, `\`${f.name}\` returns`);
      f.retRefine = checkRefinement({ ...f.ret, base: stripElems(f.ret.base) }, body, inner);
    } else if (f.ret) unifyAt(sigType(stripElems(f.ret), ctx), body, f.body.result?.span ?? f.body.span, `\`${f.name}\` returns`);
    if (f.ret) f.retElem = elemSpec(f.ret, body, inner);
    if (f.property) unifyAt(BOOL, body, f.body.result?.span ?? f.body.span, 'a property must be true or false');
    return tfun(params, body, inner.eff);
  }

  for (const comp of sccs) {
    const level = 1;
    for (const f of comp) {
      f.ctx = { level, tvars: new Map(), rvars: new Map(), scope: null, scopeName: f.scope, owner: f.property ? `property \`${f.name}\`` : `\`${f.name}\`` };
      f.ty = newVar(level);
    }
    for (const f of comp) unifyAt(f.ty, fnType(f, f.ctx, f.ctx.owner), f.nameSpan);
    for (const f of comp) { generalize(f.ty, 0); f.scheme = f.ty; }
  }
  // Impl methods, checked against their trait's signature with Self = the impl's type.
  for (const traitImpls of impls.values()) {
    for (const impl of traitImpls.values()) {
      const tr = traits.get(impl.trait);
      for (const f of impl.decl.methods) {
        const method = tr.methods.get(f.name);
        f.key = impl.keys.get(f.name);
        f.scope = impl.scope;
        const owner = `\`${f.name}\` in \`impl ${impl.trait} for ${impl.display}\``;
        const ctx = { level: 1, tvars: new Map(), rvars: new Map(), scope: null, scopeName: impl.scope, owner };
        const vars = impl.params.map(() => newVar(1));
        const selfTy = impl.head.startsWith('(') ? ttuple(vars) : tcon(impl.head, vars);
        const expected = instantiate(method.scheme, 1, new Map([[prune(method.self), selfTy]]));
        if (f.params.length !== expected.params.length) throw new LumenError(`\`${f.name}\` takes ${expected.params.length} parameter${expected.params.length === 1 ? '' : 's'} in trait \`${impl.trait}\``, f.nameSpan);
        f.presetEff = expected.eff;
        const ty = fnType(f, ctx, owner);
        unifyAt(expected, ty, f.nameSpan, `${owner} does not match the trait`);
        vars.forEach((v, i) => {
          const p = prune(v);
          if (p.k !== 'var' || vars.some((w, j) => j !== i && prune(w) === p)) throw new LumenError(`${owner} only works for some types \`${impl.params[i]}\`, but the impl is for all of them`, f.nameSpan);
          const declared = impl.where.get(impl.params[i]) ?? [];
          const missing = [...p.traits].filter((c) => !declared.includes(c));
          if (missing.length) throw new LumenError(`${owner} needs \`${impl.params[i]}: ${missing.join(' + ')}\``, f.nameSpan, `add \`where ${impl.params[i]}: ${missing.join(' + ')}\` to the impl`);
        });
        generalize(ty, 0);
        f.ty = ty; f.scheme = ty;
        allFns.push(f);
      }
    }
  }

  // Property inputs are generated, so their types must be concrete and contain no functions.
  const concrete = (t) => {
    t = prune(t);
    if (t.k === 'var' || t.k === 'fun') return false;
    return (t.k === 'tuple' ? t.elems : t.args).every(concrete);
  };
  for (const f of userAst.properties) {
    for (const p of f.params) if (!concrete(p.ty)) throw new LumenError(`property inputs need concrete types without functions; \`${p.name}\` has type ${show(p.ty)}`, p.span);
  }

  // An annotated `main` must not claim more than it was granted.
  if (grants && main?.eff) {
    const extra = main.eff.labels.filter((l) => l !== 'fail' && !grants.includes(l));
    if (extra.length) throw new LumenError(`\`main\` is declared with \`${extra.join(', ')}\`, which was not granted`, main.nameSpan, `grant it when running the program, for example \`lumen2 run --allow ${extra.join(',')}\``);
  }
  for (const run of deferred) run();

  // A signature, with any refinements written as in the source.
  const printer = (f) => {
    const refined = f.params.some((p) => p.refine || p.elemRefine) || f.retRefine || f.retElem;
    if (!refined) return new TypePrinter().signature(f.scheme);
    const t = prune(f.scheme);
    const p = new TypePrinter();
    p.show(t);
    const text = (r, ty) => `{${r.v}: ${p.show(ty, false)} | ${source.slice(r.predSpan.s, r.predSpan.e)}}`;
    // An annotation with element refinements is shown as written.
    const written = (te) => source.slice(te.span.s, te.span.e).replace(/\s+/g, ' ');
    const params = t.params.map((pt, i) => (f.params[i].elemRefine ? written(f.params[i].ann) : f.params[i].refine ? text(f.params[i].refine, pt) : p.show(pt, false)));
    const ret = f.retElem ? written(f.ret) : f.retRefine ? text(f.retRefine, t.ret) : p.show(t.ret, false);
    const cs = [...p.names.keys()].filter((v) => v.traits.size).map((v) => `${p.names.get(v)}: ${[...v.traits].sort().join(' + ')}`);
    return `fn(${params.join(', ')}) -> ${ret}${p.effect(t.eff)}${cs.length ? ` where ${cs.join(', ')}` : ''}`;
  };
  const signatures = userAst.fns.map((f) => ({ name: f.name, type: printer(f), span: f.nameSpan }));
  return {
    adts, fns: allFns, main, builtins, signatures, warnings, impls, traits,
    properties: userAst.properties.map((f) => ({ name: f.name, key: f.key, params: f.params.map((p) => ({ name: p.name, id: p.id, ty: p.ty, refine: p.refine })), span: f.nameSpan })),
    preludeFns: preludeAst.fns, userFns: userAst.fns,
  };
}

function checkEffectLabels(ast) {
  const visit = (te) => {
    if (!te || typeof te !== 'object') return;
    if (Array.isArray(te)) { te.forEach(visit); return; }
    if (te.labels) for (const l of te.labels) if (!LABELS.includes(l)) throw new LumenError(`unknown effect \`${l}\` (the effects are input, output, clock, random and fail)`, te.span);
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
