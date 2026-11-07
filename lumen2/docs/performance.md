# How fast it is

[`bench/`](../bench/) holds six programs, each written twice, in Lumen 2 and
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
| [fannkuch-redux](../bench/fannkuch.lm): permutations, arrays updated in place | 11 | 3.07 s | 3.14 s | 3.89 s | 1.3× |
| [binary trees](../bench/binarytrees.lm): allocating and freeing trees | 18 | 1.20 s | 1.32 s | 1.33 s | 1.1× |
| [N-queens](../bench/nqueens.lm): backtracking search | 13 | 0.65 s | 0.70 s | 1.20 s | 1.8× |
| [edit distance](../bench/editdist.lm): dynamic programming over arrays | 30,000 | 1.05 s | 1.15 s | 2.63 s | 2.5× |
| [n-body](../bench/nbody.lm): the planets, in floating point | 5,000,000 | 0.25 s | 0.31 s | 0.70 s | 2.8× |
| [spectral norm](../bench/spectralnorm.lm): matrix-vector products in floating point | 3,000 | 0.47 s | 0.47 s | 1.63 s | 3.5× |

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

## On every core

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
([`fannkuch-par.lm`](../bench/fannkuch-par.lm),
[`binarytrees-par.lm`](../bench/binarytrees-par.lm),
[`nqueens-par.lm`](../bench/nqueens-par.lm)), and so do the C programs, with
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

---

[Back to the Lumen 2 README](../README.md)
