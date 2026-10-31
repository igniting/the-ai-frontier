// Re-proves every rewrite rule the compiler applies (src/rules.js) from
// scratch: for all values of the inputs, locals and symbolic constants that
// satisfy the rule's side conditions, both sides compute the same value.
// Each refutation is checked by src/rup.js before it counts.
//
//   node superopt/verify.js [--emit DIR]   (DIR gets rule-N.cnf and rule-N.drup)

import { mkdirSync, writeFileSync } from 'node:fs';
import { RULES } from '../src/rules.js';
import { typeOf } from './semantics.js';
import { prove } from './synth.js';

// A rule's inputs, locals and constants, recovered from its left side.
export function signature(rule) {
  const locals = {}, ks = {};
  for (const [op, arg] of rule.lhs) if (op.endsWith('.const') && arg[0] === 'K') ks[arg] = op.slice(0, 3);
  // Locals and stack inputs take the types the two sides need: try each assignment.
  const names = [...new Set(rule.lhs.filter(([op]) => op === 'local.get').map(([, a]) => a))];
  for (const choice of assignments(names.length)) {
    names.forEach((x, i) => { locals[x] = choice[i]; });
    for (let k = 0; k <= 3; k++) {
      for (const ins of assignments(k)) {
        const out = typeOf(rule.lhs, ins, locals);
        const rhs = out && typeOf(rule.rhs, ins, locals);
        if (out?.length === 1 && rhs?.length === 1 && rhs[0] === out[0]) return { inputs: ins, locals: { ...locals }, ks, out: out[0] };
      }
    }
  }
  throw new Error(`rule ${rule.id} does not type-check`);
}
function* assignments(n) {
  for (let m = 0; m < 1 << n; m++) yield Array.from({ length: n }, (_, i) => ((m >> i) & 1 ? 'i32' : 'i64'));
}

export function verifyRule(rule, { keep = false } = {}) {
  const sig = signature(rule);
  return prove({ ...sig, code: rule.lhs }, rule.lhs, rule.rhs, rule.when, { keep });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--emit');
  const dir = i >= 0 ? process.argv[i + 1] : null;
  if (dir) mkdirSync(dir, { recursive: true });
  const t0 = performance.now();
  let bad = 0, lemmas = 0;
  for (const rule of RULES) {
    const p = verifyRule(rule, { keep: !!dir });
    if (!p.ok) { bad++; console.log(`rule ${rule.id}: NOT PROVED${p.counterexample ? ` (counterexample ${JSON.stringify(p.counterexample, (_, v) => (typeof v === 'bigint' ? String(v) : v))})` : ''}`); continue; }
    lemmas += p.lemmas;
    console.log(`rule ${rule.id}: proved (${p.structural ? 'structural' : `${p.lemmas} lemmas`}, ${p.clauses} clauses), proof checked`);
    if (dir) {
      writeFileSync(`${dir}/rule-${rule.id}.cnf`, `p cnf ${p.nvars} ${p.cnf.length}\n${p.cnf.map((c) => `${c.join(' ')} 0`).join('\n')}\n`);
      writeFileSync(`${dir}/rule-${rule.id}.drup`, `${p.proof.map((c) => `${[...c, 0].join(' ')}`).join('\n')}\n`);
    }
  }
  console.log(`${RULES.length - bad} of ${RULES.length} rules proved, ${lemmas} lemmas checked, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  process.exitCode = bad ? 1 : 0;
}
