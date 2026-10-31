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
- **Self-hosted.** A second compiler, written in Lumen 2, compiles itself
  to a fixed point: compiled by itself, it reproduces itself byte for byte.
- **64-bit integers that never wrap silently.** Overflow is a runtime error,
  not a wrong answer.
- **A theorem, proved in it.** A SAT solver written in Lumen 2 proves the
  Schur number S(4) = 44. It prints the same 255,663-step refutation, byte
  for byte, as the original Lumen's imperative solver, at about the same
  speed.

**[Open the Lumen 2 playground →](https://igniting.github.io/the-ai-frontier/lumen2/playground.html)**
(types and effects, every proof obligation, the code after reference
counting, property tests and certificates, all in the browser) ·
**[Read how it was built →](https://igniting.github.io/the-ai-frontier/#lumen2)**
(Part five of the story, with live demos)

```sh
cd lumen2
npm test                                         # 43 tests, about 50 s
node bin/lumen2.js check examples/refine.lm      # inferred types, effects, refinements
node bin/lumen2.js run examples/tour.lm          # compile to wasm and run
node bin/lumen2.js test examples/properties.lm   # check the properties
node bin/lumen2.js certify examples/refine.lm --out cert   # every certificate, written out
node bin/lumen2.js ir examples/tour.lm insert    # the IR, with reference counting
node test/fuzz.js 1000                           # differential fuzzing
node test/fuzz.js --mutants                      # are planted bugs caught?
node proofs/prove-schur.js 4 44                  # prove S(4) = 44 (about 5 minutes)
node proofs/compare-lumen.js 4 44                # the same proof as the Lumen solver's?
node superopt/search.js                          # search for rewrite rules (about 30 s)
node superopt/verify.js                          # re-prove every rule the compiler applies
node selfhost/bootstrap.js                       # the self-hosting fixed point (about 3 s)
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
  it: 106 allocations in the whole run, in about 0.4 s. The same heapsort in
  the original Lumen, which mutates its array, takes 1.0 s (0.44 s with
  `-O`), and hand-written JavaScript about 0.25 s for the sort alone.
  Refinement types state each index's range and that every function
  returns an array of the same length, and the checker proves every access
  in bounds. No function has `fail` in its type, not even `main`
  (`fn() -> () ! output`): this program cannot stop with an error, short of
  running out of memory.
- **[`search.lm`](examples/showcase/search.lm): a binary search with no
  run-time checks.** The loop invariant is in the parameter types, and three
  million lookups in a million-element array take about 0.3 s, with 30
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
state arrays: their lengths live inside the `Solver` record, and the facts
that would make them safe (every literal in every clause is below 2n + 2)
are about array contents, which refinements cannot state. The solver's
functions therefore have `! fail` in their types, and the bounds checks stay
in the compiled code.

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
inputs, and `src/sat.js` refutes their difference, with the proof checked by
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
behind. `src/peephole.js` applies them on every compile (`superopt: false`
turns them off). `node superopt/verify.js` re-proves all of them, and the
test suite does too.

The result is modest, and the reason is instructive. On the corpus, the
rules remove 1.2% of the instructions. On the SAT solver they remove 229 of
18,609 instructions (1.2%) and 338 bytes, and the time for the split of 1..44
does not change measurably. Lumen's superoptimizer found 40 rules, most of
them cleaning up after its tagged 31-bit integers. Lumen 2's integers are
untagged i64 values, so its code generator leaves much less behind, and the
engine's own optimizing compiler already performs rewrites like these.

## Self-hosting

[`selfhost/lumen2c.lm`](selfhost/lumen2c.lm) is a Lumen 2 compiler written
in Lumen 2, about 2,800 lines. It reads a program on standard input and
writes a WebAssembly module on standard output, with the same stages as the
reference compiler: a lexer and a recursive-descent parser; Hindley–Milner
inference with traits and derived `Show`, generalized per strongly
connected component of the call graph (found with Tarjan's algorithm);
monomorphization and lowering to A-normal form, with closures for lambdas
and local functions and tag tests for matches; Perceus reference counting;
code generation with the reference compiler's runtime conventions; and a
binary encoder. Its own data structures are AVL trees, and arrays that it
updates in place because it never shares them.

```
$ node selfhost/bootstrap.js
stage 1: lumen2c.lm (2844 lines) compiled by the reference compiler: 572987 bytes
stage 2: compiled by stage 1: 287308 bytes, e29b35f5fd90dccf (540 ms, 5222502 allocations, nothing leaked)
stage 3: compiled by stage 2: 287308 bytes, e29b35f5fd90dccf (739 ms, 10043674 allocations, nothing leaked)
FIXED POINT: stage 2 and stage 3 are byte-identical
```

Stage 1 is the compiler as the reference compiler builds it. Stage 2 is the
compiler as it builds itself, and stage 3, built by stage 2, is the same
bytes: the compiler reproduces itself. Stage 1 and stage 2 are different
programs from different compilers, so the test suite also checks that both
behave like the reference interpreter. On every example, the SAT solver,
the Schur encoder and 1,000 generated programs, the modules they write print
exactly what the interpreter prints, stop with the same error, and free
every object. That run found one bug: a trait method called on a type
that inference leaves undetermined, as in `size([])`, which both compilers
default to `()`, where `()` has no impl. The reference compiler emits
`unreachable` there, because such a call is never reached with a value, and
now so does `lumen2c`.

What it leaves out, deliberately: it checks types but not effects,
capabilities, exhaustiveness or refinements, so it relies on the reference
compiler to reject invalid programs. A refinement type is read as its base
type, and every partial operation keeps its run-time check. It makes none
of the reference compiler's optimizations except tail calls. The SAT
solver it compiles finds the split of 1..44 in 19.6 s instead of 2.4 s,
with the same output, which matches the reference compiler before its five
optimizations (19.0 s, in the table above).

Writing it found a bug in the reference compiler too. Its lowering passes
continuations, so its stack depth grows with the number of bindings in one
function. A list literal of about 800 elements overflows it, and so did
`lumen2c`'s table of runtime routines, until each routine became a function
of its own.

## How it works

| Stage | File | What it does |
| --- | --- | --- |
| Lexer, parser | `src/lexer.js`, `src/parser.js` | Byte strings, nested comments; lists and `\|>` desugared |
| Checker | `src/check.js`, `src/types.js` | Hindley–Milner with row-polymorphic effects, trait constraints, generalization per strongly connected component; traits, impls and derived `Show`; capability grants |
| Exhaustiveness | `src/exhaust.js` | Maranget's usefulness algorithm, with witnesses |
| Refinements | `src/refine.js` | Symbolic walk of each function; proof obligations for partial operations and refinements |
| Proofs | `src/blast.js`, `src/sat.js`, `src/rup.js` | Bit-blasting to CNF, a CDCL solver that writes DRUP proofs, and an independent RUP checker |
| Interpreter | `src/interp.js` | The reference semantics: BigInt arithmetic checked against 64 bits, trampolined tail calls, and a run-time re-check of everything the checker proved |
| Properties | `src/props.js` | Type-directed generation and shrinking; compiled replay |
| Lowering | `src/lower.js` | Monomorphization (an `Int` is never boxed, trait methods become direct calls); A-normal form; closures lifted; matches compiled to tests that borrow |
| Inlining | `src/inline.js`, `src/simplify.js` | Small functions inlined; known-constructor field reads, flattening and dead-code removal |
| Perceus | `src/perceus.js` | Ownership: dup where a value is needed twice, drop as soon as it is dead; borrowed parameters and projections, inferred |
| Reuse | `src/reuse.js` | `drop` followed by a same-size allocation becomes `drop-reuse` and an in-place constructor |
| Drop specialization | `src/specialize.js` | Taking apart a unique cell moves its fields instead of dup-ing and releasing them |
| Certificates | `src/certify.js` | Independent checkers for the IR's types and its reference counting |
| Code generator | `src/codegen.js` | WebAssembly with i64, tail calls and bulk memory; checked arithmetic and array reads inline; a size-class allocator; per-type drop and compare functions that free and compare long lists in constant stack |
| Peephole | `src/peephole.js`, `src/rules.js` | The superoptimizer's proved rewrite rules, with their side conditions |
| Encoder | `src/wasm.js` | A binary encoder; no external toolchain |

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
  compiled; compiled in *paranoid* mode, where freed memory is never reused
  and any access to a freed object stops the program; and compiled without
  reuse. All four must print the same output and stop with the same error.
- **A leak check.** Every compiled run that finishes must report zero live
  objects.
- **Proofs are re-checked as the program runs.** The interpreter re-checks
  every refinement and every operation the checker proved safe. An unsound
  proof therefore shows up as a disagreement with the compiled code.
- **Certificates on every compile**: IR types, reference counting, every
  DRUP proof, and the engine's validation of the module.
- **Planted bugs.** Twenty deliberate bugs in the compiler, the verifier
  and the SAT solver check that all of this catches what it should. Seven
  are caught at compile time by a certificate checker, before any program
  runs:

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
  | reuse a cell even when it is shared | differential run | 4 |
  | move the fields out of a cell even when it is shared | differential run | 19 |
  | update a shared array in place | differential run | 6 |
  | free an object without releasing its last field | leak check | 1 |
  | drop the overflow check on `+` | differential run | 28 |
  | an off-by-one in the overflow bound for multiplying by a constant | differential run | 37 |
  | apply a rewrite rule without checking its side condition | differential run | 8 |
  | compare constructors by their fields only | differential run | 9 |
  | an off-by-one at the end of `substring` | differential run | 47 |
  | compare a type structurally despite its `impl Ord` | differential run | 23 |
  | assume an `if`'s condition in its `else` branch too | run-time re-check of proofs | 1 |
  | a bit-blasted adder that drops the carry | run-time re-check of proofs | 21 |

  An earlier planted bug, letting a borrowed projection outlive the value it
  was read from, was never caught. It turned out to be unobservable, because
  lowering already re-reads every pattern variable from the matched value
  after the guard. It was replaced rather than counted.
- With every feature in place, 3,000 generated programs (seeds
  20000–22999) ran with no disagreement; 14 were skipped because the
  interpreter ran out of fuel. CI runs 1,000 fresh seeds on every push.

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
- The interpreter, the compiled code and the Lumen solver agree on every
  small Schur instance in the tests, and on S(4) the two solvers agree byte
  for byte; a difference anywhere in the 22 MB would have shown a bug in
  one of the two compilers.

## Limitations

There is no floating point, no modules and no mutation. Strings are bytes.
Local functions and lambdas are monomorphic. A local function can call
itself and earlier local functions, but local functions cannot be mutually
recursive.

Refinement predicates are linear integer arithmetic over variables and
lengths; the checker also knows division and remainder by constants. Hard
arithmetic obligations take a few seconds: the binary search showcase takes
about 4 s to check. The checker does not infer loop invariants: a recursive function
needs a refined parameter to carry one. It knows nothing about list lengths
or array contents. A function with refined parameters cannot be passed as a
value. Proofs run at a width of about 66 bits, and a hard obligation can
take a second; results are cached by the query's canonical form.

The reference compiler's lowering recurses once per binding in a function,
so a function with many hundreds of bindings, such as a list literal of
about 800 elements, overflows its stack.

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
src/        lexer, parser, checker, exhaustiveness, refinements, SAT solver,
            proof checker, interpreter, properties, lowering, inlining,
            Perceus, reuse, drop specialization, certificate checkers,
            code generator, wasm encoder
proofs/     a SAT solver and a Schur encoder written in Lumen 2; S(4) = 44
superopt/   the superoptimizer: corpus, synthesis, proofs, RULES.md
selfhost/   a Lumen 2 compiler written in Lumen 2, and the bootstrap
bin/        the lumen2 command
test/       node:test suites and the differential fuzzer with planted bugs
examples/   example programs
SPEC.md     the language definition
```
