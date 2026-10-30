// The self-hosted compiler (selfhost/, Lumen written in Lumen) must reach a
// fixed point and agree with the reference compiler byte for byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile } from '../src/compiler.js';
import { stage1Wasm, runLumenc, lumencSource, outputBytes } from '../selfhost/harness.js';
import { wasmDiff } from '../selfhost/wasmdiff.js';
import { generateProgram, renderProgram } from '../fuzz/generate.js';

const selfCompile = (wasm, text) => {
  const r = runLumenc(wasm, 'wasm', text);
  assert.equal(r.error, null);
  return outputBytes(r.output);
};

test('bootstrap: stage1 == stage2 == stage3, byte for byte', () => {
  const { source } = lumencSource();
  const stage1 = stage1Wasm();
  const stage2 = selfCompile(stage1, source);
  assert.equal(wasmDiff(stage1, stage2), null);
  const stage3 = selfCompile(stage2, source);
  assert.equal(wasmDiff(stage2, stage3), null);
});

test('lumenc emits exactly what the reference emits (examples and random programs)', () => {
  const programs = [
    ...readdirSync('examples').filter((f) => f.endsWith('.lm')).map((f) => readFileSync(`examples/${f}`, 'utf8')),
    ...Array.from({ length: 60 }, (_, k) => renderProgram(generateProgram(500 + k, { size: 1 + (k % 3) }))),
  ];
  for (const text of programs) {
    const ref = compile(text);
    const r = runLumenc(stage1Wasm(), 'wasm', text);
    if (!ref.ok) { assert.match(r.error ?? '', /^panic: @/); continue; }
    assert.equal(r.error, null);
    assert.equal(wasmDiff(ref.wasm, outputBytes(r.output)), null);
  }
});

test('lumenc reports the same compile errors as the reference', () => {
  const main = (b, d = '') => `${d}\nfn main() {\n${b}\n}\n`;
  const cases = [
    main('let x = 1 + "a";'), main('if 1 { 2 } else { 3 }'), main('let f = |x| x(x);'), main('[1, "two"]'),
    'fn f(a, b) { a }\nfn main() { f(1) }', main('lenght([1])'), main('let x: Int = "s";'), 'fn main() -> Int { "s" }',
    main('match Some(1) { Some(_) -> 1 }'), main('match [1] { [] -> 0, [x] -> x }'), main('match 3 { 0 -> 0, 1 -> 1 }'),
    main('match Some(1) { Some(x) if x > 0 -> 1, None -> 0 }'), main('let Some(x) = Some(1);'),
    main('match (Some(1), [2]) { (None, _) -> 0, (Some(_), []) -> 1 }'), 'fn f() { 1 }', main('let = 3;'),
    // arrays, and the value restriction that keeps them sound
    main('let a = array_make(1, []); array_set(a, 0, [1]); match array_get(a, 0) { [s] -> println(s), _ -> () }'),
    main('array_get(array_make(2, 0), "x")'), main('let a: Array<Int, Int> = array_make(1, 0);'), 'type Array { A }\nfn main() { () }',
  ];
  for (const text of cases) {
    const ref = compile(text);
    assert.equal(ref.ok, false);
    const r = runLumenc(stage1Wasm(), 'wasm', text);
    const m = /^panic: @\d+-\d+ \w+: (.*)$/s.exec(r.error ?? '');
    assert.ok(m, `lumenc should reject: ${text}`);
    assert.equal(m[1], ref.errors[0].message);
  }
});
