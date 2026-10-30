// Proves the Schur number S(k) = n with the Lumen stack, and checks every
// step with something independent of it:
//
//   1. proofs/schur.lm (Lumen) writes both formulas; a separate JavaScript
//      encoder must produce exactly the same clauses, so the formula refuted
//      below is the intended problem.
//   2. proofs/sat.lm (Lumen) splits 1..n into k groups; the split is checked
//      against the definition of sum-free directly, without the CNF.
//   3. proofs/sat.lm (Lumen) refutes 1..n+1; its DRUP proof is checked by
//      superopt/rup.js, a checker written separately in JavaScript.
//
// The only step taken on trust is the symmetry-breaking argument stated in
// schur.lm (1 in group 1, hence 2 in group 2), which is a one-line
// "without loss of generality" over interchangeable groups.
//
//   node proofs/prove-schur.js <k> <n> [--out DIR]   (DIR gets the CNFs and the DRUP proof)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { compile, runWasm } from '../src/compiler.js';
import { lumenSolve } from './lumen-sat.js';
import { checkRup } from '../superopt/rup.js';
import { parseDimacs, referenceEncoding, sameFormula, groupsOf, checkSplit } from './schur-core.js';

export { parseDimacs, referenceEncoding, sameFormula, groupsOf, checkSplit };

const now = () => performance.now();

export function lumenEncode(k, n) {
  const c = compile(readFileSync(new URL('./schur.lm', import.meta.url), 'utf8'), { optimize: true });
  if (!c.ok) throw new Error(c.errors[0].message);
  const r = runWasm(c.wasm, { input: `${k} ${n}` });
  if (r.error) throw new Error(r.error);
  return r.output;
}

export function proveSchur(k, n, { out = null, log = console.log } = {}) {
  const t0 = now();
  const steps = {};
  // 1. Encode with Lumen, and cross-check against the reference encoding.
  const cnfN = lumenEncode(k, n), cnfN1 = lumenEncode(k, n + 1);
  const fN = parseDimacs(cnfN), fN1 = parseDimacs(cnfN1);
  const encodingsAgree = sameFormula(fN, referenceEncoding(k, n)) && sameFormula(fN1, referenceEncoding(k, n + 1));
  log(`encodings: ${fN.clauses.length} and ${fN1.clauses.length} clauses from proofs/schur.lm; ${encodingsAgree ? 'identical to the reference encoder' : 'DIFFERENT from the reference encoder'}`);
  // 2. A split of 1..n.
  let t = now();
  const a = lumenSolve(cnfN);
  const groups = a.sat ? groupsOf(a.model, k, n) : null;
  const splitError = groups ? checkSplit(groups, n) : 'no split found';
  steps.witness = { ms: now() - t, conflicts: a.conflicts, ok: !splitError };
  log(`1..${n}: ${a.sat ? 'split found' : 'UNSATISFIABLE?!'} in ${(steps.witness.ms / 1000).toFixed(1)} s (${a.conflicts} conflicts); ${splitError ? `INVALID: ${splitError}` : 'checked: every group is sum-free'}`);
  if (groups) groups.forEach((g, i) => log(`  group ${i + 1}: ${g.join(' ')}`));
  // 3. No split of 1..n+1, with a checked refutation.
  t = now();
  const b = lumenSolve(cnfN1);
  steps.refutation = { ms: now() - t, conflicts: b.conflicts };
  log(`1..${n + 1}: ${b.sat ? 'SATISFIABLE?!' : 'refuted'} in ${(steps.refutation.ms / 1000).toFixed(1)} s (${b.conflicts} conflicts, ${b.sat ? 0 : b.proof.length} proof lines)`);
  let rup = { ok: false, reason: 'no proof' };
  if (!b.sat) {
    t = now();
    rup = checkRup(fN1.numVars, fN1.clauses, b.proof);
    steps.check = { ms: now() - t, ok: rup.ok, lemmas: b.proof.length };
    log(`refutation ${rup.ok ? 'CHECKED' : `REJECTED (${rup.reason})`} by superopt/rup.js in ${(steps.check.ms / 1000).toFixed(1)} s`);
  }
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/schur-${k}-${n}.cnf`, cnfN);
    writeFileSync(`${out}/schur-${k}-${n + 1}.cnf`, cnfN1);
    if (!b.sat) writeFileSync(`${out}/schur-${k}-${n + 1}.drup`, b.proof.map((c) => [...c, 0].join(' ')).join('\n') + '\n');
  }
  const proved = encodingsAgree && !splitError && !b.sat && rup.ok;
  log(proved ? `PROVED: S(${k}) = ${n}  (${((now() - t0) / 1000).toFixed(1)} s in total)` : `NOT PROVED: S(${k}) = ${n}`);
  return { proved, groups, steps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [k, n] = process.argv.slice(2, 4).map(Number);
  const i = process.argv.indexOf('--out');
  const r = proveSchur(k, n, { out: i >= 0 ? process.argv[i + 1] : null });
  process.exit(r.proved ? 0 : 1);
}
