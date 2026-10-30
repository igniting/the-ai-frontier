import assert from 'node:assert/strict';
import { compile, runWasm, interpretSource, checkSource, formatDiagnostic, decodeBytes } from '../src/compiler.js';

// Runs a program three ways (interpreter, wasm, wasm with GC stress), asserts
// they agree exactly, and returns { output, error } with output decoded.
// GC stress collects on every allocation, which is quadratic for programs
// with large live data, so those pass { stress: false }.
export function run(src, { stress = true, input = '' } = {}) {
  const ref = interpretSource(src, { input });
  if (!ref.ok) assert.fail(`program rejected:\n${formatDiagnostic(src, ref.errors[0])}`);
  for (const gcStress of stress ? [false, true] : [false]) {
    const c = compile(src, { gcStress });
    const r = runWasm(c.wasm, { input });
    assert.equal(decodeBytes(r.output), decodeBytes(ref.output), `wasm output differs (gcStress=${gcStress})`);
    assert.equal(r.error, ref.error, `wasm error differs (gcStress=${gcStress})`);
  }
  return { output: decodeBytes(ref.output), error: ref.error };
}

export const output = (src, opts) => run(src, opts).output;

// Expects a compile error and returns its message.
export function compileError(src) {
  const r = checkSource(src);
  assert.equal(r.ok, false, 'expected a compile error');
  return r.errors[0].message;
}

export function signatures(src) {
  const r = checkSource(src);
  if (!r.ok) assert.fail(formatDiagnostic(src, r.errors[0]));
  return Object.fromEntries(r.signatures.map((s) => [s.name, s.type]));
}
