# Lumen 2

**A pure functional language whose types say what a function can do, which
proves its own array accesses safe, and which compiles to WebAssembly with
no garbage collector.** Lumen 2 is a fresh design, not an extension of
[Lumen](../README.md). It shares no code with it, and Lumen is unchanged.

- **Effects are part of the type, and inferred.** A function that prints has
  `! output` in its type; one that reads input has `! input`. The clock and
  random numbers are effects too. One that can divide by zero or index out of
  bounds has `! fail`. A pure function has none. Higher-order functions are
  effect-polymorphic, so `map` is pure when its argument is.
- **Capabilities.** Whoever runs a program grants `main` its capabilities.
  A program that would read the clock without being allowed to is rejected
  before it runs, at the call responsible.
- **Proved, not checked.** An array access or a division has the `fail`
  effect only when the compiler cannot prove it safe. Refinement types such
  as `{i: Int | 0 <= i && i < array_length(a)}` state the rest. Every proof
  is a SAT refutation with a certificate that an independent checker
  validates.
- **Traits.** User-defined `Ord` replaces structural ordering wherever a
  type is compared, `Show` is derived for every type without functions in
  it, and methods are resolved at compile time.
- **Properties.** `property` declarations are laws that `lumen2 test` checks
  on generated inputs, shrinking any failure to a minimal counterexample.
- **No garbage collector.** Memory is reference counted, and the compiler
  inserts the increments and decrements precisely, after
  [Perceus](https://www.microsoft.com/en-us/research/publication/perceus-garbage-free-reference-counting-with-reuse/).
  When a value is not shared, it is updated in place.
- **Certified passes.** On every compile, independent checkers validate
  that the compiler's IR is well typed and that its reference counting
  balances on every path.
- **Proved rewrite rules.** A superoptimizer searched the compiler's
  WebAssembly for cheaper equivalent code; every rule it found is proved
  with a checked SAT refutation, including side conditions on constants.
- **Written in itself.** The compiler is a Lumen 2 program
  ([`compiler/`](compiler/), about 8,600 lines), and it compiles itself to
  itself byte for byte. It began as a JavaScript program; the port wrote
  identical modules for every program in a 1,086-program corpus before the
  JavaScript compiler was deleted.
- **64-bit integers that never wrap silently.** Overflow is a runtime error,
  not a wrong answer.
- **Floats that are always numbers.** A `Float` is a double that is never
  infinite and never NaN: an operation whose result would be stops the
  program, as integer overflow does. So equality and order on floats
  behave, and a sum computed with `par_map` is the same, bit for bit, on
  any number of threads, where C with OpenMP gives a different answer for
  each ([floats](#floats)).
- **Within 1.1 to 3.5 times of C.** On six benchmark programs, four on
  integers and two on floats, the same algorithm takes 1.1 to 3.5 times as
  long in Lumen 2 as in C compiled natively, with no mutation in the source
  and, where the program's types say so, every array access proved in
  bounds ([how fast it is](#how-fast-it-is)).
- **Every core, safely.** `par_map` runs a function on every core. The
  types guarantee that the function does no input or output and uses
  neither the clock nor randomness, so the parallel result is the
  sequential one. On four cores, four benchmarks run 2.4 to 3.5 times
  faster than on one, and three of them faster than C on one core
  ([on every core](#on-every-core)).
- **Users' code on your data, safely and on every core.** `lumen2
  transform` runs a user's function over every line of a file. A function
  that could print, read, read the clock or use randomness is rejected
  before it runs, so the output is the same on any number of threads. On 2
  million CSV rows it is 6 times as fast as Python running the same
  function with `exec`, and 4 times as fast as JavaScript in a `node:vm`
  context ([user-defined functions](#user-defined-functions-lumen2-transform)).
- **Run again, and only the changed lines run.** Because a transform is
  proved to depend on nothing but its line, `lumen2 transform --incremental`
  can reuse the last run's output for every line that did not change, and
  its output is still exactly a full run's. After 500 of 500,000 rows
  change, matching each company name to the closest of 64 known names takes
  0.38 seconds again, where C takes 5.1 seconds on four cores and 19 on one,
  and Python about 20 minutes ([running it again](#running-it-again---incremental)).
- **A theorem, proved in it.** A SAT solver written in Lumen 2 proves the
  Schur number S(4) = 44. It prints the same 255,663-step refutation, byte
  for byte, as the original Lumen's imperative solver, at about the same
  speed. Split into 256 cubes and run on every core, the whole proof,
  checked, takes 22 s instead of 8 minutes
  ([on every core](#a-theorem-s4--44)).
- **A proof checker that cannot crash.** [`proofs/rup.lm`](proofs/rup.lm),
  a DRUP checker written in Lumen 2, has every array access proved in
  bounds, so none of its functions has `fail` in its type. It checks the
  22 MB S(4) refutation again, sharing no code with the JavaScript checker.

**[Open the Lumen 2 playground →](https://igniting.github.io/the-ai-frontier/lumen2/playground.html)**
(types and effects, every proof obligation, the code after reference
counting, property tests and certificates, all in the browser) ·
**[Read how it was built →](https://igniting.github.io/the-ai-frontier/#lumen2)**
(Part five of the story, with live demos)

```sh
cd lumen2
npm test                                         # 91 tests, about 3 minutes
node bin/lumen2.js check examples/refine.lm      # inferred types, effects, refinements
node bin/lumen2.js run examples/tour.lm          # compile to wasm and run
node bin/lumen2.js test examples/properties.lm   # check the properties
node bin/lumen2.js certify examples/refine.lm --out cert   # every certificate, written out
node bin/lumen2.js ir examples/tour.lm insert    # the IR, with reference counting
node test/fuzz.js 1000                           # differential fuzzing
node test/fuzz.js --mutants                      # are planted bugs caught?
node proofs/prove-schur.js 4 44 --out s4         # prove S(4) = 44 (about 5 minutes)
node proofs/prove-schur.js 4 44 --split 3,4,5,6  # the same theorem on every core (about 25 s)
node proofs/compare-lumen.js 4 44                # the same proof as the Lumen solver's?
node proofs/check-drup.js s4/schur-4-45.cnf s4/schur-4-45.drup   # check it again, with a checker proved not to crash
node superopt/search.js                          # search for rewrite rules (about 30 s)
node superopt/verify.js                          # re-prove every rule the compiler applies
node selfhost/bootstrap.js                       # the self-hosting fixed point (about 3 s)
node bench/run.js                                # Lumen 2 against C, on one core and on all (about 4 minutes)
LUMEN2_THREADS=3 node bin/lumen2.js run bench/sum-par.lm --allow input --input FILE   # a parallel float sum: the same bits on any number of threads
node bin/lumen2.js transform transform/examples/orders.lm --input FILE   # a user's function on every line, on every core
node bin/lumen2.js transform transform/examples/match.lm --input FILE --incremental   # again after FILE changes: only the changed lines run
node transform/bench/run.js                      # the same function in Lumen 2, C, JavaScript and Python (about 2 minutes)
node transform/bench/incremental.js --sample 20000   # --incremental after six kinds of change, against full runs (about 10 minutes)
LUMEN2_THREADS=2 node bin/lumen2.js run bench/nqueens-par.lm --allow input --input FILE   # par_map on 2 threads
```

Requires Node.js 22 or later. There are no dependencies.

## Showcase

Four programs in [`examples/showcase`](examples/showcase), each making a
claim that the tests check (`test/showcase.test.js`). All of them are also in
the [playground](https://igniting.github.io/the-ai-frontier/lumen2/playground.html),
marked with a star.

- **[`heapsort.lm`](examples/showcase/heapsort.lm): pure, in place, and
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
- **[`search.lm`](examples/showcase/search.lm): a binary search with no
  run-time checks.** The loop invariant is in the parameter types, and three
  million lookups in a million-element array take about 0.23 s, with 30
  allocations. Change `n - half - 1` to `n - half` and the checker refuses
  the program with a counterexample: `array_length(a) = 16, lo = 13, n = 3`.
- **[`plugins.lm`](examples/showcase/plugins.lm): plugins whose safety is a
  type.** The host takes plugins of type `fn(String) -> String`, which has
  no effects. A plugin that prints, uses randomness, or can fail (reading
  the first character of a possibly empty string) is a compile error that
  names the effect. The plugins that are accepted read characters by index,
  and those reads are proved in bounds.
- **[`intervals.lm`](examples/showcase/intervals.lm): a subtle bug, found
  by a property.** An interval merge that looks right fails when one
  interval lies inside another. `lumen2 test` finds it and shrinks the
  failure to two intervals, `[(0, -2), (-1, -1)]` with `x = 0`, and the
  compiled code agrees. The one-word fix passes.

Two larger programs show the same ideas at scale: the
[SAT solver](proofs/sat.lm) that proves S(4) = 44 without mutation, at the
speed of Lumen's imperative solver and with the same proof byte for byte,
and the [self-hosted compiler](selfhost/lumen2c.lm), which reaches a fixed
point in under a second. Both are described below.

Writing these programs improved the checker. It now knows the range of a
quotient or remainder by a constant (a power of two is encoded as a shift
circuit, which made the binary search's proofs about ten times faster),
and what a branch learned survives the end of an `if` or `match`, so a
refined result can come from a recursive call in a branch. The compilers
also make a call that ends `a && f(x)` or `a || f(x)` a tail call; before,
`is_sorted` on a million elements overflowed the stack.

## A taste

From [`examples/tour.lm`](examples/tour.lm), with the types the checker
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

From [`examples/refine.lm`](examples/refine.lm):

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
[`proofs/rup.lm`](proofs/rup.lm) keeps its clauses as
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

From [`examples/properties.lm`](examples/properties.lm), where the last two
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

**The same sum on any number of threads.** [`bench/sum-par.c`](bench/sum-par.c)
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

[`bench/sum-par.lm`](bench/sum-par.lm) splits the terms into 1,000 blocks,
which `par_map` sums, and adds up the block sums in order. The blocks are
the same however many threads there are, and `par_map` returns their sums
in order, so the result is the same bits on any number. C can do this too,
if it is written that way; in Lumen 2, a parallel map cannot be written any
other way. (The two columns differ from each other because they add in
different orders, and neither is the exact sum.)

## A theorem: S(4) = 44

The Schur number S(4) is the largest n for which 1..n can be split into
four groups, none containing x, y and x + y. That it is 44 has been known
since a computer search in 1965. [`proofs/sat.lm`](proofs/sat.lm) is a
CDCL SAT solver written in Lumen 2, and [`proofs/schur.lm`](proofs/schur.lm)
writes the problem as CNF. `node proofs/prove-schur.js 4 44` checks each
step with something independent of it:

```
encodings: 1982 and 2071 clauses from proofs/schur.lm; identical to the reference encoder
1..44: split found in 2.7 s (27684 conflicts); checked: every group is sum-free
  group 1: 1 4 9 12 19 26 33 36 39 41 44
  group 2: 2 3 10 11 15 16 29 34 35 42 43
  group 3: 5 6 7 8 17 18 27 28 37 38 40
  group 4: 13 14 20 21 22 23 24 25 30 31 32
1..45: refuted in 119.1 s (255663 conflicts, 255663 proof lines)
refutation CHECKED by src/rup.js in 274.7 s
PROVED: S(4) = 44  (398.3 s in total)
```

(That run shared the machine with the test suite. On its own, the
refutation takes 109 s, and the checker, since rewritten to keep its
top-level assignment between lemmas, takes 170 s.) The one step taken on
trust is the symmetry breaking in `schur.lm`: 1 goes in group 1, so 2 goes
in group 2, since the groups are interchangeable.

**The same proof as the original Lumen's.** The solver is a port of
[Lumen's solver](../proofs/sat.lm), decision for decision: the same watch
order, heap, integer activities, restarts and learning. Lumen's version
mutates its arrays; Lumen 2 has none to mutate, so the solver threads its
state through every function as a value, and the compiler updates it in
place because it is never shared. `node proofs/compare-lumen.js 4 44` runs
both on the same formulas, and they print the same thing, byte for byte:
the 27,684 conflicts of the split and the 255,663-lemma refutation. Two
programs in two languages, with two compilers, agree on 22 MB of output.

| | Lumen 2 | Lumen (`-O`) |
| --- | --- | --- |
| split of 1..44 | 2.2 s | 2.6 s |
| refutation of 1..45 | 108.8 s | 93.1 s |
| proof check | 170 s (`src/rup.js`) | 158 s (`superopt/rup.js`) |

**What it took.** The first compiled version took 19.0 s for the split.
Five compiler optimizations brought it to 2.8 s on a busy machine (2.2 s
on its own), each one checked by the certificate checkers, the fuzzer and a
new planted bug:

| Optimization | Split of 1..44 |
| --- | --- |
| none | 19.0 s |
| borrowed parameters: a parameter that is only read costs no reference counting | 12.8 s |
| drop specialization: taking apart a unique record moves its fields | 5.1 s |
| inlining small functions | 4.5 s |
| checked arithmetic and array reads inline in the wasm | 2.9 s |
| simplification: a chain of record updates becomes one unpack and one constructor | 2.8 s |

**What refinements prove here, and what they do not.** The checker proves
19 of the solver's 20 divisions and the input parser's string indexing safe,
so those carry no `fail`. It does not prove the solver's 27 accesses to its
state arrays, and element refinements (above) do not change that. Its arrays
live inside the `Solver` record, and a record's fields cannot be refined.
Worse, each array mixes several kinds of number: `db` holds every clause as
its length followed by its literals, `w` holds list heads and tails followed
by (clause, next) pairs, and `vars` holds six fields per variable. The facts
that would make the accesses safe are about positions ("the element after a
clause's start is a literal"), not about every element, and no refinement
can state them. The solver's functions therefore have `! fail` in their
types, and the bounds checks stay in the compiled code.

**A second checker, proved not to crash.** So the proof is also checked by a
program that is proved safe: [`proofs/rup.lm`](proofs/rup.lm), a DRUP
checker written for the purpose. It keeps each kind of data in its own
array, so that every invariant is about every element, and passes its whole
state from function to function as refined parameters:

```
vals:  {v: Array<Int> | array_length(v) == 2 * n + 2}             per literal: true, false or unassigned
db:    Array<{c: Array<{x: Int | 2 <= x && x < 2 * n + 2}> | array_length(c) >= 2}>
w:     {ws: Array<Array<{k: Int | 0 <= k && k < array_length(db)}>> | array_length(ws) == 2 * n + 2}
trail: Array<{x: Int | 2 <= x && x < 2 * n + 2}>                  with top: {t: Int | 0 <= t && t <= array_length(trail)}
```

The checker proves all 360 of its obligations (in about 16 s), and no
function in it has `fail` in its type. Input that would break an invariant,
such as a literal above n, is reported rather than trusted. It reads its
input a line at a time with `read_line`, so the 22.6 MB proof does not have
to fit in one string (at most 16 MB). `node proofs/check-drup.js` runs it:

```
$ node proofs/check-drup.js schur-4-45.cnf schur-4-45.drup
rup.lm: proved (no function can fail) and compiled by the compiler in 17.4 s (12834 bytes)
s VERIFIED  (255663 lemmas in 528.7 s)
```

That run shared the machine with other jobs, as did the 303.8 s of
`src/rup.js` on the same proof in the same session. On smaller proofs the
Lumen 2 checker takes 1.5 to 2 times as long as the JavaScript one. With
`--selfhost`, the checker is compiled by the first self-hosted compiler
instead (stage 2 of `selfhost/bootstrap.js`), so the code that checks the
proof comes from a second, independent code generator. Built that way it
verified the S(4) proof in 629 s, on the same busy machine. CI runs it that
way, in its own job, on every push. The tests check that it agrees with `src/rup.js`
on real proofs and on tampered ones.

Writing it found three problems. The first version took 50 times as long as
`src/rup.js`. A visit to a clause wrote `array_set(db, k, c2)` after an
earlier `array_set(db, k, c)` had already made a new `db`, so the old one was
still needed and every visit copied the whole clause database. Taking the
clause out of `db` while it changes (and putting a two-literal placeholder
in its slot, which keeps the invariant) made the updates in place again.
The second was in the refinement checker itself, found when CI fuzzed fresh
seeds while this was being written. It took the value of a Boolean `match`
to be the disjunction of its arms' values. So
`if (match s { "a" -> true, _ -> false }) { ... } else { array_get(a, 10) }`
had an unreachable `else`, and the out-of-bounds access in it counted as
proved. The interpreter's run-time re-check caught the false proof on the
first run that took the `else`. A match's value is now one of its arms'
values, chosen by an arm whose conditions hold. The mistake is a planted bug
now, with a test of its own.

The third, also in the refinement checker, turned up when the 3,000-program
campaign below was run again after that fix. The checker's integers are
mathematical, so in `if true { 9223372036854775806 + 2 } else { 10 }` it
took the `if`'s value to be 2^63. At run time the addition overflows and
the program stops, so no such value exists. But the value of an `if` is a
fresh 64-bit atom with a definition, here "the atom equals 2^63", that no
64-bit number satisfies. A contradictory definition makes every obligation
it touches true, and an out-of-bounds access later in the same function
counted as proved. Again the interpreter's re-check stopped where the
compiled code read out of bounds. Every definition must be satisfiable,
whatever the values of the atoms it does not define. So an atom defined as
equal to a term now has a range wide enough for every value the term can
take, as does the quotient in a division by a constant. This too is a
planted bug, with a test.

**On every core.** With [`par_map`](#on-every-core), the refutation runs on
every core, by cube and conquer. [`proofs/cubes.lm`](proofs/cubes.lm) splits
1..45 by the groups of 3, 4, 5 and 6 (1 and 2 are placed already), which
gives 256 cubes, and `par_map` refutes each with the same solver, given the
cube as unit clauses. Then it prints one refutation of the whole formula:
each cube's learnt clauses, each with the negation of the cube added, which
makes the cube's last clause its negation; then, going up the split, the
negation of each partial cube, which follows by unit propagation from its
children and the clause saying that the next number is in some group; at
the top, the empty clause. Once a cube is done, its clauses are deleted
(DRUP's `d` lines), so the checker's database stays as small as each cube's
solver's was. `src/rup.js` checks this refutation against the unchanged
formula, as it does the sequential one:

```
$ node proofs/prove-schur.js 4 44 --split 3,4,5,6
encodings: 1982 and 2071 clauses from proofs/schur.lm; identical to the reference encoder
1..44: split found in 2.6 s (27684 conflicts); checked: every group is sum-free
1..45: refuted in 4.5 s (292561 conflicts, 256 cubes on 4 threads, 585587 proof lines)
refutation CHECKED by src/rup.js in 10.2 s
PROVED: S(4) = 44  (22.0 s in total)
```

The sequential run took 481.8 s on the same 4-core machine: the
refutation 153.5 s and its check 315.9 s. Most of the gain comes from the
split, not from the threads. The solver never forgets a learnt clause, so
each unit propagation slows down as its database grows; 256 small searches
each keep a small one. On one thread the same 256 cubes take 11.6 s, and
the solving alone 7.4 s, against 2.0 s on four threads. The checker gains
the same way, through the deletions. `proofs/rup.lm`, which skips deletion
lines (that is slower, but a lemma that follows with a clause deleted also
follows with it kept), verified the same refutation too, in 1,139 s. CI
runs the parallel proof on every push, along with the sequential one.

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

## How fast it is

[`bench/`](bench/) holds six programs, each written twice, in Lumen 2 and
in C, with the same algorithm in both, and for the two on floats the same
floating-point operations in the same order, so that they print the same
digits. `node bench/run.js` compiles every
version, runs it, checks that all of them print the same thing, and prints
the table. The C is compiled natively (`cc -O2`) and also to WebAssembly
(clang, `wasm32-wasi`), which runs in the same Node as Lumen 2. That column
shows what WebAssembly itself costs; the gap between it and Lumen 2 is what
Lumen 2 costs. Best of three runs, on one core of a 2.1 GHz Xeon, with Node 22
and clang 18 (this machine's times vary by about 20% from day to day, so
compare within a table):

| Program | n | C | C, WebAssembly | Lumen 2 | Lumen 2 / C |
| --- | --- | --- | --- | --- | --- |
| [fannkuch-redux](bench/fannkuch.lm): permutations, arrays updated in place | 11 | 3.07 s | 3.14 s | 3.89 s | 1.3× |
| [binary trees](bench/binarytrees.lm): allocating and freeing trees | 18 | 1.20 s | 1.32 s | 1.33 s | 1.1× |
| [N-queens](bench/nqueens.lm): backtracking search | 13 | 0.65 s | 0.70 s | 1.20 s | 1.8× |
| [edit distance](bench/editdist.lm): dynamic programming over arrays | 30,000 | 1.05 s | 1.15 s | 2.63 s | 2.5× |
| [n-body](bench/nbody.lm): the planets, in floating point | 5,000,000 | 0.25 s | 0.31 s | 0.70 s | 2.8× |
| [spectral norm](bench/spectralnorm.lm): matrix-vector products in floating point | 3,000 | 0.47 s | 0.47 s | 1.63 s | 3.5× |

The Lumen 2 programs are ordinary Lumen 2. Nothing in them mutates
anything: every array update returns a new array, and every loop is a
recursive function. In `fannkuch.lm` and `editdist.lm`, refinement types
prove every array access in bounds, so no function there except `main` has
`fail` in its type, and the compiled code has no bounds checks. The C
programs check nothing. Checking and compiling takes about 1.5 s for each
of those two, which prove things, and 40 ms for the others.

Where the rest of the time goes:
- **N-queens.** The Lumen 2 version keeps the queens placed so far in an
  immutable list, so trying a square allocates one cell, freed when the
  search backs up. The C version overwrites one entry of an array.
- **Edit distance.** Each cell adds array elements, and nothing is known
  about how large they are, so each addition checks for overflow: Lumen 2's
  integers never wrap silently, while C's do. Three of the six checks per
  cell could be proved unnecessary from the refinements, but the checker
  does not yet try to prove anything about arithmetic.
- **Binary trees.** The run allocates 68 million nodes, each taken from a
  free list and given back as `check` walks the tree. That now costs about
  as much as C's `malloc` and `free`, though the allocator also keeps the
  counts that the leak check reads.
- **n-body and spectral norm.** A float's result is tested to be finite
  after every `+ - *` and `/` whose result goes anywhere but into another
  of them. Leaving all the tests out (a planted bug, which the fuzzer
  catches) makes n-body 14% faster than it is. The index arithmetic, such
  as `7 * i + 3` in n-body's array of bodies, is tested for overflow too,
  though the refinements prove its bounds. And in spectral norm, the matrix
  element `1.0 / ((i + j) * (i + j + 1) / 2 + i + 1)` costs a division per
  step, and its integer arithmetic is tested for overflow at every step.

V8 compiles WebAssembly first with a baseline compiler and swaps in
optimized code only when a function is called again. A C program spends its
whole run in one call to `main`, so with default flags it would run baseline
code throughout, and would look 1.6 times slower than it is on fannkuch-redux.
`run.js` therefore passes `--no-liftoff`, so that both WebAssembly columns
run optimized code.

**What it took.** The same programs, compiled by the compiler as it was
before this work (measured on another day than the table above):

| Program | before | now |
| --- | --- | --- |
| fannkuch-redux | 10.3 s | 4.06 s |
| binary trees | 1.80 s | 1.74 s |
| N-queens | 2.77 s | 1.21 s |
| edit distance | 9.97 s | 2.78 s |

- **`array_set` inline.** The bounds check, a test that the array is not
  shared, and a store, with a call only for a shared array.
- **Tuples in registers.** A function returning a tuple returns its fields
  as several WebAssembly values, and a tuple built and taken apart in one
  function lives in locals. A version of fannkuch-redux whose helpers
  return pairs went from 120 million allocations to 24.
- **Loops.** A tail call of a function to itself jumps back to its start.
- **Proved means unchecked.** An `array_get`, `array_set` or
  `char_code_at` that the checker proved safe has no run-time check.
- **Arrays known not to be shared.** The result of `array_set`,
  `array_push`, `array_make` or `array_empty` is not shared, and stays so
  while it is only read. A fixpoint over the program's calls carries this
  into parameters, when every call passes such an array, and into results,
  when every return gives one. An update to such an array has no test at
  all.
- **Reading a list costs nothing.** A function that walks a list it only
  reads now borrows it all the way down, with no reference counting. Before,
  passing the tail to the recursive call made the function own its argument.
- **`select` instead of branches.** An `if` whose branches only compare
  values becomes a WebAssembly `select`, so the CPU has no branch to
  mispredict. For edit distance's `min3` on random data, that halved the
  time.
- **Common subexpressions.** An arithmetic operation already done on the
  same path, on the same operands, is not done again.
- **Multiplying small integers.** The test that `a * b` does not overflow
  divided the product by `b`, a 64-bit division, in a call. When both
  operands fit in 32 bits the product cannot overflow, and two comparisons
  show it, so that case is now inline and needs no division. Spectral norm
  went from 2.18 s to 1.59 s.
- **Fewer float tests.** An infinity or NaN stays one through `+ - *`, so a
  float result whose only use is the next such operation needs no test of
  its own: the test of the result it flows into fails exactly when its
  would have, with the same message. In `dx * dx + dy * dy + dz * dz` only
  the last addition is tested. n-body went from 0.75 s to 0.55 s. A
  division does not pass the test on, since `1 / inf` is 0; paranoid mode
  keeps every test, and two planted bugs (no tests, and tests left to a
  division) must be caught.
- **Reference counting inline.** V8 does not inline a call from one
  WebAssembly function to another, and a call costs more than the few
  instructions that add or remove a reference. So the code generator inlines
  those two functions at every call. Measured on the same day, before and
  after: binary trees went from 2.25 s to 1.74 s, edit distance from 3.55 s
  to 2.97 s, and the other two did not change. The compiler grew from 1.7
  MB to 2.4 MB, and compiles itself in 20 s instead of 27. Inlining
  allocation and freeing too made it 3.9 MB, for at most 10% more speed, so
  they stay calls.

Each change was checked like every other: the test suite, 500 newly
generated programs run four ways on every CI run, and the S(4) proof, which
must stay identical to the original Lumen solver's, byte for byte. Paranoid
mode keeps every check that the proofs removed, so if a proof were unsound,
the four runs would disagree.

### On every core

`par_map(xs, f)` is the array of `f` applied to each element of `xs`, and
the compiled code computes the elements on every core at once. The checker
accepts it only when `f` cannot read input, write output, read the clock or
use randomness (it may fail), so running the calls at the same time, in any
order, cannot change what the program prints:

```
error: the function given to `par_map` can write output, but `par_map` runs it in parallel
```

If calls fail, `par_map` stops with the error of the first failing element,
in array order, as a sequential map would. Three of the benchmarks have
parallel versions that split the same work into tasks
([`fannkuch-par.lm`](bench/fannkuch-par.lm),
[`binarytrees-par.lm`](bench/binarytrees-par.lm),
[`nqueens-par.lm`](bench/nqueens-par.lm)), and so do the C programs, with
OpenMP. On the same 4-core machine, best of three, in the same run as the
first table:

| Program (split into) | n | C, 1 thread | C, 4 threads | Lumen 2, 1 thread | Lumen 2, 4 threads | Lumen 2's speedup |
| --- | --- | --- | --- | --- | --- | --- |
| fannkuch-redux (990 blocks of permutations) | 11 | 2.57 s | 0.67 s | 3.78 s | 1.09 s | 3.5× |
| binary trees (the 8 depths) | 18 | 1.13 s | 0.79 s | 1.53 s | 0.52 s | 3.0× |
| N-queens (the 132 placements of two queens) | 13 | 0.60 s | 0.16 s | 1.31 s | 0.43 s | 3.1× |
| spectral norm (the rows of each product) | 3,000 | 0.41 s | 0.17 s | 1.45 s | 0.60 s | 2.4× |

On four cores, Lumen 2 is faster than C on one in the first three, and not
in spectral norm. It is faster than C on four in binary trees, where every thread allocates millions of
nodes: each Lumen 2 thread allocates from memory of its own, while the C
threads share `malloc`. The Lumen 2 times on threads include starting them.

How it runs, in Node: every thread is an instance of the program's module,
and all share one memory. Each thread takes chunks of the heap with an
atomic add and keeps free lists of its own. While a `par_map` runs,
reference counts above 1 change by atomic operations, because other threads
may hold references to the same object. A count of 1 is still exclusive, so
freeing, reuse and in-place updates stay as they were. Threads take the
indices of a `par_map` in blocks of up to 64, so that thousands of small
elements do not keep them all waiting on one shared counter. The tests run every
`par_map` program on one to four threads and compare it with the
interpreter, and the fuzzer generates them too. Two planted bugs in the
threaded runtime must be caught: counts changed without atomics, and
scratch memory shared between threads (a real bug the paranoid mode found
first). In a browser, `par_map` runs as a loop.

## User-defined functions: `lumen2 transform`

Many systems run code written by their users on their own data: a filter in
a log pipeline, a computed column in a spreadsheet or a database, a
transformation in an ETL job. The usual ways to do that trade safety
against speed. Python's `exec` and JavaScript's `eval` give the user's code
everything the host can do. Node's `vm` contexts are, in Node's own words,
"not a security mechanism". C is fast and checks nothing. And none of them
can safely run the user's code on every core without knowing what it does.

Lumen 2's types say what a function can do, so it can take that job.
`lumen2 transform FILE` applies the user's function to every line of a
file, on every core:

```
// From transform/examples/orders.lm, which also defines euro_area: keep the
// euro-area orders of at least 100.00, with a pseudonym instead of the customer.
fn transform(n: Int, line: String) -> Option<String> {
  if n == 1 { Some("order,customer,country,total") }
  else {
    let row = fields(line);
    let country = field(row, 2);
    match (parse_int(field(row, 3)), parse_decimal(field(row, 4), 2)) {
      (Some(quantity), Some(price)) -> {
        let total = quantity * price;
        if total >= 10000 && euro_area(country) {
          Some(csv([field(row, 0), "c" ++ int_to_string(hash(field(row, 1)) % 1000000), country, show_decimal(total, 2)]))
        } else { None }
      },
      _ -> panic("not an order: " ++ line),
    }
  }
}
```

```sh
node bin/lumen2.js transform transform/examples/orders.lm --input orders.csv > out.csv
```

- **The contract is checked before anything runs.** `transform` gets the
  line's number and its text and returns the output line, or `None` to drop
  it. Its only effect may be `fail`. A transform that could print, read
  input, read the clock or use randomness is rejected, with the functions
  responsible. For [`sample-random.lm`](transform/examples/sample-random.lm):

  ```
  error: `transform` can use randomness, but a transform may only compute (and fail)
    transform  fn(Int, String) -> Option<String> ! random  (line 7)
  ```

  That is what makes the next two points true. Sampling one line in a
  hundred with `random_int`, as that file does, is rejected; sampling by
  `hash(line) % 100` ([`sample.lm`](transform/examples/sample.lm)) picks
  the same lines on every run.
- **On every core, with the same output.** The lines are read 4,096 at a
  time, and `par_map` transforms each batch in tasks of 64 lines. The output
  is the same, byte for byte, on any number of threads, in any batch and
  chunk sizes; the tests check both.
- **A failure names its line.** Overflow, a `panic` or an index out of
  bounds stops the run, with what was printed before the failing batch
  kept: `runtime error: line 12346: integer overflow`. Since the transform is
  pure, finding the line is easy: the tool transforms the failing task's
  lines again, one to a task.
- **Every line has a budget.** A line may take ten million steps
  (`--steps N` to change it, `--steps none` for no limit), where a step is
  the start of a function or a round of a loop. A transform that runs too
  long on some line stops there:
  `runtime error: line 812: out of steps (each line may take 10,000,000 steps)`.
  The count depends only on the line, not on the clock or the machine's
  load, so the same line fails on every run, on any number of threads. A
  line of the orders example below takes at most 172 steps, and counting
  costs about 8% of the run.
- **Nothing else is reachable.** The program runs as WebAssembly, and its
  only imports are reading input, writing output, the clock, random numbers,
  reporting a failure and starting `par_map`'s threads. The checker keeps
  the transform from the first four. There is no file system and no network
  to reach, even through a bug in the checker.

The library ([`transform/lib.lm`](transform/lib.lm), in Lumen 2, with every
byte access proved in bounds) has CSV fields and lines (`fields`, `field`,
`csv`), numbers (`parse_int`, and `parse_decimal` and `show_decimal` for
exact decimals such as money, in hundredths), text (`split`, `trim`,
`lower`, `upper`, `starts_with`, `ends_with`, `index_of`, `includes`,
`replace_all`, `pad_left`) and a `hash` that is the same on every machine.
[`logs.lm`](transform/examples/logs.lm) reads web server logs with them.
Floats come from the language's `parse_float` and `float_to_fixed`:
[`sensors.lm`](transform/examples/sensors.lm) converts temperature
readings and marks the high ones.
A compiled transform is kept in `~/.cache/lumen2/transforms` under the hash
of everything it was compiled from, so running it again skips checking and
compiling.

**Against the usual ways.** `node transform/bench/run.js` runs the orders
transform on 2 million generated orders (105 MB). The same function is
written in C, in JavaScript and in Python, each with the same library, and
every way must print the same output, byte for byte. Wall-clock times for
the whole command, best of three, on the same 4-core machine, with Lumen 2
counting each line's steps:

| Language | Threads | The user's code is | Time | Rows per second |
| --- | --- | --- | --- | --- |
| Lumen 2 | 4 | checked, compiled before | 1.50 s | 1,330,000 |
| Lumen 2 | 4 | checked and compiled in this run | 2.03 s | 983,000 |
| Lumen 2 | 1 | checked and compiled in this run | 2.81 s | 711,000 |
| C (OpenMP) | 4 | not checked | 0.34 s | 5,840,000 |
| C | 1 | not checked | 0.31 s | 6,400,000 |
| JavaScript | 1 | in a `node:vm` context | 6.08 s | 329,000 |
| JavaScript | 1 | not isolated (as with `eval`) | 2.23 s | 896,000 |
| Python | 1 | run with `exec` | 9.03 s | 221,000 |

- Once compiled, Lumen 2 is 6.0 times as fast as Python's `exec` and 4.1
  times as fast as JavaScript in a `vm` context, which is what Node offers
  for running code apart from the host's (4.4 and 3.0 times, counting
  checking and compiling). Even so, the `vm` context isolates nothing: in
  this benchmark's harness, the user's code reaches the host's `process`
  object, and so the file system, with
  `globalThis.constructor.constructor('return process')()`.
- C on one thread is 4.8 times as fast as Lumen 2 on four, compiled
  before. Lumen 2 copies every field it splits off and
  every string it builds, where C points into the line. Its code is
  WebAssembly, and its integers are checked for overflow. C on 4 threads
  gains little: reading and writing the file is most of its time.
- Checking and compiling takes about 0.5 s: the transform with the library
  and the harness, and the compiler's own start. With the cache, that is
  paid once.
- Once compiled, Lumen 2 takes 2.4 s on one thread. Four threads make it
  1.6 times as fast, not 4, because the main thread reads the lines and
  writes the output while the others wait.

**Limitations.** A quoted CSV field cannot hold a line break, since lines
are split first.
Strings are bytes: `lower` and `upper` change only ASCII letters. A
transform's memory is limited to the WebAssembly memory's 1 GB, and its
time per line by the step budget. A step's cost is not fixed: a builtin
such as `concat_strings` is one call however long its strings, so the
budget bounds a line's time in proportion to its data, not absolutely.

### Running it again: `--incremental`

A file that a transform has run over often changes a little and needs the
transform again: a log that grew, a table with a few rows corrected. With
`--incremental`, the run transforms only the lines that changed:

```sh
node bin/lumen2.js transform transform/examples/match.lm --input companies.csv --incremental > matched.csv
# ...companies.csv changes...
node bin/lumen2.js transform transform/examples/match.lm --input companies.csv --incremental --stats > matched.csv
transformed 500 of 500,001 lines; reused the rest
```

The output is the same as a full run's, byte for byte. A run keeps its
input, its output and the length of each line's output in a state
directory (under `~/.cache/lumen2/transforms/runs`, or `--state DIR`). The
next run:

1. compares the new file with the last input from both ends, byte for byte:
   the lines in common there keep their output;
2. cuts what lies between into chunks of whole lines, at points that depend
   only on the bytes nearby, and looks each chunk's SHA-256 hash up among
   the last run's: a chunk seen before keeps its output, even if it moved;
3. matches the lines of the chunks left against the lines of the last input
   they replace, with Myers' diff (a longest common subsequence): matched
   lines keep their output;
4. transforms the lines left, on every core, and writes the new state.

Reusing an output is only right if the transform would compute it again,
and that is what the checker proves. A transform can only compute and fail,
so a line's output depends on the line, its number, and nothing else: not
the clock, randomness, input, or anything kept from line to line. It is the
same bits on every machine: integers are checked for overflow, floats are
always finite, and the step budget counts steps, not time. For the number,
the tool proves from the transform's code a number T such that a line
above T computes the same thing whatever its number: every use of the
number must be a comparison with a constant, and T is the largest. The
examples compare it with 1, for the header, so T is 1, and a line keeps
its output when lines are inserted above it. A transform that uses its
number in any other way keeps a line's output only at the same number. The
hash is a cryptographic one because the lines may come from anyone: with a
weak hash, a line written to collide with another would get the other's
output. A run that fails is done again in full, without the state, so its
error and the output printed before it are a full run's; only a run that
succeeds changes the state.

`node transform/bench/incremental.js` runs a transform over a file, changes
the file in six ways, and runs it again with `--incremental` (on 4 threads,
from the original file's state) and in full in every other way. Every
output must be exactly C's for the same file. With
[`match.lm`](transform/examples/match.lm), which matches each company name
in 500,000 rows (20 MB) to the closest of 64 known names by edit distance,
about 40 microseconds of C a row:

| Change | Lines transformed | `--incremental` | vs C, 4 threads (5.1 s) | vs C, 1 thread (19 s) | vs Lumen 2 in full (13 s) | vs JavaScript (about 80 s) | vs Python (about 1,180 s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | 0 | 0.17 s | 30× | 108× | 73× | 467× | 6,800× |
| 1 row changed | 1 | 0.19 s | 27× | 98× | 66× | 422× | 6,200× |
| 500 rows changed (0.1%), scattered | 500 | 0.38 s | 13× | 49× | 33× | 209× | 3,100× |
| 5,000 rows changed (1%), scattered | 5,000 | 0.58 s | 9× | 32× | 22× | 137× | 2,000× |
| 500 rows appended (0.1%) | 500 | 0.27 s | 19× | 69× | 47× | 297× | 4,400× |
| 10 rows inserted and 10 deleted, scattered | 10 | 0.32 s | 16× | 58× | 40× | 251× | 3,700× |

Best of three, on the same 4-core machine; JavaScript and Python (and
JavaScript in a `vm` context, about 1,540 s) were timed on the first 20,000
rows and scaled (`--sample 20000`). The first run with `--incremental`,
which transforms every line and writes the state, took 12 s, against 13 s
without it.

The margin is the work saved, so it depends on the function. For one as
cheap as [`orders.lm`](transform/examples/orders.lm), C reads, transforms
and writes 2 million rows (105 MB) in 0.31 s, about as fast as the file can
be read, and the incremental run, which reads the file and the last input,
cannot beat it:

| Change | Lines transformed | `--incremental` | vs C, 4 threads (0.32 s) | vs Lumen 2 in full (1.4 s) | vs JavaScript (2.6 s) | vs Python (8.1 s) |
| --- | --- | --- | --- | --- | --- | --- |
| none | 0 | 0.47 s | 0.7× | 3.0× | 5.5× | 17× |
| 1 row changed | 1 | 0.56 s | 0.6× | 2.5× | 4.6× | 15× |
| 2,000 rows changed (0.1%), scattered | 2,000 | 1.1 s | 0.3× | 1.3× | 2.4× | 7.5× |
| 2,000 rows appended (0.1%) | 2,000 | 0.59 s | 0.5× | 2.4× | 4.4× | 14× |

Its first run took 2.5 s, against 1.4 s without `--incremental`: for a
cheap function, recording each line's output length costs more than the
function. Edits scattered through the file cost more than edits at its
ends, which need no hashing.

**Limitations.** The file is read into memory, and the state holds a copy
of the last input and output, so a run needs room for both. A change to
the transform, the library, the compiler or the step budget starts again
from nothing. The state is trusted as the compiled transforms beside it
are: its copy of the input is not checked against a hash when it is read
back.

## A superoptimizer

`superopt/` searches the WebAssembly that Lumen 2 emits for straight-line
code with a cheaper equivalent, and proves each equivalence before the
compiler may use it. It compiles a corpus (the examples, the Schur proof's
programs and 60 generated programs) and collects every window of up to
seven pure instructions that occurs at least twice. For each window it
enumerates candidate sequences, shortest first, evaluating them on test
vectors and keeping only one of any set of partial sequences that leave the
same values on the stack. A candidate that matches on every vector is proved
equal for all inputs: both sequences become circuits over the bits of their
inputs, and `superopt/sat.js` refutes their difference, with the proof checked by
`src/rup.js`. A counterexample becomes a new test vector.

Rules are then generalized. The window's constants become symbolic (`K0`,
`K1`), and the candidate's constants become expressions over them. When the
general rule needs a side condition, the weakest one that makes it
provable is kept, and the compiler checks it before rewriting. The most
interesting rule came out of this step. The overflow check for multiplying
by a constant tests whether the other operand is outside a range:

```
x < K0 || x > K1      =>      (x - K0) >u (K1 - K0)        when K0 <= K1

local.get x  i64.const K0  i64.lt_s  local.get x  i64.const K1  i64.gt_s  i32.or
=>  local.get x  i64.const K0  i64.sub  i64.const K1-K0  i64.gt_u
```

That is the classic unsigned range-check trick, found by search and proved
with 17,195 checked lemmas. With concrete constants the search first found
a different sequence that works only for the bounds of `x * 2`; looking
for one that holds for constants with the same signs and order found the
general form.

[`superopt/RULES.md`](superopt/RULES.md) lists all 19 rules. The rest are
simpler: `i32.const 0; i32.eq` is `i32.eqz`, `0 xor x` is `x` (from `0 - x`),
and folds of constant comparisons and arithmetic that inlining leaves
behind. The compiler applies them on every compile
([`compiler/45-wasm.lm`](compiler/45-wasm.lm); `superopt: false` turns them
off), and `superopt/search.js` writes them to
[`compiler/rules.js`](compiler/rules.js), from which the compiler is built. `node superopt/verify.js` re-proves all of them, and the
test suite does too.

The result is modest, and the reason is instructive. On the corpus, the
rules remove 1.2% of the instructions. On the SAT solver they remove 229 of
18,609 instructions (1.2%) and 338 bytes, and the time for the split of 1..44
does not change measurably. Lumen's superoptimizer found 40 rules, most of
them cleaning up after its tagged 31-bit integers. Lumen 2's integers are
untagged i64 values, so its code generator leaves much less behind, and the
engine's own optimizing compiler already performs rewrites like these.

## The compiler, in Lumen 2

The compiler is written in Lumen 2: [`compiler/`](compiler/) holds it, in
the order of its passes, about 8,600 lines. It runs as WebAssembly.
[`compiler/lumen2c.wasm`](compiler/lumen2c.wasm) is the compiler compiled
by itself, and [`src/lumen2c.js`](src/lumen2c.js) hands it a program and
reads back its report and module. A change to the compiler is built by the
previous build:

```
$ node compiler/bootstrap.js
stage 1: 1650451 bytes (608f8a04ac5ad38b) in 27282 ms
fixed point: compiler/lumen2c.wasm compiles its source to itself
```

Stage 1 is the committed build compiling the source, and it gives the
committed build's own bytes: the compiler, compiled by itself, compiles
itself to itself. After a change, `node compiler/bootstrap.js --write`
compiles again with each stage's result until two stages agree (a change to
code generation takes three stages: the old build compiles the new source,
that compiler compiles it again, and the third stage confirms it) and
replaces the build. CI and the tests check the fixed point on every push.

It was ported pass by pass from a JavaScript compiler, and every pass was
compared with the original before the next one was written: the syntax
tree, the types and warnings, the safe sites and every proof obligation
with its lemma and clause counts, the IR after lowering, after inlining and
after reference counting, the certificates' statistics and their rejection
messages, and finally the module's bytes. The corpus was every Lumen 2
program in the repository (the compiler's own source among them), 200
generated programs, 600 broken ones that must fail with the same error at
the same place, and 270 programs from the test suite, under every back-end
option and every planted bug. The ported compiler wrote the same bytes for
all of them, and then compiled itself to the bytes that the JavaScript
compiler had made of it. The JavaScript compiler was deleted after that.

Byte-identical output meant copying the original's accidents too. Its
SAT solver ranks variables by activities stored as JavaScript numbers, and
its decisions follow comparisons between them, so the port computes IEEE
754 doubles exactly, rounding to nearest even, with integers. JavaScript
`Map`s and `Set`s iterate in insertion order, and the order of drops,
captured variables and per-type functions follows from it, so the port
keeps ordered lists where the original had them. The port also found a bug
in the original: a refined `let` inside a lambda crashed it, because the
refinement's bound variable was taken for a captured one.

What stays in JavaScript: the reference interpreter
([`src/interp.js`](src/interp.js)), with its own front end
([`src/check.js`](src/check.js)), which is the second implementation that
compiled code is compared with; property testing; the small host that runs
compiled modules ([`src/runtime.js`](src/runtime.js)); and
[`src/rup.js`](src/rup.js), an independent checker for the proofs the
compiler writes.

| Stage | File | What it does |
| --- | --- | --- |
| Lexer, parser | `10-lexer.lm`, `11-parser.lm` | Byte strings, nested comments; lists and `\|>` desugared |
| Checker | `20-types.lm` … `24-check.lm` | Hindley–Milner with row-polymorphic effects, trait constraints, generalization per strongly connected component; traits, impls and derived `Show`; capability grants; exhaustiveness by Maranget's usefulness algorithm, with witnesses |
| Refinements | `35-refine.lm` | Symbolic walk of each function; proof obligations for partial operations and refinements |
| Proofs | `30-big.lm` … `34-blast.lm` | Bignums and exact doubles; bit-blasting to CNF; a CDCL solver that writes DRUP proofs; an independent RUP checker for each proof |
| Lowering | `40-ir.lm`, `41-lower.lm` | Monomorphization (an `Int` is never boxed, trait methods become direct calls); A-normal form; closures lifted; matches compiled to tests that borrow |
| Inlining | `42-opt.lm` | Small functions inlined; known-constructor field reads, flattening and dead-code removal |
| Perceus | `43-rc.lm` | Ownership: dup where a value is needed twice, drop as soon as it is dead; borrowed parameters and projections, inferred; reuse of dropped cells; drop specialization |
| Certificates | `44-certify.lm` | Independent checkers for the IR's types and its reference counting |
| Code generator | `45-wasm.lm`, `46-codegen.lm` | WebAssembly with i64, tail calls and bulk memory; checked arithmetic and array reads inline; a size-class allocator; per-type drop and compare functions; the superoptimizer's proved rewrite rules; a binary encoder, with no external toolchain |
| Driver | `47-backend.lm`, `98-driver.lm`, `99-main.lm` | The passes in order; the report the host reads |

The prelude and the rewrite rules are compiled into it as data by
[`compiler/build.js`](compiler/build.js).

## The first self-hosted compiler

Before the port, [`selfhost/lumen2c.lm`](selfhost/lumen2c.lm) was the
first Lumen 2 compiler written in Lumen 2, about 2,800 lines and written
from scratch rather than ported. It reads a program on standard input and
writes a WebAssembly module on standard output, with the same stages as the
compiler: a lexer and a recursive-descent parser; Hindley–Milner inference
with traits and derived `Show`, generalized per strongly connected
component of the call graph (found with Tarjan's algorithm);
monomorphization and lowering to A-normal form, with closures for lambdas
and local functions and tag tests for matches; Perceus reference counting;
code generation with the same runtime conventions; and a binary encoder.
Its own data structures are AVL trees, and arrays that it updates in place
because it never shares them.

```
$ node selfhost/bootstrap.js
stage 1: lumen2c.lm (2853 lines) compiled by the compiler: 574696 bytes, 90b42ec3efe34ab6 (3808 ms)
stage 2: compiled by stage 1: 288477 bytes, 4b24d99b486f9b55 (660 ms, 5241087 allocations, nothing leaked)
stage 3: compiled by stage 2: 288477 bytes, 4b24d99b486f9b55 (953 ms, 10081718 allocations, nothing leaked)
FIXED POINT: stage 2 and stage 3 are byte-identical
```

Stage 2 is that compiler as it builds itself, and stage 3, built by stage 2,
is the same bytes. Its code generator is a second, independent one, so the
test suite checks that what it writes behaves like the reference
interpreter. On every example, the SAT solver, the Schur encoder, the DRUP
checker and 1,000 generated programs, its modules print exactly what the
interpreter prints, stop with the same error, and free every object. It
checks types but not effects, capabilities, exhaustiveness or refinements,
and makes none of the compiler's optimizations except tail calls. Writing
it found that a lowering that passes continuations overflows its stack on a
list literal of about 800 elements; both compilers split such tables into
one function per entry.

The language is defined in [SPEC.md](SPEC.md).

## How it is checked

The interpreter defines the language. It shares no code with the back end
after type checking.

- **Differential fuzzing.** `test/fuzz.js` generates random well-typed
  programs over lists, trees, options, tuples, strings, arrays and closures.
  They use matches, guards, higher-order prelude functions, recursion,
  integer edge cases, traits (a user `Ord`, a user trait with generic
  impls, derived `show`), refined functions, partial operations guarded so
  that they are provably safe, and others that fail when reached, plus the
  clock and random capabilities. Each program runs four ways: interpreted;
  compiled; compiled in *paranoid* mode, where freed memory is never reused,
  any access to a freed object stops the program, and every run-time check
  stays in, even those the proofs removed; and compiled without reuse. All four must print the same output and stop with the same error.
- **A leak check.** Every compiled run that finishes must report zero live
  objects.
- **Proofs are re-checked as the program runs.** The interpreter re-checks
  every refinement and every operation the checker proved safe. An unsound
  proof therefore shows up as a disagreement with the compiled code.
- **Certificates on every compile**: IR types, reference counting, every
  DRUP proof, and the engine's validation of the module.
- **Planted bugs.** Twenty-four deliberate bugs in the compiler, the
  verifier and the SAT solver check that all of this catches what it should.
  Seven are caught at compile time by a certificate checker, before any
  program runs:

  | Planted bug | Caught by | First seed |
  | --- | --- | --- |
  | pass ownership of a variable that is still needed (a missing dup) | ownership checker | 1 |
  | forget to drop a variable last used by a borrowing instruction | ownership checker | 1 |
  | drop a variable before the instruction that borrows it | ownership checker | 1 |
  | forget to free a reuse token on a path that does not use it | ownership checker | 2 |
  | release a value while a borrowed projection of it is about to be read | ownership checker | 6 |
  | give a pattern variable the type of the pattern's first variable | IR type checker | 1 |
  | a SAT solver that claims every formula is unsatisfiable | RUP proof checker | 1 |
  | read a closure's captured value without taking a reference | differential run | 1 |
  | reuse a cell even when it is shared | differential run | 1 |
  | move the fields out of a cell even when it is shared | differential run | 1 |
  | update a shared array in place | differential run | 6 |
  | free an object without releasing its last field | leak check | 1 |
  | drop the overflow check on `+` | differential run | 9 |
  | an off-by-one in the overflow bound for multiplying by a constant | differential run | 36 |
  | apply a rewrite rule without checking its side condition | differential run | 1 |
  | a remainder range one too narrow in the model of division by a constant | run-time re-check of proofs | 52 |
  | forget the element `array_push` adds, when tracking an array's elements | run-time re-check of proofs | 33 |
  | take a Boolean `match` to be the disjunction of its arms' values | run-time re-check of proofs | 44 |
  | define a branch's value as equal to a result that overflowed | run-time re-check of proofs | 142 |
  | compare constructors by their fields only | differential run | 9 |
  | an off-by-one at the end of `substring` | differential run | 89 |
  | compare a type structurally despite its `impl Ord` | differential run | 3 |
  | assume an `if`'s condition in its `else` branch too | run-time re-check of proofs | 1 |
  | a bit-blasted adder that drops the carry | run-time re-check of proofs | 10 |

  The generator makes `main` itself run some of the partial operations and
  updates of value arrays, so the bugs that need one of them to execute
  are caught sooner. Each bug must be caught within 300 programs. Before
  this, the remainder bug needed 106, and a change to the generator once
  pushed it past 200.

  An earlier planted bug, letting a borrowed projection outlive the value it
  was read from, was never caught. It turned out to be unobservable, because
  lowering already re-reads every pattern variable from the matched value
  after the guard. It was replaced rather than counted.
- With every feature in place, 3,000 generated programs (seeds
  20000–22999) ran with no disagreement; 10 were skipped because the
  interpreter ran out of fuel. CI runs 1,000 fresh seeds on every push.
  Generated programs found the two false proofs described below, one in
  CI and one in an earlier run of this campaign.

Problems the checks found during development:

- The interpreter compared values by plain recursion, so comparing two
  200,000-element lists overflowed the JavaScript stack, while the compiled
  code, which compares the last field with a tail call, did not. The
  interpreter now loops on the last field too.
- The wasm encoder spread large arrays into `push()`, which overflows the
  stack once a function body reaches a few hundred kilobytes. Replaying 200
  property cases as one compiled program found it.
- The first refinement checker recorded the facts that define an `if`'s
  value only inside the branch that computed it, so a nested `if` lost them,
  and its counterexamples were not real. Those facts define a fresh value
  and constrain nothing else, so they now hold everywhere.
- The first proof checker re-propagated every clause for every lemma and
  took 22 seconds on a 3,665-lemma proof. With watched literals it takes
  0.35 seconds.
- The first borrow inference made a setter's record parameter borrowed,
  since the setter never consumes the record itself, only its fields. Every
  update then copied the arrays, and the split ran for more than ten
  minutes instead of 19 seconds; nothing was wrong, only slow. Consuming a
  field now counts as consuming the record.
- The ownership checker rejected two of the new optimizations while they
  were being written: a borrowed projection whose source was released just
  before it was read, once inside an instruction and once at the
  projection's own definition. Both were liveness bugs in `perceus.js`. One
  is now a planted bug.
- The refinement checker took a Boolean `match`'s value to be the
  disjunction of its arms' values, so an `if` on
  `match s { "a" -> true, _ -> false }` had an unreachable `else`, and an
  out-of-bounds access there counted as proved. CI's fuzzing found it on
  fresh seeds (seed 161216): the interpreter's run-time re-check of proofs
  stopped where the compiled code read out of bounds. See the S(4) section
  for the details; it is now a planted bug.
- Rerunning 3,000 programs after that fix found a second false proof (seed
  20978): the value of a branch that overflowed, such as 2^63 from
  `9223372036854775806 + 2`, was defined as equal to a 64-bit atom, a
  definition nothing satisfies, so obligations that touched it held
  vacuously. Defined atoms now have ranges wide enough for their
  definitions. It is a planted bug too.
- The interpreter, the compiled code and the Lumen solver agree on every
  small Schur instance in the tests, and on S(4) the two solvers agree byte
  for byte; a difference anywhere in the 22 MB would have shown a bug in
  one of the two compilers.

## Limitations

There are no modules and no mutation. Strings are bytes. Floats have no
`exp`, `log`, power or trigonometric functions yet, and the checker proves
nothing about them except that a literal other than `0.0` is not zero.
Local functions and lambdas are monomorphic. A local function can call
itself and earlier local functions, but local functions cannot be mutually
recursive.

Refinement predicates are linear integer arithmetic over variables and
lengths; the checker also knows division and remainder by constants. Hard
arithmetic obligations take a few seconds: the binary search showcase takes
about 2.5 s to check. The checker does not infer loop invariants: a recursive function
needs a refined parameter to carry one. It knows nothing about list lengths.
It knows about array contents only through element refinements, which state
one fact about every element; facts about particular positions, or arrays
inside records, are out of reach. A function with refined parameters cannot
be passed as a value. Proofs run at a width of about 66 bits, and a hard obligation can
take a second; results are cached by the query's canonical form.

The compiler's lowering recurses once per binding in a function, so a
function with many hundreds of bindings, such as a list literal of about
800 elements, can overflow its stack.

Traits have no default methods or superclasses, and only types declared in
the program can have their own `Ord` or `Show`. Equality is `Ord`'s
`compare(a, b) == 0`.

Reuse needs the size of the cell being dropped to be known statically,
which is the case inside a match arm. Drop specialization applies to
tuples and types with one constructor that has fields, when the fields are
read right before the drop, so a tree insert that compares before it
rebuilds is not specialized. Deep non-tail recursion is limited by the
wasm stack.

## Layout

```
compiler/   the compiler, in Lumen 2: lexer, parser, checker, refinements,
            SAT solver and proof checker, lowering, inlining, Perceus,
            certificate checkers, code generator, wasm encoder; its build,
            lumen2c.wasm, and bootstrap.js, which rebuilds it
src/        the host that runs the compiler (lumen2c.js) and compiled
            programs (runtime.js); the reference interpreter and its front
            end; property testing; an independent DRUP proof checker;
            lumen2 transform (transform.js)
proofs/     a SAT solver, a Schur encoder and a DRUP checker proved free of
            run-time errors, all written in Lumen 2; cube and conquer on
            every core (cubes.lm); S(4) = 44
superopt/   the superoptimizer: corpus, synthesis, proofs, RULES.md
bench/      six benchmark programs in Lumen 2 and in C (two on floats), their
            parallel versions, a parallel float sum, and run.js
transform/  lumen2 transform: its library (lib.lm) and harness (harness.lm),
            examples, and a benchmark against C, JavaScript and Python
selfhost/   the first self-hosted compiler, and its bootstrap
bin/        the lumen2 command
test/       node:test suites and the differential fuzzer with planted bugs
examples/   example programs
SPEC.md     the language definition
```
