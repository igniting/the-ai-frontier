// Pattern-match exhaustiveness and redundancy (Maranget, "Warnings for
// pattern matching", 2007). A pattern vector q is *useful* after the rows P if
// some value matches q and no row of P. A match is exhaustive when the
// wildcard is not useful after its unguarded arms; when it is useful, the
// algorithm builds a witness: an example value that no arm handles.

import { prune, substParams } from './types.js';

const WILD = { k: 'wild' };

export function makeExhaustiveness(adts) {
  // Constructors of a type: a finite list, or null for infinite domains.
  function ctorsOf(t) {
    t = prune(t);
    if (t.k === 'tuple') return [{ name: '()tuple', arity: t.elems.length, fields: t.elems }];
    if (t.k !== 'con') return null;
    if (t.name === 'Bool') return [{ name: 'true', arity: 0, fields: [] }, { name: 'false', arity: 0, fields: [] }];
    if (t.name === 'Unit') return [{ name: '()', arity: 0, fields: [] }];
    const decl = adts.get(t.name);
    if (!decl || !decl.ctors) return null;
    const sub = new Map(decl.params.map((p, i) => [p, t.args[i]]));
    return decl.ctors.map((c) => ({ name: c.key, arity: c.fieldTypes.length, fields: c.fieldTypes.map((f) => substParams(f, sub)), display: c.name, list: decl.name === 'List' }));
  }

  // Patterns in a uniform shape: wild, ctor (with a key and arguments) or literal.
  function norm(p) {
    switch (p.k) {
      case 'pwild': case 'pvar': return WILD;
      case 'pbool': return { k: 'ctor', name: String(p.v), args: [] };
      case 'punit': return { k: 'ctor', name: '()', args: [] };
      case 'ptuple': return { k: 'ctor', name: '()tuple', args: p.elems.map(norm) };
      case 'pctor': return { k: 'ctor', name: p.ctorInfo.key, args: p.args.map(norm) };
      case 'pint': return { k: 'lit', v: `i${p.v}` };
      case 'pstr': return { k: 'lit', v: `s${p.v}` };
      default: throw new Error(`exhaust: ${p.k}`);
    }
  }

  function specialize(rows, name, arity) {
    const out = [];
    for (const r of rows) {
      const h = r[0];
      if (h.k === 'wild') out.push([...Array(arity).fill(WILD), ...r.slice(1)]);
      else if ((h.k === 'ctor' || h.k === 'lit') && (h.name ?? h.v) === name) out.push([...(h.args ?? []), ...r.slice(1)]);
    }
    return out;
  }

  function useful(rows, q, tys) {
    if (!q.length) return rows.length ? null : [];
    const [h, ...rest] = q;
    const [t, ...restT] = tys;
    if (h.k === 'ctor' || h.k === 'lit') {
      const name = h.name ?? h.v;
      const args = h.args ?? [];
      const ctor = (ctorsOf(t) ?? []).find((c) => c.name === name);
      const fieldTys = ctor ? ctor.fields : [];
      const w = useful(specialize(rows, name, args.length), [...args, ...rest], [...fieldTys, ...restT]);
      return w && [{ k: 'ctor', name, args: w.slice(0, args.length), ctor }, ...w.slice(args.length)];
    }
    const heads = new Set(rows.map((r) => r[0]).filter((p) => p.k !== 'wild').map((p) => p.name ?? p.v));
    const all = ctorsOf(t);
    if (all && all.every((c) => heads.has(c.name))) {
      for (const c of all) {
        const w = useful(specialize(rows, c.name, c.arity), [...Array(c.arity).fill(WILD), ...rest], [...c.fields, ...restT]);
        if (w) return [{ k: 'ctor', name: c.name, args: w.slice(0, c.arity), ctor: c }, ...w.slice(c.arity)];
      }
      return null;
    }
    const defaults = rows.filter((r) => r[0].k === 'wild').map((r) => r.slice(1));
    const w = useful(defaults, rest, restT);
    if (!w) return null;
    const missing = all?.find((c) => !heads.has(c.name));
    const head = missing ? { k: 'ctor', name: missing.name, args: Array(missing.arity).fill(WILD), ctor: missing } : WILD;
    return [head, ...w];
  }

  function show(p) {
    if (p.k === 'wild') return '_';
    if (p.k === 'lit') return p.v[0] === 'i' ? p.v.slice(1) : JSON.stringify(p.v.slice(1));
    if (p.name === '()tuple') return `(${p.args.map(show).join(', ')})`;
    if (p.name === '()' || p.name === 'true' || p.name === 'false') return p.name;
    const c = p.ctor;
    if (c?.list) {
      // Flatten Cons chains: [a, b] when the list ends in Nil, [a, b, ..] when it ends in a wildcard.
      const items = [];
      let q = p;
      while (q.k === 'ctor' && q.ctor?.list && q.ctor.display === 'Cons') { items.push(show(q.args[0])); q = q.args[1]; }
      if (q.k === 'ctor' && q.ctor?.display === 'Nil') return `[${items.join(', ')}]`;
      return `[${[...items, '..'].join(', ')}]`;
    }
    const name = c?.display ?? p.name;
    return p.args.length ? `${name}(${p.args.map(show).join(', ')})` : name;
  }

  // Returns { missing: string | null, redundant: [arm indices] }.
  function checkMatch(scrutTy, arms) {
    const rows = [];
    const redundant = [];
    arms.forEach((arm, i) => {
      const q = [norm(arm.pat)];
      if (!useful(rows, q, [scrutTy])) redundant.push(i);
      if (!arm.guard) rows.push(q);
    });
    const w = useful(rows, [WILD], [scrutTy]);
    return { missing: w ? show(w[0]) : null, redundant };
  }

  return { checkMatch };
}
