// Floats: literals rounded exactly as JavaScript's Number rounds them, the
// typing of overloaded arithmetic, and compiled code agreeing with the
// interpreter on arithmetic, text, conversions, ordering, failures and
// par_map, on any number of threads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSource, interpretSource, compileSource, runSource, testSource, makeHost, runWasm } from '../src/api.js';
import { floatToString, parseFloatText } from '../src/floats.js';
import { readFileSync } from 'node:fs';

// Runs src compiled (normally and in paranoid mode) and interpreted; all must agree.
function agree(src) {
  const ref = interpretSource(src, { host: makeHost({ seed: 9 }) });
  if (!ref.ok) assert.fail(ref.errors[0].message);
  let last;
  for (const paranoid of [false, true]) {
    const r = runSource(src, { paranoid, host: makeHost({ seed: 9 }) });
    assert.equal(r.output, ref.output, `output (paranoid: ${paranoid})`);
    assert.equal(r.error, ref.error, `error (paranoid: ${paranoid})`);
    if (!r.error) assert.equal(r.live, 0, 'every object is freed');
    last = r;
  }
  return last;
}
const error = (src) => { const c = checkSource(src); assert.equal(c.ok, false, 'must be rejected'); return c.errors[0].message; };
const sig = (src, name) => checkSource(src).signatures.find((s) => s.name === name).type;

test('literals: rounded to the nearest double, ties to even, exactly as Number rounds them', () => {
  let seed = 987654321n;
  const rnd = (n) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return Number((seed >> 33n) % BigInt(n)); };
  // The exact decimal of M * 2^E.
  const exact = (M, E) => {
    if (E >= 0) return `${(M << BigInt(E)).toString()}.0`;
    const k = -E;
    const digits = (M * 5n ** BigInt(k)).toString().padStart(k + 1, '0');
    return `${digits.slice(0, -k)}.${digits.slice(-k)}`;
  };
  const lits = ['1.7976931348623157e308', '1.7976931348623158e308', '2.2250738585072014e-308', '2.2250738585072011e-308',
    '4.9406564584124654e-324', '2.4703282292062328e-324', '0.1', '0.0', '9007199254740993.0', '1e23', '8.98846567431158e307', '1_000.000_001'];
  for (let i = 0; i < 150; i++) {
    // Halfway between two adjacent doubles, and a hair above it.
    const biased = Math.max(1, Math.min(2046, (rnd(2) ? rnd(60) - 30 : rnd(2000) - 1000) + 1023));
    const m = (1n << 52n) | (BigInt(rnd(2 ** 26)) * BigInt(2 ** 26) + BigInt(rnd(2 ** 26))) & ((1n << 52n) - 1n);
    const mid = exact(2n * m + 1n, biased - 1076);
    lits.push(mid, `${mid}1`);
  }
  for (let i = 0; i < 40; i++) lits.push(exact(2n * BigInt(rnd(2 ** 30)) + 1n, -1075)); // subnormal halfway points
  for (let i = 0; i < 250; i++) {
    const nd = 1 + rnd(25);
    let d = String(1 + rnd(9));
    for (let k = 1; k < nd; k++) d += String(rnd(10));
    const dot = rnd(nd + 1);
    const mant = dot === nd ? d : `${d.slice(0, dot) || '0'}.${d.slice(dot)}`;
    const lit = rnd(3) ? `${mant}e${rnd(2) ? '-' : ''}${rnd(330)}` : mant;
    lits.push(/[.e]/.test(lit) ? lit : `${lit}.0`);
  }
  const ok = lits.filter((l) => { const x = Number(l.replace(/_/g, '')); return Number.isFinite(x) && x !== 0 || /^[0.]+$/.test(l); });
  const parts = [];
  for (let i = 0; i < ok.length; i += 100) parts.push(`fn part${i}() {\n${ok.slice(i, i + 100).map((l) => `  println(float_to_string(${l}));`).join('\n')}\n}\n`);
  const src = `${parts.join('')}fn main() {\n${parts.map((_, k) => `  part${k * 100}();`).join('\n')}\n}\n`;
  const out = runWasm(compileSource(src).bytes).output.split('\n');
  ok.forEach((l, i) => assert.equal(out[i], floatToString(Number(l.replace(/_/g, ''))), l));
  assert.ok(ok.length > 550);
  // Too large, or too small to be anything but 0, is an error; 0 itself is fine.
  assert.match(error('fn main() { println(float_to_string(1.7976931348623159e308)) }'), /float literal out of range/);
  assert.match(error('fn main() { println(float_to_string(2.4703282292062327e-324)) }'), /float literal too small/);
  assert.match(error('fn main() { match 1.5 { 1.5 -> (), _ -> () } }'), /a float cannot be a pattern/);
});

test('arithmetic is on two Ints or two Floats; an operand type left open is Int', () => {
  assert.equal(sig('fn double(x) { x + x }\nfn main() { () }', 'double'), 'fn(Int) -> Int');
  assert.equal(sig('fn twice(x) { 2.0 * x }\nfn main() { () }', 'twice'), 'fn(Float) -> Float');
  assert.equal(sig('fn total(xs) { fold(xs, 0.0, |acc, x| acc + x) }\nfn main() { () }', 'total'), 'fn(List<Float>) -> Float');
  assert.equal(sig('fn neg(x: Float) { -x }\nfn main() { () }', 'neg'), 'fn(Float) -> Float');
  // Settled after the operator, by a later use in the same function.
  assert.equal(sig('fn f(y: Float) { let add = |a, b| a + b; add(y, 1.0) }\nfn main() { () }', 'f'), 'fn(Float) -> Float');
  // A float literal divisor other than 0.0 is not zero; any other float divisor might be.
  assert.equal(sig('fn half(x: Float) { x / 2.0 }\nfn main() { () }', 'half'), 'fn(Float) -> Float');
  assert.equal(sig('fn ratio(x: Float, y: Float) { x / y }\nfn main() { () }', 'ratio'), 'fn(Float, Float) -> Float ! fail');
  assert.equal(sig('fn zero(x: Float) { x / 0.0 }\nfn main() { () }', 'zero'), 'fn(Float) -> Float ! fail');
  assert.equal(sig('fn root(x: Float) { sqrt(x) }\nfn main() { () }', 'root'), 'fn(Float) -> Float ! fail');
  assert.match(error('fn main() { println(float_to_string(1.0 + 2)) }'), /right operand of `\+`: expected Float, found Int/);
  assert.match(error('fn main() { println(int_to_string(1 + 2.5)) }'), /left operand of `\+`: expected Float, found Int/);
  assert.match(error('fn main() { let r = 7.5 % 2.0; () }'), /expected Int, found Float/);
  assert.match(error('fn f(a, b) { let c = a + b; c ++ "!" }\nfn main() { () }'), /`\+` works on Int and Float, not String/);
  assert.match(error('fn main() { let x: Float = 1; () }'), /expected Float, found Int/);
});

test('compiled code agrees with the interpreter: arithmetic, text, conversions, ordering', () => {
  agree(`fn main() {
    println(float_to_string(0.1 + 0.2) ++ " " ++ float_to_string(1.0 / 3.0) ++ " " ++ float_to_string(2.0 * -0.0) ++ " " ++ float_to_string(-(5e-324)));
    println(show([1.0, 100.0, 1e21, 1e-7, 1.5e300, 123456789.125, -0.5]));
    println(join(map([0, 1, 2, 5, 20, 25, -3], |d| float_to_fixed(1.005, d)), " ") ++ " " ++ float_to_fixed(-0.001, 2) ++ " " ++ float_to_fixed(1e22, 2));
    println(show(map(["1.5", "-2e3", ".5", "5.", "+7", "1e999", "x", "", "1.2.3", " 1", "0x10", "Infinity", "NaN", "1e-400"], parse_float)));
    println(show(map([2.5, -2.5, 0.5, -0.5, 0.49999999999999994, 1.5, 4503599627370497.0, -0.3], round)));
    println(show(map([-1.5, -0.5, 0.5, 1.5], |x| (floor(x), ceil(x), trunc(x), float_abs(x)))));
    println(show(map([0.0, 2.0, 1e-300, 1e300], sqrt)));
    println(show(map([-7.9, 7.9, -0.5, 9.2e18, -9.223372036854775808e18], float_to_int)));
    println(show(map([9007199254740993, -9223372036854775807 - 1, 0, 1, -3], int_to_float)));
    println(show(sort([3.5, -1.0, 2.25, -0.0, 0.0, 1e-300, -1e300])) ++ show([0.0 == -0.0, 1.0 < 1.0000000000000002, 2.5 > -1.0]) ++ show(compare(2.5, -1.0)) ++ show(max(1.5, -2.0)));
  }`);
});

test('floats in data: arrays, tuples, constructors, closures, unboxed results, par_map', () => {
  const src = `type Body { Body(Float, Float, Int) }
    fn split(x: Float) -> (Float, Int) { (x - floor(x), float_to_int(floor(x))) }
    fn energy(b: Body) -> Float { match b { Body(m, v, _) -> 0.5 * m * v * v } }
    fn main() {
      let a = array_set(array_make(4, 0.5), 2, -1.25);
      let scale = 3.0;
      let f = |x| x * scale;
      println(show(a) ++ show(par_map(a, f)) ++ show(par_map(array_from_list(range(0, 2000)), |i| int_to_float(i) / 3.0) |> array_to_list |> take(3)));
      println(show(split(7.25)) ++ show(map([Body(2.0, 3.0, 1), Body(1.0, -4.0, 2)], energy)) ++ show(Body(1.5, 2.5, 3) < Body(1.5, 2.75, 0)));
      let sums = par_map(array_from_list(range(0, 64)), |k| fold(range(0, 1000), 0.0, |acc, i| acc + 1.0 / int_to_float(k * 1000 + i + 1)));
      println(float_to_string(fold(array_to_list(sums), 0.0, |acc, x| acc + x)));
    }`;
  agree(src);
  const bytes = compileSource(src).bytes;
  const outs = [1, 2, 4].map((threads) => runWasm(bytes, { threads }).output);
  assert.equal(outs[1], outs[0]);
  assert.equal(outs[2], outs[0]);
});

test('failures: float overflow, division by zero, square roots of negatives, conversions out of range', () => {
  for (const [body, msg] of [
    ['let x = 1e308; println(float_to_string(x * 10.0))', 'float overflow'],
    ['println(float_to_string(-1e308 - 1e308))', 'float overflow'],
    ['println(float_to_string(1e300 / 1e-300))', 'float overflow'],
    ['let z = 0.0; println(float_to_string(1.0 / z))', 'division by zero'],
    ['let z = -0.0; println(float_to_string(0.0 / z))', 'division by zero'],
    ['println(float_to_string(2.0 / 0.0))', 'division by zero'],
    ['println(float_to_string(sqrt(0.0 - 1e-300)))', 'square root of a negative number'],
    ['println(int_to_string(float_to_int(9.3e18)))', 'integer overflow'],
    ['println(int_to_string(float_to_int(-9.3e18)))', 'integer overflow'],
    ['println(show(par_map(array_from_list(range(0, 100)), |i| if i == 77 { 1e308 * 10.0 } else { 1.0 })))', 'float overflow'],
  ]) {
    const r = agree(`fn main() { println("before"); ${body} }`);
    assert.equal(r.error, msg, body);
    assert.equal(r.output, 'before\n');
  }
});

test('properties over floats: generated, shrunk, replayed compiled', () => {
  const t = testSource(`
    property commutes(a: Float, b: Float) { a * b == b * a }
    property round_trip(a: Float) { parse_float(float_to_string(a)) == Some(a) }
    property associates(a: Float, b: Float, c: Float) { (a + b) + c == a + (b + c) }`, { runs: 150, seed: 3 });
  const by = Object.fromEntries(t.results.map((r) => [r.name, r]));
  assert.equal(by.round_trip.ok, true);
  assert.equal(by.round_trip.compiled, 'agrees');
  assert.equal(by.associates.ok, false, 'float addition does not associate');
  assert.equal(by.associates.compiled, 'agrees');
  // commutes holds, unless a product overflows, which is a failure in both runs.
  assert.equal(by.commutes.compiled, 'agrees');
});

test('text: floatToString and parseFloatText', () => {
  assert.equal(floatToString(1), '1.0');
  assert.equal(floatToString(-0), '0.0');
  assert.equal(floatToString(1e21), '1e+21');
  assert.equal(floatToString(1.5e-7), '1.5e-7');
  assert.equal(floatToString(-2.5), '-2.5');
  for (const [s, v] of [['1.5', 1.5], ['-2e3', -2000], ['.5', 0.5], ['5.', 5], ['+7', 7], ['1e-400', 0]]) assert.equal(parseFloatText(s), v, s);
  for (const s of ['1e999', 'x', '', '1.2.3', ' 1', '0x10', 'Infinity', 'NaN', '1_000', '.', 'e5']) assert.ok(Number.isNaN(parseFloatText(s)), s);
});

test('a parallel sum of floats is the same, bit for bit, on any number of threads', () => {
  // bench/sum-par.lm: par_map adds up fixed blocks, whose sums come back in order.
  const bytes = compileSource(readFileSync(new URL('../bench/sum-par.lm', import.meta.url), 'utf8'), { grants: ['input', 'output'] }).bytes;
  const outs = [1, 2, 3, 4].map((threads) => runWasm(bytes, { input: '200000', threads }).output);
  for (const o of outs) assert.equal(o, outs[0]);
  assert.match(outs[0], /^0\.6931\d+\n$/);
});
