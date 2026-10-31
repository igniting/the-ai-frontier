// The meaning of the WebAssembly instructions the superoptimizer works with,
// written twice: on concrete values (BigInt), to test a candidate quickly on
// many inputs, and as boolean circuits in CNF, to prove two sequences equal
// for every input with the SAT solver.
//
// Only pure, non-trapping integer instructions appear: arithmetic, bitwise
// operations, shifts and rotations, comparisons, eqz, the conversions
// between i32 and i64, constants and local.get. A sequence is a list of
// [op, arg] pairs. A const's arg is a number, or a constant expression over
// symbolic constants (K0, K1-K0, ...); a local.get's arg is a name (x0, x1).

export const WIDTH = { i32: 32, i64: 64 };
const BINARY = ['add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'shr_s', 'shr_u', 'rotl', 'rotr'];
const COMPARE = ['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u'];

// op -> { in: input types (bottom first), out: result type }
export const SIG = {};
for (const t of ['i32', 'i64']) {
  for (const o of BINARY) SIG[`${t}.${o}`] = { in: [t, t], out: t };
  for (const o of COMPARE) SIG[`${t}.${o}`] = { in: [t, t], out: 'i32' };
  SIG[`${t}.eqz`] = { in: [t], out: 'i32' };
}
SIG['i32.wrap_i64'] = { in: ['i64'], out: 'i32' };
SIG['i64.extend_i32_s'] = { in: ['i32'], out: 'i64' };
SIG['i64.extend_i32_u'] = { in: ['i32'], out: 'i64' };

export const isPure = (op) => op in SIG || op === 'i32.const' || op === 'i64.const' || op === 'local.get';

// ------------------------------------------------------- constant exprs --
// K0, 7, K1-K0, K0+1, -K0: sums and differences of symbolic constants and integers.
export function constTerms(expr) {
  if (typeof expr === 'bigint' || typeof expr === 'number') return [{ sign: 1n, k: null, n: BigInt(expr) }];
  const terms = [];
  for (const m of String(expr).replace(/\s+/g, '').matchAll(/([+-]?)(K\d+|\d+)/g)) {
    const sign = m[1] === '-' ? -1n : 1n;
    terms.push(m[2][0] === 'K' ? { sign, k: m[2], n: 0n } : { sign, k: null, n: BigInt(m[2]) });
  }
  return terms;
}
export function constValue(expr, ks, t) {
  let v = 0n;
  for (const { sign, k, n } of constTerms(expr)) v += sign * (k ? ks[k] : n);
  return BigInt.asUintN(WIDTH[t], v);
}

// ------------------------------------------------------------- concrete --
// Values are unsigned BigInts below 2^width.
const s = (t, v) => BigInt.asIntN(WIDTH[t], v);
const u = (t, v) => BigInt.asUintN(WIDTH[t], v);
const b = (x) => (x ? 1n : 0n);

export function apply(op, args) {
  const [t, o] = op.split('.');
  const w = BigInt(WIDTH[t]);
  const [x, y] = args;
  switch (o) {
    case 'add': return u(t, x + y);
    case 'sub': return u(t, x - y);
    case 'mul': return u(t, x * y);
    case 'and': return x & y;
    case 'or': return x | y;
    case 'xor': return x ^ y;
    case 'shl': return u(t, x << (y % w));
    case 'shr_u': return x >> (y % w);
    case 'shr_s': return u(t, s(t, x) >> (y % w));
    case 'rotl': { const k = y % w; return u(t, (x << k) | (x >> ((w - k) % w))); }
    case 'rotr': { const k = y % w; return u(t, (x >> k) | (x << ((w - k) % w))); }
    case 'eq': return b(x === y);
    case 'ne': return b(x !== y);
    case 'lt_u': return b(x < y);
    case 'gt_u': return b(x > y);
    case 'le_u': return b(x <= y);
    case 'ge_u': return b(x >= y);
    case 'lt_s': return b(s(t, x) < s(t, y));
    case 'gt_s': return b(s(t, x) > s(t, y));
    case 'le_s': return b(s(t, x) <= s(t, y));
    case 'ge_s': return b(s(t, x) >= s(t, y));
    case 'eqz': return b(x === 0n);
    case 'wrap_i64': return u('i32', x);
    case 'extend_i32_s': return u('i64', s('i32', x));
    case 'extend_i32_u': return x;
    default: throw new Error(`no semantics for ${op}`);
  }
}

// Types a sequence. inputs: the types of the stack values below it (bottom
// first); locals: name -> type. Returns the result types, or null if the
// sequence is ill-typed or does not consume exactly its inputs.
export function typeOf(code, inputs, locals) {
  const st = [...inputs];
  for (const [op, arg] of code) {
    if (op === 'i32.const' || op === 'i64.const') st.push(op.slice(0, 3));
    else if (op === 'local.get') { if (!locals[arg]) return null; st.push(locals[arg]); }
    else {
      const sig = SIG[op];
      if (!sig || st.length < sig.in.length) return null;
      for (let i = sig.in.length - 1; i >= 0; i--) if (st.pop() !== sig.in[i]) return null;
      st.push(sig.out);
    }
  }
  return st;
}

// Runs a sequence on concrete values: { stack, locals, ks } -> the final stack.
export function run(code, { stack, locals, ks = {} }) {
  const st = [...stack];
  for (const [op, arg] of code) {
    if (op === 'i32.const' || op === 'i64.const') st.push(constValue(arg, ks, op.slice(0, 3)));
    else if (op === 'local.get') st.push(locals[arg]);
    else { const n = SIG[op].in.length; st.push(apply(op, st.splice(st.length - n, n))); }
  }
  return st;
}

// -------------------------------------------------------------- circuits --
// Literals are DIMACS integers; variable 1 is constant true, so -1 is false.
// Gates are hash-consed, so two sequences that compute the same circuit end
// in the same literals and need no search at all.
export class Circuit {
  constructor() { this.nvars = 1; this.T = 1; this.clauses = [[1]]; this.memo = new Map(); }
  fresh() { return ++this.nvars; }
  input(t) { return Array.from({ length: WIDTH[t] }, () => this.fresh()); }
  constant(t, v) { return Array.from({ length: WIDTH[t] }, (_, i) => ((v >> BigInt(i)) & 1n ? this.T : -this.T)); }
  and(x, y) {
    const T = this.T;
    if (x === -T || y === -T || x === -y) return -T;
    if (x === T) return y;
    if (y === T || x === y) return x;
    const [a, c] = x < y ? [x, y] : [y, x];
    const key = `&${a},${c}`;
    if (!this.memo.has(key)) {
      const z = this.fresh();
      this.clauses.push([-z, a], [-z, c], [z, -a, -c]);
      this.memo.set(key, z);
    }
    return this.memo.get(key);
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
    // Normalize signs so that xor(-a, b) and xor(a, -b) share a gate.
    let neg = false;
    if (x < 0) { x = -x; neg = !neg; }
    if (y < 0) { y = -y; neg = !neg; }
    const [a, c] = x < y ? [x, y] : [y, x];
    const key = `^${a},${c}`;
    if (!this.memo.has(key)) {
      const z = this.fresh();
      this.clauses.push([-z, a, c], [-z, -a, -c], [z, -a, c], [z, a, -c]);
      this.memo.set(key, z);
    }
    return neg ? -this.memo.get(key) : this.memo.get(key);
  }
  mux(sel, x, y) { return this.or(this.and(sel, x), this.and(-sel, y)); }
  any(bits) { return bits.reduce((acc, x) => this.or(acc, x), -this.T); }
  all(bits) { return bits.reduce((acc, x) => this.and(acc, x), this.T); }
  // Ripple-carry addition; returns the sum bits and the carry out.
  addc(a, c2, carry) {
    const out = [];
    for (let i = 0; i < a.length; i++) {
      out.push(this.xor(this.xor(a[i], c2[i]), carry));
      carry = this.or(this.and(a[i], c2[i]), this.and(carry, this.or(a[i], c2[i])));
    }
    return { sum: out, carry };
  }
  add(a, c2) { return this.addc(a, c2, -this.T).sum; }
  sub(a, c2) { return this.addc(a, c2.map((x) => -x), this.T).sum; }
  mul(a, c2) {
    let acc = a.map(() => -this.T);
    for (let i = 0; i < a.length; i++) {
      if (c2[i] === -this.T) continue;
      const partial = a.map((_, j) => (j < i ? -this.T : this.and(c2[i], a[j - i])));
      acc = this.add(acc, partial);
    }
    return acc;
  }
  // Shifts and rotations by an amount taken modulo the width: a barrel shifter.
  shift(a, amount, kind) {
    const w = a.length;
    let cur = a;
    for (let k = 0; (1 << k) < w; k++) {
      const by = 1 << k, sel = amount[k];
      cur = cur.map((_, i) => {
        let from;
        if (kind === 'shl') from = i - by >= 0 ? cur[i - by] : -this.T;
        else if (kind === 'shr_u') from = i + by < w ? cur[i + by] : -this.T;
        else if (kind === 'shr_s') from = i + by < w ? cur[i + by] : cur[w - 1];
        else if (kind === 'rotl') from = cur[(i - by + w) % w];
        else from = cur[(i + by) % w];
        return this.mux(sel, from, cur[i]);
      });
    }
    return cur;
  }
  ltu(a, c2) { return -this.addc(a, c2.map((x) => -x), this.T).carry; } // a - b borrows
  lts(a, c2) {
    const w = a.length;
    const flip = (v) => v.map((x, i) => (i === w - 1 ? -x : x));
    return this.ltu(flip(a), flip(c2));
  }
  eq(a, c2) { return this.all(a.map((x, i) => -this.xor(x, c2[i]))); }
  bool(lit) { return [lit, ...Array(31).fill(-this.T)]; }

  apply(op, args) {
    const [t, o] = op.split('.');
    const [x, y] = args;
    switch (o) {
      case 'add': return this.add(x, y);
      case 'sub': return this.sub(x, y);
      case 'mul': return this.mul(x, y);
      case 'and': return x.map((v, i) => this.and(v, y[i]));
      case 'or': return x.map((v, i) => this.or(v, y[i]));
      case 'xor': return x.map((v, i) => this.xor(v, y[i]));
      case 'shl': case 'shr_s': case 'shr_u': case 'rotl': case 'rotr': return this.shift(x, y, o);
      case 'eq': return this.bool(this.eq(x, y));
      case 'ne': return this.bool(-this.eq(x, y));
      case 'lt_u': return this.bool(this.ltu(x, y));
      case 'gt_u': return this.bool(this.ltu(y, x));
      case 'le_u': return this.bool(-this.ltu(y, x));
      case 'ge_u': return this.bool(-this.ltu(x, y));
      case 'lt_s': return this.bool(this.lts(x, y));
      case 'gt_s': return this.bool(this.lts(y, x));
      case 'le_s': return this.bool(-this.lts(y, x));
      case 'ge_s': return this.bool(-this.lts(x, y));
      case 'eqz': return this.bool(this.all(x.map((v) => -v)));
      case 'wrap_i64': return x.slice(0, 32);
      case 'extend_i32_s': return [...x, ...Array(32).fill(x[31])];
      case 'extend_i32_u': return [...x, ...Array(32).fill(-this.T)];
      default: throw new Error(`no circuit for ${op} (${t})`);
    }
  }

  // A constant expression as a circuit over the symbolic constants' bits
  // (each K has the width of the type it is used at).
  constExpr(expr, ks, t) {
    let acc = this.constant(t, 0n);
    for (const { sign, k, n } of constTerms(expr)) {
      const v = k ? ks[k] : this.constant(t, BigInt.asUintN(WIDTH[t], n));
      if (v.length !== WIDTH[t]) throw new Error(`${k} has the wrong width for ${t}`);
      acc = sign > 0n ? this.add(acc, v) : this.sub(acc, v);
    }
    return acc;
  }

  run(code, { stack, locals, ks }) {
    const st = [...stack];
    for (const [op, arg] of code) {
      if (op === 'i32.const' || op === 'i64.const') st.push(this.constExpr(arg, ks, op.slice(0, 3)));
      else if (op === 'local.get') st.push(locals[arg]);
      else { const n = SIG[op].in.length; st.push(this.apply(op, st.splice(st.length - n, n))); }
    }
    return st;
  }
}
