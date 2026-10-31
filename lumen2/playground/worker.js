// The Lumen 2 playground's worker: everything the compiler does runs here,
// so a long or endless program never freezes the page (the page can always
// terminate the worker and start a new one).

import { checkSource, compileSource, interpretSource, testSource, certifySource, formatDiagnostic, decodeBytes, makeHost } from '../src/api.js';
import { runWasm } from '../src/codegen.js';
import { showIR } from '../src/perceus.js';
import { lineCol } from '../src/diagnostics.js';

const since = (t) => performance.now() - t;
// A place in the source: character offsets (for marks) and line:column (for display).
const where = (source, span) => (span ? { s: span.s, e: span.e, ...lineCol(source, span.s) } : null);
const diagnostics = (source, list, severity) => list.map((e) => ({
  severity, text: formatDiagnostic(source, e).replace(/^error/, severity), message: e.message, at: where(source, e.span),
}));

// Types, effects, warnings and proof obligations: everything the checker knows.
function analyze({ source, grants }) {
  const t = performance.now();
  const c = checkSource(source, { grants });
  const checkMs = since(t);
  if (!c.ok) return { ok: false, checkMs, diagnostics: diagnostics(source, c.errors, 'error') };
  const program = c.program;
  const obligations = program.verification.obligations.filter((o) => o.scope === 'user').map((o) => ({
    kind: o.kind, what: o.what, status: o.status, lemmas: o.lemmas ?? 0, clauses: o.clauses ?? 0,
    counterexample: o.counterexample ?? null, at: where(source, o.span),
  }));
  return {
    ok: true, checkMs,
    diagnostics: diagnostics(source, c.warnings, 'warning'),
    signatures: c.signatures.map((s) => ({ name: s.name, type: s.type, at: where(source, s.span) })),
    properties: program.properties.map((p) => p.name),
    hasMain: !!program.main,
    obligations,
  };
}

function run({ source, grants, input, seed, paranoid, interp }) {
  let t = performance.now();
  const host = makeHost({ seed: BigInt(seed ?? 1), realClock: true });
  if (interp) {
    const r = interpretSource(source, { grants, input, host });
    if (!r.ok) return { ok: false, diagnostics: diagnostics(source, r.errors, 'error') };
    return { ok: true, output: decodeBytes(r.output), error: r.error, runMs: since(t), steps: r.steps };
  }
  const c = compileSource(source, { grants, paranoid });
  if (!c.ok) return { ok: false, diagnostics: diagnostics(source, c.errors, 'error') };
  const compileMs = since(t);
  t = performance.now();
  const r = runWasm(c.bytes, { input, host });
  return {
    ok: true, output: decodeBytes(r.output), error: r.error, compileMs, runMs: since(t),
    bytes: c.bytes.length, live: r.live, allocs: r.allocs, functions: c.ir.fns.length,
  };
}

function test({ source, runs, seed }) {
  const t = performance.now();
  const r = testSource(source, { runs, seed });
  if (!r.ok) return { ok: false, diagnostics: diagnostics(source, r.errors, 'error') };
  return { ok: true, results: r.results, ms: since(t) };
}

// The IR after reference counting: one function, or the list of them.
function ir({ source, name }) {
  const c = compileSource(source);
  if (!c.ok) return { ok: false, diagnostics: diagnostics(source, c.errors, 'error') };
  const fns = c.ir.fns.filter((f) => !f.name.startsWith('wrap:'));
  const user = new Set(checkSource(source).program.userFns.map((f) => f.key));
  const names = fns.map((f) => ({ name: f.name, user: user.has(f.name.replace(/<.*$/, '')) || /^lambda\d+:main/.test(f.name) }));
  const pick = fns.find((f) => f.name === name) ?? fns.find((f) => f.name === 'main') ?? fns[0];
  return { ok: true, names, name: pick.name, text: showIR(pick) };
}

function certify({ source }) {
  const t = performance.now();
  const r = certifySource(source);
  if (!r.ok) return { ok: false, diagnostics: diagnostics(source, r.errors, 'error') };
  const proved = r.obligations.filter((o) => o.status === 'proved');
  return {
    ok: true, ms: since(t), types: r.certificates.types, ownership: r.certificates.ownership, bytes: r.bytes.length,
    proved: proved.length, lemmas: proved.reduce((n, o) => n + o.lemmas, 0),
    kept: r.obligations.filter((o) => o.kind === 'partial' && o.status !== 'proved').length,
  };
}

const HANDLERS = { analyze, run, test, ir, certify };
self.onmessage = ({ data: m }) => {
  try {
    self.postMessage({ id: m.id, ...HANDLERS[m.type](m) });
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, crashed: true, diagnostics: [{ severity: 'error', text: `internal error: ${e.message}`, message: e.message, at: null }] });
  }
};
