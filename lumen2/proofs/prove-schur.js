// Proves the Schur number S(k) = n with Lumen 2, and checks every step with
// something independent of it:
//
//   1. proofs/schur.lm (Lumen 2) writes both formulas; a reference encoder
//      written here in JavaScript must produce exactly the same clauses, so
//      the formula refuted below is the intended problem.
//   2. proofs/sat.lm (Lumen 2) splits 1..n into k groups; the split is
//      checked against the definition of sum-free directly, without the CNF.
//   3. proofs/sat.lm refutes 1..n+1; its DRUP proof is checked by src/rup.js,
//      a checker that shares no code with the solver.
//
// The only step taken on trust is the symmetry-breaking argument stated in
// schur.lm (1 in group 1, hence 2 in group 2), a one-line "without loss of
// generality" over interchangeable groups.
//
//   node proofs/prove-schur.js <k> <n> [--out DIR]   (DIR gets the CNFs and the DRUP proof)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { compileSource } from '../src/api.js';
import { runWasm } from '../src/runtime.js';
import { makeHost } from '../src/host.js';
import { checkRefutation } from '../src/rup.js';

const program = (file) => {
  const c = compileSource(readFileSync(new URL(file, import.meta.url), 'utf8'));
  if (!c.ok) throw new Error(`${file}: ${c.errors[0].message}`);
  return c.bytes;
};
const run = (bytes, input) => {
  const t = performance.now();
  const r = runWasm(bytes, { input, host: makeHost() });
  if (r.error) throw new Error(r.error);
  if (r.live) throw new Error(`internal error: ${r.live} objects were never freed`);
  return { ...r, ms: performance.now() - t };
};

export function parseDimacs(text) {
  let numVars = 0;
  const clauses = [];
  let cur = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('c') || !line.trim()) continue;
    if (line.startsWith('p')) { numVars = +line.split(/\s+/)[2]; continue; }
    for (const tok of line.trim().split(/\s+/)) {
      const x = +tok;
      if (x === 0) { clauses.push(cur); cur = []; } else cur.push(x);
    }
  }
  return { numVars, clauses };
}

// The encoding, written again: variable (i - 1) * k + c says "i is in group c".
export function referenceEncoding(k, n) {
  const v = (i, c) => (i - 1) * k + c;
  const clauses = [];
  for (let i = 1; i <= n; i++) clauses.push(Array.from({ length: k }, (_, c) => v(i, c + 1)));
  for (let c = 1; c <= k; c++) {
    for (let x = 1; x <= n; x++) {
      for (let y = x; x + y <= n; y++) clauses.push(x === y ? [-v(x, c), -v(2 * x, c)] : [-v(x, c), -v(y, c), -v(x + y, c)]);
    }
  }
  if (n >= 1) clauses.push([v(1, 1)]);
  if (n >= 2 && k >= 2) clauses.push([v(2, 2)]);
  return { numVars: n * k, clauses };
}

const key = (c) => [...c].sort((a, b) => a - b).join(' ');
export function sameFormula(a, b) {
  if (a.numVars !== b.numVars || a.clauses.length !== b.clauses.length) return false;
  const count = new Map();
  for (const c of a.clauses) count.set(key(c), (count.get(key(c)) ?? 0) + 1);
  for (const c of b.clauses) { const m = count.get(key(c)); if (!m) return false; count.set(key(c), m - 1); }
  return true;
}

// Groups from a model: number i goes to the first group its literals allow.
export function groupsOf(model, k, n) {
  const truth = new Set(model.filter((l) => l > 0));
  const groups = Array.from({ length: k }, () => []);
  for (let i = 1; i <= n; i++) {
    const c = [...Array(k).keys()].find((g) => truth.has((i - 1) * k + g + 1));
    if (c === undefined) return null;
    groups[c].push(i);
  }
  return groups;
}

// Do the groups cover 1..n exactly once, and is each sum-free (no x, y, x + y; x = y allowed)?
export function checkSplit(groups, n) {
  const all = groups.flat().sort((a, b) => a - b);
  if (all.length !== n || all.some((x, i) => x !== i + 1)) return 'the groups do not cover 1..n exactly once';
  for (const g of groups) {
    const set = new Set(g);
    for (const x of g) for (const y of g) if (set.has(x + y)) return `${x} + ${y} = ${x + y} in one group`;
  }
  return null;
}

// What sat.lm prints: learnt clauses, a status, then a model or nothing.
export function parseSolverOutput(text) {
  const lines = text.split('\n');
  const status = lines.find((l) => l.startsWith('s '));
  const conflicts = +(/(\d+) conflicts/.exec(lines.find((l) => l.startsWith('c ')) ?? '')?.[1] ?? 0);
  const ints = (l) => l.trim().split(/\s+/).map(Number);
  if (status === 's SATISFIABLE') return { sat: true, model: ints(lines.find((l) => l.startsWith('v ')).slice(2)).slice(0, -1), conflicts };
  if (status !== 's UNSATISFIABLE') throw new Error(`unexpected solver output: ${text.slice(0, 200)}`);
  return { sat: false, proof: lines.filter((l) => /^-?\d/.test(l)).map((l) => ints(l).slice(0, -1)), conflicts, text };
}

export function proveSchur(k, n, { out = null, log = console.log } = {}) {
  const t0 = performance.now();
  const encoder = program('./schur.lm'), solver = program('./sat.lm');
  // 1. Encode with Lumen 2, and cross-check against the reference encoding.
  const cnfN = run(encoder, `${k} ${n}`).output, cnfN1 = run(encoder, `${k} ${n + 1}`).output;
  const fN = parseDimacs(cnfN), fN1 = parseDimacs(cnfN1);
  const encodingsAgree = sameFormula(fN, referenceEncoding(k, n)) && sameFormula(fN1, referenceEncoding(k, n + 1));
  log(`encodings: ${fN.clauses.length} and ${fN1.clauses.length} clauses from proofs/schur.lm; ${encodingsAgree ? 'identical to the reference encoder' : 'DIFFERENT from the reference encoder'}`);
  // 2. A split of 1..n.
  const ra = run(solver, cnfN);
  const a = parseSolverOutput(ra.output);
  const groups = a.sat ? groupsOf(a.model, k, n) : null;
  const splitError = groups ? checkSplit(groups, n) : 'no split found';
  log(`1..${n}: ${a.sat ? 'split found' : 'UNSATISFIABLE?!'} in ${(ra.ms / 1000).toFixed(1)} s (${a.conflicts} conflicts); ${splitError ? `INVALID: ${splitError}` : 'checked: every group is sum-free'}`);
  if (groups) groups.forEach((g, i) => log(`  group ${i + 1}: ${g.join(' ')}`));
  // 3. No split of 1..n+1, with a checked refutation.
  const rb = run(solver, cnfN1);
  const b = parseSolverOutput(rb.output);
  log(`1..${n + 1}: ${b.sat ? 'SATISFIABLE?!' : 'refuted'} in ${(rb.ms / 1000).toFixed(1)} s (${b.conflicts} conflicts, ${b.sat ? 0 : b.proof.length} proof lines)`);
  let rup = { ok: false, reason: 'no proof' };
  let checkMs = 0;
  if (!b.sat) {
    const t = performance.now();
    rup = checkRefutation(fN1.numVars, fN1.clauses, b.proof);
    checkMs = performance.now() - t;
    log(`refutation ${rup.ok ? 'CHECKED' : `REJECTED (${rup.reason})`} by src/rup.js in ${(checkMs / 1000).toFixed(1)} s`);
  }
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/schur-${k}-${n}.cnf`, cnfN);
    writeFileSync(`${out}/schur-${k}-${n + 1}.cnf`, cnfN1);
    if (!b.sat) writeFileSync(`${out}/schur-${k}-${n + 1}.drup`, `${b.proof.map((c) => [...c, 0].join(' ')).join('\n')}\n`);
  }
  const proved = encodingsAgree && !splitError && !b.sat && rup.ok;
  log(proved ? `PROVED: S(${k}) = ${n}  (${((performance.now() - t0) / 1000).toFixed(1)} s in total)` : `NOT PROVED: S(${k}) = ${n}`);
  return { proved, groups, steps: { split: { ms: ra.ms, conflicts: a.conflicts }, refutation: { ms: rb.ms, conflicts: b.conflicts, lines: b.proof?.length }, check: { ms: checkMs, ok: rup.ok } } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [k, n] = process.argv.slice(2, 4).map(Number);
  const i = process.argv.indexOf('--out');
  const r = proveSchur(k, n, { out: i >= 0 ? process.argv[i + 1] : null });
  process.exitCode = r.proved ? 0 : 1;
}
