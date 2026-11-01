// The public entry points: check a program, interpret it, compile it to
// WebAssembly and run the result.
//
// Checking and compiling are done by the Lumen 2 compiler, which is written
// in Lumen 2 and runs as WebAssembly (src/lumen2c.js). The reference
// interpreter keeps its own front end (check.js) for the typed tree it walks,
// given the sites the compiler proved safe: its job is to be a second,
// independent implementation of the language that compiled code is compared with.

import { checkOnce } from './check.js';
import { interpret } from './interp.js';
import { runWasm } from './runtime.js';
import { testProperties, HARNESS } from './props.js';
import { makeHost } from './host.js';
import { lumen2c, CertificateError } from './lumen2c.js';
import { LumenError, formatDiagnostic } from './diagnostics.js';

export { formatDiagnostic, CertificateError, runWasm };
export { decodeBytes, utf8 } from './lexer.js';
export { makeHost };

// Planted bugs that change what the checker proves (see test/fuzz.js); the
// others are in the back end and do not change a check's result.
const CHECKING_MUTANTS = new Set(['refine-else-same', 'refine-div-range', 'refine-push-forgets', 'refine-match-or', 'refine-overflow-def', 'blast-carry', 'sat-claims-unsat', 'rup-accept-all']);

// A program's checks are kept for programs seen recently, so checking it and
// then compiling it in several ways proves its obligations once.
const checks = new Map();
function checked(source, { grants = null, entry = 'main', mutant = null, keepProofs = false } = {}) {
  const m = CHECKING_MUTANTS.has(mutant) ? mutant : null;
  const key = JSON.stringify([source, grants, entry, m, keepProofs]);
  let c = checks.get(key);
  if (!c) {
    c = lumen2c.check(source, { grants, entry, mutant: m, keepProofs });
    if (checks.size >= 200) checks.delete(checks.keys().next().value);
    checks.set(key, c);
  }
  return c;
}

// Returns { ok, signatures, warnings, verification, program } or { ok: false, errors }.
// options.grants: the capabilities granted to `main`, or null for no restriction.
// program is the reference front end's typed tree (for the interpreter), made when first read.
export function checkSource(source, options = {}) {
  globalThis.__lumen2Log?.(source, options);
  const c = checked(source, options);
  if (!c.ok) return c;
  let program = null;
  return {
    ok: true, signatures: c.signatures, warnings: c.warnings, verification: c.verification, hasMain: c.hasMain,
    get program() {
      if (!program) {
        program = checkOnce(source, { grants: options.grants ?? null, entry: options.entry ?? 'main', safeSites: c.verification.safe, unproved: c.verification.unproved });
        program.verification = c.verification;
      }
      return program;
    },
  };
}

const noMain = () => ({ ok: false, errors: [new LumenError('the program has no `main` function', { s: 0, e: 0 })] });

export function interpretSource(source, options = {}) {
  const c = checkSource(source, options);
  if (!c.ok) return c;
  if (!c.hasMain) return noMain();
  return { ok: true, ...interpret(c.program, options), signatures: c.signatures };
}

// Returns { ok, bytes, ir, rewrites, certificates, signatures } or { ok: false, errors }.
// Options: paranoid, reuse, borrow, specialize, inline, superopt, mutant (see
// compiler/47-backend.lm); ir: the IR's text too; funcs: the WebAssembly functions too.
// A certificate checker rejecting a pass's output throws a CertificateError.
export function compileSource(source, options = {}) {
  const c = checkSource(source, options);
  if (!c.ok) return c;
  if (!c.hasMain) return noMain();
  const r = lumen2c.compile(source, { ...options, given: c.verification.raw });
  if (!r.ok) return r;
  return { ok: true, bytes: r.bytes, ir: r.ir, funcs: r.funcs, rewrites: r.rewrites, certificates: r.certificates, signatures: c.signatures };
}

// Compiles and runs: { ok, output, error, live, allocs } or { ok: false, errors }.
export function runSource(source, { input = '', host, ...options } = {}) {
  const c = compileSource(source, { grants: null, ...options });
  if (!c.ok) return c;
  return { ok: true, ...runWasm(c.bytes, { input, host }) };
}

// Tests every property: { ok, results } (see props.js) or { ok: false, errors }.
export function testSource(source, { runs = 100, seed = 1 } = {}) {
  const c = checkSource(source);
  if (!c.ok) return c;
  const compile = (harness) => {
    const h = compileSource(harness, { entry: HARNESS });
    if (!h.ok) return { output: '', error: `internal error: ${h.errors[0].message}` };
    return runWasm(h.bytes, { host: makeHost({ seed }) });
  };
  return { ok: true, results: testProperties(c.program, source, { runs, seed, compile }) };
}

// Compiles with every certificate kept: the IR type and ownership checks,
// each refinement obligation with its formula and checked DRUP refutation
// (the prelude's included), and the module.
export function certifySource(source, options = {}) {
  const r = lumen2c.compile(source, { ...options, keepProofs: true, ir: true });
  if (!r.ok) return r;
  if (!r.hasMain) return noMain();
  return { ok: true, bytes: r.bytes, ir: r.ir, rewrites: r.rewrites, certificates: r.certificates, signatures: r.signatures, obligations: r.verification.obligations };
}
