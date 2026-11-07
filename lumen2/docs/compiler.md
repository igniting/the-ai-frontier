# The compiler

## The compiler, in Lumen 2

The compiler is written in Lumen 2: [`compiler/`](../compiler/) holds it, in
the order of its passes, about 8,600 lines. It runs as WebAssembly.
[`compiler/lumen2c.wasm`](../compiler/lumen2c.wasm) is the compiler compiled
by itself, and [`src/lumen2c.js`](../src/lumen2c.js) hands it a program and
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
([`src/interp.js`](../src/interp.js)), with its own front end
([`src/check.js`](../src/check.js)), which is the second implementation that
compiled code is compared with; property testing; the small host that runs
compiled modules ([`src/runtime.js`](../src/runtime.js)); and
[`src/rup.js`](../src/rup.js), an independent checker for the proofs the
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
[`compiler/build.js`](../compiler/build.js).

## The first self-hosted compiler

Before the port, [`selfhost/lumen2c.lm`](../selfhost/lumen2c.lm) was the
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

The language is defined in [SPEC.md](../SPEC.md).

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

[`superopt/RULES.md`](../superopt/RULES.md) lists all 19 rules. The rest are
simpler: `i32.const 0; i32.eq` is `i32.eqz`, `0 xor x` is `x` (from `0 - x`),
and folds of constant comparisons and arithmetic that inlining leaves
behind. The compiler applies them on every compile
([`compiler/45-wasm.lm`](../compiler/45-wasm.lm); `superopt: false` turns them
off), and `superopt/search.js` writes them to
[`compiler/rules.js`](../compiler/rules.js), from which the compiler is built. `node superopt/verify.js` re-proves all of them, and the
test suite does too.

The result is modest, and the reason is instructive. On the corpus, the
rules remove 1.2% of the instructions. On the SAT solver they remove 229 of
18,609 instructions (1.2%) and 338 bytes, and the time for the split of 1..44
does not change measurably. Lumen's superoptimizer found 40 rules, most of
them cleaning up after its tagged 31-bit integers. Lumen 2's integers are
untagged i64 values, so its code generator leaves much less behind, and the
engine's own optimizing compiler already performs rewrites like these.

---

[Back to the Lumen 2 README](../README.md)
