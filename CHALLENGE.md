# The Lumen challenge

This repository is a worked answer to one hard, open-ended coding task. This
file turns the task into a repeatable comparison: give the same brief to any
model or coding agent, then score its result automatically against the
reference implementation.

Nothing here assumes how any particular model will do. The point is to
measure it.

## The brief

Give the agent an empty repository containing only [`SPEC.md`](SPEC.md) and
the prelude source ([`src/prelude.js`](src/prelude.js)), and this prompt:

> Implement the Lumen language described in SPEC.md as a compiler to
> WebAssembly, in JavaScript for Node.js 22, with no dependencies.
>
> - Encode the `.wasm` binary yourself. Do not use wabt, Binaryen, LLVM,
>   parser generators or any other library.
> - Infer types as specified and reject ill-typed programs, non-exhaustive
>   matches and refutable `let` patterns at compile time, with useful
>   messages.
> - Compiled programs must manage memory with a garbage collector that you
>   write, running inside the WebAssembly module. Programs that allocate far
>   more than they keep alive must run in bounded memory.
> - Tail calls must not grow the stack.
> - Provide a CLI where `node <your-cli> <file.lm>` compiles and runs a
>   program, following the output and exit-status protocol at the end of
>   SPEC.md.
> - Show that your implementation is correct.

## Scoring

### 1. Automatic: agreement with the reference

```sh
node challenge/score.js -- node /path/to/their/cli.js
```

This runs about 340 programs: the 11 examples in `examples/`, 29 probes
of specific corners of the spec (`challenge/probes.js`), and 300 programs
from the random program generator. Each program's stdout must match the
reference byte for byte, and runtime errors and compile-time rejections must
match too. Use `--fuzz 2000` for a deeper run and `--seed N` to draw fresh
programs, so an implementation cannot be tuned to a fixed test set.

The reference implementation scores 340/340, and so does its independent
tree-walking interpreter (`node bin/lumen.js run --interp`). That second
result shows the expected outputs depend only on the spec, not on details of
the reference compiler.

### 2. Structural: is it really a compiler?

The automatic score can be passed by an interpreter. Check these by reading
the code or running it:

| Requirement | How to check |
| --- | --- |
| Emits real WebAssembly | The CLI produces a module that `WebAssembly.validate` accepts, and the program runs inside it |
| No toolchain dependencies | `package.json` and imports |
| Garbage collector inside the module | `examples/gc_torture.lm` allocates over 100 MB. Run it with Node's memory capped or the wasm memory maximum lowered, and it must still finish |
| Constant-space tail calls | the "tail calls" probes run a million iterations |
| Diagnostics | errors in `examples/type_error.lm` and `examples/missing_case.lm` point at the right expression and name the missing pattern |

### 3. Process

Record these alongside the scores:

- Wall-clock time and the number of human interventions needed.
- Whether the agent verified its own work: tests it wrote, bugs it found and
  fixed by itself, and whether its tests could catch planted bugs. You can
  adapt `fuzz/mutants.js` to plant bugs in another implementation.
- Whether its claims about its own result were accurate when checked.

## Why this task

It is large but fully specified, and its correctness is objective. It also
rewards the abilities that matter for long, autonomous coding work:

- **Breadth.** Parsing, type theory (Hindley–Milner, Maranget's
  exhaustiveness algorithm), compiler IRs, a binary format, and memory
  management, all in one program.
- **Global invariants.** A copying garbage collector is correct only if every
  live pointer is visible at every allocation, across code generation and the
  runtime. One missed root corrupts memory silently and fails much later,
  somewhere else.
- **No scaffolding.** No assembler, compiler framework or GC library. Every
  byte of the module comes from the agent's own code.
- **Self-verification.** A plausible-looking compiler is easy to write. A
  correct one requires building the tools to prove it, such as an
  independent oracle, a stress mode for the collector, and a generator of
  random programs.
