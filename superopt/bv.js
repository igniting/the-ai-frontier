// Bit-blasting for 32-bit WebAssembly integer code.
//
// A Circuit builds CNF through the Tseitin transformation. Gates fold
// constants and are hash-consed, so multiplying by a constant collapses to
// shifts and adds, and structurally equal subterms share variables. Words
// are arrays of 32 literals, least significant bit first.

export { PURE_OPS } from '../src/peephole.js';

export const STACK_EFFECT = {
  'i32.const': [0, 1], 'kconst': [0, 1], 'local.get': [0, 1], 'i32.eqz': [1, 1], select: [3, 1],
};
export const arity = (op) => STACK_EFFECT[op]?.[0] ?? 2;

export class Circuit {
  constructor() {
    this.numVars = 1; // variable 1 is constant true
    this.clauses = [[1]];
    this.memo = new Map();
  }
  get T() { return 1; }
  get F() { return -1; }
  fresh() { return ++this.numVars; }

  and(a, b) {
    if (a === -1 || b === -1 || a === -b) return -1;
    if (a === 1) return b;
    if (b === 1 || a === b) return a;
    const key = a < b ? `&${a},${b}` : `&${b},${a}`;
    let g = this.memo.get(key);
    if (g === undefined) {
      g = this.fresh();
      this.clauses.push([-g, a], [-g, b], [g, -a, -b]);
      this.memo.set(key, g);
    }
    return g;
  }
  or(a, b) { return -this.and(-a, -b); }
  xor(a, b) {
    if (a === -1) return b;
    if (b === -1) return a;
    if (a === 1) return -b;
    if (b === 1) return -a;
    if (a === b) return -1;
    if (a === -b) return 1;
    const key = Math.abs(a) < Math.abs(b) ? `^${a},${b}` : `^${b},${a}`;
    let g = this.memo.get(key);
    if (g === undefined) {
      g = this.fresh();
      this.clauses.push([-g, a, b], [-g, -a, -b], [g, -a, b], [g, a, -b]);
      this.memo.set(key, g);
    }
    return g;
  }
  mux(s, a, b) { // s ? a : b
    if (s === 1) return a;
    if (s === -1) return b;
    if (a === b) return a;
    return this.or(this.and(s, a), this.and(-s, b));
  }

  // ------------------------------------------------------------- words --
  input() { return Array.from({ length: 32 }, () => this.fresh()); }
  constant(v) { return Array.from({ length: 32 }, (_, i) => ((v >>> i) & 1 ? 1 : -1)); }
  bool(l) { return [l, ...Array(31).fill(-1)]; }

  addc(a, b, cin) {
    const out = [];
    let c = cin;
    for (let i = 0; i < 32; i++) {
      const t = this.xor(a[i], b[i]);
      out.push(this.xor(t, c));
      c = this.or(this.and(a[i], b[i]), this.and(c, t));
    }
    return { sum: out, carry: c };
  }
  add(a, b) { return this.addc(a, b, -1).sum; }
  sub(a, b) { return this.addc(a, b.map((x) => -x), 1).sum; }
  ult(a, b) { return -this.addc(a, b.map((x) => -x), 1).carry; } // borrow out of a - b
  slt(a, b) {
    const sa = a[31], sb = b[31];
    return this.mux(this.xor(sa, sb), sa, this.ult(a, b));
  }
  eq(a, b) {
    let r = 1;
    for (let i = 0; i < 32; i++) r = this.and(r, -this.xor(a[i], b[i]));
    return r;
  }
  nonzero(a) { return a.reduce((acc, x) => this.or(acc, x), -1); }

  shiftConst(a, k, kind) {
    k &= 31;
    const fill = kind === 'shr_s' ? a[31] : -1;
    return Array.from({ length: 32 }, (_, i) => {
      if (kind === 'shl') return i - k >= 0 ? a[i - k] : -1;
      return i + k < 32 ? a[i + k] : fill;
    });
  }
  shift(a, amt, kind) {
    // Barrel shifter on the low five bits of the amount (wasm shifts are mod 32).
    let cur = a;
    for (let s = 0; s < 5; s++) {
      const shifted = this.shiftConst(cur, 1 << s, kind);
      cur = cur.map((x, i) => this.mux(amt[s], shifted[i], x));
    }
    return cur;
  }
  mul(a, b) {
    let acc = this.constant(0);
    for (let i = 0; i < 32; i++) {
      if (b[i] === -1) continue;
      const partial = this.shiftConst(a, i, 'shl').map((x) => this.and(x, b[i]));
      acc = this.add(acc, partial);
    }
    return acc;
  }
}

// --------------------------------------------------- symbolic evaluation --
// Evaluates straight-line code over symbolic inputs. `locals` maps names to
// words; `stack` holds the words already on the operand stack.
export function symbolic(c, code, locals, stack = []) {
  const s = [...stack];
  const pop = () => { if (!s.length) throw new Error('stack underflow'); return s.pop(); };
  for (const [op, arg] of code) {
    switch (op) {
      case 'i32.const': s.push(c.constant(arg)); break;
      case 'local.get': s.push(locals[arg]); break;
      case 'i32.eqz': s.push(c.bool(-c.nonzero(pop()))); break;
      case 'select': { const cond = pop(), b = pop(), a = pop(); const nz = c.nonzero(cond); s.push(a.map((x, i) => c.mux(nz, x, b[i]))); break; }
      default: {
        const b = pop(), a = pop();
        switch (op) {
          case 'i32.add': s.push(c.add(a, b)); break;
          case 'i32.sub': s.push(c.sub(a, b)); break;
          case 'i32.mul': s.push(c.mul(a, b)); break;
          case 'i32.and': s.push(a.map((x, i) => c.and(x, b[i]))); break;
          case 'i32.or': s.push(a.map((x, i) => c.or(x, b[i]))); break;
          case 'i32.xor': s.push(a.map((x, i) => c.xor(x, b[i]))); break;
          case 'i32.shl': s.push(c.shift(a, b, 'shl')); break;
          case 'i32.shr_s': s.push(c.shift(a, b, 'shr_s')); break;
          case 'i32.shr_u': s.push(c.shift(a, b, 'shr_u')); break;
          case 'i32.eq': s.push(c.bool(c.eq(a, b))); break;
          case 'i32.ne': s.push(c.bool(-c.eq(a, b))); break;
          case 'i32.lt_s': s.push(c.bool(c.slt(a, b))); break;
          case 'i32.lt_u': s.push(c.bool(c.ult(a, b))); break;
          case 'i32.gt_s': s.push(c.bool(c.slt(b, a))); break;
          case 'i32.gt_u': s.push(c.bool(c.ult(b, a))); break;
          case 'i32.le_s': s.push(c.bool(-c.slt(b, a))); break;
          case 'i32.le_u': s.push(c.bool(-c.ult(b, a))); break;
          case 'i32.ge_s': s.push(c.bool(-c.slt(a, b))); break;
          case 'i32.ge_u': s.push(c.bool(-c.ult(a, b))); break;
          default: throw new Error(`symbolic: unsupported ${op}`);
        }
      }
    }
  }
  return s;
}

// ---------------------------------------------------- concrete evaluation --
export function concrete(code, locals, stack = []) {
  const s = [...stack];
  const pop = () => { if (!s.length) throw new Error('stack underflow'); return s.pop(); };
  for (const [op, arg] of code) {
    switch (op) {
      case 'i32.const': s.push(arg | 0); break;
      case 'local.get': s.push(locals[arg] | 0); break;
      case 'i32.eqz': s.push(pop() === 0 ? 1 : 0); break;
      case 'select': { const cond = pop(), b = pop(), a = pop(); s.push(cond !== 0 ? a : b); break; }
      default: {
        const b = pop(), a = pop();
        let r;
        switch (op) {
          case 'i32.add': r = (a + b) | 0; break;
          case 'i32.sub': r = (a - b) | 0; break;
          case 'i32.mul': r = Math.imul(a, b); break;
          case 'i32.and': r = a & b; break;
          case 'i32.or': r = a | b; break;
          case 'i32.xor': r = a ^ b; break;
          case 'i32.shl': r = a << (b & 31); break;
          case 'i32.shr_s': r = a >> (b & 31); break;
          case 'i32.shr_u': r = (a >>> (b & 31)) | 0; break;
          case 'i32.eq': r = a === b ? 1 : 0; break;
          case 'i32.ne': r = a !== b ? 1 : 0; break;
          case 'i32.lt_s': r = a < b ? 1 : 0; break;
          case 'i32.lt_u': r = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
          case 'i32.gt_s': r = a > b ? 1 : 0; break;
          case 'i32.gt_u': r = (a >>> 0) > (b >>> 0) ? 1 : 0; break;
          case 'i32.le_s': r = a <= b ? 1 : 0; break;
          case 'i32.le_u': r = (a >>> 0) <= (b >>> 0) ? 1 : 0; break;
          case 'i32.ge_s': r = a >= b ? 1 : 0; break;
          case 'i32.ge_u': r = (a >>> 0) >= (b >>> 0) ? 1 : 0; break;
          default: throw new Error(`concrete: unsupported ${op}`);
        }
        s.push(r);
      }
    }
  }
  return s;
}
