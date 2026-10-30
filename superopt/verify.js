// Re-verifies every rule the compiler ships (src/rules.js) from scratch,
// trusting nothing recorded by the search:
//
//   1. builds the equivalence miter again and asks the SAT solver for a
//      counterexample (the rule holds for all inputs, all values of its
//      symbolic constants that meet its side conditions, and every local it
//      assumes odd);
//   2. checks the solver's refutation with the independent RUP checker;
//   3. runs both sides on random inputs with the concrete evaluator, which
//      shares no code with the bit-blaster.
//
//   node superopt/verify.js [--emit DIR]   (DIR gets rule-N.cnf / rule-N.drup
//                                           for an external checker such as drat-trim)

import { mkdirSync, writeFileSync } from 'node:fs';
import { RULES } from '../src/rules.js';
import { verifyRule } from './verify-core.js';
import { show } from './show.js';

export { verifyRule, randomCheck } from './verify-core.js';

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
