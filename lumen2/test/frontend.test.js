// Front end and reference interpreter: inferred types and effects, the
// claims the checker enforces, and the semantics the interpreter defines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSource, interpretSource } from '../src/api.js';

const sigs = (src) => {
  const c = checkSource(src);
  if (!c.ok) assert.fail(c.errors[0].message);
  return Object.fromEntries(c.signatures.map((s) => [s.name, s.type]));
};
const rejects = (src, pattern) => {
  const c = checkSource(src);
  assert.equal(c.ok, false, 'expected a compile error');
  assert.match(c.errors[0].message, pattern);
};
const run = (src, input = '') => {
  const r = interpretSource(src, { input });
  if (!r.ok) assert.fail(r.errors[0].message);
  return r;
};

test('types and effects are inferred, effects are polymorphic', () => {
  const s = sigs(`
    fn area(w, h) { w * h }
    fn average(xs) { sum(xs) / length(xs) }
    fn shout(xs) { each(xs, |x| println(int_to_string(x))) }
    fn apply(f, x) { f(x) }
    fn has(xs, y) { any(xs, |x| x == y) }
    fn main() { shout([average([1, 2])]) }
  `);
  assert.equal(s.area, 'fn(Int, Int) -> Int');
  assert.equal(s.average, 'fn(List<Int>) -> Int ! fail');
  assert.equal(s.shout, 'fn(List<Int>) -> () ! io');
  assert.equal(s.apply, 'fn(fn(a) -> b ! e, a) -> b ! e');
  assert.equal(s.has, 'fn(List<a>, a) -> Bool where a: Cmp');
  assert.equal(s.main, 'fn() -> () ! {fail, io}');
});

test('effect annotations are checked claims', () => {
  rejects('fn f(xs: List<Int>) -> Int ! {} { sum(xs) / length(xs) }\nfn main() { () }', /`\/` \(division by zero\) can fail, but `f` is declared without `fail`/);
  rejects('fn f() -> () ! fail { println("x") }\nfn main() { () }', /calling `println` can perform io, but `f` is declared without `io`/);
  rejects('fn g(f: fn(Int) -> Int) -> Int { f(1) }\nfn main() { let n = g(|x| { println("hi"); x }); () }', /differ in their effects|expected fn\(Int\) -> Int, found fn\(Int\) -> Int ! io/);
  sigs('fn f(xs: List<Int>) -> Int ! fail { sum(xs) / length(xs) }\nfn main() { () }');
  sigs('fn g(f: fn(Int) -> Int ! e, x: Int) -> Int ! e { f(x) }\nfn main() { let n = g(|x| { println("ok"); x }, 1); () }');
});

test('comparison needs a type without functions', () => {
  rejects('fn main() { let f = |x: Int| x; let b = f == f; () }', /cannot be compared/);
  rejects('fn main() { let b = contains([|x: Int| x], |x: Int| x); () }', /cannot be compared/);
  rejects('type Box { B(fn(Int) -> Int) }\nfn main() { let b = B(|x| x) == B(|x| x); () }', /cannot be compared/);
  sigs('type Pt { P(Int, Int) }\nfn main() { let b = P(1, 2) < P(1, 3); () }');
});

test('pattern matches must be exhaustive, with a witness', () => {
  rejects('type L { R, G, B }\nfn f(l) { match l { R -> 1, G -> 2 } }\nfn main() { () }', /`B` is not covered/);
  rejects('fn f(xs) { match xs { [] -> 0, [x] -> x } }\nfn main() { () }', /`\[_, _, \.\.\]` is not covered/);
  rejects('fn f(p) { match p { (true, _) -> 1, (_, Some(x)) -> x } }\nfn main() { () }', /`\(false, None\)` is not covered/);
  rejects('fn main() { let Some(x) = None; () }', /`None` is not covered/);
});

test('ordinary type errors point at the expression', () => {
  rejects('fn main() { println("n = " ++ 1) }', /`\+\+` joins Strings: expected String, found Int/);
  rejects('fn main() { let x = if true { 1 } else { "a" }; () }', /`if` branches differ/);
  rejects('fn f(x) { x(x) }\nfn main() { () }', /infinite type/);
  rejects('fn main() { nope(1) }', /unknown variable `nope`/);
  rejects('fn main() { let x = 92233720368547758070; () }', /out of range/);
});

test('integers are 64-bit; overflow and division by zero are runtime errors', () => {
  assert.equal(run('fn main() { println(int_to_string(9223372036854775807)) }').output, '9223372036854775807\n');
  assert.equal(run('fn main() { println(int_to_string(-9223372036854775808)) }').output, '-9223372036854775808\n');
  assert.equal(run('fn main() { println(int_to_string(9223372036854775807 + 1)) }').error, 'integer overflow');
  assert.equal(run('fn main() { println(int_to_string(-9223372036854775808 / -1)) }').error, 'integer overflow');
  assert.equal(run('fn main() { println(int_to_string(1 / 0)) }').error, 'division by zero');
  assert.equal(run('fn main() { println(int_to_string(-7 / 2) ++ " " ++ int_to_string(-7 % 2)) }').output, '-3 -1\n');
});

test('arrays are values: setting returns a new array', () => {
  const r = run(`fn main() {
    let a = array_make(3, 0);
    let b = array_set(a, 1, 42);
    let c = array_push(b, 7);
    println(show_list(array_to_list(a), int_to_string) ++ show_list(array_to_list(b), int_to_string) ++ show_list(array_to_list(c), int_to_string));
    println(int_to_string(array_get(c, 5)))
  }`);
  assert.equal(r.output, '[0, 0, 0][0, 42, 0][0, 42, 0, 7]\n');
  assert.equal(r.error, 'index out of bounds');
});

test('evaluation order, tail calls, strings and the prelude', () => {
  const r = run(`
    fn trace(s, v) { print(s); v }
    fn count(n, acc) { if n == 0 { acc } else { count(n - 1, acc + 1) } }
    fn main() {
      let x = trace("a", 1) + trace("b", 2) * trace("c", 3);
      println(" " ++ int_to_string(x));
      println(int_to_string(count(1000000, 0)));
      println(substring("hello", -3, 3) ++ char_from_code(33) ++ int_to_string(char_code_at("A", 0)));
      println(join(map(sort([5, 3, 9, 1, 3]), int_to_string), ","));
      println(show_list(take(range(0, 10), 3), int_to_string) ++ show_list(zip([1, 2], [3]) |> map(|p| match p { (a, b) -> a + b }), int_to_string));
    }`);
  assert.equal(r.output, 'abc 7\n1000000\nhel!65\n1,3,3,5,9\n[0, 1, 2][4]\n');
});

test('ordering is structural: constructors by declaration order, then fields', () => {
  const r = run(`type T { A(Int), B }
    fn main() {
      let bs = [A(2) < A(3), A(9) < B, "ab" < "b", (1, "z") < (2, "a"), [1, 2] < [1, 2, 0], Some(1) == Some(1)];
      println(show_list(bs, |b| if b { "t" } else { "f" }))
    }`);
  assert.equal(r.output, '[t, t, t, t, t, t]\n');
});
