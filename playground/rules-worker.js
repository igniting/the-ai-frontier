// Re-proves the superoptimizer's rules in the browser: for each rule, the
// SAT solver refutes "the two sides differ for some input", the RUP checker
// validates that refutation, and both sides are also run on random inputs.

import { RULES } from '../src/rules.js';
import { verifyRule } from '../superopt/verify-core.js';

self.onmessage = () => {
  let lemmas = 0;
  const t0 = performance.now();
  for (const rule of RULES) {
    const t = performance.now();
    const r = verifyRule(rule);
    lemmas += r.proof.lemmas ?? 0;
    self.postMessage({ type: 'rule', id: rule.id, ok: r.ok, lemmas: r.proof.lemmas ?? 0, vars: r.proof.vars, clauses: r.proof.clauses, trivial: !!r.proof.trivial, ms: performance.now() - t });
  }
  self.postMessage({ type: 'done', rules: RULES.length, lemmas, ms: performance.now() - t0 });
};
