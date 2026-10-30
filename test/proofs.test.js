// The SAT solver written in Lumen (proofs/sat.lm) and the Schur proofs built
// on it: answers against brute force, models against the formula, and every
// refutation through the independent RUP checker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lumenSolve, toDimacs } from '../proofs/lumen-sat.js';
import { checkRup } from '../superopt/rup.js';
import { proveSchur, lumenEncode, parseDimacs, referenceEncoding, sameFormula, checkSplit } from '../proofs/prove-schur.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0); };
}

test('the Lumen SAT solver agrees with brute force; its models satisfy and its proofs check', () => {
  const r = rng(17);
  let unsat = 0;
  for (let t = 0; t < 150; t++) {
    const n = 3 + (r() % 10), m = Math.round(n * (2.5 + (r() % 30) / 10));
    const clauses = Array.from({ length: m }, () => Array.from({ length: 1 + (r() % 4) }, () => (1 + (r() % n)) * (r() & 1 ? 1 : -1)));
    let brute = false;
    for (let bits = 0; bits < 1 << n && !brute; bits++) brute = clauses.every((c) => c.some((l) => ((bits >> (Math.abs(l) - 1)) & 1) === (l > 0 ? 1 : 0)));
    const res = lumenSolve(toDimacs(n, clauses));
    assert.equal(res.sat, brute, `instance ${t}`);
    if (res.sat) {
      const val = new Map(res.model.map((l) => [Math.abs(l), l > 0]));
      assert.ok(clauses.every((c) => c.some((l) => val.get(Math.abs(l)) === l > 0)), `model ${t}`);
    } else {
      unsat++;
      assert.ok(checkRup(n, clauses, res.proof).ok, `proof ${t}`);
    }
  }
  assert.ok(unsat > 30);
});

test('the Lumen Schur encoder writes exactly the reference formula', () => {
  for (const [k, n] of [[2, 5], [3, 14], [4, 45]]) assert.ok(sameFormula(parseDimacs(lumenEncode(k, n)), referenceEncoding(k, n)), `${k} ${n}`);
});

test('the split checker rejects a group containing x, y and x + y', () => {
  assert.equal(checkSplit([[1, 4], [2, 3]], 4), null);
  assert.match(checkSplit([[1, 2], [3, 4]], 4), /1 \+ 1 = 2|1 \+ 2 = 3/);
  assert.match(checkSplit([[1, 4], [2, 3, 5]], 5), /2 \+ 3 = 5/);
});

test('S(2) = 4 and S(3) = 13, proved end to end by the Lumen stack', () => {
  for (const [k, n] of [[2, 4], [3, 13]]) assert.equal(proveSchur(k, n, { log: () => {} }).proved, true, `S(${k}) = ${n}`);
});
