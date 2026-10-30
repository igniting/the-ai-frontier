// The public entry points: check a program, interpret it, and (once the back
// end is loaded) compile it to WebAssembly.

import { check } from './check.js';
import { interpret } from './interp.js';
import { LumenError, formatDiagnostic } from './diagnostics.js';

export { formatDiagnostic };
export { decodeBytes, utf8 } from './lexer.js';

// Returns { ok, program, signatures, warnings } or { ok: false, errors }.
export function checkSource(source) {
  try {
    const program = check(source);
    return { ok: true, program, signatures: program.signatures, warnings: program.warnings };
  } catch (e) {
    if (e instanceof LumenError) return { ok: false, errors: [e] };
    throw e;
  }
}

export function interpretSource(source, options = {}) {
  const c = checkSource(source);
  if (!c.ok) return c;
  return { ok: true, ...interpret(c.program, options), signatures: c.signatures };
}
