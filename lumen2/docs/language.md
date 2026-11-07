# The language

## Showcase

Four programs in [`examples/showcase`](../examples/showcase), each making a
claim that the tests check (`test/showcase.test.js`). All of them are also in
the [playground](https://igniting.github.io/the-ai-frontier/lumen2/playground.html),
marked with a star.

- **[`heapsort.lm`](../examples/showcase/heapsort.lm): pure, in place, and
  proved.** Every function returns a new array; no line mutates anything.
  Yet sorting a million numbers allocates the array once and never copies
  it: 106 allocations in the whole run, in about 0.3 s. The same heapsort in
  the original Lumen, which mutates its array, takes 1.0 s (0.44 s with
  `-O`), and hand-written JavaScript about 0.25 s for the sort alone.
  Refinement types state each index's range and that every function
  returns an array of the same length, and the checker proves every access
  in bounds. No function has `fail` in its type, not even `main`
  (`fn() -> () ! output`): this program cannot stop with an error, short of
  running out of memory.
- **[`search.lm`](../examples/showcase/search.lm): a binary search with no
  run-time checks.** The loop invariant is in the parameter types, and three
  million lookups in a million-element array take about 0.23 s, with 30
  allocations. Change `n - half - 1` to `n - half` and the checker refuses
  the program with a counterexample: `array_length(a) = 16, lo = 13, n = 3`.
- **[`plugins.lm`](../examples/showcase/plugins.lm): plugins whose safety is a
  type.** The host takes plugins of type `fn(String) -> String`, which has
  no effects. A plugin that prints, uses randomness, or can fail (reading
  the first character of a possibly empty string) is a compile error that
  names the effect. The plugins that are accepted read characters by index,
  and those reads are proved in bounds.
- **[`intervals.lm`](../examples/showcase/intervals.lm): a subtle bug, found
  by a property.** An interval merge that looks right fails when one
  interval lies inside another. `lumen2 test` finds it and shrinks the
  failure to two intervals, `[(0, -2), (-1, -1)]` with `x = 0`, and the
  compiled code agrees. The one-word fix passes.

Two larger programs show the same ideas at scale: the
[SAT solver](../proofs/sat.lm) that proves S(4) = 44 without mutation, at the
speed of Lumen's imperative solver and with the same proof byte for byte,
and the [self-hosted compiler](../selfhost/lumen2c.lm), which reaches a fixed
point in under a second. Both are described below.

Writing these programs improved the checker. It now knows the range of a
quotient or remainder by a constant (a power of two is encoded as a shift
circuit, which made the binary search's proofs about ten times faster),
and what a branch learned survives the end of an `if` or `match`, so a
refined result can come from a recursive call in a branch. The compilers
also make a call that ends `a && f(x)` or `a || f(x)` a tail call; before,
`is_sorted` on a million elements overflowed the stack.

## A taste

From [`examples/tour.lm`](../examples/tour.lm), with the types the checker
infers (`lumen2 check`):

```
fn area(s) { match s { Circle(r) -> 3 * r * r, Rect(w, h) -> w * h, Dot -> 0 } }
fn average(xs) { sum(xs) / length(xs) }
fn twice(f, x) { f(f(x)) }

area    : fn(Shape) -> Int
average : fn(List<Int>) -> Int ! fail
twice   : fn(fn(a) -> a ! e, a) -> a ! e
insert  : fn(Tree<a>, a) -> Tree<a> where a: Ord
main    : fn() -> () ! {fail, output}
```

`twice` performs whatever effects `e` its argument performs. `insert`
compares elements, so its element type must be ordered (`where a: Ord`);
trying to sort a list of functions is a compile-time error. `average` can
fail because the list may be empty.

## Proved operations and refinement types

From [`examples/refine.lm`](../examples/refine.lm):

```
fn safe_get(a, i) { if 0 <= i && i < array_length(a) { Some(array_get(a, i)) } else { None } }

fn sum_from(a: Array<Int>, i: {i: Int | 0 <= i}, acc: Int) -> Int {
  if i < array_length(a) { sum_from(a, i + 1, acc + array_get(a, i)) } else { acc }
}

fn clamp_index(i: Int, n: {n: Int | n > 0}) -> {r: Int | 0 <= r && r < n} {
  if i < 0 { 0 } else if i >= n { n - 1 } else { i }
}

fn average(xs) { let n = length(xs); if n == 0 { 0 } else { sum(xs) / n } }
```

```
safe_get    : fn(Array<a>, Int) -> Option<a>
sum_from    : fn(Array<Int>, {i: Int | 0 <= i}, Int) -> Int
clamp_index : fn(Int, {n: Int | n > 0}) -> {r: Int | 0 <= r && r < n}
average     : fn(List<Int>) -> Int
```

None of these can fail, and their types say so. The checker walks each
function and tracks two kinds of facts: what it knows about integers and
array lengths, and what holds on the current path (conditions, refined
parameters, the results of refined functions, and the success of earlier
operations). Each array access and division is a proof obligation. A
refined parameter is assumed inside the function and proved at every call;
a refined result is proved at the end of the body. When a proof fails, the
error gives a counterexample:

```
fn clamp(x: Int, n: Int) -> {r: Int | 0 <= r && r <= n} { if x < 0 { 0 } else if x > n { n } else { x } }
fn f(a: Array<Int>, i: Int) -> Int ! {} { if i <= array_length(a) && i >= 0 { array_get(a, i) } else { 0 } }

error: cannot prove that the result of `clamp` satisfies `0 <= r && r <= n`
  = note: for example when n = -16, x = 0

error: calling `array_get` can fail, but `f` is declared without `fail`
  = note: could not prove that the index is in bounds: for example when array_length(a) = 3, i = 3
```

Both are real bugs: with no lower bound on `n`, no result fits; and `<=`
should be `<`. The checker retries a counterexample with small numbers, so
it is easy to read.

Each obligation is turned into a formula over two's-complement bit vectors,
wide enough that no sum overflows. A CDCL SAT solver written for this
project refutes the formula's negation and writes a DRUP proof. A separate
RUP checker, which shares no code with the solver, checks the proof before
the operation is treated as safe. `lumen2 certify --out DIR` writes every
formula and proof in the standard DIMACS and DRUP formats that external
checkers such as drat-trim read (this repository's tests use its own
checker; drat-trim was not run).
The prelude uses refinements too: `array_to_list` is pure because a
refinement on its loop index proves every access in bounds.

**Element refinements** say something about every element of an array, so
an array of indices can carry the fact that each one is in bounds for
another array:

```
fn sum_at(a: Array<Int>, ix: Array<{k: Int | 0 <= k && k < array_length(a)}>, i: {i: Int | 0 <= i}, acc: Int) -> Int {
  if i < array_length(ix) { sum_at(a, ix, i + 1, acc + array_get(a, array_get(ix, i))) } else { acc }
}
```

Inside `sum_at`, every element of `ix` is assumed in bounds for `a`, so
`array_get(a, array_get(ix, i))` is proved. At each call the checker proves
it for every element the caller could have put in `ix`: it tracks an
array's possible elements through `array_make`, `array_set`, `array_push`
and branches. A caller that pushes an unchecked index gets `cannot prove
that the elements of argument `ix` of `sum_at` satisfy ...`. They nest:
[`proofs/rup.lm`](../proofs/rup.lm) keeps its clauses as
`Array<{c: Array<{x: Int | 2 <= x && x < 2 * n + 2}> | array_length(c) >= 2}>`,
every clause at least two literals long and every literal a valid index.

## Traits

```
trait Area { fn area(x: Self) -> Int }
impl Area for Shape { fn area(s) { match s { Sq(n) -> n * n, Rect(w, h) -> w * h } } }
impl Area for List<a> where a: Area { fn area(xs) { sum(map(xs, area)) } }

type Version { V(Int, Int) }
impl Ord for Version {   // newest first
  fn compare(a, b) { match (a, b) { (V(x1, y1), V(x2, y2)) -> if x1 != x2 { x2 - x1 } else { y2 - y1 } } }
}

fn describe(x) { show(x) ++ " has area " ++ show(area(x)) }   // fn(a) -> String where a: Area + Show
```

`sort([V(1, 2), V(3, 0)])` gives `[V(3, 0), V(1, 2)]`, and the user `Ord`
also decides `[Some(V(1, 0))] < [Some(V(0, 0))]`. `show` works on every type
without functions in it: `[Rect(2, 3), Dot]`, `(1, "two", [true])`,
`#[1, 2, 3]` for an array. Impls are checked against the trait's
signature, including its effects. An impl that needs a constraint it does
not declare (`where a: Area`) is an error that names it.

## Properties

From [`examples/properties.lm`](../examples/properties.lm), where the last two
properties are false on purpose:

```
$ lumen2 test examples/properties.lm
ok      reverse_twice (100 cases; compiled code agrees)
ok      sort_is_sorted (100 cases; compiled code agrees)
ok      sort_keeps_length (100 cases; compiled code agrees)
ok      tree_stays_sorted (100 cases; compiled code agrees)
ok      join_length (100 cases; compiled code agrees)
FAILED  insert_keeps_order: returned false on case 16; compiled code agrees
        counterexample, shrunk in 8 steps: t = Node(Leaf, 0, Node(Leaf, -1, Leaf))
FAILED  average_exists: stopped with division by zero on case 1; compiled code agrees
        counterexample, shrunk in 0 steps: xs = []
```

Inputs are generated from the parameter types, small ones first, plus
integer edge cases. A failing case is shrunk and printed as Lumen source.
Cases run in the reference interpreter, and are then replayed in compiled
code, which must agree. So every property also tests the compiler.

## Capabilities

```
fn roll() { random_int(1, 6) }
fn main() { println(int_to_string(roll() + roll())) }
```

```
$ lumen2 run dice.lm
error: calling `roll` can use randomness, but `main` was not granted `random`
  = note: grant it when running the program, for example `lumen2 run --allow random`
$ lumen2 run dice.lm --allow random --seed 3
6
```

The capabilities are `input`, `output`, `clock` and `random`; `io` in an
annotation means all four. `run` grants `output`. The clock and random
numbers come from a host that the interpreter and the compiled code share,
so a seeded run is reproducible.

## Floats

```
fn mean(xs: List<Float>) -> Float { fold(xs, 0.0, |acc, x| acc + x) / int_to_float(length(xs)) }
fn main() {
  println(float_to_string(mean([1.5, 2.5, 3.0])));   // 2.3333333333333335
  println(float_to_string(0.1 + 0.2));                // 0.30000000000000004
  println(float_to_string(1e308 * 10.0))              // runtime error: float overflow
}
```

A `Float` is an IEEE 754 double, and arithmetic rounds as IEEE 754 says.
What is different is that a `Float` is always a number. An operation whose
result would be infinite stops the program with `float overflow`, as an
`Int` that overflows does, and `x / 0.0` stops with `division by zero`.
With finite operands, `+ - *` and `/` can only make a NaN by going through
an infinity or a division by zero, so there is no NaN either. Comparisons,
equality and sorting then work as on any other type (`-0.0` equals `0.0`).
And results are the same bits on every machine and every thread.

- **Arithmetic** takes two `Int`s or two `Float`s, never one of each
  (`int_to_float` and `float_to_int` convert). Inference settles which,
  even through a lambda, as in `fold(xs, 0.0, |acc, x| acc + x)`; an
  operand type still unknown at the end of a top-level function is `Int`,
  so programs written before floats keep their types.
- **Builtins:** `sqrt`, `float_abs`, `floor`, `ceil`, `trunc`, `round`
  (halves away from zero), `float_to_string` (the shortest decimal that
  reads back as the same double, `1.0`, `0.1`, `1e+21`), `float_to_fixed`
  and `parse_float`, which gives `None` for text that is not a number.
  There are no `exp`, `log` or trigonometric functions yet.
- **Effects.** The checker proves nothing about floats, except that a
  literal other than `0.0` is not zero. So `x / 2.0` is pure, while
  `x / y` and `sqrt(x)` have `fail` in their types. `float overflow` is not
  tracked, like `integer overflow`.
- **Literals** are rounded by the compiler itself, which is written in
  Lumen 2 and does not use floats: it does the exact arithmetic on
  bignums. A test compares the result, bit for bit, with JavaScript's
  `Number`, on 600 literals that include exact ties between two doubles
  and subnormals. Formatting and parsing are the host's (JavaScript's),
  and the interpreter uses the same functions, so the two print every
  float alike.

**The same sum on any number of threads.** [`bench/sum-par.c`](../bench/sum-par.c)
adds up the 10 million terms of `1 - 1/2 + 1/3 - ...` with OpenMP's
`reduction`: each thread sums its share, and the shares are added up.
Floating-point addition does not associate, and the shares depend on the
number of threads, so the answer does too:

| Threads | C (OpenMP `reduction`) | Lumen 2 (`par_map`) |
| --- | --- | --- |
| 1 | 0.69314713056010635 | 0.6931471305599604 |
| 2 | 0.69314713056006005 | 0.6931471305599604 |
| 3 | 0.69314713056002475 | 0.6931471305599604 |
| 4 | 0.69314713056005628 | 0.6931471305599604 |

[`bench/sum-par.lm`](../bench/sum-par.lm) splits the terms into 1,000 blocks,
which `par_map` sums, and adds up the block sums in order. The blocks are
the same however many threads there are, and `par_map` returns their sums
in order, so the result is the same bits on any number. C can do this too,
if it is written that way; in Lumen 2, a parallel map cannot be written any
other way. (The two columns differ from each other because they add in
different orders, and neither is the exact sum.)

## Memory without a garbage collector

`lumen2 ir` shows what the compiler does with memory. Here is the `insert`
from the tour, compiled for `Int` elements:

```
fn insert<Int>(t, x) {
  if is Leaf(t) {
    drop t
    ret Node(Leaf, x, Leaf)
  } else {
    let l = field t.0                  // read the fields, taking a reference to each
    let y = field t.1
    let r = field t.2
    if x < y {
      let ru = drop-reuse t            // release t; if that was the last reference,
      let l2 = insert<Int>(l, x)       //   keep its cell instead of freeing it
      ret Node@ru(l2, y, r)            // build the new node in that cell
    } else if x > y { ... } else {
      drop l
      drop r
      ret t
    }
  }
}
```

This is simplified for reading: the real output names variables `t_101`,
`b_109` and so on, and binds every test and constant to a variable of its
own. When the tree is not shared, `drop-reuse` gets the cell back and the
insert allocates exactly one new node, the leaf. When the tree is shared,
`drop-reuse` just decrements the count, and the path to the new leaf is
copied. The source code is the same in both cases. Likewise `array_set` on
an array nothing else refers to writes in place, and reversing a list that
is not used again allocates nothing.

---

[Back to the Lumen 2 README](../README.md)
