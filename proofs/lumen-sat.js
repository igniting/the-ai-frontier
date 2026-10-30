// Runs the Lumen SAT solver (proofs/sat.lm, compiled with -O) and parses
// what it prints: a status, and either a model or a DRUP refutation.

import { readFileSync } from 'node:fs';
import { compile, runWasm } from '../src/compiler.js';
import { parseSolverOutput } from './schur-core.js';

let wasm = null;
export function solverWasm() {
  if (!wasm) {
    const c = compile(readFileSync(new URL('./sat.lm', import.meta.url), 'utf8'), { optimize: true });
    if (!c.ok) throw new Error(`sat.lm does not compile: ${c.errors[0].message}`);
    wasm = c.wasm;
  }
  return wasm;
}

export const toDimacs = (numVars, clauses) => `p cnf ${numVars} ${clauses.length}\n${clauses.map((c) => `${c.join(' ')} 0`).join('\n')}\n`;

// Returns { sat, model (DIMACS literals) | proof (clauses), conflicts, timeMs, stats }.
export function lumenSolve(cnfText) {
  const r = runWasm(solverWasm(), { input: cnfText });
  if (r.error) throw new Error(`the Lumen solver failed: ${r.error}`);
  return { ...parseSolverOutput(r.output), timeMs: r.timeMs, stats: r.stats };
}
