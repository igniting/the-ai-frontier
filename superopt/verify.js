// Re-verifies every rule the compiler ships (src/rules.js) from scratch,
// trusting nothing recorded by the search:
//
//   1. builds the equivalence miter again and asks the SAT solver for a
//      counterexample (the rule holds for all inputs, all values of its
//      symbolic constants, and every local it assumes odd);
//   2. checks the solver's refutation with the independent RUP checker;
//   3. runs both sides on random inputs with the concrete evaluator, which
//      shares no code with the bit-blaster.
//
//   node superopt/verify.js [--emit DIR]   (DIR gets rule-N.cnf / rule-N.drup
//                                           for an external checker such as drat-trim)

import { mkdirSync, writeFileSync } from 'node:fs';
import { RULES } from '../src/rules.js';
import { prove } from './synth.js';
import { concrete } from './bv.js';
import { kValue } from '../src/peephole.js';
import { show } from './show.js';

export function randomCheck(rule, trials = 2000, seed = 7) {
  let a = seed >>> 0;
  const rnd = () => { a = (Math.imul(a ^ (a >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0; a ^= a >>> 13; return a; };
  const pick = () => { const r = rnd(); return (r & 3) === 0 ? [0, 1, -1, 2, 3, 0x7fffffff, -0x80000000][(r >>> 2) % 7] : r; };
  const names = new Set(rule.lhs.filter(([op]) => op === 'kconst').map(([, arg]) => arg.k));
  for (let t = 0; t < trials; t++) {
    const ks = Object.fromEntries([...names].map((k) => [k, pick()]));
    const locals = Object.fromEntries(rule.odd.map((odd, i) => [`x${i}`, odd ? pick() | 1 : pick()]));
    const stack = Array.from({ length: rule.inputs }, pick);
    const inst = (code) => code.map(([op, arg]) => (op === 'kconst' ? ['i32.const', kValue(ks, arg)] : [op, arg]));
    const l = concrete(inst(rule.lhs), locals, stack);
    const r = concrete(inst(rule.rhs), locals, stack);
    if (l.length !== 1 || r.length !== 1 || l[0] !== r[0]) return { ok: false, ks, locals, stack, lhs: l, rhs: r };
  }
  return { ok: true, trials };
}

export function verifyRule(rule, { keep = false } = {}) {
  const p = prove({ odd: rule.odd, inputs: rule.inputs }, rule.lhs, rule.rhs, { keep });
  const rnd = randomCheck(rule);
  return { ok: p.proved && p.checked && rnd.ok, proof: p, random: rnd };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--emit');
  const emit = i >= 0 ? process.argv[i + 1] : null;
  if (emit) mkdirSync(emit, { recursive: true });
  let failed = 0, lemmas = 0;
  const t0 = Date.now();
  for (const rule of RULES) {
    const r = verifyRule(rule, { keep: !!emit });
    lemmas += r.proof.lemmas ?? 0;
    if (!r.ok) { failed++; console.log(`FAIL #${rule.id} ${show(rule.lhs)} ==> ${show(rule.rhs)}`, r.proof.cex ?? r.proof.rupFailure ?? r.random); }
    if (emit && r.proof.cnf) {
      const { numVars, clauses } = r.proof.cnf;
      writeFileSync(`${emit}/rule-${rule.id}.cnf`, `c ${show(rule.lhs)} ==> ${show(rule.rhs)}\np cnf ${numVars} ${clauses.length}\n${clauses.map((c) => `${c.join(' ')} 0`).join('\n')}\n`);
      writeFileSync(`${emit}/rule-${rule.id}.drup`, r.proof.drup.map((c) => `${c.join(' ')} 0`).join('\n') + '\n');
    }
  }
  console.log(`${RULES.length - failed}/${RULES.length} rules re-proved (${lemmas} lemmas RUP-checked, plus random testing) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(failed ? 1 : 0);
}
