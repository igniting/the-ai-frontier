// Synthesis of shorter equivalent code, with machine-checked proofs.
//
// For a window of straight-line i32 code (k stack inputs -> 1 output), we
// enumerate candidate replacements by iterative deepening, evaluating each
// on a set of test vectors in parallel lanes. A candidate that agrees on all
// vectors is then *proved* equivalent for every possible input with the SAT
// solver; a counterexample becomes a new test vector (CEGIS). Proofs are
// re-checked by the independent RUP checker before a rule is accepted.

import { Circuit, symbolic, concrete, arity } from './bv.js';
import { solve } from './sat.js';
import { checkRup } from './rup.js';
import { kValue } from '../src/peephole.js';

export { kValue };

const BINARY = ['i32.add', 'i32.sub', 'i32.mul', 'i32.and', 'i32.or', 'i32.xor', 'i32.shl', 'i32.shr_s', 'i32.shr_u',
  'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u', 'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u'];

// One byte per opcode plus LEB128 immediates: used to break ties between equally long sequences.
export function byteCost(code) {
  return code.reduce((n, [op, arg]) => {
    if (op === 'i32.const') { let v = arg | 0, b = 1; for (;;) { const byte = v & 0x7f; v >>= 7; if ((v === 0 && !(byte & 0x40)) || (v === -1 && (byte & 0x40))) break; b++; } return n + 1 + b; }
    return n + (op === 'local.get' ? 2 : 1);
  }, 0);
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (t ^ (t >>> 14)) | 0; };
}

const EDGES = [0, 1, -1, 2, 3, 5, 0x7fffffff, -0x80000000, 0x3fffffff, -0x40000000, 255, 256, 31, 32, 0x55555555];

function makeVectors(window, n, seed) {
  const r = rng(seed);
  const locals = window.odd;
  return Array.from({ length: n }, (_, t) => {
    const pick = () => (t < EDGES.length * 2 && r() & 1 ? EDGES[(r() >>> 0) % EDGES.length] : r());
    return {
      locals: Object.fromEntries(locals.map((odd, i) => [`x${i}`, odd ? (pick() | 1) : pick()])),
      stack: Array.from({ length: window.inputs }, pick),
    };
  });
}

// ------------------------------------------------------------------ proofs --
// Proves lhs == rhs for all inputs satisfying the preconditions. Constant
// placeholders ['kconst', {k, f, d}] stand for functions of symbolic
// constants K0, K1, ... that are themselves universally quantified.
export function prove(window, lhs, rhs, { conflictLimit = 300000, check = true, keep = false, nonneg = [] } = {}) {
  const c = new Circuit();
  const locals = {};
  window.odd.forEach((odd, i) => {
    locals[`x${i}`] = c.input();
    if (odd) c.clauses.push([locals[`x${i}`][0]]); // precondition: the value is odd
  });
  const stack = Array.from({ length: window.inputs }, () => c.input());
  const ks = {};
  const resolve = (code) => code.map(([op, arg]) => {
    if (op !== 'kconst') return [op, arg];
    ks[arg.k] ??= c.input();
    if (arg.f === 'sum' || arg.f === 'diff') ks[arg.d] ??= c.input();
    return ['word', kWord(c, ks[arg.k], arg, ks)];
  });
  const evalSym = (code) => {
    const words = [];
    const plain = resolve(code).map(([op, arg]) => (op === 'word' ? (words.push(arg), ['local.get', `__w${words.length - 1}`]) : [op, arg]));
    const env = { ...locals };
    words.forEach((w, i) => { env[`__w${i}`] = w; });
    return symbolic(c, plain, env, stack)[0];
  };
  const a = evalSym(lhs);
  const b = evalSym(rhs);
  for (const k of nonneg) if (ks[k]) c.clauses.push([-ks[k][31]]); // side condition: K >= 0
  const diff = a.map((l, i) => c.xor(l, b[i])).reduce((acc, l) => c.or(acc, l), -1);
  if (diff === -1) return { proved: true, trivial: true, vars: c.numVars, clauses: c.clauses.length, lemmas: 0, checked: true };
  c.clauses.push([diff]);
  const t0 = Date.now();
  const r = solve(c.numVars, c.clauses, { conflictLimit });
  const ms = Date.now() - t0;
  if (r.sat === null) return { proved: false, unknown: true };
  if (r.sat) {
    const word = (w) => w.reduce((acc, l, i) => acc | ((l === 1 || (l !== -1 && (l > 0 ? r.model[l] === 1 : r.model[-l] === -1)) ? 1 : 0) << i), 0);
    return {
      proved: false,
      cex: { locals: Object.fromEntries(Object.entries(locals).map(([k, w]) => [k, word(w)])), stack: stack.map(word), ks: Object.fromEntries(Object.entries(ks).map(([k, w]) => [k, word(w)])) },
    };
  }
  const rup = check ? checkRup(c.numVars, c.clauses, r.proof) : { ok: true };
  return {
    ...(keep ? { cnf: { numVars: c.numVars, clauses: c.clauses }, drup: r.proof } : {}), proved: rup.ok, checked: check && rup.ok, vars: c.numVars, clauses: c.clauses.length, lemmas: r.proof.length, conflicts: r.conflicts ?? 0, ms, rupFailure: rup.ok ? null : rup.reason };
}

function kWord(c, k, { f, d }, ks) {
  switch (f) {
    case 'id': return k;
    case 'sum': return c.add(k, ks[d]);
    case 'diff': return c.sub(k, ks[d]);
    case 'add': return c.add(k, c.constant(d));
    case 'neg': return c.sub(c.constant(0), k);
    case 'shl1': return c.shiftConst(k, 1, 'shl');
    case 'shr1': return c.shiftConst(k, 1, 'shr_s');
    default: throw new Error(`kWord: ${f}`);
  }
}


// ------------------------------------------------------------- enumeration --
// Applies one instruction to every test lane at once.
export function applyLanes(op, [a, b, c], n) {
  const out = new Int32Array(n);
  switch (op) {
    case 'i32.add': for (let i = 0; i < n; i++) out[i] = (a[i] + b[i]) | 0; break;
    case 'i32.sub': for (let i = 0; i < n; i++) out[i] = (a[i] - b[i]) | 0; break;
    case 'i32.mul': for (let i = 0; i < n; i++) out[i] = Math.imul(a[i], b[i]); break;
    case 'i32.and': for (let i = 0; i < n; i++) out[i] = a[i] & b[i]; break;
    case 'i32.or': for (let i = 0; i < n; i++) out[i] = a[i] | b[i]; break;
    case 'i32.xor': for (let i = 0; i < n; i++) out[i] = a[i] ^ b[i]; break;
    case 'i32.shl': for (let i = 0; i < n; i++) out[i] = a[i] << (b[i] & 31); break;
    case 'i32.shr_s': for (let i = 0; i < n; i++) out[i] = a[i] >> (b[i] & 31); break;
    case 'i32.shr_u': for (let i = 0; i < n; i++) out[i] = a[i] >>> (b[i] & 31); break;
    case 'i32.eq': for (let i = 0; i < n; i++) out[i] = a[i] === b[i] ? 1 : 0; break;
    case 'i32.ne': for (let i = 0; i < n; i++) out[i] = a[i] !== b[i] ? 1 : 0; break;
    case 'i32.lt_s': for (let i = 0; i < n; i++) out[i] = a[i] < b[i] ? 1 : 0; break;
    case 'i32.gt_s': for (let i = 0; i < n; i++) out[i] = a[i] > b[i] ? 1 : 0; break;
    case 'i32.le_s': for (let i = 0; i < n; i++) out[i] = a[i] <= b[i] ? 1 : 0; break;
    case 'i32.ge_s': for (let i = 0; i < n; i++) out[i] = a[i] >= b[i] ? 1 : 0; break;
    case 'i32.lt_u': for (let i = 0; i < n; i++) out[i] = (a[i] >>> 0) < (b[i] >>> 0) ? 1 : 0; break;
    case 'i32.gt_u': for (let i = 0; i < n; i++) out[i] = (a[i] >>> 0) > (b[i] >>> 0) ? 1 : 0; break;
    case 'i32.le_u': for (let i = 0; i < n; i++) out[i] = (a[i] >>> 0) <= (b[i] >>> 0) ? 1 : 0; break;
    case 'i32.ge_u': for (let i = 0; i < n; i++) out[i] = (a[i] >>> 0) >= (b[i] >>> 0) ? 1 : 0; break;
    case 'i32.eqz': for (let i = 0; i < n; i++) out[i] = a[i] === 0 ? 1 : 0; break;
    case 'select': for (let i = 0; i < n; i++) out[i] = c[i] !== 0 ? a[i] : b[i]; break;
    default: throw new Error(`applyLanes: ${op}`);
  }
  return out;
}

export function synthesize(window, { maxLen = 3, lanes = 48, seed = 1, timeLimitMs = 4000 } = {}) {
  const L = window.code.length;
  const lhsBytes = byteCost(window.code);
  const vectors = makeVectors(window, lanes, seed);
  const consts = new Set([0, 1, 2, 3, 4, -1, -2]);
  for (const [op, arg] of window.code) {
    if (op !== 'i32.const') continue;
    for (const v of [arg, arg + 1, arg - 1, arg + 2, arg - 2, arg * 2, arg >> 1, -arg]) consts.add(v | 0);
  }
  const leaves = [
    ...window.odd.map((_, i) => ['local.get', `x${i}`]),
    ...[...consts].map((v) => ['i32.const', v]),
  ];
  const ops = [...BINARY.map((o) => [o]), ['i32.eqz'], ['select']];
  const t0 = Date.now();
  let target = null;
  const evalLanes = () => { target = Int32Array.from(vectors, (v) => concrete(window.code, v.locals, v.stack)[0]); };
  evalLanes();

  const laneValue = (ins, vec) => (ins[0] === 'i32.const' ? ins[1] : vec.locals[ins[1]]);
  const apply = (op, args) => applyLanes(op, args, vectors.length);
  const equalsTarget = (v) => { for (let i = 0; i < v.length; i++) if (v[i] !== target[i]) return false; return true; };

  for (let len = 0; len < L && len <= maxLen; len++) {
    let found = null;
    let timedOut = false;
    const dfs = (seq, stack) => {
      if (found || timedOut) return;
      if (Date.now() - t0 > timeLimitMs) { timedOut = true; return; }
      const remaining = len - seq.length;
      if (remaining === 0) {
        if (stack.length === 1 && equalsTarget(stack[0])) {
          const p = prove(window, window.code, seq);
          if (p.proved) found = { rhs: [...seq], proof: p };
          else if (p.cex) { // counterexample-guided refinement
            vectors.push({ locals: p.cex.locals, stack: p.cex.stack });
            evalLanes();
            found = 'restart';
          }
        }
        return;
      }
      if (stack.length - 1 > remaining) return; // cannot reduce to one value in time
      for (const leaf of leaves) {
        dfs([...seq, leaf], [...stack, Int32Array.from(vectors, (v) => laneValue(leaf, v))]);
        if (found) return;
      }
      for (const o of ops) {
        const n = arity(o[0]);
        if (stack.length < n) continue;
        dfs([...seq, o], [...stack.slice(0, stack.length - n), apply(o[0], stack.slice(stack.length - n))]);
        if (found) return;
      }
    };
    do {
      found = null;
      dfs([], Array.from({ length: window.inputs }, (_, i) => Int32Array.from(vectors, (v) => v.stack[i])));
    } while (found === 'restart');
    if (found) return { ...found, lhsCost: L, rhsCost: found.rhs.length, bytesSaved: lhsBytes - byteCost(found.rhs) };
    if (timedOut) return null;
  }
  return null;
}

// ---------------------------------------------------------- generalization --
// Tries to replace a rule's constants by symbols proved for all values, so
// one rule covers every literal (e.g. x - K + 1  ==>  x - (K - 1)).
const FAMILIES = [{ f: 'id' }, ...[1, -1, 2, -2, 3, -3, 4, -4].map((d) => ({ f: 'add', d })), { f: 'neg' }, { f: 'shl1' }, { f: 'shr1' }];

export function generalize(window, rhs) {
  const lhsConsts = window.code.map(([op, arg], i) => (op === 'i32.const' ? i : -1)).filter((i) => i >= 0);
  if (!lhsConsts.length) return null;
  // Try abstracting subsets of the LHS constants, largest first; equal
  // constants may also share one symbol (a rule that needs them equal).
  const subsets = [];
  for (let mask = (1 << lhsConsts.length) - 1; mask > 0; mask--) {
    const subset = lhsConsts.filter((_, j) => mask & (1 << j));
    subsets.push({ subset, tied: false });
    const vals = subset.map((idx) => window.code[idx][1]);
    if (new Set(vals).size < vals.length) subsets.push({ subset, tied: true });
  }
  subsets.sort((a, b) => b.subset.length - a.subset.length || a.tied - b.tied);
  for (const { subset, tied } of subsets) {
    const names = new Map();
    const kOf = new Map(subset.map((idx) => {
      const v = window.code[idx][1];
      const key = tied ? v : idx;
      if (!names.has(key)) names.set(key, `K${names.size}`);
      return [idx, names.get(key)];
    }));
    const lhs = window.code.map((ins, i) => (kOf.has(i) ? ['kconst', { k: kOf.get(i), f: 'id' }] : ins));
    const kvals = Object.fromEntries([...kOf].map(([idx, k]) => [k, window.code[idx][1]]));
    // Each RHS constant: a function of some K with the same concrete value, or itself.
    const options = rhs.map((ins) => {
      if (ins[0] !== 'i32.const') return [ins];
      const alts = [];
      for (const k of Object.keys(kvals)) {
        for (const fam of FAMILIES) if (kValue(kvals, { k, ...fam }) === ins[1]) alts.push(['kconst', { k, ...fam }]);
        for (const k2 of Object.keys(kvals)) {
          if (k2 === k) continue;
          for (const f of ['sum', 'diff']) if (kValue(kvals, { k, f, d: k2 }) === ins[1]) alts.push(['kconst', { k, f, d: k2 }]);
        }
      }
      return [...alts, ins];
    });
    // Explore combinations, most general (fewest literal constants) first, capped.
    const combos = [];
    const walk = (i, acc) => {
      if (combos.length > 64) return;
      if (i === options.length) { combos.push(acc); return; }
      for (const o of options[i]) walk(i + 1, [...acc, o]);
    };
    walk(0, []);
    for (const cand of combos) {
      const p = prove(window, lhs, cand, { conflictLimit: 50000 });
      if (p.proved) return { lhs, rhs: cand, proof: p, nonneg: [] };
    }
    // Some rules hold only for non-negative constants (e.g. when doubling
    // one must not overflow into the sign bit): retry with K >= 0 as a side
    // condition when every symbol's example value satisfies it.
    const symbols = Object.keys(kvals);
    if (symbols.every((k) => kvals[k] >= 0)) {
      for (const cand of combos) {
        const p = prove(window, lhs, cand, { conflictLimit: 50000, nonneg: symbols });
        if (p.proved) return { lhs, rhs: cand, proof: p, nonneg: symbols };
      }
    }
  }
  return null;
}
