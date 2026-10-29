// Pattern-match exhaustiveness and redundancy checking.
//
// Implements the "usefulness" algorithm from Luc Maranget, "Warnings for
// pattern matching" (JFP 2007). A pattern vector q is *useful* with respect to
// a matrix P if some value matches q but no row of P. Then:
//   * an arm is redundant  iff  it is not useful w.r.t. the arms above it;
//   * a match is exhaustive iff  the wildcard vector is not useful,
// and the algorithm can produce a concrete *witness* — an example value that
// no arm handles — which we print in the error message.

import { prune, substitute } from './types.js';
import { decodeBytes } from './lexer.js';

const WILD = { k: 'wild' };

function normalize(p) {
  switch (p.k) {
    case 'pwild':
    case 'pvar':
      return WILD;
    case 'pint':
      return { k: 'ctor', key: `int:${p.v}`, lit: p.v, args: [] };
    case 'pstr':
      return { k: 'ctor', key: `str:${p.v}`, lit: p.v, args: [] };
    case 'pbool':
      return { k: 'ctor', key: String(p.v), args: [] };
    case 'punit':
      return { k: 'ctor', key: '()', args: [] };
    case 'ptuple':
      return { k: 'ctor', key: 'tuple', args: p.elems.map(normalize) };
    case 'pctor':
      return { k: 'ctor', key: p.name, args: p.args.map(normalize) };
  }
  throw new Error(`exhaustive: unknown pattern ${p.k}`);
}

// The complete list of constructors for a type, or null when the type has
// infinitely many (Int, String) or unknowable (functions, type variables) values.
function signature(type, ctx) {
  const t = prune(type);
  if (t.k === 'tuple') return [{ key: 'tuple', arity: t.elems.length, fieldTypes: t.elems }];
  if (t.k !== 'con') return null;
  if (t.name === 'Bool') return [{ key: 'false', arity: 0, fieldTypes: [] }, { key: 'true', arity: 0, fieldTypes: [] }];
  if (t.name === 'Unit') return [{ key: '()', arity: 0, fieldTypes: [] }];
  const info = ctx.typeInfos.get(t.name);
  if (!info) return null;
  const subst = new Map(info.paramVars.map((v, i) => [v, t.args[i]]));
  return info.ctors.map((c) => ({
    key: c.name, arity: c.arity, typeName: info.name, fieldTypes: c.fields.map((f) => substitute(f, subst)),
  }));
}

function specialize(rows, key, arity) {
  const out = [];
  for (const row of rows) {
    const h = row[0];
    if (h.k === 'wild') out.push([...Array(arity).fill(WILD), ...row.slice(1)]);
    else if (h.key === key) out.push([...h.args, ...row.slice(1)]);
  }
  return out;
}

const defaultRows = (rows) => rows.filter((r) => r[0].k === 'wild').map((r) => r.slice(1));

function headCtors(rows) {
  const heads = new Map();
  for (const row of rows) if (row[0].k === 'ctor') heads.set(row[0].key, row[0]);
  return heads;
}

function useful(rows, types, q, ctx) {
  if (rows.length === 0) return true;
  if (q.length === 0) return false;
  const rest = types.slice(1);
  const h = q[0];
  const sig = signature(types[0], ctx);
  if (h.k === 'ctor') {
    const fieldTypes = sig?.find((c) => c.key === h.key)?.fieldTypes ?? [];
    return useful(specialize(rows, h.key, h.args.length), [...fieldTypes, ...rest], [...h.args, ...q.slice(1)], ctx);
  }
  const heads = headCtors(rows);
  if (sig && sig.every((c) => heads.has(c.key))) {
    return sig.some((c) =>
      useful(specialize(rows, c.key, c.arity), [...c.fieldTypes, ...rest], [...Array(c.arity).fill(WILD), ...q.slice(1)], ctx));
  }
  return useful(defaultRows(rows), rest, q.slice(1), ctx);
}

// Returns a vector of witness patterns not matched by any row, or null.
function missing(rows, types, ctx) {
  if (types.length === 0) return rows.length === 0 ? [] : null;
  const rest = types.slice(1);
  const heads = headCtors(rows);
  const sig = signature(types[0], ctx);
  if (sig && sig.every((c) => heads.has(c.key))) {
    for (const c of sig) {
      const w = missing(specialize(rows, c.key, c.arity), [...c.fieldTypes, ...rest], ctx);
      if (w) return [{ k: 'ctor', key: c.key, typeName: c.typeName, args: w.slice(0, c.arity) }, ...w.slice(c.arity)];
    }
    return null;
  }
  const w = missing(defaultRows(rows), rest, ctx);
  if (!w) return null;
  if (heads.size === 0) return [WILD, ...w];
  if (sig) {
    const c = sig.find((c) => !heads.has(c.key));
    return [{ k: 'ctor', key: c.key, typeName: c.typeName, args: Array(c.arity).fill(WILD) }, ...w];
  }
  return [freshLiteral(heads, types[0]), ...w];
}

function freshLiteral(heads, type) {
  const t = prune(type);
  if (t.k === 'con' && t.name === 'Int') {
    for (let n = 0; ; n++) if (!heads.has(`int:${n}`)) return { k: 'ctor', key: `int:${n}`, lit: n, args: [] };
  }
  if (t.k === 'con' && t.name === 'String') {
    for (const s of ['', 'a', 'b', 'c', 'd', 'e']) if (!heads.has(`str:${s}`)) return { k: 'ctor', key: `str:${s}`, lit: s, args: [] };
  }
  return WILD;
}

export function showWitness(p) {
  if (p.k === 'wild') return '_';
  if (p.key === 'tuple') return `(${p.args.map(showWitness).join(', ')})`;
  if (p.key.startsWith('int:')) return String(p.lit);
  if (p.key.startsWith('str:')) return JSON.stringify(decodeBytes(p.lit));
  if (p.typeName === 'List' && (p.key === 'Cons' || p.key === 'Nil')) {
    const elems = [];
    let cur = p;
    while (cur.k === 'ctor' && cur.typeName === 'List' && cur.key === 'Cons') {
      elems.push(showWitness(cur.args[0]));
      cur = cur.args[1];
    }
    if (cur.k === 'ctor' && cur.key === 'Nil') return `[${elems.join(', ')}]`;
    return `[${elems.join(', ')}, ..${showWitness(cur)}]`;
  }
  return p.args.length ? `${p.key}(${p.args.map(showWitness).join(', ')})` : p.key;
}

export function checkMatch(m, ctx) {
  const types = [m.e.ty];
  const rows = [];
  const redundant = [];
  m.arms.forEach((arm, i) => {
    const row = [normalize(arm.pat)];
    if (!useful(rows, types, row, ctx)) redundant.push(i);
    if (!arm.guard) rows.push(row); // a guarded arm may fail, so it covers nothing
  });
  const w = missing(rows, types, ctx);
  return { missing: w ? showWitness(w[0]) : null, redundant };
}

export function checkIrrefutable(pat, ctx) {
  const w = missing([[normalize(pat)]], [pat.ty], ctx);
  return w ? showWitness(w[0]) : null;
}
