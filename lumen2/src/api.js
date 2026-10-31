// The public entry points: check a program, interpret it, compile it to
// WebAssembly and run the result.

import { check } from './check.js';
import { interpret } from './interp.js';
import { compileProgram, runWasm } from './codegen.js';
import { testProperties, HARNESS } from './props.js';
import { makeHost } from './host.js';
import { LumenError, formatDiagnostic } from './diagnostics.js';

export { formatDiagnostic };
export { decodeBytes, utf8 } from './lexer.js';
export { makeHost };

// Returns { ok, program, signatures, warnings } or { ok: false, errors }.
// options.grants: the capabilities granted to `main`, or null for no restriction.
export function checkSource(source, options = {}) {
  globalThis.__lumen2Log?.(source, options);
  try {
    const program = check(source, options);
    return { ok: true, program, signatures: program.signatures, warnings: program.warnings };
  } catch (e) {
    if (e instanceof LumenError) return { ok: false, errors: [e] };
    throw e;
  }
}

const noMain = () => ({ ok: false, errors: [new LumenError('the program has no `main` function', { s: 0, e: 0 })] });

export function interpretSource(source, options = {}) {
  const c = checkSource(source, options);
  if (!c.ok) return c;
  if (!c.program.main) return noMain();
  return { ok: true, ...interpret(c.program, options), signatures: c.signatures };
}

// Returns { ok, bytes, module, ir } or { ok: false, errors }.
export function compileSource(source, options = {}) {
  const c = checkSource(source, options);
  if (!c.ok) return c;
  if (!c.program.main) return noMain();
  return { ok: true, ...compileProgram(c.program, options), signatures: c.signatures };
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
    const h = checkSource(harness, { entry: HARNESS });
    if (!h.ok) return { output: '', error: `internal error: ${h.errors[0].message}` };
    return runWasm(compileProgram(h.program).bytes, { host: makeHost({ seed }) });
  };
  return { ok: true, results: testProperties(c.program, source, { runs, seed, compile }) };
}

// Compiles with every certificate kept: the IR type and ownership checks,
// each refinement obligation with its formula and checked DRUP refutation
// (the prelude's included), and the validated module.
export function certifySource(source, options = {}) {
  const c = checkSource(source, { ...options, keepProofs: true });
  if (!c.ok) return c;
  if (!c.program.main) return noMain();
  const compiled = compileProgram(c.program, options);
  return { ok: true, ...compiled, obligations: c.program.verification.obligations };
}
