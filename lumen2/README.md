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
- **64-bit integers that never wrap silently.** Overflow is a runtime error,
  not a wrong answer.

```sh
cd lumen2
npm test                                         # 28 tests, about 20 s
node bin/lumen2.js check examples/refine.lm      # inferred types, effects, refinements
node bin/lumen2.js run examples/tour.lm          # compile to wasm and run
node bin/lumen2.js test examples/properties.lm   # check the properties
node bin/lumen2.js certify examples/refine.lm --out cert   # every certificate, written out
node bin/lumen2.js ir examples/tour.lm insert    # the IR, with reference counting
node test/fuzz.js 1000                           # differential fuzzing
node test/fuzz.js --mutants                      # are planted bugs caught?
```

Requires Node.js 22 or later. There are no dependencies.

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
formula and proof as DIMACS and DRUP files, which drat-trim can also check.
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
| Perceus | `src/perceus.js` | Ownership: dup where a value is needed twice, drop as soon as it is dead |
| Reuse | `src/reuse.js` | `drop` followed by a same-size allocation becomes `drop-reuse` and an in-place constructor |
| Certificates | `src/certify.js` | Independent checkers for the IR's types and its reference counting |
| Code generator | `src/codegen.js` | WebAssembly with i64, tail calls and bulk memory; a size-class allocator; per-type drop and compare functions that free and compare long lists in constant stack |
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
- **Planted bugs.** Sixteen deliberate bugs in the compiler, the verifier
  and the SAT solver check that all of this catches what it should. Six are
  caught at compile time by a certificate checker, before any program runs:

  | Planted bug | Caught by | First seed |
  | --- | --- | --- |
  | pass ownership of a variable that is still needed (a missing dup) | ownership checker | 1 |
  | forget to drop a variable last used by a borrowing instruction | ownership checker | 1 |
  | drop a variable before the instruction that borrows it | ownership checker | 1 |
  | forget to free a reuse token on a path that does not use it | ownership checker | 2 |
  | give a pattern variable the type of the pattern's first variable | IR type checker | 1 |
  | a SAT solver that claims every formula is unsatisfiable | RUP proof checker | 1 |
  | read a closure's captured value without taking a reference | differential run | 1 |
  | reuse a cell even when it is shared | differential run | 11 |
  | update a shared array in place | differential run | 6 |
  | free an object without releasing its last field | leak check | 1 |
  | drop the overflow check on `+` | differential run | 12 |
  | compare constructors by their fields only | differential run | 9 |
  | an off-by-one at the end of `substring` | differential run | 47 |
  | compare a type structurally despite its `impl Ord` | differential run | 13 |
  | assume an `if`'s condition in its `else` branch too | run-time re-check of proofs | 1 |
  | a bit-blasted adder that drops the carry | run-time re-check of proofs | 10 |

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

## Limitations

There is no floating point, no modules and no mutation. Strings are bytes.
Local functions and lambdas are monomorphic. A local function can call
itself and earlier local functions, but local functions cannot be mutually
recursive.

Refinement predicates are linear integer arithmetic over variables and
lengths. The checker does not infer loop invariants: a recursive function
needs a refined parameter to carry one. It knows nothing about list lengths
or array contents. A function with refined parameters cannot be passed as a
value. Proofs run at a width of about 66 bits, and a hard obligation can
take a second; results are cached by the query's canonical form.

Traits have no default methods or superclasses, and only types declared in
the program can have their own `Ord` or `Show`. Equality is `Ord`'s
`compare(a, b) == 0`.

Reuse needs the size of the cell being dropped to be known statically,
which is the case inside a match arm. The Perceus paper's further
optimizations (drop specialization, borrowed parameters) are not
implemented. Deep non-tail recursion is limited by the wasm stack.

## Layout

```
src/        lexer, parser, checker, exhaustiveness, refinements, SAT solver,
            proof checker, interpreter, properties, lowering, Perceus, reuse,
            certificate checkers, code generator, wasm encoder
bin/        the lumen2 command
test/       node:test suites and the differential fuzzer with planted bugs
examples/   example programs
SPEC.md     the language definition
```
