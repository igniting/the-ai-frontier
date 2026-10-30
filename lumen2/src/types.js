// Types, effect rows, and unification for Hindley–Milner inference with
// row-polymorphic effects.
//
// A function type carries an effect row: the set of effects calling it may
// perform. Rows are a set of labels plus an optional tail variable:
//   {}            pure: no effects
//   {io, fail}    exactly these effects
//   {io | e}      io, plus whatever e turns out to be
// Two labels exist: `io` (input and output) and `fail` (a runtime error the
// program can cause: panic, division by zero, an index out of bounds).
//
// Type variables use the "levels" technique (as in OCaml) for linear-time
// generalization. A type variable may carry the `cmp` constraint: it can only
// be instantiated to a type whose values can be compared, i.e. one that
// contains no functions. This makes `==` and `<` on functions a type error.

import { LumenError } from './diagnostics.js';

export const GENERIC = 1e9;
export const LABELS = ['fail', 'io'];

let counter = 0;
export const newVar = (level, cmp = false) => ({ k: 'var', id: counter++, level, link: null, cmp });
export const newRowVar = (level) => ({ k: 'rvar', id: counter++, level, link: null });
export const tcon = (name, args = []) => ({ k: 'con', name, args });
export const tfun = (params, ret, eff) => ({ k: 'fun', params, ret, eff });
export const ttuple = (elems) => ({ k: 'tuple', elems });
export const row = (labels, tail = null) => ({ k: 'row', labels: [...new Set(labels)].sort(), tail });
export const PURE = () => row([]);

export const INT = tcon('Int');
export const BOOL = tcon('Bool');
export const STRING = tcon('String');
export const UNIT = tcon('Unit');

export function prune(t) {
  while (t.k === 'var' && t.link) t = t.link;
  return t;
}

// A row with every bound tail followed: labels gathered, tail an unbound row variable or null.
export function pruneRow(r) {
  const labels = new Set(r.labels);
  let tail = r.tail;
  while (tail && tail.link) {
    for (const l of tail.link.labels) labels.add(l);
    tail = tail.link.tail;
  }
  return { k: 'row', labels: [...labels].sort(), tail };
}

export class UnifyError extends Error {}

// ----------------------------------------------------------- unification --
// `adts` maps type names to their declarations; it is needed to decide
// whether a user-defined type is comparable.
export function makeUnifier(adts) {
  function occursAdjust(v, t) {
    t = prune(t);
    if (t === v) throw new UnifyError('infinite type');
    if (t.k === 'var') { if (t.level > v.level) t.level = v.level; return; }
    if (t.k === 'con') t.args.forEach((a) => occursAdjust(v, a));
    else if (t.k === 'tuple') t.elems.forEach((a) => occursAdjust(v, a));
    else if (t.k === 'fun') { t.params.forEach((a) => occursAdjust(v, a)); occursAdjust(v, t.ret); adjustRow(v.level, t.eff); }
  }
  function adjustRow(level, r) {
    const p = pruneRow(r);
    if (p.tail && p.tail.level > level) p.tail.level = level;
  }

  // Can values of this type be compared? Marks type variables as needing it.
  function requireCmp(t, seen = new Set()) {
    t = prune(t);
    if (t.k === 'var') { t.cmp = true; return; }
    if (t.k === 'fun') throw new UnifyError('functions cannot be compared');
    if (t.k === 'tuple') { t.elems.forEach((e) => requireCmp(e, seen)); return; }
    t.args.forEach((a) => requireCmp(a, seen));
    const decl = adts.get(t.name);
    if (!decl || seen.has(t.name)) return;
    seen.add(t.name);
    const sub = new Map(decl.params.map((p, i) => [p, t.args[i]]));
    for (const c of decl.ctors) for (const f of c.fieldTypes) requireCmp(substParams(f, sub), seen);
  }

  function unify(a, b) {
    a = prune(a); b = prune(b);
    if (a === b) return;
    if (a.k === 'var') {
      occursAdjust(a, b);
      if (a.cmp) {
        if (b.k === 'var') b.cmp = true; else requireCmp(b);
      }
      a.link = b;
      return;
    }
    if (b.k === 'var') return unify(b, a);
    if (a.k !== b.k) throw new UnifyError('mismatch');
    if (a.k === 'con') {
      if (a.name !== b.name || a.args.length !== b.args.length) throw new UnifyError('mismatch');
      a.args.forEach((x, i) => unify(x, b.args[i]));
      return;
    }
    if (a.k === 'tuple') {
      if (a.elems.length !== b.elems.length) throw new UnifyError('mismatch');
      a.elems.forEach((x, i) => unify(x, b.elems[i]));
      return;
    }
    if (a.params.length !== b.params.length) throw new UnifyError('mismatch');
    a.params.forEach((x, i) => unify(x, b.params[i]));
    unify(a.ret, b.ret);
    unifyRows(a.eff, b.eff);
  }

  // Rows are equal when they have the same labels; an open tail can grow to
  // absorb the labels the other side has.
  function unifyRows(r1, r2) {
    const a = pruneRow(r1), b = pruneRow(r2);
    const onlyA = a.labels.filter((l) => !b.labels.includes(l));
    const onlyB = b.labels.filter((l) => !a.labels.includes(l));
    const extra = (labels) => new EffectError(labels);
    if (!a.tail && !b.tail) {
      if (onlyA.length || onlyB.length) throw extra(onlyA.length ? onlyA : onlyB);
      return;
    }
    if (!a.tail) {
      if (onlyB.length) throw extra(onlyB);
      bindRow(b.tail, row(onlyA, null));
      return;
    }
    if (!b.tail) {
      if (onlyA.length) throw extra(onlyA);
      bindRow(a.tail, row(onlyB, null));
      return;
    }
    if (a.tail === b.tail) {
      if (onlyA.length || onlyB.length) throw new UnifyError('recursive effect row');
      return;
    }
    const fresh = newRowVar(Math.min(a.tail.level, b.tail.level));
    bindRow(a.tail, row(onlyB, fresh));
    bindRow(b.tail, row(onlyA, fresh));
  }

  function bindRow(v, r) {
    const p = pruneRow(r);
    if (p.tail === v) throw new UnifyError('recursive effect row');
    if (p.tail && p.tail.level > v.level) p.tail.level = v.level;
    v.link = r;
  }

  return { unify, unifyRows, requireCmp };
}

export class EffectError extends UnifyError {
  constructor(labels) { super(`effect ${labels.join(', ')}`); this.labels = labels; }
}

// Substitutes declared type parameter names in a field type (used for ADTs).
export function substParams(t, sub) {
  switch (t.k) {
    case 'param': return sub.get(t.name);
    case 'con': return tcon(t.name, t.args.map((a) => substParams(a, sub)));
    case 'tuple': return ttuple(t.elems.map((a) => substParams(a, sub)));
    case 'fun': return tfun(t.params.map((a) => substParams(a, sub)), substParams(t.ret, sub), t.eff);
    default: return t;
  }
}

// ------------------------------------------------ generalize / instantiate --
export function generalize(t, level) {
  t = prune(t);
  if (t.k === 'var') { if (t.level > level) t.level = GENERIC; return; }
  if (t.k === 'con') t.args.forEach((a) => generalize(a, level));
  else if (t.k === 'tuple') t.elems.forEach((a) => generalize(a, level));
  else if (t.k === 'fun') {
    t.params.forEach((a) => generalize(a, level));
    generalize(t.ret, level);
    const r = pruneRow(t.eff);
    if (r.tail && r.tail.level > level) r.tail.level = GENERIC;
  }
}

// Copies a type, replacing generic variables with fresh ones; `inst` records the mapping.
export function instantiate(t, level, inst = new Map()) {
  t = prune(t);
  switch (t.k) {
    case 'var':
      if (t.level !== GENERIC) return t;
      if (!inst.has(t)) inst.set(t, newVar(level, t.cmp));
      return inst.get(t);
    case 'con': return t.args.length ? tcon(t.name, t.args.map((a) => instantiate(a, level, inst))) : t;
    case 'tuple': return ttuple(t.elems.map((a) => instantiate(a, level, inst)));
    case 'fun': {
      const r = pruneRow(t.eff);
      let tail = r.tail;
      if (tail && tail.level === GENERIC) {
        if (!inst.has(tail)) inst.set(tail, newRowVar(level));
        tail = inst.get(tail);
      }
      return tfun(t.params.map((a) => instantiate(a, level, inst)), instantiate(t.ret, level, inst), row(r.labels, tail));
    }
    default: return t;
  }
}

// A function type whose effect row is closed, reopened with a fresh tail:
// a function with effects E may run wherever a superset of E is allowed.
export function openEffect(t, level) {
  t = prune(t);
  if (t.k !== 'fun') return t;
  const r = pruneRow(t.eff);
  if (r.tail) return t;
  return tfun(t.params, t.ret, row(r.labels, newRowVar(level)));
}

// ----------------------------------------------------------------- printing --
export class TypePrinter {
  constructor() { this.names = new Map(); this.rowNames = new Map(); this.rowUses = new Map(); }

  // Counts row-variable occurrences so that a tail used only once (meaning
  // "and any further effects") can be left out of the printed type.
  scan(t) {
    t = prune(t);
    if (t.k === 'con') t.args.forEach((a) => this.scan(a));
    else if (t.k === 'tuple') t.elems.forEach((a) => this.scan(a));
    else if (t.k === 'fun') {
      t.params.forEach((a) => this.scan(a));
      this.scan(t.ret);
      const r = pruneRow(t.eff);
      if (r.tail) this.rowUses.set(r.tail, (this.rowUses.get(r.tail) ?? 0) + 1);
    }
  }

  varName(v) {
    if (!this.names.has(v)) {
      const n = this.names.size;
      this.names.set(v, n < 26 ? String.fromCharCode(97 + n) : `t${n}`);
    }
    return this.names.get(v);
  }

  rowName(v) {
    if (!this.rowNames.has(v)) {
      const n = this.rowNames.size;
      this.rowNames.set(v, n === 0 ? 'e' : `e${n + 1}`);
    }
    return this.rowNames.get(v);
  }

  effect(eff) {
    const r = pruneRow(eff);
    const tail = r.tail && (this.rowUses.get(r.tail) ?? 0) > 1 ? this.rowName(r.tail) : null;
    if (!r.labels.length && !tail) return '';
    if (!tail) return r.labels.length === 1 ? ` ! ${r.labels[0]}` : ` ! {${r.labels.join(', ')}}`;
    return r.labels.length ? ` ! {${r.labels.join(', ')} | ${tail}}` : ` ! ${tail}`;
  }

  show(t, top = true) {
    if (top) this.scan(t);
    t = prune(t);
    switch (t.k) {
      case 'var': return this.varName(t);
      case 'con':
        if (t.name === 'Unit') return '()';
        return t.args.length ? `${t.name}<${t.args.map((a) => this.show(a, false)).join(', ')}>` : t.name;
      case 'tuple': return `(${t.elems.map((a) => this.show(a, false)).join(', ')})`;
      case 'fun': return `fn(${t.params.map((a) => this.show(a, false)).join(', ')}) -> ${this.show(t.ret, false)}${this.effect(t.eff)}`;
      default: return '?';
    }
  }

  // A signature: the type plus any comparability constraints on its variables.
  signature(t) {
    const s = this.show(t);
    const cmp = [...this.names.keys()].filter((v) => v.cmp).map((v) => `${this.names.get(v)}: Cmp`);
    return cmp.length ? `${s} where ${cmp.join(', ')}` : s;
  }
}

export function typeError(msg, span, note) { return new LumenError(msg, span, note); }
