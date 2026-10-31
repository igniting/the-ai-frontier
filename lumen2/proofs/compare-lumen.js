// Runs the Lumen 2 solver and the original Lumen solver (../../proofs/sat.lm)
// on the same Schur formulas and checks that they print the same thing,
// byte for byte: the two are the same algorithm, decision for decision, in
// two languages with two compilers.
//
//   node proofs/compare-lumen.js 4 44     (compares 1..44 and 1..45)

import { readFileSync } from 'node:fs';
import { compileSource } from '../src/api.js';
import { runWasm } from '../src/codegen.js';
import { makeHost } from '../src/host.js';
import { referenceEncoding } from './prove-schur.js';
import { solverWasm } from '../../proofs/lumen-sat.js';
import { runWasm as runLumen } from '../../src/compiler.js';

const [k, n] = process.argv.slice(2, 4).map(Number);
const solver = compileSource(readFileSync(new URL('./sat.lm', import.meta.url), 'utf8')).bytes;
let same = true;
for (const m of [n, n + 1]) {
  const { numVars, clauses } = referenceEncoding(k, m);
  const input = `p cnf ${numVars} ${clauses.length}\n${clauses.map((c) => `${c.join(' ')} 0`).join('\n')}\n`;
  let t = performance.now();
  const a = runWasm(solver, { input, host: makeHost() });
  const ms2 = performance.now() - t;
  t = performance.now();
  const b = runLumen(solverWasm(), { input });
  const ms1 = performance.now() - t;
  const ok = a.output === b.output;
  same &&= ok;
  console.log(`1..${m}: Lumen 2 ${(ms2 / 1000).toFixed(1)} s, Lumen ${(ms1 / 1000).toFixed(1)} s; ${a.output.split('\n').length - 1} lines, ${ok ? 'identical' : 'DIFFERENT'}`);
}
process.exitCode = same ? 0 : 1;
