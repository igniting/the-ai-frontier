// Re-proving one rule, with no Node dependencies (the playground runs this
// in a Web Worker; superopt/verify.js runs it for every shipped rule).

import { prove } from './synth.js';
import { concrete } from './bv.js';
import { kValue } from '../src/peephole.js';

export function randomCheck(rule, trials = 2000, seed = 7) {
  let a = seed >>> 0;
  const rnd = () => { a = (Math.imul(a ^ (a >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0; a ^= a >>> 13; return a; };
  const pick = () => { const r = rnd(); return (r & 3) === 0 ? [0, 1, -1, 2, 3, 0x7fffffff, -0x80000000][(r >>> 2) % 7] : r; };
  const names = new Set(rule.lhs.filter(([op]) => op === 'kconst').map(([, arg]) => arg.k));
  for (let t = 0; t < trials; t++) {
    const ks = Object.fromEntries([...names].map((k) => [k, rule.nonneg?.includes(k) ? pick() & 0x7fffffff : pick()]));
    const locals = Object.fromEntries(rule.odd.map((odd, i) => [`x${i}`, odd ? pick() | 1 : pick()]));
    const stack = Array.from({ length: rule.inputs }, pick);
    const inst = (code) => code.map(([op, arg]) => (op === 'kconst' ? ['i32.const', kValue(ks, arg)] : [op, arg]));
    const l = concrete(inst(rule.lhs), locals, stack);
    const r = concrete(inst(rule.rhs), locals, stack);
    if (l.length !== 1 || r.length !== 1 || l[0] !== r[0]) return { ok: false, ks, locals, stack, lhs: l, rhs: r };
  }
  return { ok: true, trials };
}

export function verifyRule(rule, { keep = false } = {}) {
  const p = prove({ odd: rule.odd, inputs: rule.inputs }, rule.lhs, rule.rhs, { keep, nonneg: rule.nonneg ?? [] });
  const rnd = randomCheck(rule);
  return { ok: p.proved && p.checked && rnd.ok, proof: p, random: rnd };
}
