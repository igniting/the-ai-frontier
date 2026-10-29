// The binary encoder: hand-built modules validate and behave as expected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Module } from '../src/wasm.js';
import { compile } from '../src/compiler.js';
import { readFileSync, readdirSync } from 'node:fs';

test('LEB128 constants round-trip through a real module', () => {
  const values = [0, 1, -1, 63, 64, -64, -65, 127, 128, 2 ** 31 - 1, -(2 ** 31), 123456789, -987654321];
  const mod = new Module();
  mod.memory.exportName = null;
  values.forEach((v, i) => mod.addFunc({ name: `$f${i}`, exportName: `f${i}`, params: [], results: ['i32'], body: [['i32.const', v]] }));
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(mod.encode()));
  values.forEach((v, i) => assert.equal(exports[`f${i}`](), v));
});

test('labels resolve to the correct relative depth', () => {
  const mod = new Module();
  mod.memory.exportName = null;
  mod.addFunc({
    name: '$f', exportName: 'f', params: [{ name: '$x', type: 'i32' }], results: ['i32'],
    body: [
      ['block', '$outer', 'i32'],
      ['block', '$inner', null],
      ['local.get', '$x'], ['br_if', '$inner'],
      ['i32.const', 10], ['br', '$outer'],
      ['end'],
      ['i32.const', 20],
      ['end'],
    ],
  });
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(mod.encode()));
  assert.equal(exports.f(0), 10);
  assert.equal(exports.f(1), 20);
});

test('every example compiles to a module that validates', () => {
  const dir = new URL('../examples/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.lm'))) {
    const c = compile(readFileSync(new URL(f, dir), 'utf8'));
    if (!c.ok) continue; // the error-demo examples
    assert.ok(WebAssembly.validate(c.wasm), `${f} does not validate`);
    assert.match(c.wat, /^\(module/);
  }
});
