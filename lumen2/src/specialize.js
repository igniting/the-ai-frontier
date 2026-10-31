// Drop specialization (Perceus, section 2.6). After Perceus and reuse, taking
// a value apart looks like this:
//
//     let a = field v.0          (load, dup)
//     let b = field v.1          (load, dup)
//     let r = drop-reuse v       (if unique: release a and b again, keep the cell)
//
// When v is unique, the dups and the releases cancel out. This pass rewrites
// the sequence to
//
//     let a = peek v.0
//     let b = peek v.1
//     let r = unpack v [a, b] reuse
//
// which at run time checks once: if v is unique, a and b are *moved* out of
// it (no reference counting at all; any other fields are released) and the
// cell is kept for reuse, or freed; otherwise a and b are dup'ed and v's count
// is decremented. Taking apart and rebuilding a uniquely owned record then
// costs one test instead of a dup and a release per field.
//
// The rewrite needs to know the cell's layout, so it applies to tuples and to
// types with a single constructor that has fields (records, lists, options,
// trees), and only when the loads come right before the drop.

import { substParams } from './types.js';

export function specializeDrops(fn, adts, isHeap) {
  // The field types of a cell of type t, or null if they depend on its constructor.
  function layout(t) {
    if (t.k === 'tuple') return t.elems;
    if (t.k !== 'con' || !adts.has(t.name)) return null;
    const d = adts.get(t.name);
    const withFields = d.ctors.filter((c) => c.fieldTypes.length);
    if (withFields.length !== 1) return null;
    const sub = new Map(d.params.map((p, i) => [p, t.args[i]]));
    return withFields[0].fieldTypes.map((f) => substParams(f, sub));
  }

  function walk(e) {
    switch (e.k) {
      case 'let':
      case 'dup': case 'drop': case 'dropreuse': case 'freetoken': case 'unpack': {
        const r = rewrite(e);
        if (r !== e) return walk(r);
        if (e.k === 'let' && e.rhs.k === 'expr') e.rhs = { k: 'expr', e: walk(e.rhs.e) };
        e.body = walk(e.body);
        return e;
      }
      case 'if': return { ...e, t: walk(e.t), e: walk(e.e) };
      default: return e;
    }
  }

  // At a chain of field loads from one variable followed by its drop, rewrites the chain.
  function rewrite(e) {
    const loads = [];
    let cur = e;
    const v = e.k === 'let' && e.rhs.k === 'field' && e.rhs.path.length === 1 && e.rhs.x.k === 'var' ? e.rhs.x.v : null;
    if (v === null) return e;
    while (cur.k === 'let' && cur.rhs.k === 'field' && cur.rhs.path.length === 1 && cur.rhs.x.k === 'var' && cur.rhs.x.v === v) {
      loads.push(cur);
      cur = cur.body;
    }
    if (!((cur.k === 'drop' && cur.v === v) || (cur.k === 'dropreuse' && cur.v === v))) return e;
    const fields = layout(fn.vars.get(v));
    if (!fields) return e;
    const moved = loads.filter((l) => isHeap(l.rhs.ty));
    if (new Set(moved.map((l) => l.rhs.path[0])).size !== moved.length) return e; // the same field twice
    for (const l of moved) { l.rhs = { ...l.rhs, k: 'peek' }; }
    const node = { k: 'unpack', v, xs: moved.map((l) => ({ x: l.v, i: l.rhs.path[0] })), r: cur.k === 'dropreuse' ? cur.r : null, fields, body: cur.body };
    // Splice the unpack in place of the drop.
    loads[loads.length - 1].body = node;
    return e;
  }

  fn.body = walk(fn.body);
  return fn;
}
