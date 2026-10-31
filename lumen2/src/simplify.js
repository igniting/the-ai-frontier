// Simplification of the monomorphic IR, after inlining and before reference
// counting.
//
//   flatten       `let x = { lets; ret r }` with no branches becomes
//                 `lets; let x = r`, so inlined code is straight-line.
//   known fields  reading field i of a value built by a constructor (or a
//                 tuple) in this function gives that constructor's argument
//                 i, and testing its tag gives a constant.
//   dead code     a constructor, tuple, projection or copy whose result is
//                 never used is removed. Nothing that can fail is removed.
//
// Together these turn a chain of updates to a record (each inlined setter
// takes the record apart and builds a new one) into one unpacking at the
// start and one constructor at the end, with the fields in between updated
// directly. The IR type checker checks the result like any other IR.

export function simplify(fn) {
  const sub = new Map(); // variable -> the atom it stands for
  const known = new Map(); // variable -> { tag, args } of the constructor that built it
  const atom = (a) => {
    while (a.k === 'var' && sub.has(a.v)) a = sub.get(a.v);
    return a;
  };
  const rhs = (r) => {
    switch (r.k) {
      case 'atom': return { ...r, a: atom(r.a) };
      case 'prim': case 'cmp': case 'call': case 'ctor': case 'tuple': case 'builtin': return { ...r, args: r.args.map(atom) };
      case 'callc': return { ...r, f: atom(r.f), args: r.args.map(atom) };
      case 'closure': return { ...r, captures: r.captures.map(atom) };
      case 'field': case 'peek': case 'testtag': case 'testlit': return { ...r, x: atom(r.x) };
      default: return r;
    }
  };
  const straight = (e) => (e.k === 'let' ? e.rhs.k !== 'expr' && straight(e.body) : e.k === 'ret' && e.rhs.k !== 'expr');

  // Rewrites e; k receives the rewritten rhs of a final `ret` when e is spliced into a let.
  function walk(e) {
    switch (e.k) {
      case 'let': {
        if (e.rhs.k === 'expr') {
          const inner = walk(e.rhs.e);
          if (straight(inner)) return splice(inner, e.v, e.body);
          return { ...e, rhs: { k: 'expr', e: inner }, body: walk(e.body) };
        }
        const r = rhs(e.rhs);
        // A field of a known constructor is its argument.
        if ((r.k === 'field' || r.k === 'peek') && r.path.length === 1 && r.x.k === 'var' && known.has(r.x.v)) {
          sub.set(e.v, known.get(r.x.v).args[r.path[0]]);
          return walk(e.body);
        }
        if (r.k === 'testtag' && !r.path.length && r.x.k === 'var' && known.has(r.x.v)) {
          sub.set(e.v, { k: 'bool', b: known.get(r.x.v).tag === r.tag });
          return walk(e.body);
        }
        if (r.k === 'atom') { sub.set(e.v, r.a); return walk(e.body); }
        if ((r.k === 'ctor' && r.args.length) || r.k === 'tuple') known.set(e.v, { tag: r.k === 'ctor' ? r.tag : 0, args: r.args });
        return { k: 'let', v: e.v, rhs: r, body: walk(e.body) };
      }
      case 'ret': return e.rhs.k === 'expr' ? (() => { const inner = walk(e.rhs.e); return straight(inner) ? inner : { k: 'ret', rhs: { k: 'expr', e: inner } }; })() : { k: 'ret', rhs: rhs(e.rhs) };
      case 'if': {
        const c = atom(e.c);
        if (c.k === 'bool') return walk(c.b ? e.t : e.e);
        return { k: 'if', c, t: walk(e.t), e: walk(e.e) };
      }
      default: return e;
    }
  }
  // Splices a straight-line expression's lets before `let v = <its result>; body`.
  function splice(inner, v, body) {
    if (inner.k === 'ret') return walk({ k: 'let', v, rhs: inner.rhs, body });
    return { ...inner, body: splice(inner.body, v, body) };
  }

  // Dead code: instructions that cannot fail and whose result is unused.
  // dce returns the rewritten expression and the variables it uses.
  const PURE = new Set(['ctor', 'tuple', 'peek', 'field', 'testtag', 'testlit', 'staticfn', 'closure']);
  const uses = (x, out) => {
    const add = (a) => { if (a?.k === 'var') out.add(a.v); };
    switch (x.k) {
      case 'atom': add(x.a); break;
      case 'callc': add(x.f); x.args.forEach(add); break;
      case 'closure': x.captures.forEach(add); break;
      case 'field': case 'peek': case 'testtag': case 'testlit': add(x.x); break;
      default: (x.args ?? []).forEach(add);
    }
    return out;
  };
  function dce(e) {
    switch (e.k) {
      case 'let': {
        const [body, used] = dce(e.body);
        if (PURE.has(e.rhs.k) && !used.has(e.v)) return [body, used];
        used.delete(e.v);
        if (e.rhs.k === 'expr') {
          const [inner, u] = dce(e.rhs.e);
          for (const v of u) used.add(v);
          return [{ k: 'let', v: e.v, rhs: { k: 'expr', e: inner }, body }, used];
        }
        uses(e.rhs, used);
        return [{ k: 'let', v: e.v, rhs: e.rhs, body }, used];
      }
      case 'ret': {
        if (e.rhs.k === 'expr') { const [inner, u] = dce(e.rhs.e); return [{ k: 'ret', rhs: { k: 'expr', e: inner } }, u]; }
        return [e, uses(e.rhs, new Set())];
      }
      case 'if': {
        const [t, ut] = dce(e.t), [f, uf] = dce(e.e);
        for (const v of uf) ut.add(v);
        if (e.c.k === 'var') ut.add(e.c.v);
        return [{ ...e, t, e: f }, ut];
      }
      default: return [e, new Set()];
    }
  }

  fn.body = dce(walk(fn.body))[0];
  return fn;
}
