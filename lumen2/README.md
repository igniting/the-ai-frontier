# Lumen 2

**A pure functional language whose types say what a function can do, compiled
to WebAssembly with no garbage collector.** Lumen 2 is a fresh design, not an
extension of [Lumen](../README.md). It shares no code with it, and Lumen is
unchanged.

- **Effects are part of the type, and inferred.** A function that prints has
  `! io` in its type. One that can divide by zero or index out of bounds has
  `! fail`. A pure function has neither. Higher-order functions are
  effect-polymorphic, so `map` is pure when its argument is.
- **Annotations are checked claims.** Writing `-> Int ! {}` promises that a
  function cannot fail. If it can, the compiler names the operation that
  breaks the promise.
- **No garbage collector.** Memory is reference counted, and the compiler
  inserts the increments and decrements precisely, after
  [Perceus](https://www.microsoft.com/en-us/research/publication/perceus-garbage-free-reference-counting-with-reuse/).
  Every object is freed as soon as it is last used, and the test suite checks
  that a finished program has freed everything.
- **Functional code, in-place updates.** Values are immutable, but when a
  value is not shared the compiler updates it in place. Inserting into a
  search tree held once rebuilds each node in the cell of the node it
  replaces. `array_set` on an array nothing else refers to writes in place.
  Reversing a list that is not used again allocates nothing.
- **64-bit integers that never wrap silently.** Overflow is a runtime error,
  not a wrong answer.
- **Exhaustive matching with examples.** A non-exhaustive `match` is an error
  that shows a value no arm handles.

```sh
cd lumen2
npm test                                  # 16 tests, about 15 s
node bin/lumen2.js check examples/tour.lm # inferred types and effects
node bin/lumen2.js run examples/tour.lm   # compile to wasm and run
node bin/lumen2.js ir examples/tour.lm insert   # the IR, with reference counting
node test/fuzz.js 1000                    # differential fuzzing
node test/fuzz.js --mutants               # are planted bugs caught?
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
insert  : fn(Tree<a>, a) -> Tree<a> where a: Cmp
main    : fn() -> () ! {fail, io}
```

`twice` performs whatever effects `e` its argument performs. `insert`
compares elements, so its element type must be comparable (`where a: Cmp`);
trying to sort a list of functions is a compile-time error.

The checker's errors name the cause:

```
error: `/` (division by zero) can fail, but `average` is declared without `fail`
 --> 2:3
  |
2 |   sum(xs) / length(xs)
  |   ^^^^^^^^^^^^^^^^^^^^
  = note: add the effect to the signature (for example `! {fail}`), or remove the cause

error: non-exhaustive match: `Blue` is not covered
 --> 3:9
  |
3 |   match c { Red -> "red", Green -> "green" }
  |         ^
  = note: add an arm for it, or a wildcard `_ ->` arm
```

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
own. When the tree is not shared, `drop-reuse` gets the cell back
and the insert allocates exactly one new node, the leaf. When the tree is
shared, `drop-reuse` just decrements the count, and the path to the new leaf
is copied. The source code is the same in both cases.

## How it works

| Stage | File | What it does |
| --- | --- | --- |
| Lexer, parser | `src/lexer.js`, `src/parser.js` | Byte strings, nested comments; lists and `\|>` desugared |
| Checker | `src/check.js`, `src/types.js` | Hindley–Milner with row-polymorphic effects, comparability constraints, generalization per strongly connected component |
| Exhaustiveness | `src/exhaust.js` | Maranget's usefulness algorithm, with witnesses |
| Interpreter | `src/interp.js` | The reference semantics: BigInt arithmetic checked against 64 bits, trampolined tail calls |
| Lowering | `src/lower.js` | Monomorphization (an `Int` is never boxed); A-normal form; closures lifted; matches compiled to tests that borrow |
| Perceus | `src/perceus.js` | Ownership: dup where a value is needed twice, drop as soon as it is dead |
| Reuse | `src/reuse.js` | `drop` followed by a same-size allocation becomes `drop-reuse` and an in-place constructor |
| Code generator | `src/codegen.js` | WebAssembly with i64, tail calls and bulk memory; a size-class allocator; per-type drop and compare functions that free and compare long lists in constant stack |
| Encoder | `src/wasm.js` | A binary encoder; no external toolchain |

The language is defined in [SPEC.md](SPEC.md).

## How it is checked

The interpreter defines the language. It shares no code with the back end
after type checking. The compiler is tested against it:

- **Differential fuzzing.** `test/fuzz.js` generates random well-typed
  programs over lists, trees, options, tuples, strings, arrays and closures,
  with matches, guards, higher-order prelude functions, recursion and integer
  edge cases. Each program runs four ways: interpreted; compiled; compiled in
  *paranoid* mode, where freed memory is never reused and any access to a
  freed object stops the program; and compiled without reuse. All four must
  print the same output and stop with the same error.
- **A leak check.** Every compiled run that finishes must report zero live
  objects.
- **Planted bugs.** Eleven deliberate compiler bugs check that the harness
  catches what it should. Each is caught within the first 200 generated
  programs:

  | Planted bug | First seed that catches it |
  | --- | --- |
  | pass ownership of a variable that is still needed (a missing dup) | 1 |
  | forget to drop a variable last used by a borrowing instruction | 2 |
  | drop a variable before the instruction that borrows it | 1 |
  | read a closure's captured value without taking a reference | 1 |
  | reuse a cell even when it is shared | 4 |
  | forget to free a reuse token on a path that does not use it | 2 |
  | update a shared array in place | 87 |
  | free an object without releasing its last field | 2 |
  | drop the overflow check on `+` | 63 |
  | compare constructors by their fields only | 11 |
  | an off-by-one at the end of `substring` | 17 |

  An earlier planted bug, letting a borrowed projection outlive the value it
  was read from, was never caught. It turned out to be unobservable, because
  lowering already re-reads every pattern variable from the matched value
  after the guard. It was replaced rather than counted.
- During development, 3,000 generated programs (seeds 1000–3999) ran with no
  disagreement; 9 were skipped because the interpreter ran out of fuel. CI
  runs fresh seeds on every push.

Two problems the harness found while the back end was being written:

- The interpreter compared values by plain recursion, so comparing two
  200,000-element lists overflowed the JavaScript stack, while the compiled
  code, which compares the last field with a tail call, did not. The
  interpreter now loops on the last field too, and the spec says comparison
  takes constant stack.
- The first generator produced programs that mostly stopped at an
  out-of-range index within a few hundred steps, so it barely exercised the
  memory manager. Indices are now usually in range, and some programs build
  structures with thousands of elements.

## What is not built yet

The design this follows has more parts. These are not implemented, and
nothing above depends on them:

- **Refinement types**, such as `{ n: Int | n >= 0 }` for indices, discharged
  by a SAT/SMT solver with checked certificates, so that `array_get` with a
  proven index has no `fail` effect.
- **Traits** for user-defined equality, ordering and printing, in place of
  structural comparison.
- **Certifying passes**: each compiler pass emits evidence that a checker
  validates, as the original Lumen's superoptimizer does for its rewrite
  rules.
- **Properties as part of the language**: `property` declarations that the
  toolchain tests with generated inputs.
- **Capabilities**: `io` split into finer effects such as reading input,
  writing output, time and randomness, granted explicitly to `main`.

## Limitations

There is no floating point, no modules, no type classes and no mutation.
Strings are bytes. Local functions and lambdas are monomorphic. A local
function can call itself and earlier local functions, but local functions
cannot be mutually recursive. Reuse needs the
size of the cell being dropped to be known statically, which is the case
inside a match arm. The Perceus paper's further optimizations (drop
specialization, borrowed parameters) are not implemented, so a uniquely owned
value still has its fields' counts raised and lowered once when it is taken
apart. Deep non-tail recursion is limited by the wasm stack.

## Layout

```
src/        lexer, parser, checker, exhaustiveness, interpreter,
            lowering, Perceus, reuse, code generator, wasm encoder
bin/        the lumen2 command
test/       node:test suites and the differential fuzzer with planted bugs
examples/   example programs
SPEC.md     the language definition
```
