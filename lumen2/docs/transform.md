# User-defined functions: `lumen2 transform`

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
  responsible. For [`sample-random.lm`](../transform/examples/sample-random.lm):

  ```
  error: `transform` can use randomness, but a transform may only compute (and fail)
    transform  fn(Int, String) -> Option<String> ! random  (line 7)
  ```

  That is what makes the next two points true. Sampling one line in a
  hundred with `random_int`, as that file does, is rejected; sampling by
  `hash(line) % 100` ([`sample.lm`](../transform/examples/sample.lm)) picks
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

The library ([`transform/lib.lm`](../transform/lib.lm), in Lumen 2, with every
byte access proved in bounds) has CSV fields and lines (`fields`, `field`,
`csv`), numbers (`parse_int`, and `parse_decimal` and `show_decimal` for
exact decimals such as money, in hundredths), text (`split`, `trim`,
`lower`, `upper`, `starts_with`, `ends_with`, `index_of`, `includes`,
`replace_all`, `pad_left`) and a `hash` that is the same on every machine.
[`logs.lm`](../transform/examples/logs.lm) reads web server logs with them.
Floats come from the language's `parse_float` and `float_to_fixed`:
[`sensors.lm`](../transform/examples/sensors.lm) converts temperature
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

## Running it again: `--incremental`

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
[`match.lm`](../transform/examples/match.lm), which matches each company name
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
cheap as [`orders.lm`](../transform/examples/orders.lm), C reads, transforms
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

**A month of a pipeline.** The tables above compare with running the
function again in full, but a pipeline that runs every day usually does
not: it transforms only the rows updated since its last run, as dbt's
incremental models do, or it caches outputs by row.
`node transform/bench/simulate.js` simulates a month of such a pipeline. A
vendor file of 500,000 rows is exported again in full every day, with the
changes such files get: rows appended (0.4% a day), corrected (0.1%,
mostly recent ones), deleted (0.02%), and arriving late, with yesterday's
timestamp (0.02%). A new supplier starts appearing on day 10 and is added
to the known names on day 15, and on day 22 a correction updates 5% of the
rows. Five ways keep the output up to date, each run as its own process
every day, and each day's output is compared, row by row, with the
function run over the whole file. The first four run the function in C,
which reads the known names from a file, as C and Python programs usually
keep such data; the cache and the dbt-style merge are Node scripts
([`sim-memo.js`](../transform/bench/sim-memo.js),
[`sim-watermark.js`](../transform/bench/sim-watermark.js)).

| Way | Days with a wrong output | Usual day | Day 15: names changed | Day 22: 5% updated | Days 1 to 30 |
| --- | --- | --- | --- | --- | --- |
| run the function over the whole file again, in C | 0 of 30 | 5.7 s | 6.3 s | 5.6 s | 3 min |
| transform the rows updated since the last run, merge by id (dbt-style) | **30 of 30** | 0.71 s | 0.74 s | 0.97 s | 22 s |
| cache outputs by row and the code's version | **16 of 30** | 1.95 s | 1.82 s | 2.24 s | 58 s |
| the same cache, keyed by the file of names too | 0 of 30 | 1.91 s | 7.3 s | 2.14 s | 62 s |
| `lumen2 transform --incremental` | 0 of 30 | 0.68 s | 17 s | 1.76 s | 38 s |
| run it again in Python (estimated from 2,000 rows) | 0 of 30 | 18 min | 18 min | 19 min | 9 hours |

On 4 threads; on day 0 every way runs in full (5.5 to 6 s in C, 16 s for
Lumen 2, which also compiles the transform then).

- The dbt-style merge is the fastest, and wrong from the first day: it
  never sees a row that arrives with an older timestamp, keeps deleted
  rows, and gives the new name only to rows updated after it. By day 30,
  6,239 of 563,616 rows are wrong (2,672 missing, 3,174 deleted but still
  there, 393 wrong). Pipelines that use it run it again in full now and
  then.
- The cache keyed by the code is right until day 15, when the names
  change, and then about 400 rows are wrong for the rest of the month: the
  names are in a file the code reads, and the key did not include it.
  Keyed by that file too, it is right every day. It is as right as its
  author's list of what the function reads, and nothing checks the list.
- `lumen2 transform --incremental` is right every day with nothing listed:
  the names are part of the transform, the only place a transform can get
  them from, so changing them changes the program, and the state starts
  again. On a usual day it takes 0.68 s, as long as the dbt-style merge,
  and over the month 38 s, against 3 minutes for running the function
  again in C. Most of the 38 s is its two full runs, on day 0 and day 15,
  where Lumen 2 takes about three times as long as C.

**Limitations.** The file is read into memory, and the state holds a copy
of the last input and output, so a run needs room for both. A change to
the transform, the library, the compiler or the step budget starts again
from nothing. The state is trusted as the compiled transforms beside it
are: its copy of the input is not checked against a hash when it is read
back.

---

[Back to the Lumen 2 README](../README.md)
