// The theorem prover written in Lumen 2: its encoder and SAT solver prove
// small Schur numbers with checked refutations, and the compiled solver
// behaves exactly as the reference interpreter says it must.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { interpretSource, runSource, makeHost } from '../src/api.js';
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
