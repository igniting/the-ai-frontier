// The showcase programs (examples/showcase) make claims; these tests hold
// them to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkSource, runSource, testSource, makeHost } from '../src/api.js';

const source = (f) => readFileSync(new URL(`../examples/showcase/${f}`, import.meta.url), 'utf8');
const types = (src) => Object.fromEntries(checkSource(src).signatures.map((s) => [s.name, s.type]));

test('heapsort: pure, in place, and proved: not even main can fail', () => {
  const src = source('heapsort.lm');
  const t = types(src);
  for (const f of ['swap', 'sift', 'heapify', 'pop_all', 'heapsort', 'fill', 'is_sorted']) assert.ok(!t[f].includes('fail'), `${f}: ${t[f]}`);
  assert.equal(t.main, 'fn() -> () ! output');
  const r = runSource(src, { host: makeHost() });
  assert.match(r.output, /^sorted 1000000 numbers: true, from 0 to 65535\n/);
  assert.match(r.output, /#\[5, 449, 33749, 40843, 48597, 40314, 8922, 13854\] stays as it was/);
  assert.ok(r.allocs < 200, `a million-element sort allocated ${r.allocs} times`);
  assert.equal(r.live, 0);
});

test('binary search: every access proved, and a classic off-by-one refuted', () => {
  const src = source('search.lm');
  const t = types(src);
  assert.ok(!t.lower_bound.includes('fail') && !t.member.includes('fail'));
  assert.equal(runSource(src, { host: makeHost() }).output, 'found 1000000 of 3000000 numbers among 1000000\n');
  const bad = checkSource(src.replace('lower_bound(a, x, mid + 1, n - half - 1)', 'lower_bound(a, x, mid + 1, n - half)'));
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /cannot prove that argument `n` of `lower_bound`/);
});

test('plugins: the type of a plugin rules out output, randomness and failure', () => {
  const src = source('plugins.lm');
  assert.equal(runSource(src, { host: makeHost() }).output, 'initials -> upper -> exclaim: PNG!\n');
  for (const [plugin, effect] of [['spy', 'output'], ['coin', 'random'], ['first_letter', 'fail']]) {
    const c = checkSource(src.replace(new RegExp(`// \\("[a-z ]+", ${plugin}\\),`), `("x", ${plugin}),`));
    assert.equal(c.ok, false, plugin);
    assert.match(c.errors[0].note ?? c.errors[0].message, new RegExp(effect), plugin);
  }
});

test('intervals: the property finds the nested-interval bug, and the fix passes', () => {
  const src = source('intervals.lm');
  const r = testSource(src).results;
  const keeps = r.find((p) => p.name === 'merge_keeps_points');
  assert.equal(keeps.ok, false);
  assert.equal(keeps.compiled, 'agrees');
  assert.ok(r.find((p) => p.name === 'merge_is_disjoint').ok);
  const fixed = testSource(src.replace('go(rest, Some((cs, e)), acc)', 'go(rest, Some((cs, max(ce, e))), acc)')).results;
  assert.ok(fixed.every((p) => p.ok));
});
