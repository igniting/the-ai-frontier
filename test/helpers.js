import assert from 'node:assert/strict';
import { compile, runWasm, interpretSource, checkSource, formatDiagnostic, decodeBytes } from '../src/compiler.js';

// Runs a program five ways (interpreter; wasm and wasm -O, each also with GC
// stress), asserts they agree exactly, and returns { output, error } with
// output decoded. GC stress collects on every allocation, which is quadratic
// for programs with large live data, so those pass { stress: false }.
export function run(src, { stress = true, input = '' } = {}) {
  const ref = interpretSource(src, { input });
  if (!ref.ok) assert.fail(`program rejected:\n${formatDiagnostic(src, ref.errors[0])}`);
  const modes = [{}, { optimize: true }, ...(stress ? [{ gcStress: true }, { optimize: true, gcStress: true }] : [])];
  for (const options of modes) {
    const c = compile(src, options);
    const r = runWasm(c.wasm, { input });
    assert.equal(decodeBytes(r.output), decodeBytes(ref.output), `wasm output differs (${JSON.stringify(options)})`);
    assert.equal(r.error, ref.error, `wasm error differs (${JSON.stringify(options)})`);
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
