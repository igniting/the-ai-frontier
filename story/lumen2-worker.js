// The story's Lumen 2 demos: types and effects, proof obligations, memory
// statistics, planted bugs, and the Schur proof, all with the Lumen 2
// compiler running in this worker.

import { checkSource, compileSource, formatDiagnostic, decodeBytes, makeHost } from '../lumen2/src/api.js';
import { runWasm } from '../lumen2/src/codegen.js';
import { checkRefutation } from '../lumen2/src/rup.js';
import { lineCol } from '../lumen2/src/diagnostics.js';
import { compile as compileLumen, runWasm as runLumen } from '../src/compiler.js';
import { parseDimacs, referenceEncoding, sameFormula, groupsOf, checkSplit, parseSolverOutput } from '../proofs/schur-core.js';

const since = (t) => performance.now() - t;
const errors = (source, list) => list.map((e) => formatDiagnostic(source, e));

// Checks against the grants, but shows the inferred types: with a grant, main
// is checked as if annotated with it, and would show the annotation instead.
function signatures({ source, grants }) {
  const c = checkSource(source, { grants });
  if (!c.ok) return { ok: false, errors: errors(source, c.errors) };
  return { ok: true, signatures: checkSource(source).signatures.map((s) => ({ name: s.name, type: s.type })) };
}

function obligations({ source }) {
  const t = performance.now();
  const c = checkSource(source);
  if (!c.ok) return { ok: false, errors: errors(source, c.errors) };
  return {
    ok: true, ms: since(t),
    obligations: c.program.verification.obligations.filter((o) => o.scope === 'user').map((o) => ({
      kind: o.kind, what: o.what, status: o.status, lemmas: o.lemmas ?? 0, clauses: o.clauses ?? 0, counterexample: o.counterexample ?? null,
      line: o.span ? lineCol(source, o.span.s).line : null,
    })),
    signatures: c.signatures.map((s) => ({ name: s.name, type: s.type })),
  };
}

function run({ source }) {
  let t = performance.now();
  const c = compileSource(source);
  if (!c.ok) return { ok: false, errors: errors(source, c.errors) };
  const compileMs = since(t);
  t = performance.now();
  const r = runWasm(c.bytes, { host: makeHost() });
  return { ok: true, output: decodeBytes(r.output), error: r.error, compileMs, runMs: since(t), bytes: c.bytes.length, allocs: r.allocs, live: r.live };
}

// Compiles with one planted bug and reports which checker, if any, refused the result.
function plant({ source, mutant }) {
  const t = performance.now();
  try {
    const c = compileSource(source, { mutant: mutant || null });
    if (!c.ok) return { ok: false, errors: errors(source, c.errors) };
    const r = runWasm(c.bytes, { host: makeHost() });
    return { ok: true, caught: false, output: decodeBytes(r.output), error: r.error, live: r.live, ms: since(t) };
  } catch (e) {
    const by = e.message.startsWith('ownership') ? 'the ownership checker'
      : e.message.startsWith('IR types') ? 'the IR type checker'
        : /proof checker/.test(e.message) ? 'the proof checker' : null;
    if (!by) throw e;
    return { ok: true, caught: true, by, message: e.message.replace(/^internal error: /, ''), ms: since(t) };
  }
}

// The Schur proof with Lumen 2's encoder and solver, checked independently,
// then Lumen's own solver on the same formulas, compared byte for byte.
const text = async (path) => (await fetch(new URL(path, import.meta.url))).text();
let programs = null;
async function compiled() {
  if (!programs) {
    const [encoder, solver, lumenSolver] = await Promise.all([text('../lumen2/proofs/schur.lm'), text('../lumen2/proofs/sat.lm'), text('../proofs/sat.lm')]);
    const lumen2 = (src) => { const c = compileSource(src); if (!c.ok) throw new Error(c.errors[0].message); return c.bytes; };
    programs = { encoder: lumen2(encoder), solver: lumen2(solver), lumen: compileLumen(lumenSolver, { optimize: true }).wasm };
  }
  return programs;
}
const run2 = (bytes, input) => {
  const t = performance.now();
  const r = runWasm(bytes, { input, host: makeHost() });
  if (r.error) throw new Error(`the Lumen 2 program failed: ${r.error}`);
  if (r.live) throw new Error(`${r.live} objects were never freed`);
  return { output: decodeBytes(r.output), ms: since(t), allocs: r.allocs };
};

async function schur({ k, n, refute }, post) {
  const p = await compiled();
  const cnfN = run2(p.encoder, `${k} ${n}`).output, cnfN1 = run2(p.encoder, `${k} ${n + 1}`).output;
  const fN = parseDimacs(cnfN), fN1 = parseDimacs(cnfN1);
  const agree = sameFormula(fN, referenceEncoding(k, n)) && sameFormula(fN1, referenceEncoding(k, n + 1));
  post({ step: 'encode', clauses: [fN.clauses.length, fN1.clauses.length], agree });

  const ra = run2(p.solver, cnfN);
  const a = parseSolverOutput(ra.output);
  const groups = a.sat ? groupsOf(a.model, k, n) : null;
  const splitError = groups ? checkSplit(groups, n) : 'no split found';
  post({ step: 'witness', groups, ok: !splitError, error: splitError, ms: ra.ms, conflicts: a.conflicts });

  const outputs = [ra.output];
  let rupOk = true;
  if (refute) {
    const rb = run2(p.solver, cnfN1);
    const b = parseSolverOutput(rb.output);
    post({ step: 'refute', sat: b.sat, lemmas: b.sat ? 0 : b.proof.length, ms: rb.ms, conflicts: b.conflicts });
    if (b.sat) return { proved: false };
    const t = performance.now();
    const rup = checkRefutation(fN1.numVars, fN1.clauses, b.proof);
    rupOk = rup.ok;
    post({ step: 'check', ok: rup.ok, reason: rup.reason, ms: since(t), lemmas: b.proof.length });
    outputs.push(rb.output);
  }

  // Lumen's solver mutates arrays in place; Lumen 2's threads its state as a value.
  const t = performance.now();
  const lumenOut = [cnfN, cnfN1].slice(0, outputs.length).map((cnf) => {
    const r = runLumen(p.lumen, { input: cnf });
    if (r.error) throw new Error(`the Lumen solver failed: ${r.error}`);
    return r.output;
  });
  const same = lumenOut.every((o, i) => o === outputs[i]);
  post({ step: 'same', same, bytes: outputs.reduce((s, o) => s + o.length, 0), ms: since(t) });
  return { proved: refute ? agree && !splitError && rupOk : null, same };
}

const HANDLERS = { signatures, obligations, run, plant };
self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'schur') {
      const r = await schur(m, (x) => self.postMessage({ id: m.id, progress: true, ...x }));
      self.postMessage({ id: m.id, ok: true, ...r });
    } else self.postMessage({ id: m.id, ...HANDLERS[m.type](m) });
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, errors: [`internal error: ${e.message}`] });
  }
};
