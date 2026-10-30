// Type representation and unification for Hindley–Milner inference.
//
// We use the "levels" technique (Rémy, as used in OCaml): every type variable
// records the let-nesting level at which it was created. Generalization turns
// variables whose level is deeper than the current one into generic variables
// (level = GENERIC); instantiation copies generic variables into fresh ones.
// This makes generalization linear instead of scanning the environment.

export const GENERIC = 1e9;

let counter = 0;
export const newVar = (level) => ({ k: 'var', id: counter++, level, link: null });
export const tcon = (name, args = []) => ({ k: 'con', name, args });
export const tfun = (params, ret) => ({ k: 'fun', params, ret });
export const ttuple = (elems) => ({ k: 'tuple', elems });

export const INT = tcon('Int');
export const BOOL = tcon('Bool');
export const STRING = tcon('String');
export const UNIT = tcon('Unit');

export function prune(t) {
  if (t.k !== 'var' || !t.link) return t;
  const root = prune(t.link);
  t.link = root; // path compression
  return root;
}

export class UnifyError extends Error {
  constructor(kind, a, b) {
    super(kind);
    this.kind = kind; // 'mismatch' | 'occurs' | 'arity'
    this.a = a;
    this.b = b;
  }
}

// Occurs check that also lowers the level of every variable in `t` to at most
// `v.level`, so variables that escape into an outer binding are not generalized.
function occursAdjust(v, t) {
  t = prune(t);
  switch (t.k) {
    case 'var':
      if (t === v) throw new UnifyError('occurs', v, t);
      if (t.level > v.level) t.level = v.level;
      return;
    case 'con':
      t.args.forEach((a) => occursAdjust(v, a));
      return;
    case 'fun':
      t.params.forEach((p) => occursAdjust(v, p));
      occursAdjust(v, t.ret);
      return;
    case 'tuple':
      t.elems.forEach((x) => occursAdjust(v, x));
  }
}

export function unify(a, b) {
  a = prune(a);
  b = prune(b);
  if (a === b) return;
  if (a.k === 'var' || b.k === 'var') {
    const [v, t] = a.k === 'var' ? [a, b] : [b, a];
    try {
      occursAdjust(v, t);
    } catch (err) {
      throw err.kind === 'occurs' ? new UnifyError('occurs', v, t) : err;
    }
    v.link = t;
    return;
  }
  if (a.k !== b.k) throw new UnifyError('mismatch', a, b);
  switch (a.k) {
    case 'con':
      if (a.name !== b.name || a.args.length !== b.args.length) throw new UnifyError('mismatch', a, b);
      for (let i = 0; i < a.args.length; i++) unify(a.args[i], b.args[i]);
      return;
    case 'fun':
      if (a.params.length !== b.params.length) throw new UnifyError('arity', a, b);
      for (let i = 0; i < a.params.length; i++) unify(a.params[i], b.params[i]);
      unify(a.ret, b.ret);
      return;
    case 'tuple':
      if (a.elems.length !== b.elems.length) throw new UnifyError('mismatch', a, b);
      for (let i = 0; i < a.elems.length; i++) unify(a.elems[i], b.elems[i]);
  }
}

export function generalize(t, level) {
  t = prune(t);
  switch (t.k) {
    case 'var':
      if (t.level > level && t.level !== GENERIC) t.level = GENERIC;
      return;
    case 'con':
      t.args.forEach((a) => generalize(a, level));
      return;
    case 'fun':
      t.params.forEach((p) => generalize(p, level));
      generalize(t.ret, level);
      return;
    case 'tuple':
      t.elems.forEach((x) => generalize(x, level));
  }
}

// Keeps a type's variables from being generalized beyond `level` (for a
// `let` whose right-hand side is not a syntactic value).
export function pinLevels(t, level) {
  t = prune(t);
  switch (t.k) {
    case 'var':
      if (t.level > level && t.level !== GENERIC) t.level = level;
      return;
    case 'con':
      t.args.forEach((a) => pinLevels(a, level));
      return;
    case 'fun':
      t.params.forEach((p) => pinLevels(p, level));
      pinLevels(t.ret, level);
      return;
    case 'tuple':
      t.elems.forEach((x) => pinLevels(x, level));
  }
}

export function instantiate(t, level, subst = new Map()) {
  t = prune(t);
  switch (t.k) {
    case 'var':
      if (t.level !== GENERIC) return t;
      if (!subst.has(t)) subst.set(t, newVar(level));
      return subst.get(t);
    case 'con':
      return t.args.length ? tcon(t.name, t.args.map((a) => instantiate(a, level, subst))) : t;
    case 'fun':
      return tfun(t.params.map((p) => instantiate(p, level, subst)), instantiate(t.ret, level, subst));
    case 'tuple':
      return ttuple(t.elems.map((x) => instantiate(x, level, subst)));
  }
}

// Substitute type variables (by identity) — used to specialize constructor
// field types to a concrete instance of their ADT.
export function substitute(t, map) {
  t = prune(t);
  switch (t.k) {
    case 'var':
      return map.get(t) ?? t;
    case 'con':
      return t.args.length ? tcon(t.name, t.args.map((a) => substitute(a, map))) : t;
    case 'fun':
      return tfun(t.params.map((p) => substitute(p, map)), substitute(t.ret, map));
    case 'tuple':
      return ttuple(t.elems.map((x) => substitute(x, map)));
  }
}

// Internal type names may carry a `#scope` suffix to keep a user-defined type
// distinct from a prelude type with the same name; it is hidden when printing.
export const displayName = (name) => name.replace(/#.*$/, '');

export class TypePrinter {
  constructor() {
    this.names = new Map();
  }
  varName(v) {
    if (!this.names.has(v)) {
      const n = this.names.size;
      this.names.set(v, String.fromCharCode(97 + (n % 26)) + (n >= 26 ? Math.floor(n / 26) : ''));
    }
    return this.names.get(v);
  }
  show(t) {
    t = prune(t);
    switch (t.k) {
      case 'var':
        return this.varName(t);
      case 'con':
        if (t.name === 'Unit') return '()';
        return t.args.length ? `${displayName(t.name)}<${t.args.map((a) => this.show(a)).join(', ')}>` : displayName(t.name);
      case 'fun':
        return `fn(${t.params.map((p) => this.show(p)).join(', ')}) -> ${this.show(t.ret)}`;
      case 'tuple':
        return `(${t.elems.map((x) => this.show(x)).join(', ')}${t.elems.length === 1 ? ',' : ''})`;
    }
  }
}

export const showType = (t) => new TypePrinter().show(t);
