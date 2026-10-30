// The WebAssembly back end: compiled programs must behave exactly like the
// reference interpreter, free every object they allocate, and update uniquely
// owned data in place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretSource, compileSource, runSource, makeHost } from '../src/api.js';
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
