# The Lumen language

This is the complete reference for Lumen as implemented in `src/`. It is
precise enough to write an independent implementation, and
[`challenge/score.js`](challenge/score.js) checks such an implementation
against this one.

## Programs

A program is a sequence of top-level `type` and `fn` declarations, in any
order. Execution starts at `fn main()`, which takes no parameters; its
result is ignored. The [prelude](src/prelude.js) is implicitly part of every
program.

```
type Shape { Circle(Int), Rect(Int, Int) }

fn area(s) {
  match s {
    Circle(r) -> 3 * r * r,
    Rect(w, h) -> w * h,
  }
}

fn main() {
  [Circle(1), Rect(2, 3)] |> map(area) |> sum |> int_to_string |> println
}
```

## Lexical structure

- Whitespace separates tokens. Comments are `// …` to end of line and
  `/* … */`, which nest.
- Identifiers are `[A-Za-z_][A-Za-z0-9_]*`. Those starting with an uppercase
  letter name types and constructors; the rest name values. `_` alone is a
  wildcard pattern.
- Keywords: `fn let if else match type true false`.
- Integer literals are decimal digits, optionally separated by `_`
  (`1_000_000`). They must be at most 2³⁰ − 1; a literal written directly
  after unary minus may be 2³⁰, so `-1073741824` is valid.
- String literals are `"…"` with escapes `\n \t \r \\ \" \' \0 \xHH`. A
  string is a sequence of **bytes**: the UTF-8 encoding of the literal's
  characters, with `\xHH` contributing one raw byte.
- Operators and punctuation: `|> -> => == != <= >= && || ++ .. ( ) { } [ ] , ; : < > + - * / % ! = |`.

## Types

| Type | Values |
| --- | --- |
| `Int` | 31-bit two's-complement integers, −2³⁰ to 2³⁰ − 1 |
| `Bool` | `true`, `false` |
| `String` | immutable byte strings |
| `()` | the unit value `()` |
| `(T1, T2, …)` | tuples |
| `fn(T1, …) -> R` | functions of a fixed number of arguments (not curried) |
| `Name<T1, …>` | algebraic data types declared with `type` |

Type declarations: `type Name<a, b> { Ctor1, Ctor2(T, …), … }`. Type
parameters are lowercase. Constructors may be nullary. Types may be
recursive and mutually recursive.

### Type inference

Types are inferred with Hindley–Milner: no annotations are required, and
every binding gets its most general type. `let`-bound values and local
functions are generalized (the language has no mutation, so there is no value
restriction). Top-level functions may be used before they are defined; they
are type-checked in dependency order (strongly connected components of the
call graph), so a function is polymorphic for every function that does not
belong to its own recursive group. Recursion is monomorphic within a group.

Optional annotations: `fn f(x: Int, xs: List<a>) -> Bool { … }`,
`let x: Int = …;`, `|x: Int| …`. Lowercase names in annotations are type
variables, scoped to the declaration.

## Expressions

Lowest to highest precedence:

| Operator | Associativity | Operands |
| --- | --- | --- |
| `\|>` | left | `x \|> f(a, b)` means `f(x, a, b)`; `x \|> f` means `f(x)` |
| `\|\|` | left | `Bool`, short-circuit |
| `&&` | left | `Bool`, short-circuit |
| `== != < <= > >=` | none (cannot chain) | any type `a`, both sides the same type |
| `++` | right | `String` concatenation |
| `+ -` | left | `Int` |
| `* / %` | left | `Int` |
| unary `- !` | prefix | `Int` / `Bool` |
| call `f(args)` | postfix | |

Other expressions:

- Literals, variables, `()`, tuples `(a, b)`. A one-element tuple needs a
  trailing comma: `(a,)`.
- Constructor application `Some(x)`. A constructor or a built-in function
  used without arguments is a first-class function value (`map(xs, Some)`).
- Lists: `[a, b, c]` is `Cons(a, Cons(b, Cons(c, Nil)))`; `[a, ..rest]` is
  `Cons(a, rest)`. List syntax always refers to the prelude's `List`, even if
  the program defines its own `Cons` or `Nil`.
- Lambdas: `|x, y| expr`, `|| expr`, or `fn(x, y) { … }`. A `|…|` lambda's
  body extends as far right as possible.
- Blocks: `{ stmt; stmt; expr }`. Statements are `let pattern = expr;`,
  `expr;`, or a local `fn name(params) { … }` (which may call itself
  recursively). A block's value is its final expression, or `()` if there is
  none. An `if`, `match` or block statement may omit its `;`.
- `if cond { … } else { … }`, with `else if` chains. Without `else`, the
  `then` branch must have type `()`.
- `match scrutinee { pattern -> expr, pattern if guard -> expr, … }`. Commas
  between arms are optional after an arm whose body is a block, `if` or `match`.

### Patterns

`_`, variables, integer literals (including negative ones), string literals,
`true`, `false`, `()`, tuples, constructors `C` / `C(p, …)`, and list patterns
`[]`, `[p, q]`, `[p, ..rest]`, `[p, ..]`. A variable may appear only once in
a pattern.

Every `match` must be **exhaustive**: a non-exhaustive match is a compile
error that names an example of an unmatched value. Guarded arms do not count
toward exhaustiveness. Patterns in `let` must be irrefutable. Arms that can
never match produce a warning.

## Semantics

- **Evaluation order is strictly left to right**: the callee before the
  arguments, arguments in order, the left operand before the right. Tuple and
  constructor fields are evaluated in order.
- **Integers** wrap around modulo 2³¹. `/` truncates toward zero; `%` takes
  the sign of the dividend. Division or remainder by zero is a runtime error.
  `-1073741824 / -1` wraps to `-1073741824`.
- **Equality and ordering are structural**, on values of the same type:
  - `Int` numerically, `Bool` with `false < true`, `()` equals itself;
  - strings by bytes, lexicographically, where a proper prefix is smaller;
  - tuples field by field, left to right;
  - constructors first by their declaration index, then field by field.
  Comparison stops at the first difference. Reaching a function value during
  a comparison is the runtime error `cannot compare functions`, even if the
  two functions are the same; `(1, f) == (2, f)` is `false` with no error.
- **Tail calls** do not grow the stack, including calls through closures and
  mutual recursion. Deep non-tail recursion may fail with `stack overflow`.
- Strings are immutable; `++` concatenates bytes. A string holds at most
  2^23 − 1 bytes: a `++` (or `read_input()`) that would produce a longer one
  is the runtime error `string too long`.

## Built-in functions

| Function | Type | Behaviour |
| --- | --- | --- |
| `print(s)` | `fn(String) -> ()` | writes the bytes of `s` to standard output |
| `println(s)` | `fn(String) -> ()` | writes `s` and then `\n` |
| `int_to_string(n)` | `fn(Int) -> String` | decimal, with a leading `-` if negative |
| `string_length(s)` | `fn(String) -> Int` | number of bytes |
| `substring(s, start, end)` | `fn(String, Int, Int) -> String` | bytes `[a, b)` where `a = clamp(start, 0, len)` and `b = clamp(end, a, len)` |
| `char_code_at(s, i)` | `fn(String, Int) -> Int` | the byte at index `i` (0–255); `index out of bounds` if `i < 0` or `i >= len` |
| `char_from_code(c)` | `fn(Int) -> String` | the one-byte string containing byte `c & 255` |
| `panic(msg)` | `fn(String) -> a` | stops with the runtime error `panic: <msg>` |
| `read_input()` | `fn() -> String` | the program's input: bytes supplied by the host (`lumen run file.lm --input data.txt`), or `""` if there are none |

## The prelude

Written in Lumen, in [`src/prelude.js`](src/prelude.js). An implementation
may include it verbatim. It defines `Option<a> { None, Some(a) }`,
`Result<a, e> { Ok(a), Err(e) }`, `List<a> { Nil, Cons(a, List<a>) }` and:

`fold rev_append reverse append fold_right map filter flatten flat_map length
sum is_empty each range any all contains find head nth take drop zip repeat
sort_by sort min max abs pow unwrap_or map_option join show_list chars
repeat_string pad_left parse_int print_int`.

User definitions may reuse these names: a user `map` shadows the prelude's
`map` in user code, while prelude functions keep using their own.

## Runtime errors

A runtime error stops the program. Output written before the error is kept.
The messages are exactly:

`division by zero` · `cannot compare functions` · `index out of bounds` ·
`panic: <message>` · `string too long` · `stack overflow` · `out of memory`

The reference CLI (`node bin/lumen.js run file.lm`) writes program output to
standard output. On a runtime error it writes `runtime error: <message>` to
standard error and exits with status 1. On a compile error it writes
diagnostics to standard error, writes nothing to standard output, and exits
with status 1.
