// Reuse, the second half of Perceus. When a `drop x` releases the last
// reference to a constructor cell and the code after it allocates a cell of
// the same size, the memory is handed over directly:
//
//     drop xs; ...; let ys = Cons(y, rest)
//  => let ru = drop-reuse xs; ...; let ys = Cons@ru(y, rest)
//
// `drop-reuse` releases the cell's fields but keeps the cell when it was the
// last reference (ru = the cell), and does a plain decrement otherwise
// (ru = null); `Cons@ru` writes into ru when it is not null and allocates
// otherwise. So a function that rebuilds a uniquely owned structure (insert
// into a tree, reverse a list) updates it in place, and a shared structure is
// copied, without the source code saying which. On a path that does not use
// the token, it is freed at the start of that path.
//
// The size of the dropped cell must be known statically. Inside a match arm
// it is: the arm's tag test fixes the constructor.

const sizeClass = (fields) => { const size = 8 + 8 * fields; return size <= 16 ? 4 : 32 - Math.clz32(size - 1); };

export function insertReuse(fn, adts, mutant = null) {
  let fresh = 0;
  const tests = new Map(); // condition variable -> { x, tag }

  // The size class of the cell x points to, or null when it is not known.
  function dropClass(v, facts) {
    const t = fn.vars.get(v);
    if (t.k === 'tuple') return sizeClass(t.elems.length);
    if (t.k !== 'con' || !adts.has(t.name)) return null;
    const d = adts.get(t.name);
    const possible = facts.get(v) ?? new Set(d.ctors.map((c) => c.idx));
    const classes = new Set([...possible].map((i) => d.ctors[i].fieldTypes.length).filter((n) => n > 0).map(sizeClass));
    return classes.size === 1 ? [...classes][0] : null;
  }
  const allocClass = (rhs) => ((rhs.k === 'ctor' || rhs.k === 'tuple') && rhs.args.length && !rhs.reuse ? sizeClass(rhs.args.length) : null);
  const freeToken = (r, cls, body) => ({ k: 'freetoken', v: r, size: 1 << cls, body });

  // Gives token r to the first allocation of class cls on each path.
  function place(e, r, cls) {
    switch (e.k) {
      case 'let': {
        if (allocClass(e.rhs) === cls) return { e: { ...e, rhs: { ...e.rhs, reuse: r } }, used: true };
        const b = place(e.body, r, cls);
        return { e: { ...e, body: b.e }, used: b.used };
      }
      case 'dup': case 'drop': case 'dropreuse': case 'freetoken': {
        const b = place(e.body, r, cls);
        return { e: { ...e, body: b.e }, used: b.used };
      }
      case 'if': {
        const t = place(e.t, r, cls), f = place(e.e, r, cls);
        if (!t.used && !f.used) return { e, used: false };
        const unused = (b) => (mutant === 'reuse-no-free' ? b : freeToken(r, cls, b));
        return { e: { ...e, t: t.used ? t.e : unused(e.t), e: f.used ? f.e : unused(e.e) }, used: true };
      }
      case 'ret':
        if (allocClass(e.rhs) === cls) return { e: { ...e, rhs: { ...e.rhs, reuse: r } }, used: true };
        return { e, used: false };
      default: return { e, used: false };
    }
  }

  // facts: variable -> the constructor tags it can still have on this path.
  function walk(e, facts) {
    switch (e.k) {
      case 'let':
        if (e.rhs.k === 'testtag' && !e.rhs.path.length && e.rhs.x.k === 'var') tests.set(e.v, { x: e.rhs.x.v, tag: e.rhs.tag });
        return { ...e, rhs: e.rhs.k === 'expr' ? { k: 'expr', e: walk(e.rhs.e, facts) } : e.rhs, body: walk(e.body, facts) };
      case 'if': {
        const test = e.c.k === 'var' ? tests.get(e.c.v) : undefined;
        if (!test) return { ...e, t: walk(e.t, facts), e: walk(e.e, facts) };
        const t = fn.vars.get(test.x);
        const all = new Set(adts.get(t.name).ctors.map((c) => c.idx));
        const before = facts.get(test.x) ?? all;
        const yes = new Map(facts).set(test.x, new Set([test.tag]));
        const no = new Map(facts).set(test.x, new Set([...before].filter((i) => i !== test.tag)));
        return { ...e, t: walk(e.t, yes), e: walk(e.e, no) };
      }
      case 'drop': {
        const cls = dropClass(e.v, facts);
        if (cls !== null) {
          const r = `ru$${fresh++}`;
          const p = place(e.body, r, cls);
          if (p.used) {
            fn.vars.set(r, fn.vars.get(e.v));
            return { k: 'dropreuse', v: e.v, r, body: walk(p.e, facts) };
          }
        }
        return { ...e, body: walk(e.body, facts) };
      }
      case 'dup': case 'dropreuse': case 'freetoken': return { ...e, body: walk(e.body, facts) };
      default: return e;
    }
  }

  fn.body = walk(fn.body, new Map());
  return fn;
}
