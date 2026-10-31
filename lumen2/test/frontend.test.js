// Front end and reference interpreter: inferred types and effects, the
// claims the checker enforces, and the semantics the interpreter defines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSource, interpretSource, makeHost } from '../src/api.js';

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
const run = (src, input = '', host = undefined) => {
  const r = interpretSource(src, { input, host });
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
  assert.equal(s.shout, 'fn(List<Int>) -> () ! output');
  assert.equal(s.apply, 'fn(fn(a) -> b ! e, a) -> b ! e');
  assert.equal(s.has, 'fn(List<a>, a) -> Bool where a: Ord');
  assert.equal(s.main, 'fn() -> () ! {fail, output}');
});

test('effect annotations are checked claims', () => {
  rejects('fn f(xs: List<Int>) -> Int ! {} { sum(xs) / length(xs) }\nfn main() { () }', /`\/` \(division by zero\) can fail, but `f` is declared without `fail`/);
  rejects('fn f() -> () ! fail { println("x") }\nfn main() { () }', /calling `println` can write output, but `f` is declared without `output`/);
  rejects('fn g(f: fn(Int) -> Int) -> Int { f(1) }\nfn main() { let n = g(|x| { println("hi"); x }); () }', /differ in their effects|expected fn\(Int\) -> Int, found fn\(Int\) -> Int ! output/);
  sigs('fn f() -> () ! io { println("x") }\nfn main() { f() }');
  sigs('fn f(xs: List<Int>) -> Int ! fail { sum(xs) / length(xs) }\nfn main() { () }');
  sigs('fn g(f: fn(Int) -> Int ! e, x: Int) -> Int ! e { f(x) }\nfn main() { let n = g(|x| { println("ok"); x }, 1); () }');
});

test('capabilities: io is split, and main gets only what it is granted', () => {
  const s = sigs(`
    fn greet() { println("hi") }
    fn echo() { print(read_input()) }
    fn roll() { random_int(1, 6) }
    fn stamp() { clock_ms() }
    fn main() { greet() }
  `);
  assert.equal(s.greet, 'fn() -> () ! output');
  assert.equal(s.echo, 'fn() -> () ! {input, output}');
  assert.equal(s.roll, 'fn() -> Int ! random');
  assert.equal(s.stamp, 'fn() -> Int ! clock');
  const granted = (src, grants) => checkSource(src, { grants });
  const prog = 'fn roll() { random_int(1, 6) }\nfn main() { println(int_to_string(roll())) }';
  const denied = granted(prog, ['output']);
  assert.equal(denied.ok, false);
  assert.match(denied.errors[0].message, /calling `roll` can use randomness, but `main` was not granted `random`/);
  assert.equal(granted(prog, ['output', 'random']).ok, true);
  // fail is not a capability: it is always allowed.
  assert.equal(granted('fn main() { println(int_to_string(1 / 0)) }', ['output']).ok, true);
  // An annotation on main cannot claim more than the grant.
  assert.match(granted('fn main() -> () ! {output, clock} { println("x") }', ['output']).errors[0].message, /declared with `clock`, which was not granted/);
  rejects('fn f() -> () ! {net} { () }\nfn main() { () }', /unknown effect `net`/);
});

test('clock and random come from the host, so a seeded run is reproducible', () => {
  const src = 'fn main() { let t = clock_ms(); let a = random_int(1, 100); let b = random_int(100, 1); println(int_to_string(a) ++ " " ++ int_to_string(b) ++ " " ++ int_to_string(clock_ms() - t)) }';
  const one = run(src, '', makeHost({ seed: 42 })).output;
  assert.equal(run(src, '', makeHost({ seed: 42 })).output, one);
  const [a, b, dt] = one.trim().split(' ').map(Number);
  assert.ok(a >= 1 && a <= 100 && b >= 1 && b <= 100 && dt === 1);
});

test('traits: methods are typed by their signatures and need an impl', () => {
  const prog = `
    trait Area { fn area(x: Self) -> Int }
    type Shape { Sq(Int), Rect(Int, Int) }
    impl Area for Shape { fn area(s) { match s { Sq(n) -> n * n, Rect(w, h) -> w * h } } }
    impl Area for List<a> where a: Area { fn area(xs) { sum(map(xs, area)) } }
    fn total(xs) { area(xs) }
    fn describe(x) { show(x) ++ " has area " ++ show(area(x)) }
    fn main() { println(describe([Sq(2), Rect(1, 3)])) }`;
  const s = sigs(prog);
  assert.equal(s.total, 'fn(a) -> Int where a: Area');
  assert.equal(s.describe, 'fn(a) -> String where a: Area + Show');
  assert.equal(run(prog).output, '[Sq(2), Rect(1, 3)] has area 7\n');
  rejects('trait Area { fn area(x: Self) -> Int }\nfn main() { println(show(area(3))) }', /`Int` does not implement `Area`/);
  rejects('type F { F(fn(Int) -> Int) }\nfn main() { println(show(F(|x| x))) }', /`F` does not implement `Show`/);
  const base = 'trait Area { fn area(x: Self) -> Int }\ntype S { S(Int) }\n';
  rejects(base + 'impl Area for S { }\nfn main() { () }', /missing the method `area`/);
  rejects(base + 'impl Area for S { fn area(s) { "big" } }\nfn main() { () }', /does not match the trait/);
  rejects(base + 'impl Area for S { fn area(s) { println("x"); 1 } }\nfn main() { () }', /calling `println` can write output, but `area` in `impl Area for S` is declared without `output`/);
  rejects('trait Area { fn area(x: Self) -> Int }\ntype B<a> { B(a) }\nimpl Area for B<a> { fn area(b) { match b { B(x) -> area(x) } } }\nfn main() { () }', /needs `a: Area`/);
  rejects('type V { V(Int) }\nimpl Ord for V { fn compare(a, b) { 0 } }\nimpl Ord for V { fn compare(a, b) { 1 } }\nfn main() { () }', /already implements `Ord`/);
  rejects('impl Show for Int { fn show(n) { "n" } }\nfn main() { () }', /only types declared in this program can have their own `impl Show`/);
});

test('Ord: a user impl replaces structural ordering, everywhere the type is compared', () => {
  const r = run(`
    type Version { V(Int, Int) }
    impl Ord for Version {
      fn compare(a, b) { match (a, b) { (V(x1, y1), V(x2, y2)) -> if x1 != x2 { x2 - x1 } else { y2 - y1 } } }
    }
    fn main() {
      println(show(sort([V(1, 2), V(3, 0), V(1, 5)])));
      println(show([V(1, 0)] < [V(0, 0)]) ++ " " ++ show(compare(Some(V(1, 0)), Some(V(2, 0)))) ++ " " ++ show(compare((1, "a"), (1, "b"))))
    }`);
  assert.equal(r.output, '[V(3, 0), V(1, 5), V(1, 2)]\ntrue 1 -1\n');
});

test('properties: typed inputs, a Bool result, no effects but fail', () => {
  assert.equal(checkSource('property p(xs: List<Int>) { reverse(reverse(xs)) == xs }').ok, true, 'a program of properties needs no main');
  rejects('property p(xs) { true }', /need types, so that inputs can be generated/);
  rejects('property p(f: fn(Int) -> Int) { f(1) == 1 }', /concrete types without functions/);
  rejects('property p(xs: List<a>) { true }', /concrete types without functions/);
  rejects('property p(n: Int) { n + 1 }', /a property must be true or false/);
  rejects('property p(n: Int) { println("x"); true }', /calling `println` can write output, but property `p` is declared without `output`/);
  assert.equal(checkSource('property p(n: Int) { 10 / n > 0 }').ok, true, 'a property may fail');
});

test('refinements: proved partial operations do not fail', () => {
  const s = sigs(`
    fn safe_get(a, i) { if 0 <= i && i < array_length(a) { Some(array_get(a, i)) } else { None } }
    fn average(xs) { let n = length(xs); if n == 0 { 0 } else { sum(xs) / n } }
    fn first(a) { array_get(a, 0) }
    fn last_char(s) { if string_length(s) > 0 { char_code_at(s, string_length(s) - 1) } else { -1 } }
    fn sum_array(a: Array<Int>) -> Int {
      fn go(i: {i: Int | 0 <= i}, acc) { if i < array_length(a) { go(i + 1, acc + array_get(a, i)) } else { acc } }
      go(0, 0)
    }
    fn ratio(x, d) { match d { 0 -> 0, _ -> x / d } }
    fn grid(n) { if n >= 0 { array_length(array_make(n, 0)) } else { 0 } }
    fn main() { () }
  `);
  assert.equal(s.safe_get, 'fn(Array<a>, Int) -> Option<a>');
  assert.equal(s.average, 'fn(List<Int>) -> Int');
  assert.equal(s.first, 'fn(Array<a>) -> a ! fail');
  assert.equal(s.last_char, 'fn(String) -> Int');
  assert.equal(s.sum_array, 'fn(Array<Int>) -> Int');
  assert.equal(s.ratio, 'fn(Int, Int) -> Int');
  assert.equal(s.grid, 'fn(Int) -> Int');
  // The prelude's own array functions are pure for the same reason.
  assert.equal(sigs('fn f(a) { array_to_list(a) }\nfn main() { () }').f, 'fn(Array<a>) -> List<a>');
});

test('refinements: contracts are proved at every call, with counterexamples', () => {
  const get = 'fn get(a: Array<Int>, i: {i: Int | 0 <= i && i < array_length(a)}) -> Int { array_get(a, i) }\n';
  sigs(get + 'fn main() { let a = array_make(3, 7); println(int_to_string(get(a, 2))) }');
  rejects(get + 'fn main() { let a = array_make(3, 7); println(int_to_string(get(a, 3))) }', /cannot prove that argument `i` of `get` satisfies `0 <= i && i < array_length\(a\)`/);
  const c = checkSource(get + 'fn f(a: Array<Int>, j: Int) -> Int { if j <= array_length(a) { get(a, j) } else { 0 } }\nfn main() { () }');
  assert.match(c.errors[0].note, /for example when array_length\(a\) = \d+, j = \d+/);
  const [len, j] = c.errors[0].note.match(/\d+/g).map(Number);
  assert.ok(j >= len && len <= 16, 'the counterexample is a real one, and small');
  rejects('fn clamp(x: Int, n: Int) -> {r: Int | 0 <= r && r <= n} { if x < 0 { 0 } else if x > n { n } else { x } }\nfn main() { () }', /cannot prove that the result of `clamp` satisfies/);
  sigs('fn clamp(x: Int, n: {n: Int | n >= 0}) -> {r: Int | 0 <= r && r <= n} { if x < 0 { 0 } else if x > n { n } else { x } }\nfn main() { () }');
  sigs('fn main() { let n: {n: Int | n > 0} = 4; println(int_to_string(10 / n)) }');
  rejects('fn main() { let n: {n: Int | n > 0} = 0; () }', /cannot prove that this value satisfies `n > 0`/);
  // An effect annotation that a failed proof breaks says why.
  const f = checkSource('fn f(a: Array<Int>, i: Int) -> Int ! {} { if i <= array_length(a) && i >= 0 { array_get(a, i) } else { 0 } }\nfn main() { () }');
  assert.match(f.errors[0].message, /calling `array_get` can fail/);
  assert.match(f.errors[0].note, /could not prove that the index is in bounds: for example when array_length\(a\) = (\d+), i = \1/);
});

test('refinements: element refinements describe every element of an array', () => {
  const pick = 'fn pick(a: Array<Int>, ix: Array<{k: Int | 0 <= k && k < array_length(a)}>, j: Int) -> Int { if 0 <= j && j < array_length(ix) { array_get(a, array_get(ix, j)) } else { 0 } }\n';
  const call = (ix) => `${pick}fn main() { let a = array_make(5, 1); println(int_to_string(pick(a, ${ix}, 1))) }`;
  assert.equal(sigs(call('array_push(array_make(2, 4), 0)')).pick, 'fn(Array<Int>, Array<{k: Int | 0 <= k && k < array_length(a)}>, Int) -> Int');
  sigs(call('array_set(array_push(array_empty(), 3), 0, 4)'));
  rejects(call('array_push(array_make(2, 4), 5)'), /cannot prove that the elements of argument `ix` of `pick` satisfy `0 <= k && k < array_length\(a\)`/);
  rejects(call('array_set(array_make(2, 4), 1, -1)'), /cannot prove that the elements of argument `ix`/);
  // A refined result: whoever calls indices knows every element is below n.
  const indices = (push) => `fn indices(n: {n: Int | n > 0}, xs: List<Int>, acc: Array<{k: Int | 0 <= k && k < n}>) -> Array<{k: Int | 0 <= k && k < n}> {
    match xs { [] -> acc, [x, ..rest] -> indices(n, rest, array_push(acc, ${push})) }
  }
  fn last(a: Array<Int>, xs: List<Int>) -> Int {
    if array_length(a) > 0 { let ix = indices(array_length(a), xs, array_empty()); if array_length(ix) > 0 { array_get(a, array_get(ix, array_length(ix) - 1)) } else { 0 } } else { 0 }
  }
  fn main() { println(int_to_string(last(array_make(3, 9), [7, -2]))) }`;
  const ok = indices('if x < 0 { 0 } else if x >= n { n - 1 } else { x }');
  assert.equal(sigs(ok).last, 'fn(Array<Int>, List<Int>) -> Int');
  assert.equal(run(ok).output, '9\n');
  rejects(indices('if x < 0 { 0 } else if x > n { n } else { x }'), /cannot prove that the elements of argument `acc` of `indices` satisfy `0 <= k && k < n`/);
  // Nested: the elements of the elements.
  sigs(`fn total(rows: Array<{r: Array<{x: Int | 0 <= x && x < 10}> | array_length(r) >= 1}>, i: {i: Int | 0 <= i}, acc: Int) -> Int {
    if i < array_length(rows) { let r = array_get(rows, i); total(rows, i + 1, acc + array_get(r, 0) + array_get(array_make(10, 1), array_get(r, array_length(r) - 1))) } else { acc }
  }
  fn main() { println(int_to_string(total(array_make(2, array_make(3, 4)), 0, 0))) }`);
  rejects('fn main() { let a: Array<{x: Int | x > 0}> = array_make(2, 1); () }', /element refinements can annotate the parameters and results of named functions/);
});

test('refinements: a Boolean match is one of its arms, not their disjunction', () => {
  // Found by the fuzzer: with `_ -> false` after `"a" -> true`, the checker
  // took the match to be always true, so the else branch was unreachable and
  // its out-of-bounds access counted as proved.
  const s = sigs(`fn f(s: String, a: Array<Int>) -> Int { if (match s { "a" -> true, _ -> false }) { 0 } else { array_get(a, 10) } }
  fn g(x: Int) -> Int { let ok = match x { 0 -> false, _ -> true }; if ok { 10 / x } else { 0 } }
  fn main() { () }`);
  assert.equal(s.f, 'fn(String, Array<Int>) -> Int ! fail');
  assert.equal(s.g, 'fn(Int) -> Int', 'what the arms say about x is kept');
});

test('refinements: a value that overflowed constrains nothing', () => {
  // Found by the fuzzer: the checker computes 9223372036854775806 + 2 as 2^63,
  // which no Int is. Defining the if's value as equal to it made the
  // definitions contradictory, so the access after the match counted as proved.
  const s = sigs(`fn g(k: Int, xs: List<Int>) -> Int {
    let a = array_make(k, 1);
    let x = match xs { [] -> 0, [y] -> array_get(array_push(a, y), 0), _ -> if true { 9223372036854775806 + 2 } else { 10 } };
    array_get(a, array_length(a))
  }
  fn h(x: Int) -> Int { let q = (x + 1) / 2; if x >= 0 && x <= 10 { array_get(array_make(6, 0), q) } else { 0 } }
  fn main() { () }`);
  assert.equal(s.g, 'fn(Int, List<Int>) -> Int ! fail');
  assert.equal(s.h, 'fn(Int) -> Int', 'in range, a quotient is still known');
});

test('read_line streams standard input a line at a time', () => {
  const src = `fn count(n: Int, bytes: Int) -> (Int, Int) ! input {
    let l = read_line();
    if string_length(l) == 0 { (n, bytes) } else { count(n + 1, bytes + string_length(l)) }
  }
  fn main() { match count(0, 0) { (n, b) -> println(int_to_string(n) ++ " lines, " ++ int_to_string(b) ++ " bytes " ++ read_input()) } }`;
  assert.equal(sigs(src).count, 'fn(Int, Int) -> (Int, Int) ! input');
  assert.equal(run(src, 'p\nqr\n\ns').output, '4 lines, 7 bytes p\nqr\n\ns\n');
  assert.equal(run(src, '').output, '0 lines, 0 bytes \n');
});

test('refinements: a small decidable predicate language', () => {
  rejects('fn f(x: {x: Int | length([x]) > 0}) { x }\nfn main() { () }', /the only calls allowed in a refinement are array_length/);
  rejects('fn f(x: {x: Int | x / 2 > 0}) { x }\nfn main() { () }', /`\/` cannot be used in a refinement/);
  rejects('fn f(x: Int, y: {y: Int | x * y > 0}) { x }\nfn main() { () }', /`\*` needs a constant on one side/);
  rejects('fn f(xs: {xs: List<Int> | true}) { xs }\nfn main() { () }', /only Int, Array and String values can be refined/);
  rejects('fn main() { let f = |x: {x: Int | x > 0}| x; () }', /the parameters of a lambda cannot be refined/);
  rejects('fn pos(x: {x: Int | x > 0}) -> Int { x }\nfn main() { println(show(map([1, 2], pos))) }', /`pos` has refined parameters, so it can only be called directly/);
  rejects('type T { T({x: Int | x > 0}) }\nfn main() { () }', /refinement types can annotate the parameters and results of named functions/);
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
