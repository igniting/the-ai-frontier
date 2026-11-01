// The story's Lumen 2 demos: types and effects, proof obligations, memory
// statistics, planted bugs, and the Schur proof, all with the Lumen 2
// compiler running in this worker.

import { checkSource, compileSource, formatDiagnostic, decodeBytes, makeHost, runWasm } from '../lumen2/src/api.js';
import { checkRefutation } from '../lumen2/src/rup.js';
import { lineCol } from '../lumen2/src/diagnostics.js';
import { makeCompiler } from '../lumen2/src/lumen2c.js';
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
    obligations: c.verification.obligations.filter((o) => o.scope === 'user').map((o) => ({
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

// The self-hosting fixed point: the reference compiler builds lumen2c.lm
// (stage 1), which compiles itself (stage 2), which compiles itself (stage 3).
async function bootstrap(_, post) {
  const src = await text('../lumen2/selfhost/lumen2c.lm');
  const digest = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
  let t = performance.now();
  const c = compileSource(src);
  if (!c.ok) throw new Error(c.errors[0].message);
  post({ step: 'stage1', bytes: c.bytes.length, ms: since(t), hash: await digest(c.bytes), lines: src.split('\n').length });
  const stage = async (compiler, name) => {
    const t0 = performance.now();
    const r = runWasm(compiler, { input: src, host: makeHost() });
    if (r.error) throw new Error(`${name} stopped: ${r.error}`);
    const bytes = Uint8Array.from(r.output, (ch) => ch.charCodeAt(0));
    post({ step: name, bytes: bytes.length, ms: since(t0), hash: await digest(bytes), allocs: r.allocs, live: r.live });
    return bytes;
  };
  const s2 = await stage(c.bytes, 'stage2');
  const s3 = await stage(s2, 'stage3');
  return { same: s2.length === s3.length && s2.every((b, i) => b === s3[i]) };
}

// The compiler compiles its own source: lumen2c.wasm, given compiler/*.lm
// (put together with the prelude and the rewrite rules), must write lumen2c.wasm.
async function selfCompile(_, post) {
  const [src, wasm] = await Promise.all([
    text('../lumen2/compiler/lumen2c.lm'),
    fetch(new URL('../lumen2/compiler/lumen2c.wasm', import.meta.url)).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
  ]);
  const digest = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
  post({ step: 'load', bytes: wasm.length, hash: await digest(wasm), lines: src.split('\n').length });
  const t = performance.now();
  const c = makeCompiler(wasm).compile(src, { grants: null });
  if (!c.ok) throw new Error(c.errors[0].message);
  post({ step: 'build', bytes: c.bytes.length, ms: since(t), hash: await digest(c.bytes) });
  return { same: c.bytes.length === wasm.length && c.bytes.every((b, i) => b === wasm[i]) };
}

const HANDLERS = { signatures, obligations, run, plant };
const STREAMING = { schur, bootstrap, selfCompile };
self.onmessage = async ({ data: m }) => {
  try {
    if (STREAMING[m.type]) {
      const r = await STREAMING[m.type](m, (x) => self.postMessage({ id: m.id, progress: true, ...x }));
      self.postMessage({ id: m.id, ok: true, ...r });
    } else self.postMessage({ id: m.id, ...HANDLERS[m.type](m) });
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, errors: [`internal error: ${e.message}`] });
  }
};
