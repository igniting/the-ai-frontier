// The theorem prover written in Lumen 2: its encoder and SAT solver prove
// small Schur numbers with checked refutations, and the compiled solver
// behaves exactly as the reference interpreter says it must.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { interpretSource, runSource, compileSource, makeHost } from '../src/api.js';
import { runWasm } from '../src/runtime.js';
import { checkRefutation } from '../src/rup.js';
import { proveSchur, parseSolverOutput, referenceEncoding } from '../proofs/prove-schur.js';

const source = (f) => readFileSync(new URL(`../proofs/${f}`, import.meta.url), 'utf8');
const dimacs = ({ numVars, clauses }) => `p cnf ${numVars} ${clauses.length}\n${clauses.map((c) => `${c.join(' ')} 0`).join('\n')}\n`;

test('S(2) = 4 and S(3) = 13, with checked splits and refutations', () => {
  for (const [k, n] of [[2, 4], [3, 13]]) {
    const r = proveSchur(k, n, { log: () => {} });
    assert.equal(r.proved, true, `S(${k}) = ${n}`);
  }
  assert.equal(proveSchur(3, 12, { log: () => {} }).proved, false, 'S(3) is not 12: 1..13 can be split');
});

test('the compiled solver prints exactly what the interpreter prints', () => {
  const sat = source('sat.lm');
  for (const [k, n] of [[2, 4], [2, 5], [3, 14]]) {
    const input = dimacs(referenceEncoding(k, n));
    const a = interpretSource(sat, { input, host: makeHost() });
    const b = runSource(sat, { input, host: makeHost() });
    assert.equal(b.output, a.output, `S(${k}), 1..${n}`);
    assert.equal(b.error, null);
    assert.equal(b.live, 0, 'every object is freed');
  }
  const p = parseSolverOutput(runSource(sat, { input: dimacs(referenceEncoding(3, 14)), host: makeHost() }).output);
  assert.equal(p.sat, false);
});

test('the solver handles trivial and contradictory formulas', () => {
  const sat = source('sat.lm');
  const solve = (text) => parseSolverOutput(runSource(sat, { input: text, host: makeHost() }).output);
  assert.equal(solve('p cnf 0 0\n').sat, true);
  assert.equal(solve('p cnf 1 2\n1 0\n-1 0\n').sat, false);
  assert.equal(solve('p cnf 2 1\n1 -1 0\n').sat, true, 'a tautology');
  const r = solve('p cnf 3 4\n1 2 0\n-1 2 0\n1 -2 0\n-1 -2 3 0\n');
  assert.equal(r.sat, true);
  assert.deepEqual(r.model, [1, 2, 3]);
});

// proofs/rup.lm: a second DRUP checker, written in Lumen 2 with every array
// access proved, so that nothing in it can fail. It must agree with
// src/rup.js on real proofs and on tampered ones.
test('the proved checker: no function can fail, and it agrees with src/rup.js', () => {
  const c = compileSource(source('rup.lm'));
  assert.ok(c.ok, c.errors?.[0]?.message);
  for (const s of c.signatures) assert.ok(!s.type.includes('fail'), `${s.name}: ${s.type}`);
  const check = (text) => { const r = runWasm(c.bytes, { input: text, host: makeHost() }); assert.equal(r.live, 0); return r.output.trim(); };
  const sat = compileSource(source('sat.lm')).bytes;
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const verdicts = new Set();
  for (const [k, n] of [[3, 14], [3, 15]]) {
    const f = referenceEncoding(k, n);
    const cnf = dimacs(f);
    const lemmas = runWasm(sat, { input: cnf, host: makeHost() }).output.split('\n').filter((l) => /^-?\d/.test(l)).map((l) => l.trim().split(/\s+/).map(Number).slice(0, -1));
    assert.equal(check(cnf + lemmas.map((l) => [...l, 0].join(' ')).join('\n') + '\n'), 's VERIFIED');
    for (let trial = 0; trial < 40; trial++) {
      const ls = lemmas.map((l) => [...l]);
      const i = rnd(ls.length - 1);
      const kind = ['flip', 'drop-lit', 'drop-lemma', 'add-lit'][trial % 4];
      if (kind === 'flip' && ls[i].length) { const j = rnd(ls[i].length); ls[i][j] = -ls[i][j]; }
      if (kind === 'drop-lit' && ls[i].length) ls[i].splice(rnd(ls[i].length), 1);
      if (kind === 'drop-lemma') ls.splice(i, 1);
      if (kind === 'add-lit') ls[i].push((rnd(2) ? 1 : -1) * (1 + rnd(f.numVars)));
      const want = checkRefutation(f.numVars, f.clauses, ls).ok;
      const got = check(cnf + ls.map((l) => [...l, 0].join(' ')).join('\n') + '\n');
      assert.equal(got.startsWith('s VERIFIED'), want, `S(${k}), 1..${n}, ${kind} in lemma ${i}: ${got}`);
      verdicts.add(want);
    }
  }
  assert.equal(verdicts.size, 2, 'some tampered proofs are rejected and some still follow');
  // Input that breaks the invariants is reported, not trusted.
  assert.equal(check('1 2 0\n'), 's NOT VERIFIED: no `p cnf` header');
  assert.equal(check('c hi\n\np cnf 2 1\n1 3 0\n0\n'), 's NOT VERIFIED: 3 is not a literal of 2 variables');
  assert.equal(check('p cnf 2 2\n1 2 0\n-1 0\n-2'), 's NOT VERIFIED: the last clause has no terminating 0');
  assert.equal(check('p cnf 1 2\n1 0\n-1 0\n'), 's VERIFIED', 'the formula refutes itself by unit propagation');
  assert.equal(check('p cnf 2 1\n1 2 0\n0\n'), 's NOT VERIFIED: lemma 1 does not follow by unit propagation');
});
