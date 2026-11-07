# A theorem: S(4) = 44

The Schur number S(4) is the largest n for which 1..n can be split into
four groups, none containing x, y and x + y. That it is 44 has been known
since a computer search in 1965. [`proofs/sat.lm`](../proofs/sat.lm) is a
CDCL SAT solver written in Lumen 2, and [`proofs/schur.lm`](../proofs/schur.lm)
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
[Lumen's solver](../../proofs/sat.lm), decision for decision: the same watch
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
program that is proved safe: [`proofs/rup.lm`](../proofs/rup.lm), a DRUP
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

**On every core.** With [`par_map`](performance.md#on-every-core), the refutation runs on
every core, by cube and conquer. [`proofs/cubes.lm`](../proofs/cubes.lm) splits
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

---

[Back to the Lumen 2 README](../README.md)
