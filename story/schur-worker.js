// Proves a Schur number in the browser with the Lumen stack: the encoder
// and the SAT solver are Lumen programs compiled here with -O; the witness
// is checked against the definition and the refutation by the independent
// RUP checker. Posts progress as it goes.

import { compile, runWasm } from '../src/compiler.js';
import { checkRup } from '../superopt/rup.js';
import { parseDimacs, referenceEncoding, sameFormula, groupsOf, checkSplit, parseSolverOutput } from '../proofs/schur-core.js';

const text = async (path) => (await fetch(new URL(path, import.meta.url))).text();
let programs = null;
async function compiled() {
  if (!programs) {
    const [encoder, solver] = await Promise.all([text('../proofs/schur.lm'), text('../proofs/sat.lm')]);
    programs = { encoder: compile(encoder, { optimize: true }).wasm, solver: compile(solver, { optimize: true }).wasm };
  }
  return programs;
}

function solve(wasm, cnf, onLines) {
  let lines = 0, last = 0;
  const r = runWasm(wasm, {
    input: cnf,
    onOutput: (s) => {
      for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) lines++;
      const t = performance.now();
      if (t - last > 200) { last = t; onLines(lines); }
    },
  });
  if (r.error) throw new Error(`the Lumen solver failed: ${r.error}`);
  return { ...parseSolverOutput(r.output), ms: r.timeMs };
}

self.onmessage = async ({ data: { k, n } }) => {
  const post = (m) => self.postMessage(m);
  try {
    const p = await compiled();
    const encode = (m) => { const r = runWasm(p.encoder, { input: `${k} ${m}` }); if (r.error) throw new Error(r.error); return r.output; };
    const cnfN = encode(n), cnfN1 = encode(n + 1);
    const fN = parseDimacs(cnfN), fN1 = parseDimacs(cnfN1);
    const agree = sameFormula(fN, referenceEncoding(k, n)) && sameFormula(fN1, referenceEncoding(k, n + 1));
    post({ step: 'encode', clauses: [fN.clauses.length, fN1.clauses.length], agree });

    const a = solve(p.solver, cnfN, (lines) => post({ step: 'witness', progress: lines }));
    const groups = a.sat ? groupsOf(a.model, k, n) : null;
    const splitError = groups ? checkSplit(groups, n) : 'no split found';
    post({ step: 'witness', done: true, groups, ok: !splitError, error: splitError, ms: a.ms, conflicts: a.conflicts });

    const b = solve(p.solver, cnfN1, (lines) => post({ step: 'refute', progress: lines }));
    post({ step: 'refute', done: true, sat: b.sat, lemmas: b.sat ? 0 : b.proof.length, ms: b.ms, conflicts: b.conflicts });
    if (b.sat) { post({ step: 'done', proved: false }); return; }

    const t = performance.now();
    const rup = checkRup(fN1.numVars, fN1.clauses, b.proof, { onProgress: (i, total) => post({ step: 'check', progress: i, total }) });
    post({ step: 'check', done: true, ok: rup.ok, reason: rup.reason, ms: performance.now() - t, lemmas: b.proof.length });
    post({ step: 'done', proved: agree && !splitError && rup.ok });
  } catch (e) {
    post({ step: 'failed', message: e.message });
  }
};
