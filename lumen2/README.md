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
  each ([floats](docs/language.md#floats)).
- **Within 1.1 to 3.5 times of C.** On six benchmark programs, four on
  integers and two on floats, the same algorithm takes 1.1 to 3.5 times as
  long in Lumen 2 as in C compiled natively, with no mutation in the source
  and, where the program's types say so, every array access proved in
  bounds ([how fast it is](docs/performance.md#how-fast-it-is)).
- **Every core, safely.** `par_map` runs a function on every core. The
  types guarantee that the function does no input or output and uses
  neither the clock nor randomness, so the parallel result is the
  sequential one. On four cores, four benchmarks run 2.4 to 3.5 times
  faster than on one, and three of them faster than C on one core
  ([on every core](docs/performance.md#on-every-core)).
- **Users' code on your data, safely and on every core.** `lumen2
  transform` runs a user's function over every line of a file. A function
  that could print, read, read the clock or use randomness is rejected
  before it runs, so the output is the same on any number of threads. On 2
  million CSV rows it is 6 times as fast as Python running the same
  function with `exec`, and 4 times as fast as JavaScript in a `node:vm`
  context ([user-defined functions](docs/transform.md#user-defined-functions-lumen2-transform)).
- **Run again, and only the changed lines run.** Because a transform is
  proved to depend on nothing but its line, `lumen2 transform --incremental`
  can reuse the last run's output for every line that did not change, and
  its output is still exactly a full run's. After 500 of 500,000 rows
  change, matching each company name to the closest of 64 known names takes
  0.38 seconds again, where C takes 5.1 seconds on four cores and 19 on one,
  and Python about 20 minutes. In a simulated month of a daily pipeline, it
  is as fast as the dbt-style pattern of transforming only the rows updated
  since the last run, which was wrong on every one of the 30 days, while
  `--incremental` was right on all of them
  ([running it again](docs/transform.md#running-it-again---incremental)).
- **A theorem, proved in it.** A SAT solver written in Lumen 2 proves the
  Schur number S(4) = 44. It prints the same 255,663-step refutation, byte
  for byte, as the original Lumen's imperative solver, at about the same
  speed. Split into 256 cubes and run on every core, the whole proof,
  checked, takes 22 s instead of 8 minutes
  ([on every core](docs/theorem.md#a-theorem-s4--44)).
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
node transform/bench/simulate.js                 # a month of a daily pipeline: full runs, a dbt-style merge, caches, --incremental (about 10 minutes)
LUMEN2_THREADS=2 node bin/lumen2.js run bench/nqueens-par.lm --allow input --input FILE   # par_map on 2 threads
```

Requires Node.js 22 or later. There are no dependencies.

## What it is, and what it isn't

Lumen 2 is a research language, built to see how much a compiler can prove
and check about the programs it compiles. It is not a language to adopt. It
runs 1.1 to 3.5 times as long as C on one core. Where it wins, the win comes
from what its checker proves, not from speed: a parallel result that cannot
depend on the threads, a user's function that cannot reach anything,
failures and step budgets that are the same on every run, and outputs that
can be reused because the function provably depends on nothing else. In a
simulated month of a daily pipeline, that last guarantee kept every output
right where the usual shortcuts were wrong, but the computing it saved was
worth about a cent. The guarantee would be worth more as a check on code
people already write (an `IMMUTABLE` declaration that is verified, not
trusted) than as a reason to write code in a new language.

## The documentation

- **[The language](docs/language.md)**: a showcase (a heapsort that is pure,
  updates in place and is proved unable to fail; a proved binary search;
  plugins whose safety is a type), then refinement types and proved
  operations, traits, properties, capabilities, floats, and memory without
  a garbage collector. [`SPEC.md`](SPEC.md) defines the language.
- **[A theorem: S(4) = 44](docs/theorem.md)**: a SAT solver written in
  Lumen 2 proves the Schur number S(4) = 44 and prints the same
  255,663-step refutation as the original Lumen's solver; split into 256
  cubes and run on every core, the proof takes 22 seconds; a DRUP checker
  proved unable to crash checks it again.
- **[How fast it is](docs/performance.md)**: six programs against C, four
  of them also on four cores, what WebAssembly costs, and the compiler
  changes that brought Lumen 2 from 1.5 to 10 times slower than C to 1.1 to
  3.5.
- **[User-defined functions: `lumen2 transform`](docs/transform.md)**: a
  user's function over every line of a file, on every core, rejected if it
  could do anything but compute; a step budget for every line; and
  `--incremental`, which runs it again on only the lines that changed, with
  a month of a daily pipeline simulated against the usual alternatives.
- **[The compiler](docs/compiler.md)**: the compiler written in Lumen 2,
  how it was ported from JavaScript, the first self-hosted compiler, and a
  superoptimizer whose rewrite rules are proved.
- **[How it is checked](docs/checking.md)**: the test suite, differential
  fuzzing, planted bugs that the tests must catch, and certificates.

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
            lumen2 transform (transform.js, incremental.js)
proofs/     a SAT solver, a Schur encoder and a DRUP checker proved free of
            run-time errors, all written in Lumen 2; cube and conquer on
            every core (cubes.lm); S(4) = 44
superopt/   the superoptimizer: corpus, synthesis, proofs, RULES.md
bench/      six benchmark programs in Lumen 2 and in C (two on floats), their
            parallel versions, a parallel float sum, and run.js
transform/  lumen2 transform: its library (lib.lm) and harness (harness.lm),
            examples, benchmarks against C, JavaScript and Python, and a
            simulated month of a daily pipeline (bench/simulate.js)
selfhost/   the first self-hosted compiler, and its bootstrap
bin/        the lumen2 command
test/       node:test suites and the differential fuzzer with planted bugs
examples/   example programs
docs/       the documentation, by topic (see above)
SPEC.md     the language definition
```
