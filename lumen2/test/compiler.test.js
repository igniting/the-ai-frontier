// The compiler: written in Lumen 2 (compiler/*.lm) and built by itself.
// The committed build, compiler/lumen2c.wasm, must be the fixed point of its
// source: compiling compiler/*.lm with it gives it back, byte for byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from '../compiler/bootstrap.js';
import { makeCompiler, charOffsets } from '../src/lumen2c.js';

test('the compiler compiles its own source to itself', () => {
  const seed = readFileSync(new URL('../compiler/lumen2c.wasm', import.meta.url));
  const out = build(seed);
  assert.equal(out.length, seed.length);
  assert.ok(out.every((b, i) => b === seed[i]), 'compiler/lumen2c.wasm is the fixed point; run node compiler/bootstrap.js --write');
});

test('spans are character offsets, whatever the encoding of the text before them', () => {
  const src = 'fn main() {\n  // é ü 漢字 😀\n  println(undefined_name)\n}\n';
  const c = makeCompiler().check(src);
  assert.equal(c.ok, false);
  const { s, e } = c.errors[0].span;
  assert.equal(src.slice(s, e), 'undefined_name');
  // a, then the four bytes of 😀 (two UTF-16 units), then b, then the end.
  assert.deepEqual([...charOffsets('a😀b')], [0, 1, 1, 1, 1, 3, 4]);
});
