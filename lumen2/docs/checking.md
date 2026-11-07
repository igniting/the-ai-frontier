# How it is checked

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

---

[Back to the Lumen 2 README](../README.md)
