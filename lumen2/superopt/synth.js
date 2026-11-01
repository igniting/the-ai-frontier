// Synthesis of shorter equivalent code, with checked proofs.
//
// For a window (k stack inputs and some locals -> one value), we enumerate
// candidate sequences breadth first, shortest first, evaluating each on a
// set of test vectors at once. Two partial sequences that leave the same
// values on every vector are interchangeable, so only one is extended. A
// candidate that matches the window on every vector is then proved equal
// for all inputs by the SAT solver; a counterexample becomes a new test
// vector. A proof counts only after the RUP checker accepts it.
//
// A rule found with concrete constants is then generalized: the window's
// constants become symbolic (K0, K1, ...), the candidate's constants become
// expressions over them (K1-K0), and if the general rule needs a side
// condition (K0 <= K1), the weakest one that makes it provable is kept.

import { SIG, WIDTH, run, typeOf, apply, constValue, Circuit } from './semantics.js';
import { solve } from './sat.js';
import { checkRefutation } from '../src/rup.js';

// ----------------------------------------------------------------- cost --
const lebBytes = (v) => { let n = 1; for (;;) { const byte = v & 0x7fn; v >>= 7n; if ((v === 0n && !(byte & 0x40n)) || (v === -1n && (byte & 0x40n))) return n; n++; } };
export function cost(code, ks = {}) {
  let bytes = 0;
  for (const [op, arg] of code) {
    if (op === 'i32.const' || op === 'i64.const') {
      const t = op.slice(0, 3);
      bytes += 1 + lebBytes(BigInt.asIntN(WIDTH[t], constValue(arg, ks, t)));
    } else bytes += op === 'local.get' ? 2 : 1;
  }
  return { instructions: code.length, bytes };
}
const cheaper = (a, b) => a.instructions < b.instructions || (a.instructions === b.instructions && a.bytes < b.bytes);

// --------------------------------------------------------- test vectors --
function rng(seed) {
  let x = BigInt(seed) * 0x9e3779b97f4a7c15n + 1n;
  return () => { x ^= x << 13n; x ^= x >> 7n; x ^= x << 17n; x &= (1n << 64n) - 1n; return x; };
}
const edges = (t) => { const w = BigInt(WIDTH[t]); return [0n, 1n, 2n, 3n, (1n << w) - 1n, (1n << w) - 2n, 1n << (w - 1n), (1n << (w - 1n)) - 1n, (1n << (w - 1n)) + 1n, w - 1n, w, 255n]; };
function vector(window, r, i, ks) {
  const pick = (t) => {
    const e = edges(t);
    const x = r();
    if (i < 2 * e.length && (x & 1n)) return e[Number((x >> 1n) % BigInt(e.length))];
    if ((x & 6n) === 0n) return BigInt.asUintN(WIDTH[t], (x >> 8n) % 64n - 32n); // small, either sign
    return BigInt.asUintN(WIDTH[t], x >> 3n);
  };
  return {
    stack: window.inputs.map(pick),
    locals: Object.fromEntries(Object.entries(window.locals).map(([x, t]) => [x, pick(t)])),
    ks: ks ?? {},
  };
}
export function makeVectors(window, n = 24, seed = 1) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => vector(window, r, i));
}

// ---------------------------------------------------------------- search --
// Breadth-first enumeration with deduplication by the values a partial
// sequence leaves on the stack. Returns the cheapest candidate cheaper than
// the window, or null.
export function synthesize(window, { maxDepth = 4, maxStates = 60000, seed = 1, deadline = Infinity, focused = false, symbolic = false } = {}) {
  const target = cost(window.code);
  // In symbolic mode the window's constants become K0, K1, ...: each test
  // vector gives them different values (with the same signs and order), so a
  // candidate must work for all of them, and its constants are expressions.
  const lifted = symbolic ? liftConstants(window) : null;
  if (symbolic && !lifted) return null;
  const concreteKs = lifted?.concrete ?? {};
  const relations = lifted ? conditionsFor(lifted.ks, lifted.concrete).filter((c) => c.length === 1).map(([c]) => c) : [];
  if (lifted) window = { ...window, code: lifted.lhs, ks: lifted.ks };
  let vectors = makeVectors(window, 16, seed);
  if (lifted) {
    const r = rng(seed + 7);
    vectors = vectors.map((v, i) => ({ ...v, ks: i === 0 ? concreteKs : sampleKs(lifted, relations, r) }));
  }
  const types = new Set([...window.inputs, ...Object.values(window.locals), window.out,
    ...window.code.filter(([op]) => op in SIG).flatMap(([op]) => [...SIG[op].in, SIG[op].out])]);
  // The alphabet: locals, constants (the window's, small ones and simple combinations), operations.
  const consts = new Map();
  const addConst = (t, v) => { if (types.has(t)) consts.set(`${t}:${BigInt.asIntN(WIDTH[t], v)}`, [`${t}.const`, String(BigInt.asIntN(WIDTH[t], v))]); };
  for (const t of types) for (const v of [0n, 1n, -1n]) addConst(t, v);
  if (lifted) {
    const names = Object.keys(lifted.ks);
    for (const k of names) {
      const t = lifted.ks[k];
      for (const e of [k, `${k}+1`, `${k}-1`, `-${k}`]) consts.set(`${t}:${e}`, [`${t}.const`, e]);
      for (const j of names) if (j !== k && lifted.ks[j] === t) for (const e of [`${k}-${j}`, `${k}+${j}`]) consts.set(`${t}:${e}`, [`${t}.const`, e]);
    }
  } else {
    const wc = window.code.filter(([op]) => op.endsWith('.const')).map(([op, a]) => ({ t: op.slice(0, 3), v: BigInt(a) }));
    for (const a of wc) {
      for (const d of [0n, 1n, -1n]) addConst(a.t, a.v + d);
      addConst(a.t, -a.v);
      for (const c of wc) if (c.t === a.t) { addConst(a.t, a.v - c.v); addConst(a.t, a.v + c.v); }
    }
  }
  let ops = Object.keys(SIG).filter((op) => SIG[op].in.every((t) => types.has(t)) && types.has(SIG[op].out));
  // For long windows, a focused alphabet: the window's own operations and their relatives
  // (the other comparisons of the same width, addition and subtraction, boolean logic).
  if (focused) {
    const own = new Set(window.code.map(([op]) => op).filter((op) => op in SIG));
    const widths = new Set([...own].map((op) => op.slice(0, 3)));
    const compares = [...own].some((op) => /\.(eq|ne|[lg][te]_[su])$/.test(op));
    ops = ops.filter((op) => own.has(op) || (widths.has(op.slice(0, 3)) && /\.(add|sub)$/.test(op))
      || (compares && widths.has(op.slice(0, 3)) && /\.(eq|ne|[lg][te]_[su]|eqz)$/.test(op)) || /^i32\.(and|or|xor|eqz)$/.test(op));
  }
  const alphabet = [...Object.keys(window.locals).map((x) => ['local.get', x]), ...consts.values(), ...ops.map((op) => [op])];

  for (let attempt = 0; attempt < 8; attempt++) {
    const want = vectors.map((v) => run(window.code, v)[0]);
    const found = enumerate(window, alphabet, vectors, want, target, maxDepth, maxStates, deadline, concreteKs);
    if (!found) return null;
    if (lifted) {
      const g = proveWeakest(window, window.code, found, conditionsFor(lifted.ks, lifted.concrete));
      if (g) return { code: found, lhs: window.code, ks: lifted.ks, when: g.when, proof: g.proof };
      const p = prove(window, window.code, found, relations);
      if (!p.counterexample) return null;
      vectors = [...vectors, p.counterexample];
      continue;
    }
    const p = prove(window, window.code, found, []);
    if (p.ok) return { code: found, proof: p };
    if (!p.counterexample) return null;
    vectors = [...vectors, p.counterexample];
  }
  return null;
}

function enumerate(window, alphabet, vectors, want, target, maxDepth, maxStates, deadline, concreteKs) {
  const n = vectors.length;
  const constVals = new Map(alphabet.filter(([op]) => op.endsWith('.const')).map((ins) => [ins, vectors.map((v) => constValue(ins[1], v.ks, ins[0].slice(0, 3)))]));
  const wantKey = want.join(',');
  // A state: the stack (types and values on every vector), how many inputs are still below it, and the code.
  const start = { st: [], left: window.inputs.length, code: [] };
  let frontier = [start];
  const seen = new Set();
  let best = null;
  const inputVals = window.inputs.map((_, i) => vectors.map((v) => v.stack[i]));
  for (let depth = 1; depth <= maxDepth && depth < target.instructions + 1; depth++) {
    const next = [];
    for (const s of frontier) {
      if (performance.now() > deadline) return best;
      for (const ins of alphabet) {
        const [op, arg] = ins;
        let st, left = s.left;
        if (op === 'local.get') st = [...s.st, { t: window.locals[arg], v: vectors.map((v) => v.locals[arg]) }];
        else if (op.endsWith('.const')) st = [...s.st, { t: op.slice(0, 3), v: constVals.get(ins) }];
        else {
          const sig = SIG[op];
          const args = [];
          st = [...s.st];
          let ok = true;
          for (let i = sig.in.length - 1; i >= 0; i--) {
            let e;
            if (st.length) e = st.pop();
            else if (left > 0) { left--; e = { t: window.inputs[left], v: inputVals[left] }; } else { ok = false; break; }
            if (e.t !== sig.in[i]) { ok = false; break; }
            args.unshift(e.v);
          }
          if (!ok) continue;
          st.push({ t: sig.out, v: vectors.map((_, j) => apply(op, args.map((a) => a[j]))) });
        }
        const code = [...s.code, ins];
        // Each remaining instruction can lower the stack by at most one.
        if (st.length + left - 1 > maxDepth - depth) continue;
        if (st.length === 1 && left === 0 && st[0].t === window.out && st[0].v.join(',') === wantKey) {
          const c = cost(code, concreteKs);
          if (cheaper(c, target) && (!best || cheaper(c, cost(best, concreteKs)))) best = code;
          continue;
        }
        const key = `${left}|${st.map((e) => `${e.t}:${e.v.join(',')}`).join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (next.length < maxStates) next.push({ st, left, code });
      }
    }
    if (best) return best;
    frontier = next;
  }
  return best;
}

// --------------------------------------------------------------- proofs --
// Proves lhs == rhs for every value of the stack inputs, the locals and the
// symbolic constants that satisfies the side conditions `when`. Returns
// { ok, structural, lemmas, vars, clauses, cnf?, proof? } or, when they
// differ, { ok: false, counterexample }.
export function prove(window, lhs, rhs, when, { maxConflicts = 400000, keep = false } = {}) {
  const c = new Circuit();
  const stack = window.inputs.map((t) => c.input(t));
  const locals = Object.fromEntries(Object.entries(window.locals).map(([x, t]) => [x, c.input(t)]));
  const ks = Object.fromEntries(Object.entries(window.ks ?? {}).map(([k, t]) => [k, c.input(t)]));
  for (const cond of when) c.clauses.push([condition(c, cond, ks)]);
  const a = c.run(lhs, { stack, locals, ks })[0];
  const b = c.run(rhs, { stack, locals, ks })[0];
  const differ = c.any(a.map((x, i) => c.xor(x, b[i])));
  const structural = differ === -c.T;
  c.clauses.push([differ]);
  const r = solve(c.nvars, c.clauses, { maxConflicts });
  if (r.status === 'unknown') return { ok: false, unknown: true };
  if (r.status === 'sat') {
    const val = (bits) => bits.reduce((v, l, i) => ((r.model[Math.abs(l)] === 1) === (l > 0) ? v | (1n << BigInt(i)) : v), 0n);
    return {
      ok: false,
      counterexample: {
        stack: stack.map(val),
        locals: Object.fromEntries(Object.entries(locals).map(([x, bits]) => [x, val(bits)])),
        ks: Object.fromEntries(Object.entries(ks).map(([k, bits]) => [k, val(bits)])),
      },
    };
  }
  const check = checkRefutation(c.nvars, c.clauses, r.proof);
  if (!check.ok) throw new Error(`internal error: a superoptimizer proof was rejected (${check.reason})`);
  return { ok: true, structural, lemmas: check.lemmas, vars: c.nvars, clauses: c.clauses.length, ...(keep ? { cnf: c.clauses, nvars: c.nvars, proof: r.proof } : {}) };
}

// Side conditions: signed comparisons between symbolic constants or with 0.
export const CONDITIONS = ['!=', '<=', '<', '>=', '>'];
export function holds(cond, ks, kTypes) {
  const [x, op, y] = cond.split(' ');
  const t = kTypes[x];
  const v = (e) => BigInt.asIntN(WIDTH[t], e[0] === 'K' ? ks[e] : BigInt(e));
  const a = v(x), b = v(y);
  return op === '<=' ? a <= b : op === '<' ? a < b : op === '>=' ? a >= b : op === '!=' ? a !== b : a > b;
}
function condition(c, cond, ks) {
  const [x, op, y] = cond.split(' ');
  const w = ks[x].length;
  const vec = (e) => (e[0] === 'K' ? ks[e] : c.constant(w === 32 ? 'i32' : 'i64', BigInt.asUintN(w, BigInt(e))));
  const a = vec(x), b = vec(y);
  return op === '<=' ? -c.lts(b, a) : op === '<' ? c.lts(a, b) : op === '>=' ? -c.lts(a, b) : op === '!=' ? -c.eq(a, b) : c.lts(b, a);
}

// ---------------------------------------------------------- generalizing --
// The window with its constants made symbolic. 0, 1 and -1 stay literal:
// they usually matter as themselves.
function liftConstants(window, all = false) {
  const kOf = [];
  const ks = {};
  const lhs = window.code.map(([op, arg]) => {
    if (!op.endsWith('.const')) return [op, arg];
    const v = BigInt(arg);
    if (!all && v >= -1n && v <= 1n) return [op, arg];
    const t = op.slice(0, 3);
    let i = kOf.findIndex((k) => k.t === t && k.v === v);
    if (i < 0) { i = kOf.length; kOf.push({ t, v }); ks[`K${i}`] = t; }
    return [op, `K${i}`];
  });
  if (!kOf.length) return null;
  const concrete = Object.fromEntries(kOf.map((k, i) => [`K${i}`, BigInt.asUintN(WIDTH[k.t], k.v)]));
  return { lhs, ks, kOf, concrete };
}

// Candidate side conditions that hold for the concrete constants, weakest (none) first.
function conditionsFor(ks, concrete) {
  const conds = [[]];
  const names = Object.keys(ks);
  for (const x of names) {
    for (const op of CONDITIONS) conds.push([`${x} ${op} 0`]);
    for (const y of names) if (x !== y && ks[x] === ks[y]) for (const op of ['!=', '<=', '<']) conds.push([`${x} ${op} ${y}`]);
  }
  return conds.filter((cs) => cs.every((cond) => holds(cond, concrete, ks)));
}

function proveWeakest(gw, lhs, rhs, usable) {
  for (const when of usable) {
    const p = prove(gw, lhs, rhs, when);
    if (p.ok) return { when, proof: p };
    if (p.unknown) return null;
  }
  return null;
}

// Random constants with the same signs and order as the concrete ones.
function sampleKs(lifted, relations, r) {
  for (let tries = 0; tries < 200; tries++) {
    const ks = {};
    for (const [k, t] of Object.entries(lifted.ks)) {
      const c = BigInt.asIntN(WIDTH[t], lifted.concrete[k]);
      const x = r();
      const mode = Number(x % 4n);
      let v = mode === 0 ? c + ((x >> 8n) % 7n) - 3n : mode === 1 ? (c < 0n ? -1n : 1n) * ((x >> 8n) % 1000n + 2n) : BigInt.asIntN(WIDTH[t], x >> 2n);
      if (mode >= 2 && (v < 0n) !== (c < 0n)) v = -v;
      ks[k] = BigInt.asUintN(WIDTH[t], v);
    }
    if (relations.every((cond) => holds(cond, ks, lifted.ks))) return ks;
  }
  return lifted.concrete;
}

// Turns a concrete rule into one over symbolic constants, if it can be proved.
// First with 0, 1 and -1 kept literal, then with every constant symbolic.
export function generalize(window, rhs) {
  for (const all of [false, true]) {
    const g = generalizeWith(window, rhs, all);
    if (g) return g;
  }
  return null;
}
function generalizeWith(window, rhs, all) {
  const lifted = liftConstants(window, all);
  if (!lifted) return null;
  const { lhs, ks, kOf } = lifted;
  // Each constant of the candidate: the expressions over K that equal it.
  const options = rhs.map(([op, arg]) => {
    if (!op.endsWith('.const')) return [[op, arg]];
    const t = op.slice(0, 3);
    const v = BigInt.asIntN(WIDTH[t], BigInt(arg));
    const eq = (e) => BigInt.asIntN(WIDTH[t], e) === v;
    const forms = [];
    kOf.forEach((a, i) => {
      if (a.t !== t) return;
      if (eq(a.v)) forms.push(`K${i}`);
      if (eq(a.v + 1n)) forms.push(`K${i}+1`);
      if (eq(a.v - 1n)) forms.push(`K${i}-1`);
      if (eq(-a.v)) forms.push(`-K${i}`);
      kOf.forEach((b, j) => {
        if (j === i || b.t !== t) return;
        if (eq(a.v - b.v)) forms.push(`K${i}-K${j}`);
        if (j > i && eq(a.v + b.v)) forms.push(`K${i}+K${j}`);
      });
    });
    return [...forms.map((f) => [op, f]), [op, arg]];
  });
  const usable = conditionsFor(ks, lifted.concrete);
  const gw = { ...window, code: lhs, ks };
  for (const r of product(options).slice(0, 16)) {
    const g = proveWeakest(gw, lhs, r, usable);
    if (g) return { lhs, rhs: r, ks, when: g.when, proof: g.proof };
  }
  return null;
}

function product(lists) {
  return lists.reduce((acc, opts) => acc.flatMap((prefix) => opts.map((o) => [...prefix, o])), [[]]);
}

export { typeOf };
