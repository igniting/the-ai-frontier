// Inlining small functions, on the monomorphic IR before reference counting.
//
// A call to a small, non-recursive named function is replaced by the
// function's body, with its parameters replaced by the arguments and its
// variables renamed. In tail position the body's returns become the caller's
// returns; elsewhere the body becomes a nested expression bound to the call's
// variable. Since reference counting has not been inserted yet, this is a
// plain substitution, and Perceus then treats the result like any other code:
// a chain of inlined accessors and setters on a unique record becomes
// straight-line loads, in-place updates and cell reuse, with no calls.
//
// The IR type checker (certify.js) checks the result like any other IR.

const SIZE = 14; // the most instructions a function may have to be inlined

export function inlineSmall(ir, { rounds = 2 } = {}) {
  const byName = new Map(ir.fns.map((f) => [f.name, f]));
  let fresh = 0;
  let inlined = 0;

  const size = (e) => {
    switch (e.k) {
      case 'let': return 1 + (e.rhs.k === 'expr' ? size(e.rhs.e) : 0) + size(e.body);
      case 'ret': return 1 + (e.rhs.k === 'expr' ? size(e.rhs.e) : 0);
      case 'if': return 1 + size(e.t) + size(e.e);
      default: return 1;
    }
  };
  const calls = (e, name) => {
    const r = (x) => x.k === 'call' && x.fn === name || (x.k === 'expr' && calls(x.e, name));
    switch (e.k) {
      case 'let': return r(e.rhs) || calls(e.body, name);
      case 'ret': return r(e.rhs);
      case 'if': return calls(e.t, name) || calls(e.e, name);
      default: return false;
    }
  };
  const candidate = (name) => {
    const f = byName.get(name);
    return f && !f.env && name !== ir.main && size(f.body) <= SIZE && !calls(f.body, name) ? f : null;
  };

  // Copies a callee's body into caller g: params -> argument atoms, other variables renamed.
  function instantiate(f, args, g) {
    const sub = new Map(f.params.map((p, i) => [p.v, args[i]]));
    const name = (v) => {
      if (!sub.has(v)) {
        const w = `${v}~${fresh++}`;
        g.vars.set(w, f.vars.get(v));
        if (f.borrowed?.has(v)) (g.borrowed ??= new Set()).add(w);
        sub.set(v, { k: 'var', v: w });
      }
      return sub.get(v).v;
    };
    const atom = (a) => (a.k === 'var' ? (sub.get(a.v) ?? { k: 'var', v: name(a.v) }) : a);
    const rhs = (r) => {
      switch (r.k) {
        case 'atom': return { ...r, a: atom(r.a) };
        case 'prim': case 'cmp': case 'call': case 'ctor': case 'tuple': case 'builtin': return { ...r, args: r.args.map(atom) };
        case 'callc': return { ...r, f: atom(r.f), args: r.args.map(atom) };
        case 'closure': return { ...r, captures: r.captures.map(atom) };
        case 'field': case 'peek': case 'testtag': case 'testlit': return { ...r, x: atom(r.x) };
        case 'expr': return { k: 'expr', e: expr(r.e) };
        default: return r; // staticfn, envfield (not in named functions)
      }
    };
    const expr = (e) => {
      switch (e.k) {
        case 'let': { const r = rhs(e.rhs); return { k: 'let', v: name(e.v), rhs: r, body: expr(e.body) }; }
        case 'ret': return { k: 'ret', rhs: rhs(e.rhs) };
        case 'if': return { k: 'if', c: atom(e.c), t: expr(e.t), e: expr(e.e) };
        default: return e;
      }
    };
    return expr(f.body);
  }

  function walk(e, g) {
    switch (e.k) {
      case 'let': {
        const f = e.rhs.k === 'call' && e.rhs.fn !== g.name ? candidate(e.rhs.fn) : null;
        if (f) {
          inlined++;
          const body = instantiate(f, e.rhs.args, g);
          const rhs = body.k === 'ret' && body.rhs.k !== 'expr' ? body.rhs : { k: 'expr', e: body };
          return { k: 'let', v: e.v, rhs, body: walk(e.body, g) };
        }
        return { ...e, rhs: e.rhs.k === 'expr' ? { k: 'expr', e: walk(e.rhs.e, g) } : e.rhs, body: walk(e.body, g) };
      }
      case 'ret': {
        const f = e.rhs.k === 'call' && e.rhs.fn !== g.name ? candidate(e.rhs.fn) : null;
        if (f) { inlined++; return instantiate(f, e.rhs.args, g); }
        return e.rhs.k === 'expr' ? { k: 'ret', rhs: { k: 'expr', e: walk(e.rhs.e, g) } } : e;
      }
      case 'if': return { ...e, t: walk(e.t, g), e: walk(e.e, g) };
      default: return e;
    }
  }

  // A body that grows past SIZE stops being a candidate, and one that comes to
  // call itself (through an inlined call) does too, so this terminates.
  for (let round = 0; round < rounds; round++) for (const f of ir.fns) f.body = walk(f.body, f);
  return { inlined };
}
