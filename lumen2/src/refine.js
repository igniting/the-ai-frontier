// Refinement checking: proof obligations for partial operations and for
// refinement types, discharged by bit-blasting and SAT (blast.js), with every
// proof checked by an independent RUP checker.
//
// The walk is a symbolic evaluation of each function body. It tracks:
//   * integers as linear terms over atoms (one atom per variable or unknown
//     value), and arrays and strings by their lengths;
//   * the facts that hold on the current path: `if` conditions and their
//     negations, match arms on integer literals, guards, refined parameters,
//     the results of refined functions, and the success of every operation
//     already performed (after `array_get(a, i)` returns, i is in bounds).
// Values never change once bound, so a fact about a variable holds wherever
// the variable is visible, including inside closures created on that path.
//
// Obligations:
//   * a partial operation (`/`, `%`, array_get, array_set, char_code_at,
//     array_make) whose precondition is proved is *safe*: the checker then
//     gives it no `fail` effect;
//   * a call to a function with refined parameters must prove them, and a
//     function with a refined result must prove it at its end; these are
//     compile errors when they cannot be proved, with a counterexample.

import { LumenError } from './diagnostics.js';
import { prune } from './types.js';
import { INT_MIN, INT_MAX, MAX_ARRAY, MAX_STRING } from './interp.js';
import { prove, konst, atomTerm, addTerms, subTerms, scaleTerm, isConst, compare, and, or, not, boolAtom, TRUE, FALSE } from './blast.js';

export const PARTIAL_BUILTINS = new Set(['array_get', 'array_set', 'char_code_at', 'array_make']);
export const siteKey = (scope, span) => `${scope}:${span.s}:${span.e}`;

// Proofs for the prelude never change, so they are found once per process.
let preludeCache = null;

// program: a checked program (with refinements recorded on the syntax tree).
// sources: { user, prelude } source text, for messages.
// Returns { safe: Set(site), unproved: Map(site -> note), obligations: [...] }.
export function verify(program, sources, { mutant = null, keepProofs = false, includePrelude = false } = {}) {
  const atoms = new Map();
  let nextAtom = 0;
  // An atom is shown in counterexamples when it names a program variable (or its length).
  const newAtom = (name, lo = INT_MIN, hi = INT_MAX, display = false) => { const id = nextAtom++; atoms.set(id, { lo, hi, name, display }); return id; };
  const newBool = (name, display = false) => { const id = nextAtom++; atoms.set(id, { bool: true, name, display }); return id; };
  // Facts that define a fresh atom (the value of an `if` or `match`). Each one
  // can always be satisfied by choosing the atom, so it constrains nothing
  // else, and it is safe to assume everywhere.
  const defs = [];
  const env = new Map(); // local id -> symbolic value
  const localFns = new Map(); // local function id -> declaration
  const fnsByKey = new Map(program.fns.map((f) => [f.key, f]));
  const safe = new Set();
  const unproved = new Map();
  const obligations = [];
  let scope = 'user';

  const textOf = (span, sc) => (sc === 'prelude' ? sources.prelude : sources.user).slice(span.s, span.e);
  const err = (msg, span, note) => new LumenError(msg, sc0(span), note);
  const sc0 = (span) => (scope === 'user' ? span : { s: 0, e: 0 });

  // Symbolic values: { k: 'int', t } | { k: 'bool', f } | { k: 'len', t } | null.
  const typeName = (ty) => { const t = prune(ty); return t.k === 'con' ? t.name : null; };
  function fresh(ty, name, display = false) {
    switch (typeName(ty)) {
      case 'Int': return { k: 'int', t: atomTerm(newAtom(name, INT_MIN, INT_MAX, display)) };
      case 'Bool': return { k: 'bool', f: boolAtom(newBool(name, display)) };
      case 'Array': return { k: 'len', t: atomTerm(newAtom(`array_length(${name})`, 0n, BigInt(MAX_ARRAY), display)) };
      case 'String': return { k: 'len', t: atomTerm(newAtom(`string_length(${name})`, 0n, BigInt(MAX_STRING), display)) };
      default: return null;
    }
  }
  const varSym = (id, ty, name) => {
    if (!env.has(id)) env.set(id, fresh(ty, name, true));
    return env.get(id);
  };
  const intOf = (s) => (s?.k === 'int' ? s.t : null);
  const lenOf = (s) => (s?.k === 'len' ? s.t : null);
  const boolOf = (s) => (s?.k === 'bool' ? s.f : null);
  const copy = (st) => ({ facts: [...st.facts] });

  // Merges the values of two or more branches into one, with a disjunction.
  function merge(ty, alts, name) {
    if (alts.some((a) => !a.v)) return fresh(ty, name);
    const kind = alts[0].v.k;
    if (kind === 'bool') return { k: 'bool', f: alts.map((a) => (a.c ? and(a.c, a.v.f) : a.v.f)).reduce((x, y) => or(x, y)) };
    const r = fresh(ty, name);
    if (!r || r.k !== kind) return r;
    const cases = alts.map((a) => { const eq = compare('==', r.t, a.v.t); return a.c ? and(a.c, eq) : eq; });
    defs.push(cases.reduce((x, y) => or(x, y)));
    return r;
  }

  // Records an obligation and tries to prove it. Afterwards the goal holds on this path.
  function oblige(kind, goal, st, info) {
    const o = { kind, ...info };
    obligations.push(o);
    if (goal) {
      const r = prove(atoms, [...defs, ...st.facts], goal, { mutant });
      o.status = r.status;
      if (r.status === 'proved') {
        o.lemmas = r.lemmas;
        o.clauses = r.cnf.clauses.length;
        if (keepProofs) { o.cnf = r.cnf; o.proof = r.proof; }
      } else if (r.status === 'refuted') {
        // Prefer a counterexample with small numbers, when there is one.
        const small = new Map([...atoms].map(([id, a]) => [id, a.bool ? a : { ...a, lo: a.lo < -16n ? -16n : a.lo, hi: a.hi > 16n ? 16n : a.hi }]));
        const s2 = [...small.values()].every((a) => a.bool || a.lo <= a.hi) ? prove(small, [...defs, ...st.facts], goal, { mutant }) : null;
        o.counterexample = describeModel(s2?.status === 'refuted' ? s2.model : r.model);
      }
      st.facts.push(goal);
    } else o.status = 'unknown';
    return o;
  }
  function describeModel(model) {
    const parts = [...model].filter(([id]) => atoms.get(id).display).map(([id, v]) => `${atoms.get(id).name} = ${v}`).sort();
    return parts.length ? `for example when ${parts.join(', ')}` : 'it does not hold here';
  }

  // A refinement predicate as a formula, with `binding` for the refined value
  // and the callee's parameters (other variables come from the enclosing scope).
  function predicate(e, binding) {
    const val = (x) => {
      switch (x.k) {
        case 'int': return { k: 'int', t: konst(x.v) };
        case 'bool': return { k: 'bool', f: x.v ? TRUE : FALSE };
        case 'var': return binding.get(x.ref.id) ?? varSym(x.ref.id, x.ty, x.name);
        case 'unop': {
          const a = val(x.e);
          if (x.op === '-') return intOf(a) && { k: 'int', t: scaleTerm(a.t, -1n) };
          return boolOf(a) && { k: 'bool', f: not(a.f) };
        }
        case 'call': return { k: 'int', t: lenOf(val(x.args[0])) ?? atomTerm(newAtom('length')) };
        case 'binop': {
          const l = val(x.l), r = val(x.r);
          switch (x.op) {
            case '+': return intOf(l) && intOf(r) && { k: 'int', t: addTerms(l.t, r.t) };
            case '-': return intOf(l) && intOf(r) && { k: 'int', t: subTerms(l.t, r.t) };
            case '*': {
              const [a, b] = [intOf(l), intOf(r)];
              if (a && b && isConst(a)) return { k: 'int', t: scaleTerm(b, a.c) };
              if (a && b && isConst(b)) return { k: 'int', t: scaleTerm(a, b.c) };
              return null;
            }
            case '&&': return boolOf(l) && boolOf(r) && { k: 'bool', f: and(l.f, r.f) };
            case '||': return boolOf(l) && boolOf(r) && { k: 'bool', f: or(l.f, r.f) };
            default: return intOf(l) && intOf(r) && { k: 'bool', f: compare(x.op, l.t, r.t) };
          }
        }
        default: return null;
      }
    };
    return boolOf(val(e));
  }

  // ------------------------------------------------------ expressions --
  // Returns the symbolic value of e; records obligations; facts accumulate in st.
  function sym(e, st, callee = false) {
    switch (e.k) {
      case 'int': return { k: 'int', t: konst(e.v) };
      case 'bool': return { k: 'bool', f: e.v ? TRUE : FALSE };
      case 'str': return { k: 'len', t: konst(e.v.length) };
      case 'unit': return null;
      case 'var': {
        if (e.ref.k === 'local') {
          const f = localFns.get(e.ref.id);
          if (f && !callee && hasRefinedParams(f)) throw err(`\`${e.name}\` has refined parameters, so it can only be called directly`, e.span, 'a call through a function value could not be checked against the refinements');
          return varSym(e.ref.id, e.ty, e.name);
        }
        if (e.ref.k === 'global' && !callee) {
          const f = fnsByKey.get(e.ref.key);
          if (f && hasRefinedParams(f)) throw err(`\`${e.name}\` has refined parameters, so it can only be called directly`, e.span, 'a call through a function value could not be checked against the refinements');
        }
        return null;
      }
      case 'ctor': (e.args ?? []).forEach((a) => sym(a, st)); return null;
      case 'tuple': e.elems.forEach((a) => sym(a, st)); return null;
      case 'lambda': body(e.params, e.body, null, copy(st)); return null;
      case 'unop': {
        const a = sym(e.e, st);
        if (e.op === '-') return intOf(a) ? { k: 'int', t: scaleTerm(a.t, -1n) } : fresh(e.ty, '-');
        return boolOf(a) ? { k: 'bool', f: not(a.f) } : null;
      }
      case 'binop': return binop(e, st);
      case 'block': {
        for (const s of e.stmts) {
          if (s.k === 'let') {
            const v = sym(s.value, st);
            if (s.refine) {
              const goal = predicate(s.refine.pred, new Map([[s.refine.vId, v]]));
              const o = oblige('let', goal, st, { span: s.value.span, what: `\`${textOf(s.refine.span, scope)}\`` });
              if (o.status !== 'proved') throw err(`cannot prove that this value satisfies \`${textOf(s.refine.predSpan, scope)}\``, s.value.span, o.counterexample);
            }
            if (s.pat.k === 'pvar') env.set(s.pat.id, v);
          } else if (s.k === 'expr') sym(s.e, st);
          else {
            localFns.set(s.fn.id, s.fn);
            body(s.fn.params, s.fn.body, s.fn, copy(st));
          }
        }
        return e.result ? sym(e.result, st) : null;
      }
      case 'if': {
        const c = boolOf(sym(e.cond, st));
        const yes = copy(st), no = copy(st);
        if (c) { yes.facts.push(c); no.facts.push(mutant === 'refine-else-same' ? c : not(c)); }
        const a = sym(e.then, yes);
        const b = e.else ? sym(e.else, no) : null;
        return merge(e.ty, [{ c, v: a }, { c: c ? not(c) : null, v: b }], 'if');
      }
      case 'match': {
        const s = sym(e.scrut, st);
        const before = []; // negations of earlier literal arms
        const alts = [];
        for (const arm of e.arms) {
          const a = { facts: [...st.facts, ...before] };
          let litFact = null;
          if (arm.pat.k === 'pint' && intOf(s)) litFact = compare('==', s.t, konst(arm.pat.v));
          if (arm.pat.k === 'pbool' && boolOf(s)) litFact = arm.pat.v ? s.f : not(s.f);
          if (litFact) a.facts.push(litFact);
          if (arm.pat.k === 'pvar') env.set(arm.pat.id, s);
          if (arm.guard) { const g = boolOf(sym(arm.guard, a)); if (g) a.facts.push(g); }
          alts.push({ c: null, v: sym(arm.body, a) });
          if (litFact && !arm.guard) before.push(not(litFact));
        }
        return merge(e.ty, alts, 'match');
      }
      case 'call': return call(e, st);
      default: return null;
    }
  }

  function binop(e, st) {
    if (e.op === '&&' || e.op === '||') {
      const l = boolOf(sym(e.l, st));
      const rs = copy(st);
      if (l) rs.facts.push(e.op === '&&' ? l : not(l));
      const r = boolOf(sym(e.r, rs));
      if (!l || !r) return null;
      return { k: 'bool', f: e.op === '&&' ? and(l, r) : or(l, r) };
    }
    const l = sym(e.l, st), r = sym(e.r, st);
    switch (e.op) {
      case '+': return intOf(l) && intOf(r) ? { k: 'int', t: addTerms(l.t, r.t) } : fresh(e.ty, '+');
      case '-': return intOf(l) && intOf(r) ? { k: 'int', t: subTerms(l.t, r.t) } : fresh(e.ty, '-');
      case '*': {
        const [a, b] = [intOf(l), intOf(r)];
        if (a && b && isConst(a)) return { k: 'int', t: scaleTerm(b, a.c) };
        if (a && b && isConst(b)) return { k: 'int', t: scaleTerm(a, b.c) };
        return fresh(e.ty, '*');
      }
      case '/': case '%': {
        const d = intOf(r);
        partial(e, d ? not(compare('==', d, konst(0))) : null, st, 'the divisor is not zero');
        return fresh(e.ty, e.op);
      }
      case '++': return lenOf(l) && lenOf(r) ? { k: 'len', t: addTerms(l.t, r.t) } : fresh(e.ty, '++');
      default: {
        const [a, b] = [intOf(l), intOf(r)];
        return a && b ? { k: 'bool', f: compare(e.op, a, b) } : null;
      }
    }
  }

  // A partial operation: proved safe, or it keeps its `fail` effect.
  function partial(e, goal, st, what) {
    const key = siteKey(scope, e.span);
    const o = oblige('partial', goal, st, { site: key, span: e.span, what });
    if (o.status === 'proved') safe.add(key);
    else unproved.set(key, `could not prove that ${what}${o.counterexample ? `: ${o.counterexample}` : ''}`);
  }
  const inBounds = (i, n) => (i && n ? and(compare('>=', i, konst(0)), compare('<', i, n)) : null);

  function call(e, st) {
    const f = e.fn;
    if (f.k === 'var' && f.ref.k === 'builtin') {
      const args = e.args.map((a) => sym(a, st));
      const name = f.ref.name;
      switch (name) {
        case 'array_length': case 'string_length': return lenOf(args[0]) ? { k: 'int', t: lenOf(args[0]) } : fresh(e.ty, `${name}(..)`);
        case 'array_get': partial(e, inBounds(intOf(args[1]), lenOf(args[0])), st, 'the index is in bounds'); return fresh(e.ty, 'array_get(..)');
        case 'array_set': partial(e, inBounds(intOf(args[1]), lenOf(args[0])), st, 'the index is in bounds'); return lenOf(args[0]) ? { k: 'len', t: lenOf(args[0]) } : fresh(e.ty, 'array_set(..)');
        case 'char_code_at': {
          partial(e, inBounds(intOf(args[1]), lenOf(args[0])), st, 'the index is in bounds');
          const r = newAtom('char_code_at(..)', 0n, 255n);
          return { k: 'int', t: atomTerm(r) };
        }
        case 'array_make': {
          const n = intOf(args[0]);
          partial(e, n ? compare('>=', n, konst(0)) : null, st, 'the length is not negative');
          if (!n) return fresh(e.ty, 'array_make(..)');
          st.facts.push(compare('<=', n, konst(MAX_ARRAY))); // or it would have run out of memory
          return { k: 'len', t: n };
        }
        case 'array_push': return lenOf(args[0]) ? { k: 'len', t: addTerms(lenOf(args[0]), konst(1)) } : fresh(e.ty, 'array_push(..)');
        case 'array_empty': return { k: 'len', t: konst(0) };
        case 'char_from_code': return { k: 'len', t: konst(1) };
        case 'int_to_string': return { k: 'len', t: atomTerm(newAtom('string_length(int_to_string(..))', 1n, 20n)) };
        case 'random_int': {
          const r = fresh(e.ty, 'random_int(..)');
          const [lo, hi] = [intOf(args[0]), intOf(args[1])];
          if (lo && hi) st.facts.push(or(and(compare('<=', lo, r.t), compare('<=', r.t, hi)), and(compare('<=', hi, r.t), compare('<=', r.t, lo))));
          return r;
        }
        case 'panic': st.facts.push(FALSE); return fresh(e.ty, 'panic(..)'); // it never returns
        default: return fresh(e.ty, `${name}(..)`);
      }
    }
    // A direct call of a function: check its refined parameters, assume its refined result.
    let decl = null;
    if (f.k === 'var' && f.ref.k === 'global') decl = fnsByKey.get(f.ref.key);
    else if (f.k === 'var' && f.ref.k === 'local') decl = localFns.get(f.ref.id) ?? null;
    else sym(f, st);
    if (f.k === 'var' && f.ref.k === 'local' && !decl) sym(f, st);
    const args = e.args.map((a) => sym(a, st));
    if (!decl) return fresh(e.ty, f.k === 'var' ? `${f.name}(..)` : 'call(..)');
    const binding = new Map(decl.params.map((p, i) => [p.id, args[i] ?? fresh(p.ty, p.name)]));
    decl.params.forEach((p, i) => {
      if (!p.refine) return;
      const b = new Map(binding).set(p.refine.vId, binding.get(p.id));
      const goal = predicate(p.refine.pred, b);
      const o = oblige('argument', goal, st, { span: e.args[i].span, what: `argument \`${p.name}\` of \`${decl.name}\`` });
      if (o.status !== 'proved') {
        throw err(`cannot prove that argument \`${p.name}\` of \`${decl.name}\` satisfies \`${textOf(p.refine.predSpan, decl.scope ?? scope)}\``, e.args[i].span, o.counterexample ?? undefined);
      }
    });
    const r = fresh(e.ty, `${decl.name}(..)`);
    if (decl.retRefine && r) {
      const fact = predicate(decl.retRefine.pred, new Map(binding).set(decl.retRefine.vId, r));
      if (fact) st.facts.push(fact);
    }
    return r;
  }

  const hasRefinedParams = (f) => f.params.some((p) => p.refine);

  // A function body: refined parameters are facts; a refined result is an obligation.
  function body(params, b, decl, st) {
    for (const p of params) {
      if (!p.refine) continue;
      const v = varSym(p.id, p.ty, p.name);
      const fact = predicate(p.refine.pred, new Map([[p.refine.vId, v]]));
      if (fact) st.facts.push(fact);
    }
    const r = sym(b, st);
    if (decl?.retRefine) {
      const goal = predicate(decl.retRefine.pred, new Map([[decl.retRefine.vId, r]]));
      const o = oblige('result', goal, st, { span: decl.nameSpan, what: `the result of \`${decl.name}\`` });
      if (o.status !== 'proved') throw err(`cannot prove that the result of \`${decl.name}\` satisfies \`${textOf(decl.retRefine.predSpan, decl.scope ?? scope)}\``, b.result?.span ?? b.span, o.counterexample ?? undefined);
    }
  }

  const usePreludeCache = preludeCache && !includePrelude && !keepProofs && !mutant;
  for (const f of program.fns) {
    const fromPrelude = f.scope !== 'user';
    if (fromPrelude && usePreludeCache) continue;
    scope = f.scope === 'user' ? 'user' : f.scope;
    body(f.params, f.body, f, { facts: [] });
  }
  if (usePreludeCache) {
    for (const s of preludeCache.safe) safe.add(s);
    for (const [k, v] of preludeCache.unproved) unproved.set(k, v);
  } else if (!mutant && !keepProofs) {
    preludeCache = {
      safe: new Set([...safe].filter((k) => !k.startsWith('user:'))),
      unproved: new Map([...unproved].filter(([k]) => !k.startsWith('user:'))),
    };
  }
  return { safe, unproved, obligations };
}
