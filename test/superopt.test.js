// The superoptimizer's trusted base: the SAT solver against brute force, the
// RUP checker against corrupted proofs, the bit-blaster against the
// concrete evaluator, and every shipped rule re-proved from scratch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../superopt/sat.js';
import { checkRup } from '../superopt/rup.js';
import { Circuit, symbolic, concrete } from '../superopt/bv.js';
import { synthesize, prove } from '../superopt/synth.js';
import { verifyRule } from '../superopt/verify.js';
import { RULES } from '../src/rules.js';
import { rewriteRun, indexRules, foldBinary } from '../src/peephole.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0); };
}

const satisfies = (clauses, assign) => clauses.every((c) => c.some((l) => (l > 0 ? assign[l] : !assign[-l])));

test('SAT solver agrees with brute force on random 3-CNF, and its UNSAT proofs check', () => {
  const r = rng(11);
  let unsat = 0;
  for (let t = 0; t < 400; t++) {
    const n = 4 + (r() % 9), m = Math.round(n * (3 + (r() % 30) / 10));
    const clauses = Array.from({ length: m }, () => Array.from({ length: 3 }, () => (1 + (r() % n)) * (r() & 1 ? 1 : -1)));
    let brute = false;
    for (let bits = 0; bits < 1 << n && !brute; bits++) {
      const a = [null]; for (let v = 1; v <= n; v++) a.push(!!(bits & (1 << (v - 1))));
      brute = satisfies(clauses, a);
    }
    const res = solve(n, clauses);
    assert.equal(res.sat, brute, `instance ${t}`);
    if (res.sat) assert.ok(satisfies(clauses, [null, ...Array.from({ length: n }, (_, i) => res.model[i + 1] === 1)]));
    else { unsat++; assert.ok(checkRup(n, clauses, res.proof).ok, `proof ${t}`); }
  }
  assert.ok(unsat > 50, 'the test should exercise unsatisfiable instances');
});

// The obvious, slow RUP check: unit propagation from scratch for every lemma.
function naiveRup(clauses, proof) {
  const db = clauses.map((c) => [...c]);
  if (!proof.length || proof[proof.length - 1].length) return false;
  for (const lemma of proof) {
    const val = new Map(lemma.map((l) => [Math.abs(l), l < 0]));
    let conflict = lemma.some((l) => lemma.includes(-l)), changed = true;
    while (!conflict && changed) {
      changed = false;
      for (const c of db) {
        const open = [...new Set(c.filter((l) => !val.has(Math.abs(l))))];
        if (c.some((l) => val.get(Math.abs(l)) === l > 0)) continue;
        if (open.length === 0) { conflict = true; break; }
        if (open.length === 1) { val.set(Math.abs(open[0]), open[0] > 0); changed = true; }
      }
    }
    if (!conflict) return false;
    db.push(lemma);
  }
  return true;
}

test('the watched-literal RUP checker agrees with a naive one on real and corrupted proofs', () => {
  const r = rng(23);
  let rejected = 0;
  for (let t = 0; t < 300; t++) {
    const n = 5 + (r() % 6), m = Math.round(n * 5);
    const clauses = Array.from({ length: m }, () => Array.from({ length: 3 }, () => (1 + (r() % n)) * (r() & 1 ? 1 : -1)));
    const res = solve(n, clauses);
    if (res.sat) continue;
    let proof = res.proof;
    if (t % 2) { // corrupt it: drop a lemma, or flip a literal
      proof = proof.map((c) => [...c]);
      if (proof.length > 1 && r() & 1) proof.splice(r() % (proof.length - 1), 1);
      else { const c = proof[r() % proof.length]; if (c.length) c[0] = -c[0]; }
    }
    const fast = checkRup(n, clauses, proof).ok;
    assert.equal(fast, naiveRup(clauses, proof), `instance ${t}`);
    if (!fast) rejected++;
  }
  assert.ok(rejected > 5, 'some corrupted proofs should be rejected');
});

test('RUP checker rejects proofs that skip steps or claim a satisfiable formula is unsat', () => {
  // (x1 | x2) & (!x1 | x2) & (x1 | !x2) & (!x1 | !x2) is unsat; the proof [x1], [] is valid.
  const f = [[1, 2], [-1, 2], [1, -2], [-1, -2]];
  assert.ok(checkRup(2, f, [[1], []]).ok);
  assert.equal(checkRup(2, f, [[1]]).ok, false, 'must end with the empty clause');
  assert.equal(checkRup(2, f.slice(1), [[]]).ok, false, 'drop a clause: now satisfiable');
  assert.equal(checkRup(3, [[1, 2, 3], [-1, 2], [-2, 3]], [[3], []]).ok, false, 'satisfiable formula');
});

test('bit-blasted circuits agree with concrete evaluation on every operator', () => {
  const r = rng(5);
  const ops = ['i32.add', 'i32.sub', 'i32.mul', 'i32.and', 'i32.or', 'i32.xor', 'i32.shl', 'i32.shr_s', 'i32.shr_u',
    'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u', 'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u'];
  const edges = [0, 1, -1, 31, 32, 0x7fffffff, -0x80000000];
  for (const op of ops) {
    for (let t = 0; t < 30; t++) {
      const a = t < 7 ? edges[t] : r() | 0, b = t < 7 ? edges[(t * 3) % 7] : r() | 0;
      const c = new Circuit();
      const [w] = symbolic(c, [['i32.const', a], ['i32.const', b], [op]], {});
      const val = w.reduce((acc, l, i) => acc | ((l === 1 ? 1 : 0) << i), 0);
      assert.equal(val, concrete([['i32.const', a], ['i32.const', b], [op]], {})[0], `${op} ${a} ${b}`);
      assert.equal(foldBinary(op, a, b), val, `constant folder: ${op} ${a} ${b}`);
    }
  }
});

test('synthesis finds and proves shorter code, using the odd-local precondition', () => {
  const r = synthesize({ code: [['local.get', 'x0'], ['i32.const', 1], ['i32.shr_s'], ['i32.const', 1], ['i32.shl'], ['i32.const', 1], ['i32.or']], odd: [true], inputs: 0 });
  assert.deepEqual(r.rhs, [['local.get', 'x0']]);
  // Without the precondition the same rewrite is false, and the solver says why.
  const p = prove({ odd: [false], inputs: 0 }, [['local.get', 'x0'], ['i32.const', 1], ['i32.shr_s'], ['i32.const', 1], ['i32.shl'], ['i32.const', 1], ['i32.or']], [['local.get', 'x0']]);
  assert.equal(p.proved, false);
  assert.equal(p.cex.locals.x0 & 1, 0, 'the counterexample is an even value');
});

test('every shipped rule is re-proved from scratch, its proof RUP-checked, and random-tested', () => {
  for (const rule of RULES) {
    const r = verifyRule(rule);
    assert.ok(r.ok, `rule ${rule.id}: ${JSON.stringify(r.proof.cex ?? r.random)}`);
  }
});

test('a wrong rule is refuted with a counterexample', () => {
  const wrong = { ...RULES.find((r) => r.lhs.length === 3 && r.rhs[1]?.[0] === 'i32.le_u'), rhs: [['i32.const', 1], ['i32.lt_u']] };
  const r = verifyRule(wrong);
  assert.equal(r.ok, false);
  assert.deepEqual(r.proof.cex.stack, [1]);
});

test('the peephole pass rewrites to a fixed point and respects the odd precondition', () => {
  const index = indexRules(RULES);
  const run = [['local.get', '$a'], ['local.get', '$b'], ['i32.gt_s'], ['i32.const', 1], ['i32.shl'], ['i32.const', 1], ['i32.or'], ['i32.const', 1], ['i32.shr_u'], ['i32.eqz']];
  assert.deepEqual(rewriteRun(run, index, () => true), [['local.get', '$a'], ['local.get', '$b'], ['i32.le_s']]);
  assert.deepEqual(rewriteRun([['i32.const', 6], ['i32.const', 7], ['i32.mul'], ['i32.eqz']], index, () => true), [['i32.const', 0]]);
  const odd = RULES.find((r) => r.odd.some(Boolean));
  assert.ok(odd, 'some rule relies on a local being odd');
  const code = odd.lhs.map(([op, arg]) => (op === 'local.get' ? [op, `$${arg}`] : op === 'kconst' ? ['i32.const', 5] : [op, arg]));
  const used = (isOdd) => { const stats = new Map(); rewriteRun(code, index, isOdd, stats); return stats.has(odd.id); };
  assert.equal(used(() => true), true, 'applies when the local is known to be odd');
  assert.equal(used(() => false), false, 'not applied when the local is not known to be odd');
});

test('a rule with a K >= 0 side condition is not applied to a negative constant', () => {
  const rule = RULES.find((r) => r.nonneg?.length);
  assert.ok(rule, 'some rule has a side condition');
  const index = indexRules([rule]);
  const inst = (k) => rule.lhs.map(([op, arg]) => (op === 'kconst' ? ['i32.const', k] : op === 'local.get' ? [op, `$${arg}`] : [op, arg]));
  assert.notDeepEqual(rewriteRun(inst(5), index, () => true), inst(5), 'applies to a non-negative constant');
  assert.deepEqual(rewriteRun(inst(-5), index, () => true), inst(-5), 'not applied to a negative one');
});
