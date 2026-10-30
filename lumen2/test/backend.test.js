// The WebAssembly back end: compiled programs must behave exactly like the
// reference interpreter, free every object they allocate, and update uniquely
// owned data in place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSource, interpretSource, compileSource, runSource, testSource, makeHost } from '../src/api.js';
import { checkRefutation } from '../src/rup.js';
import { runWasm } from '../src/codegen.js';
import { generate, differential, MUTANTS } from './fuzz.js';

// Runs src compiled (normally and in paranoid mode) and interpreted; all must agree.
function agree(src, input = '') {
  const ref = interpretSource(src, { input, host: makeHost({ seed: 9 }) });
  if (!ref.ok) assert.fail(ref.errors[0].message);
  let last;
  for (const paranoid of [false, true]) {
    const r = runSource(src, { input, paranoid, host: makeHost({ seed: 9 }) });
    assert.equal(r.output, ref.output, `output (paranoid: ${paranoid})`);
    assert.equal(r.error, ref.error, `error (paranoid: ${paranoid})`);
    if (!r.error) assert.equal(r.live, 0, 'every object is freed');
    last = r;
  }
  return last;
}

test('compiled programs agree with the interpreter', () => {
  agree(`fn main() {
    let x = 9223372036854775807;
    println(int_to_string(x) ++ " " ++ int_to_string(-9223372036854775808) ++ " " ++ int_to_string(-7 / 2) ++ " " ++ int_to_string(-7 % 2));
    println(substring("hello", -3, 3) ++ char_from_code(33) ++ int_to_string(char_code_at("A", 0)) ++ char_from_code(321));
    println(join(map(sort([5, 3, 9, 1, 3]), int_to_string), ","));
    println(show_list(take(range(0, 10), 3), int_to_string) ++ show_list(zip([1, 2], [3]) |> map(|p| match p { (a, b) -> a + b }), int_to_string));
    println(int_to_string(x + 1))
  }`);
  agree(`type T { A(Int), B }
    fn main() {
      let bs = [A(2) < A(3), A(9) < B, "ab" < "b", (1, "z") < (2, "a"), [1, 2] < [1, 2, 0], Some(1) == Some(1), array_make(2, 1) < array_make(3, 0)];
      println(show_list(bs, |b| if b { "t" } else { "f" }))
    }`);
  agree(`fn trace(s, v) { print(s); v }
    fn main() { let x = trace("a", 1) + trace("b", 2) * trace("c", 3); println(" " ++ int_to_string(x)); println(int_to_string(1 / 0)) }`);
  agree('fn main() { let a = array_make(3, "x"); println(array_get(a, 3)) }');
  agree('fn main() { panic("stop") }');
  agree('fn main() { println(int_to_string(3037000500 * 3037000500)) }');
  agree('fn main() { let s = read_input(); println(int_to_string(string_length(s)) ++ s) }', 'caf\xc3\xa9 \xff');
  agree('fn main() { let t = clock_ms(); println(int_to_string(random_int(-5, 5)) ++ " " ++ int_to_string(random_int(-9223372036854775808, 9223372036854775807)) ++ " " ++ int_to_string(clock_ms() - t)) }');
});

test('closures, local functions, guards and nested patterns', () => {
  agree(`type Tree<a> { Leaf, Node(Tree<a>, a, Tree<a>) }
    fn insert(t, x) {
      match t {
        Leaf -> Node(Leaf, x, Leaf),
        Node(l, y, r) -> if x < y { Node(insert(l, x), y, r) } else if x > y { Node(l, y, insert(r, x)) } else { t },
      }
    }
    fn to_list(t) { match t { Leaf -> [], Node(l, x, r) -> append(to_list(l), [x, ..to_list(r)]) } }
    fn classify(xs) {
      match xs { [] -> "empty", [x] if x > 10 -> "big", [x] -> "one", [x, y, ..] if x == y -> "pair", _ -> "other" }
    }
    fn main() {
      println(join(to_list(fold(["m", "c", "x", "a", "e", "m"], Leaf, insert)), " "));
      let s = "kept";
      let f = |x| s ++ x;
      let g = |x| f(f(x));
      println(g("!"));
      println(join(map([[], [11], [3], [4, 4, 1], [1, 2]], classify), ","));
      fn count(n, acc) { if n == 0 { acc } else { count(n - 1, [n, ..acc]) } }
      println(int_to_string(sum(count(1000, []))));
      let fs = map([1, 2, 3], |k| |x| x * k);
      println(show_list(map(fs, |h| h(10)), int_to_string));
      println(match Some(Some(7)) { Some(Some(n)) if n > 9 -> "big", Some(Some(n)) -> int_to_string(n), _ -> "none" })
    }`);
});

test('traits: impls are resolved at compile time, and user Ord reaches structural comparison', () => {
  agree(`type Shape { Circle(Int), Rect(Int, Int), Dot }
    type Version { V(Int, Int) }
    impl Ord for Version { fn compare(a, b) { match (a, b) { (V(x1, y1), V(x2, y2)) -> if x1 != x2 { x2 - x1 } else { y2 - y1 } } } }
    trait Area { fn area(x: Self) -> Int }
    impl Area for Shape { fn area(s) { match s { Circle(r) -> 3 * r * r, Rect(w, h) -> w * h, Dot -> 0 } } }
    impl Area for List<a> where a: Area { fn area(xs) { sum(map(xs, area)) } }
    type Tree<a> { Leaf, Node(Tree<a>, a, Tree<a>) }
    fn main() {
      println(show([Rect(2, 3), Dot]) ++ show((1, "two", [true], ())));
      println(show(sort([V(1, 2), V(3, 0), V(1, 5)])) ++ show([Some(V(1, 1))] < [Some(V(0, 1))]));
      println(show(area([[Rect(2, 3)], [Circle(1), Dot]])) ++ show(compare(Some(2), None)) ++ show(compare("a", "b")));
      println(show(Node(Leaf, (V(1, 2), "x"), Leaf)) ++ join(map([1, 2], show), "+"));
      println(show(map([(Dot, Dot), (Dot, Circle(1))], |p| match p { (x, y) -> compare(x, y) })) ++ show(sort(["pear", "fig", "apple"])))
    }`);
  // join is linear: a long join neither overflows the stack nor takes quadratic time.
  const r = agree('fn main() { println(int_to_string(string_length(join(map(range(0, 20000), int_to_string), ",")))) }');
  assert.equal(r.output, '108889\n');
});

test('properties: generated inputs, shrunk counterexamples, compiled replay', () => {
  const t = testSource(`
    type Tree { Leaf, Node(Tree, Int, Tree) }
    fn sorted(xs) { match xs { [a, b, ..rest] -> a <= b && sorted([b, ..rest]), _ -> true } }
    fn to_list(t) { match t { Leaf -> [], Node(l, x, r) -> append(to_list(l), [x, ..to_list(r)]) } }
    property reverse_twice(xs: List<Int>) { reverse(reverse(xs)) == xs }
    property pairs(ps: List<(Int, String)>, b: Bool) { length(map(ps, |p| match p { (n, _) -> n })) == length(ps) || b }
    property small(n: Int) { n < 100 }
    property search_tree(t: Tree) { sorted(to_list(t)) }
    property divides(xs: List<Int>) { sum(xs) / length(xs) <= sum(xs) }
  `, { runs: 200, seed: 3 });
  const by = Object.fromEntries(t.results.map((r) => [r.name, r]));
  assert.equal(by.reverse_twice.ok, true);
  assert.equal(by.pairs.ok, true);
  for (const r of t.results) assert.equal(r.compiled, 'agrees', r.name);
  assert.equal(by.small.ok, false);
  assert.deepEqual(by.small.counterexample, [{ name: 'n', value: '100' }], 'shrinks to the boundary');
  assert.equal(by.search_tree.counterexample[0].value.split('Node').length - 1, 2, 'the smallest unsorted tree has two nodes');
  assert.deepEqual([by.divides.reason, by.divides.counterexample[0].value], ['stopped with division by zero', '[]']);
});

test('refinements: compiled programs agree, and every proof is a checked DRUP certificate', () => {
  const src = `
    fn sum_from(a: Array<Int>, i: {i: Int | 0 <= i}, acc: Int) -> Int {
      if i < array_length(a) { sum_from(a, i + 1, acc + array_get(a, i)) } else { acc }
    }
    fn clamp_index(i: Int, n: {n: Int | n > 0}) -> {r: Int | 0 <= r && r < n} { if i < 0 { 0 } else if i >= n { n - 1 } else { i } }
    fn main() {
      let a = array_from_list(range(1, 11));
      let n = array_length(a);
      println(show(sum_from(a, 0, 0)) ++ " " ++ show(if n > 0 { array_get(a, clamp_index(99, n)) } else { 0 }));
      println(show(map([-5, 3, 50], |i| array_get(a, clamp_index(i, 10)))))
    }`;
  assert.equal(agree(src).output, '55 10\n[1, 4, 10]\n');
  const c = checkSource(src, { keepProofs: true });
  const proved = c.program.verification.obligations.filter((o) => o.status === 'proved' && o.proof);
  assert.ok(proved.length >= 5);
  for (const o of proved) assert.equal(checkRefutation(o.cnf.nvars, o.cnf.clauses, o.proof).ok, true);
  // A tampered certificate is rejected: drop the lemmas, keep only the empty clause.
  const big = proved.reduce((x, y) => (y.proof.length > x.proof.length ? y : x));
  assert.ok(big.proof.length > 1);
  assert.equal(checkRefutation(big.cnf.nvars, big.cnf.clauses, [[]]).ok, false);
});

test('constant stack: tail calls, long lists are freed and compared without recursion', () => {
  const r = agree(`fn main() {
    fn count(n, acc) { if n == 0 { acc } else { count(n - 1, [n, ..acc]) } }
    let xs = count(300000, []);
    let ys = count(300000, []);
    println(if xs == ys { "equal" } else { "different" });
    println(int_to_string(length(xs)))
  }`);
  assert.equal(r.output, 'equal\n300000\n');
});

test('reuse: rebuilding a uniquely owned list or tree allocates nothing new', () => {
  const allocs = (src) => runSource(src).allocs;
  const base = allocs('fn main() { let xs = range(0, 100000); println(int_to_string(length(xs))) }');
  const reversed = allocs('fn main() { let xs = range(0, 100000); println(int_to_string(length(reverse(xs)))) }');
  const shared = allocs('fn main() { let xs = range(0, 100000); println(int_to_string(length(reverse(xs)) + length(xs))) }');
  assert.ok(reversed - base < 10, `reverse of a unique list reuses its cells (${reversed - base} extra allocations)`);
  assert.ok(shared - base >= 100000, 'reverse of a shared list copies it');
  // Inserting into a tree held once allocates only the new leaf; into a shared
  // tree, it copies the path to the leaf.
  const tree = (extra) => `type Tree { Leaf, Node(Tree, Int, Tree) }
    fn insert(t, x) { match t { Leaf -> Node(Leaf, x, Leaf), Node(l, y, r) -> if x < y { Node(insert(l, x), y, r) } else if x > y { Node(l, y, insert(r, x)) } else { t } } }
    fn size(t) { match t { Leaf -> 0, Node(l, _, r) -> size(l) + 1 + size(r) } }
    fn main() { let t = fold(range(0, 1000), Leaf, |t, i| insert(t, (i * 7919) % 1000)); ${extra} }`;
  const t0 = allocs(tree('println(int_to_string(size(t)))'));
  assert.equal(allocs(tree('let u = insert(t, 5000); println(int_to_string(size(u)))')) - t0, 1);
  assert.ok(allocs(tree('let u = insert(t, 5000); println(int_to_string(size(u) + size(t)))')) - t0 > 1);
  // Without reuse, the same program allocates a second list.
  const noReuse = runWasm(compileSource('fn main() { let xs = range(0, 100000); println(int_to_string(length(reverse(xs)))) }', { reuse: false }).bytes);
  assert.ok(noReuse.allocs - base >= 100000);
});

test('arrays are values, updated in place when unique', () => {
  // The interpreter copies on every update, so it checks a small array; the
  // compiled code, which updates in place, also runs a large one.
  const program = (n) => `fn main() {
    fn fill(a, i) { if i == array_length(a) { a } else { fill(array_set(a, i, i * i), i + 1) } }
    let a = fill(array_make(${n}, 0), 0);
    println(int_to_string(array_get(a, ${n} - 1)));
    let b = array_set(a, 0, -1);
    println(int_to_string(array_get(a, 0)) ++ " " ++ int_to_string(array_get(b, 0)));
    fn grow(a, i) { if i == ${n} { a } else { grow(array_push(a, i), i + 1) } }
    println(int_to_string(array_length(grow(array_empty(), 0))))
  }`;
  assert.equal(agree(program(2000)).output, '3996001\n0 -1\n2000\n');
  const r = runSource(program(100000));
  assert.equal(r.output, '9999800001\n0 -1\n100000\n');
  assert.ok(r.allocs < 50, `in-place updates (${r.allocs} allocations)`);
});

test('differential fuzzing: random programs agree in every mode', () => {
  let ran = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const d = differential(generate(seed));
    if (d === 'skip') continue;
    assert.equal(d, null, `seed ${seed}`);
    ran++;
  }
  assert.ok(ran >= 50);
});

test('every planted bug is caught', () => {
  for (const mutant of MUTANTS) {
    let caught = false;
    for (let seed = 1; seed <= 200 && !caught; seed++) {
      const d = differential(generate(seed), { mutant });
      caught = d !== null && d !== 'skip';
    }
    assert.ok(caught, `mutant ${mutant}`);
  }
});
