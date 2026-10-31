// The superoptimizer: its instruction semantics agree with the engine and
// with its circuits, every rule the compiler applies is re-proved, and the
// peephole pass respects side conditions and preserves behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SIG, WIDTH, apply, Circuit } from '../superopt/semantics.js';
import { verifyRule } from '../superopt/verify.js';
import { RULES } from '../src/rules.js';
import { peephole } from '../src/peephole.js';
import { Module } from '../src/wasm.js';
import { runSource, makeHost } from '../src/api.js';

function values(seed) {
  let x = BigInt(seed);
  return (t) => {
    x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    const w = BigInt(WIDTH[t]);
    const edges = [0n, 1n, (1n << w) - 1n, 1n << (w - 1n), (1n << (w - 1n)) - 1n, w - 1n, w, w + 1n];
    return x >> 61n === 0n ? edges[Number(x % 8n)] : BigInt.asUintN(WIDTH[t], x ^ (x >> 29n));
  };
}

test('the semantics agree with the WebAssembly engine', () => {
  const m = new Module();
  const ops = Object.keys(SIG);
  ops.forEach((op, i) => {
    const sig = SIG[op];
    const body = [...sig.in.map((_, j) => ['local.get', `p${j}`]), [op], ...(sig.out === 'i32' ? [['i64.extend_i32_u']] : [])];
    m.addFunc({ name: `f${i}`, params: sig.in.map((t, j) => ({ name: `p${j}`, type: t })), results: ['i64'], locals: [], body });
    m.addExport(`f${i}`, 'func', `f${i}`);
  });
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(m.encode()));
  const pick = values(3);
  ops.forEach((op, i) => {
    for (let k = 0; k < 150; k++) {
      const args = SIG[op].in.map(pick);
      const js = args.map((v, j) => (SIG[op].in[j] === 'i32' ? Number(BigInt.asIntN(32, v)) : BigInt.asIntN(64, v)));
      const got = BigInt.asUintN(WIDTH[SIG[op].out], exports[`f${i}`](...js));
      assert.equal(got, apply(op, args), `${op}(${args.join(', ')})`);
    }
  });
});

test('the circuits agree with the semantics', () => {
  const pick = values(5);
  for (const op of Object.keys(SIG)) {
    for (let k = 0; k < 60; k++) {
      const args = SIG[op].in.map(pick);
      const c = new Circuit();
      const bits = c.apply(op, args.map((v, j) => c.constant(SIG[op].in[j], v)));
      const got = bits.reduce((v, l, i) => (l === c.T ? v | (1n << BigInt(i)) : v), 0n);
      assert.ok(bits.every((l) => Math.abs(l) === c.T), `${op} folds on constants`);
      assert.equal(got, apply(op, args), `${op}(${args.join(', ')})`);
    }
  }
});

test('every rule the compiler applies is proved, with a checked proof', () => {
  assert.ok(RULES.length > 0);
  for (const rule of RULES) assert.equal(verifyRule(rule).ok, true, `rule ${rule.id}`);
});

test('a rule is applied only when its side condition holds', () => {
  const range = RULES.find((r) => r.when.includes('K0 <= K1') && r.lhs.length === 7);
  assert.ok(range, 'the range-check rule is in the rule set');
  const body = (lo, hi) => [['local.get', 'n'], ['i64.const', lo], ['i64.lt_s'], ['local.get', 'n'], ['i64.const', hi], ['i64.gt_s'], ['i32.or']];
  assert.deepEqual(peephole(body(-10n, 20n), { rules: [range] }), [['local.get', 'n'], ['i64.const', -10n], ['i64.sub'], ['i64.const', 30n], ['i64.gt_u']]);
  assert.equal(peephole(body(20n, -10n), { rules: [range] }).length, 7, 'K0 > K1: not rewritten');
});

test('the rewrite rules fire on real programs and change no output', () => {
  const dir = new URL('../examples/', import.meta.url);
  for (const f of ['tour.lm', 'memory.lm', 'traits.lm', 'refine.lm']) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const on = runSource(src, { host: makeHost() }), off = runSource(src, { host: makeHost(), superopt: false });
    assert.equal(on.output, off.output, f);
    assert.equal(on.error, off.error, f);
  }
});
