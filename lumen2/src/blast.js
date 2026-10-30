// Deciding linear integer arithmetic by bit-blasting.
//
// A *term* is a linear combination of atoms plus a constant:
//   { coeffs: Map(atom id -> BigInt), c: BigInt }
// An atom is an unknown integer with a range [lo, hi] (a program variable, an
// array length, a value nothing is known about). A *formula* is built from
// comparisons `t <= 0`, `t < 0`, `t == 0`, `t != 0`, Boolean atoms, and
// and/or/not.
//
// To prove that facts imply a goal, the solver is asked whether
// facts && !goal can hold. Every term is encoded as a two's-complement bit
// vector wide enough that no sum overflows (the width comes from the atoms'
// ranges and the coefficients), so bit-vector arithmetic agrees exactly with
// integer arithmetic. UNSAT means the goal is proved; the refutation is
// checked by rup.js before it is believed. SAT gives a counterexample.

import { solve } from './sat.js';
import { checkRefutation } from './rup.js';

// ----------------------------------------------------- terms and formulas --
export const term = (coeffs = new Map(), c = 0n) => ({ coeffs, c });
export const konst = (c) => term(new Map(), BigInt(c));
export const atomTerm = (id) => term(new Map([[id, 1n]]), 0n);
export function addTerms(a, b, sign = 1n) {
  const coeffs = new Map(a.coeffs);
  for (const [id, k] of b.coeffs) {
    const v = (coeffs.get(id) ?? 0n) + sign * k;
    if (v === 0n) coeffs.delete(id); else coeffs.set(id, v);
  }
  return term(coeffs, a.c + sign * b.c);
}
export const subTerms = (a, b) => addTerms(a, b, -1n);
export const scaleTerm = (a, k) => (k === 0n ? konst(0) : term(new Map([...a.coeffs].map(([id, c]) => [id, c * k])), a.c * k));
export const isConst = (t) => t.coeffs.size === 0;

export const TRUE = { k: 'true' }, FALSE = { k: 'false' };
// a op b, for op in < <= > >= == !=
export function compare(op, a, b) {
  switch (op) {
    case '<': return { k: 'lt', t: subTerms(a, b) };
    case '<=': return { k: 'le', t: subTerms(a, b) };
    case '>': return { k: 'lt', t: subTerms(b, a) };
    case '>=': return { k: 'le', t: subTerms(b, a) };
    case '==': return { k: 'eq', t: subTerms(a, b) };
    case '!=': return { k: 'not', a: { k: 'eq', t: subTerms(a, b) } };
    default: throw new Error(op);
  }
}
export const and = (a, b) => (a.k === 'true' ? b : b.k === 'true' ? a : { k: 'and', a, b });
export const or = (a, b) => ({ k: 'or', a, b });
export const not = (a) => (a.k === 'not' ? a.a : { k: 'not', a });
export const boolAtom = (id) => ({ k: 'bvar', id });

// Atoms a formula mentions.
function atomsOf(f, out = new Set()) {
  switch (f.k) {
    case 'lt': case 'le': case 'eq': for (const id of f.t.coeffs.keys()) out.add(id); break;
    case 'bvar': out.add(f.id); break;
    case 'and': case 'or': atomsOf(f.a, out); atomsOf(f.b, out); break;
    case 'not': atomsOf(f.a, out); break;
    default: break;
  }
  return out;
}

// --------------------------------------------------------------- proving --
// atoms: Map(id -> { lo, hi, name, bool? }). Returns
//   { status: 'proved', cnf: { nvars, clauses }, proof, lemmas }
//   { status: 'refuted', model: Map(id -> BigInt | boolean) }
//   { status: 'unknown' }
export function prove(atoms, facts, goal, { mutant = null, maxConflicts = 100000, cone = true } = {}) {
  // Keep only the facts connected to the goal through shared atoms. (If the
  // others contradict each other the goal holds vacuously, in code that can
  // never run; missing that costs nothing but a proof there.)
  const relevant = new Set(atomsOf(goal));
  if (!cone) for (const f of facts) for (const a of atomsOf(f)) relevant.add(a);
  const pending = facts.map((f) => ({ f, atoms: atomsOf(f) }));
  const used = pending.filter((p) => p.atoms.size === 0);
  let rest = pending.filter((p) => p.atoms.size > 0);
  for (let grew = true; grew;) {
    grew = false;
    const next = [];
    for (const p of rest) {
      if ([...p.atoms].some((a) => relevant.has(a))) { used.push(p); for (const a of p.atoms) relevant.add(a); grew = true; } else next.push(p);
    }
    rest = next;
  }

  // The same query (up to renaming atoms) gets the same, already checked, answer.
  const canon = new Map();
  const name = (id) => { if (!canon.has(id)) canon.set(id, canon.size); return canon.get(id); };
  const ser = (f) => {
    switch (f.k) {
      case 'lt': case 'le': case 'eq': return `${f.k}(${[...f.t.coeffs].map(([id, k]) => `${k}*${name(id)}`).join('+')}+${f.t.c})`;
      case 'bvar': return `b${name(f.id)}`;
      case 'and': case 'or': return `${f.k}(${ser(f.a)},${ser(f.b)})`;
      case 'not': return `!${ser(f.a)}`;
      default: return f.k;
    }
  };
  const body = `${used.map((p) => ser(p.f)).join(';')}|${ser(goal)}`;
  const key = `${body}|${[...canon.keys()].map((id) => { const a = atoms.get(id); return a.bool ? 'B' : `${a.lo}:${a.hi}`; }).join(',')}`;
  const back = [...canon.keys()];
  // A planted bug in the solver, the encoder or the checker changes answers, so it bypasses the cache.
  const cached = !['blast-carry', 'sat-claims-unsat', 'rup-accept-all'].includes(mutant);
  if (cached && cache.has(key)) {
    const hit = cache.get(key);
    if (hit.status !== 'refuted') return hit;
    return { status: 'refuted', model: new Map(hit.model.map(([i, v]) => [back[i], v])) };
  }
  const remember = (r) => {
    if (!cached) return r;
    if (cache.size > 20000) cache.clear();
    cache.set(key, r.status === 'refuted' ? { status: 'refuted', model: [...r.model].map(([id, v]) => [canon.get(id), v]).filter(([i]) => i !== undefined) } : r);
    return r;
  };

  // Width: enough bits that no term (or atom range check) can overflow.
  const mag = (id) => { const a = atoms.get(id); return a.bool ? 1n : (a.lo < 0n ? -a.lo : a.lo) > (a.hi < 0n ? -a.hi : a.hi) ? (a.lo < 0n ? -a.lo : a.lo) : (a.hi < 0n ? -a.hi : a.hi); };
  const abs = (x) => (x < 0n ? -x : x);
  let bound = 1n;
  const visitTerms = (f) => {
    switch (f.k) {
      case 'lt': case 'le': case 'eq': {
        let b = abs(f.t.c);
        for (const [id, k] of f.t.coeffs) b += abs(k) * mag(id);
        if (b > bound) bound = b;
        break;
      }
      case 'and': case 'or': visitTerms(f.a); visitTerms(f.b); break;
      case 'not': visitTerms(f.a); break;
      default: break;
    }
  };
  for (const p of used) visitTerms(p.f);
  visitTerms(goal);
  for (const id of relevant) { const a = atoms.get(id); if (!a.bool) { const b = mag(id) * 2n; if (b > bound) bound = b; } }
  const width = bound.toString(2).length + 2;

  const enc = new Encoder(width, mutant);
  const atomBits = new Map();
  const bitsOf = (id) => {
    if (!atomBits.has(id)) {
      const a = atoms.get(id);
      if (a.bool) atomBits.set(id, enc.fresh());
      else {
        const bits = Array.from({ length: width }, () => enc.fresh());
        atomBits.set(id, bits);
        // lo <= x <= hi
        enc.clauses.push([enc.not(enc.sign(enc.sub(bits, enc.constant(a.lo))))]);
        enc.clauses.push([enc.not(enc.sign(enc.sub(enc.constant(a.hi), bits)))]);
      }
    }
    return atomBits.get(id);
  };
  const termBits = (t) => {
    let acc = enc.constant(t.c);
    for (const [id, k] of t.coeffs) acc = enc.add(acc, enc.scale(bitsOf(id), k));
    return acc;
  };
  const formula = (f) => {
    switch (f.k) {
      case 'true': return enc.T;
      case 'false': return -enc.T;
      case 'lt': return enc.sign(termBits(f.t));
      case 'le': { const b = termBits(f.t); return enc.or(enc.sign(b), enc.isZero(b)); }
      case 'eq': return enc.isZero(termBits(f.t));
      case 'bvar': return bitsOf(f.id);
      case 'and': return enc.and(formula(f.a), formula(f.b));
      case 'or': return enc.or(formula(f.a), formula(f.b));
      case 'not': return -formula(f.a);
      default: throw new Error(`blast: ${f.k}`);
    }
  };
  for (const p of used) enc.clauses.push([formula(p.f)]);
  enc.clauses.push([-formula(goal)]);

  const cnf = { nvars: enc.nvars, clauses: enc.clauses };
  const r = solve(cnf.nvars, cnf.clauses, { mutant, maxConflicts });
  if (r.status === 'unknown') return { status: 'unknown' };
  if (r.status === 'unsat') {
    const check = checkRefutation(cnf.nvars, cnf.clauses, r.proof, { mutant });
    if (!check.ok) throw new Error(`internal error: the SAT solver's refutation was rejected by the proof checker (${check.reason})`);
    return remember({ status: 'proved', cnf, proof: r.proof, lemmas: check.lemmas });
  }
  const model = new Map();
  for (const [id, bits] of atomBits) {
    if (atoms.get(id).bool) { model.set(id, r.model[Math.abs(bits)] === (bits > 0 ? 1 : 0)); continue; }
    let v = 0n;
    for (let i = 0; i < width; i++) {
      const l = bits[i];
      const on = (r.model[Math.abs(l)] === 1) === (l > 0);
      if (on) v |= 1n << BigInt(i);
    }
    model.set(id, BigInt.asIntN(width, v));
  }
  return remember({ status: 'refuted', model });
}

const cache = new Map();

// ------------------------------------------------------- the bit circuits --
// Literals are DIMACS integers; variable 1 is constant true (T), so -T is false.
class Encoder {
  constructor(width, mutant) {
    this.width = width;
    this.mutant = mutant;
    this.nvars = 1;
    this.T = 1;
    this.clauses = [[1]];
    this.memo = new Map();
  }
  fresh() { return ++this.nvars; }
  not(x) { return -x; }
  gate(key, make) {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key);
  }
  and(x, y) {
    const T = this.T;
    if (x === -T || y === -T || x === -y) return -T;
    if (x === T) return y;
    if (y === T || x === y) return x;
    const [a, b] = x < y ? [x, y] : [y, x];
    return this.gate(`&${a},${b}`, () => {
      const z = this.fresh();
      this.clauses.push([-z, a], [-z, b], [z, -a, -b]);
      return z;
    });
  }
  or(x, y) { return -this.and(-x, -y); }
  xor(x, y) {
    const T = this.T;
    if (x === -T) return y;
    if (y === -T) return x;
    if (x === T) return -y;
    if (y === T) return -x;
    if (x === y) return -T;
    if (x === -y) return T;
    const [a, b] = Math.abs(x) < Math.abs(y) ? [x, y] : [y, x];
    return this.gate(`^${a},${b}`, () => {
      const z = this.fresh();
      this.clauses.push([-z, a, b], [-z, -a, -b], [z, -a, b], [z, a, -b]);
      return z;
    });
  }
  // The carry of a full adder: at least two of x, y, z.
  maj(x, y, z) {
    if (this.mutant === 'blast-carry') return this.and(x, y);
    return this.or(this.and(x, y), this.and(z, this.or(x, y)));
  }
  constant(k) {
    const bits = [];
    for (let i = 0; i < this.width; i++) bits.push((BigInt.asUintN(this.width, k) >> BigInt(i)) & 1n ? this.T : -this.T);
    return bits;
  }
  add(a, b, carryIn = -this.T) {
    const out = [];
    let c = carryIn;
    for (let i = 0; i < this.width; i++) {
      out.push(this.xor(this.xor(a[i], b[i]), c));
      c = this.maj(a[i], b[i], c);
    }
    return out;
  }
  neg(a) { return this.add(a.map((x) => -x), this.constant(0n), this.T); }
  sub(a, b) { return this.add(a, b.map((x) => -x), this.T); }
  scale(a, k) {
    if (k < 0n) return this.neg(this.scale(a, -k));
    let acc = this.constant(0n);
    for (let shift = 0; k > 0n; shift++, k >>= 1n) {
      if (k & 1n) acc = this.add(acc, [...Array(shift).fill(-this.T), ...a.slice(0, this.width - shift)]);
    }
    return acc;
  }
  sign(a) { return a[this.width - 1]; }
  isZero(a) { return a.reduce((acc, x) => this.and(acc, -x), this.T); }
}
