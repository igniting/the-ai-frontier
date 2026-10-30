# The performance campaign

An optimization campaign on Lumen's `-O`, run as a loop: profile, form a
hypothesis, implement it, pass the gate, measure, then keep or revert. Every kept
step is its own commit. Experiments that did not pay off are listed too.

**Result.** Measured against the default build of the same compiler:
- **Instructions:** compiled programs execute **31.2% fewer wasm instructions**
  (geometric mean over the original 11 benchmarks).
- **Wall time:** they run **15–61% faster** on 9 of 10 timed benchmarks. The
  tenth, `fib`, is flat.
- **Self-hosting:** the self-hosted compiler compiles itself 18% faster, using
  35% fewer instructions.
- **Costs:** final memory grows by 27% (geometric mean), up to 2.9× on the most
  allocation-heavy benchmark. Code is 1.8% smaller.
- **Default build:** unchanged byte for byte. The self-hosted compiler still
  reproduces it exactly.

![Executed instructions per step](bench/campaign-instructions.svg)

![Wall time saved per benchmark](bench/campaign-time.svg)

## Method

**Metrics.**
- *Executed wasm instructions* is the primary metric. It is deterministic,
  machine-independent and exact. A `countInstructions` build adds a counter to
  every straight-line segment; see `src/instrument.js`.
- *Wall time* is judged by `bench/ab.js`. It loads two compiler checkouts in one
  process and alternates their runs, so machine noise hits both sides equally.
  Plain single-process timings swung by up to 25% between identical runs.
- *Binary size* and *final linear-memory size* are reported as costs.
- The benchmarks are in `bench/bench.js`. The largest is `lumenc`, the
  self-hosted compiler compiling its own 3,300-line source. The others are three
  dedicated programs (`bench/programs/`) and seven examples.

**The gate** (`node bench/gate.js`). Every step had to pass it before it was
kept:
1. The test suite. Every language test runs the interpreter and four wasm
   builds: default and `-O`, each with and without GC stress (a collection on
   every allocation).
2. Differential fuzzing on fresh random seeds: 4,500 programs, each run those
   five ways, with exact agreement required.
3. Mutation testing: every deliberately injected compiler or optimizer bug must
   be caught. The suite grew from 18 to 27 mutants over steps 0–8, and to 34
   with arrays and step 9. Every new pass got mutants of its own.
4. Every superoptimizer rule re-proved from scratch, with its proof checked.
5. The self-hosted bootstrap reaches its byte-identical fixed point.
6. The benchmarks: every `-O` build must print exactly what the default build
   prints. That includes the self-hosted compiler built with `-O` compiling
   itself to the identical binary.

**The rule:** keep a change if it lowers the instruction geometric mean and
passes the gate. Report what it costs.

**Where to look:** `bench/profile.js` gives exact executed-instruction counts per
function and per opcode. Each step after the first two was chosen from its
output.

## Steps

| # | step | instructions (geomean) | instructions (lumenc) | binary size | memory |
|---|---|---|---|---|---|
| 0 | starting point: superoptimizer rules + constant folding | −3.4% | −2.4% | −0.8% | — |
| 1 | forward single-use temporaries | −11.2% | −5.9% | −2.5% | — |
| 2 | re-mine the superoptimizer on forwarded code | −11.2% | −6.1% | −2.5% | 0.0% |
| 3 | heap headroom: grow at ¼ full instead of ½ | −20.0% | −18.4% | −2.3% | +26.6% |
| 4 | inline the allocation fast path | −22.5% | −20.6% | +3.4% | +26.6% |
| 5 | zero only frame slots a collection could see unwritten | −23.9% | −22.6% | +2.8% | +26.6% |
| 6 | mine rules to a fixed point, with side conditions | −24.0% | −22.6% | +2.8% | +26.6% |
| 7 | forward frame-slot loads between GC points | −25.2% | −24.6% | +0.9% | +26.6% |
| 8 | self tail calls become loops | −27.3% | −26.9% | +1.3% | +26.6% |
| 9 | inline array access; no frame where nothing can collect | **−31.2%** | **−35.1%** | −1.8% | +26.6% |

All figures are relative to the default build. The raw numbers for every
benchmark are in `bench/history.json`.

**0. Starting point.** `-O` applied the superoptimizer's 40 proved rewrite rules
and folded constants. That saved only 3.4%. Most rules never fired, because
codegen routes every intermediate value through a local, so the patterns are
rarely adjacent.

**1. Forward single-use temporaries.** `local.set $t; local.get $t` becomes
nothing when that is `$t`'s only use, and `local.tee` otherwise. This lines the
code up for the rules. A comparison's boxing and the `if` that unboxes it now
meet, and the proved rule `cmp 1 shl 1 or 1 shr_u ⇒ cmp` deletes six of every
seven instructions. Result: −11.2% (`fib` −39%).

**2. Re-mine the rules on forwarded code.** The search found 43 rules, one of
which repairs a non-confluence: greedy rewriting of `0 lt_s …` got stuck at a
4-instruction local optimum. The gain was small (`lumenc` −5.9% → −6.1%). The
same step added the profiler, which showed the copying collector taking 34–48%
of all instructions in the allocation-heavy benchmarks.

**3. Heap headroom.** By default, the semispaces grow when a collection leaves
them more than half full, so a program with a large live set copies about one
byte per byte it allocates. Under `-O` they grow at a quarter full. Result:
−20.0% instructions and `tail_calls` −45%, at a memory cost.

The new growth path only runs when a program outgrows its heap, which small fuzz
programs rarely do. So fuzzing and the test helper gained the fifth mode, `-O`
with GC stress (a 4 KiB heap that grows constantly). A mutant that inverts the
growth test is caught *only* by that mode.

**4. Inline the allocation fast path.** Every allocation was a call to
`$rt:alloc`. Compiled code now bumps the heap pointer inline and calls the
runtime only when the semispace is full. Allocated bytes are then tallied at
each collection, so `--stats` still reports exact totals. Result: −22.5%
instructions and +17% code size for `lumenc`. In A/B against step 3 it was
2–8% faster on four of five workloads.

**5. Frame-zeroing elision.** Every call cleared its shadow-stack frame with
`memory.fill`, so the collector would never see a stale pointer. Codegen now
tags frame-slot stores, and a conservative analysis zeroes only the slots that
some path can carry to a GC point before writing them:
- writes inside a block, loop or `if` are forgotten at its end;
- an `else` branch starts from the state before the `if`;
- a GC point is any call that can reach the allocator, found by a call-graph
  analysis of the runtime.

In the self-hosted compiler, 229 of 474 `memory.fill`s disappear. Result:
−23.9% instructions, and 8.5–13% faster in A/B against step 4.

One of the two new mutants (trust writes made inside a block) survived 400
programs. A stale slot is usually harmless by luck: a stale pointer into the
other semispace is treated as static data and ignored. So `-O` with GC stress
became a *paranoid mode*: popped frames are poisoned, and the collector
validates every root. Any stale slot now traps immediately with
`internal error: invalid GC root`, and that mutant is caught after 8 programs.

**6. Mine rules to a fixed point, with side conditions.** Two changes to the
search:
- Rewriting creates sequences unrewritten code never contains, so the search now
  re-mines the corpus after rewriting it until a round finds nothing new.
- Constants can now be generalized under a `K ≥ 0` side condition, which the SAT
  proof assumes and the matcher checks. Ten rules of the form
  `(x >>> 1) & K == N`, one per tag value, collapsed into one proved for every
  N ≥ 0.

Result: −24.0%.

**7. Forward frame-slot loads.** Traced variables live in shadow-stack slots and
were reloaded on every use. Between GC points a slot changes only through the
function's own stores, so a forward dataflow analysis over the structured
control flow keeps loaded and stored values in locals. States are intersected at
merges. Two passes ensure a value is teed into a local only when a later load
reuses it. Result: −25.2% instructions, and code smaller than at step 5.
`strings` got 0.3% worse, because its reuse is off the hot path.

**8. Self tail calls become loops.** A self tail call now assigns the new
arguments to the parameters and branches to a loop just after the frame is
pushed. The fuel check, frame zeroing and parameter stores sit inside the loop,
so every iteration starts in the state of a fresh call. Result: −27.3%. In A/B
against step 7: `lumenc` −10%, `sort` −14%, `nqueens` −10%, `gc_torture` −6%.

`tail_calls` is the exception, and the reason is worth recording:
- In V8's default mode its median got 2–14% *slower*.
- Yet it is 19% faster with only V8's optimizing tier (`--no-liftoff`) and 25%
  faster with only its baseline tier (`--liftoff-only`).
- The cause: V8 moves wasm code to the optimizing tier between calls, not inside
  a running loop. One long `count_up(n)` call now never leaves its loop, so it
  stays in baseline code. The `return_call` version re-enters the function and is
  promoted early.

**9. Inline array access; no frame where nothing can collect.** Chosen by
profiling the SAT solver that proves S(4) = 44 (`proofs/sat.lm`, the first
program here that uses arrays):
- 24% of its instructions were spent in the runtime's array functions.
  `array_get`, `array_set` and `array_length` are now emitted inline: a bounds
  check against the length in the block header, then a load or a store.
- Many small functions pushed a shadow-stack frame although no collection can
  happen while they run. Two greatest fixed points over the call graph now find
  them. `never(g)`: calling `g` can never collect, even through `g`'s own tail
  calls. `frameless(f)`: `f` allocates nothing, and each of its non-tail calls
  is to a `never` function; tail calls may collect, because `f`'s activation
  has ended by then. Frameless functions keep pointers in wasm locals and have
  no prologue or epilogue. (The first version merged the two properties; see
  below.)

Result: −31.2%, and code 3 points smaller than at step 8. Every benchmark but
`fib` improved; `nqueens`, `huffman` and `life` by 10–12%. The solver, in A/B
against the previous commit on the 1…44 search: −30.4% instructions, −27.4%
time, identical output. It joined the benchmarks as `sat` at this step; the
geometric mean stays over the original 11, so the steps remain comparable.
`lumenc`'s default build executes 6% more instructions than at step 8, because
its input, the self-hosted compiler's own source, grew to support arrays. Each
step is measured against the default build of the same commit, so the ratio is
unaffected.

## Experiments that did not make it

- **Inline the collector's "is it an immediate?" test** (call `$rt:forward` only
  for pointers). Instructions went *up*: `lumenc` +1.7%, geometric mean −20.0% →
  −19.7%. Most scanned words are pointers, so the extra test costs more than the
  calls it saves. Reverted.
- **Add the self-hosted compiler's own source to the superoptimizer's corpus.**
  It gained 0.1 points on that one benchmark and nothing elsewhere. It also made
  that benchmark partly in-sample, and the proofs grew from 49,689 to 141,293
  learned clauses (verification 2.7 s → 13.5 s). Not adopted.
- **Re-mine after slot-load forwarding.** The search produced exactly the same 40
  rules: instruction-level patterns have saturated. What remains is the corpus
  now always coming from exactly the passes that run before the rules
  (`prePasses`), so later passes cannot drift from it.

## What the gate caught along the way

- **A real interpreter bug.** Fresh-seed fuzzing found a program whose string
  grows eightfold per step. Compiled code stopped with `string too long`, while
  the reference interpreter carried on. The 2^23 − 1 byte limit had never been
  written down. SPEC.md now states it, and the interpreter enforces it.
- **A blind spot in the fuzzer.** Stale shadow-stack slots were caught only by
  luck. This led to the paranoid mode described in step 5.
- **A hole in step 9's frame removal.** The first version asked one question
  of every function: can a collection happen while it is active? A tail call
  was allowed to reach the allocator, since the function's activation ends
  first. But the same answer was then trusted at non-tail call sites, where
  the caller is still waiting. The prelude's `reverse` tail-calls the
  allocating `rev_append`, so `append`, which calls `reverse` before returning,
  lost its frame while `ys` was still live. The paranoid mode reported an
  invalid GC root on one of the test suite's fixed fuzz seeds. The analysis
  now computes the two properties separately, and the original bug is a
  planted mutant.
- **A bug in the benchmark harness itself.** It deleted the baseline's output
  before comparing against it, and reported a miscompilation that did not exist.
  The `lumenc` output was checked and was identical.

## Caveats

- **Memory.** Heap headroom trades memory for speed. Final linear memory is +27%
  by geometric mean, but 2.9× for `gc_torture` and 2× for `lumenc` (255 MiB vs
  127 MiB). `tail_calls` uses *less*.
- **Instructions are not time.** `fib` executes 39% fewer instructions but runs
  no faster: V8's optimizing tier already removes the redundancy the rules remove.
  Wall time is reported from A/B runs for that reason.
- **One machine, one engine.** All timings are Node 22 (V8) on one Linux
  container. A repeat of the final A/B moved individual figures by up to 10
  points (`tail_calls` −61% and −51%, `lumenc` −18% and −16%) and swapped three
  pairs of neighbours in the ranking. `mandelbrot` and `huffman` run in a few milliseconds, too short to
  time, so they are absent from the wall-time chart. Their instruction counts are
  in `bench/history.json`.
- **Corpus overlap.** The seven examples are both benchmarks and part of the
  superoptimizer's corpus. The rules are proved for all inputs, so this cannot
  affect correctness, only which rules exist. Re-mining without them is one
  command.
- **What stays unchanged.** `-O` changes only optimized builds. The default
  build, and the self-hosted compiler's byte-identical reproduction of it, are
  untouched.

## Reproduce

```sh
node bench/bench.js                                  # instructions, time, size, memory per benchmark
node bench/profile.js lumenc -O                      # where the instructions go
node bench/ab.js . . --flagsA base --flagsB O        # wall time, default vs -O, interleaved
node bench/gate.js                                   # the full gate (about 7 minutes)
node bench/chart.js                                  # redraw the two charts
```
