# The Lumen 2 language

This document defines Lumen 2. The reference interpreter (`src/interp.js`)
is the executable form of the dynamic semantics. Where this text and the
interpreter disagree, that is a bug in one of them.

A Lumen 2 program is a set of type and function declarations with a `main`
function. Programs are pure except for two *effects* that types track:
`io` (reading input, printing) and `fail` (an operation that can stop the
program with an error). The checker infers every type and effect. An
annotation is a claim that the checker verifies, not a hint it trusts.

## 1. Lexical structure

- **Comments.** `//` to the end of the line, and `/* ... */`, which nest.
- **Identifiers.** `[A-Za-z_][A-Za-z0-9_]*`. Names that start with an
  upper-case letter are types and constructors. All other names are
  variables, functions and type variables. `_` alone is the wildcard pattern.
- **Keywords.** `fn let if else match type true false`.
- **Integer literals.** Decimal digits with optional `_` separators, such as
  `1_000_000`. The value must fit in a signed 64-bit integer.
  `-9223372036854775808` is a single literal: a `-` directly before an
  integer literal is folded into it.
- **String literals.** Between `"` quotes, on one line. The escapes are
  `\n \t \r \\ \" \' \0` and `\xHH`. A string is a sequence of bytes: other
  characters stand for their UTF-8 encoding, and `\xHH` is the single byte
  `HH`.
- **Operators and punctuation.** `|> -> => == != <= >= && || ++ ..` and
  `( ) { } [ ] , ; : < > + - * / % ! = |`.

## 2. Types

| Type | Values |
| --- | --- |
| `Int` | 64-bit two's-complement integers |
| `Bool` | `true`, `false` |
| `String` | immutable byte strings, at most 2^24 - 1 bytes |
| `()` | the unit value `()` |
| `(T1, T2, ...)` | tuples of two or more values |
| `Array<T>` | arrays with value semantics (§7.3), at most 2^24 - 1 elements |
| `fn(T1, ...) -> R ! E` | functions, with effect row `E` |
| `Name<T1, ...>` | user-declared algebraic data types |

The prelude declares three algebraic types:

```
type Option<a> { None, Some(a) }
type Result<a, e> { Ok(a), Err(e) }
type List<a> { Nil, Cons(a, List<a>) }
```

A type declaration lists constructors, each with zero or more field types.
It may be recursive and may take type parameters:

```
type Tree<a> { Leaf, Node(Tree<a>, a, Tree<a>) }
```

Type and constructor names are global. Defining a type or constructor twice
is an error, as is redefining a built-in type.

**Comparable types.** `==`, `!=`, `<`, `<=`, `>`, `>=` and the prelude
functions built on them (`sort`, `contains`, `min`, `max`) need a
*comparable* type: one with no function type anywhere inside it. Comparing
values that contain functions is a compile-time error. A function that
compares values of a type variable `a` has the constraint `where a: Cmp` in
its signature, and every use of it must instantiate `a` with a comparable
type.

## 3. Effects

An effect row is a set of labels drawn from `io` and `fail`, optionally
ending in an effect variable that stands for "whatever else":

| Written | Meaning |
| --- | --- |
| `! {}` | pure: no effects |
| `! io` | may perform io |
| `! {io, fail}` | may perform io and may fail |
| `! e` | performs exactly the effects `e` (an effect variable) |
| `! {io \| e}` | performs io, plus the effects `e` |

A function type with no `!` in an annotation is pure.

**Inference.** The effects of a function body are the union of the effects
of the operations it performs. These are:

- calls to builtins that print or read (`io`);
- the operations that can fail (`fail`): `/` and `%` (division by zero),
  `char_code_at`, `array_make`, `array_get` and `array_set` (index out of
  bounds), and `panic`;
- calls to functions and closures, which perform the callee's effects.

Higher-order functions are *effect-polymorphic*. The prelude's `map` has type

```
map : fn(List<a>, fn(a) -> b ! e) -> List<b> ! e
```

so `map(xs, |x| x + 1)` is pure and `map(xs, |x| { println("hi"); x })`
performs `io`.

**Claims.** An annotation `-> T ! E` on a function is checked. If the body
can perform an effect that `E` does not allow, the checker reports the
operation responsible, for example:

```
error: `/` (division by zero) can fail, but `average` is declared without `fail`
```

A closure passed where a function type is expected must not perform more
effects than that type allows.

**Untracked failures.** Three runtime errors can happen in pure code and are
deliberately not tracked: `integer overflow`, `out of memory` and
`string too long`. Tracking them would put `fail` on nearly every function.
They are the analogue of running out of stack in other languages. `main` may
perform any effect.

## 4. Declarations and expressions

```
program   := (typedecl | fndecl)*
typedecl  := "type" Upper ("<" lower ("," lower)* ">")? "{" ctor ("," ctor)* ","? "}"
ctor      := Upper ("(" type ("," type)* ")")?
fndecl    := "fn" lower "(" (param ("," param)*)? ")" ("->" type)? effect? block
param     := lower (":" type)?
effect    := "!" ( "{" (label ("," label)*)? ("|" lower)? "}" | label | lower )
block     := "{" stmt* expr? "}"
stmt      := "let" pattern (":" type)? "=" expr ";"
           | fndecl                         -- a local function, may call itself
           | expr ";"
           | (if | match | block)           -- no ";" needed after these
```

Expressions, from loosest to tightest binding:

| Level | Forms |
| --- | --- |
| pipe | `e \|> f(a, b)` means `f(e, a, b)`; `e \|> f` means `f(e)` |
| or | `a \|\| b` (short-circuit) |
| and | `a && b` (short-circuit) |
| comparison | `== != < <= > >=`; these do not chain: `a < b < c` is an error |
| concatenation | `a ++ b` on Strings, right-associative |
| additive | `+ -`, left-associative |
| multiplicative | `* / %`, left-associative |
| unary | `-e`, `!e` |
| postfix | calls `f(a, b)` |

Primary expressions are: literals; variables; constructors `Some(x)` or
`None` (a constructor with fields can also be used as a function value);
`()`; parenthesized expressions; tuples `(a, b)`; list literals
`[a, b, c]` and `[a, b, ..rest]`, which build `Cons` and `Nil`; blocks;
`if c { ... } else { ... }` (with no `else`, the value is `()`);
`match e { pattern (if guard)? -> expr, ... }`; and lambdas `|x, y| expr`
(`|| expr` takes no arguments).

**Patterns.** `_`, a variable, an integer, string or Boolean literal, `()`,
a tuple `(p1, p2)`, a constructor `Some(p)`, and list patterns `[]`,
`[p1, p2]` (exactly two elements), `[p1, ..rest]` and `[p1, ..]`.

**Scoping.** Top-level functions are visible everywhere, including before
their definition and from each other (mutual recursion). A user function
with the name of a prelude function hides it within the user's program.
Local names are lexically scoped and may shadow earlier ones.

## 5. Static semantics

Lumen 2 uses Hindley–Milner inference with row-polymorphic effects.

- Top-level functions are grouped into strongly connected components of the
  call graph. Each component is inferred together and then generalized, so
  top-level functions are polymorphic in types and effects. Local bindings,
  lambdas and local functions are monomorphic.
- Parameter and return annotations, and `let` annotations, are unified with
  the inferred types. Type variables in annotations are scoped to the
  function.
- **Exhaustiveness.** Every `match` must cover every value of its
  scrutinee's type. The checker uses Maranget's usefulness algorithm. When a
  match is not exhaustive, the error shows a value that no arm handles, such
  as ``non-exhaustive match: `[_, _, ..]` is not covered``. Arms with guards
  do not count towards coverage. An arm that can never match is a warning.
- **Refutable lets.** The pattern of a `let` must be irrefutable, by the
  same check.
- **Comparisons** need a comparable type (§2).
- The program must have a function `main` with no parameters.

## 6. Dynamic semantics

- **Strict, left to right.** Arguments are evaluated before the call, from
  left to right, after the function expression. The operands of a binary
  operator are evaluated left then right, except for `&&` and `||`, which
  skip their right operand when the left decides the result.
- **Tail calls** run in constant stack space, both direct and through
  closures.
- **Integers.** `+ - *` and unary `-` produce the exact result, or stop with
  `integer overflow` when it does not fit in 64 bits. `/` truncates towards
  zero. `%` takes the sign of its left operand. Both stop with
  `division by zero` when the divisor is 0. `-9223372036854775808 / -1`
  stops with `integer overflow`.
- **Ordering** is structural. Integers compare numerically, `false < true`,
  and strings compare by bytes (lexicographic, with a proper prefix first).
  Tuples and constructor fields compare left to right. Constructors of
  different kinds compare by their order in the type declaration: `None <
  Some(_)`, and `[] < [x, ..]`. Arrays compare by length first, then
  element by element. Comparing long lists takes constant stack.
- **Runtime errors.** A runtime error stops the program; the output printed
  so far is kept. The messages are `integer overflow`, `division by zero`,
  `index out of bounds`, `panic: <message>`, `out of memory`,
  `string too long` and `stack overflow`. How deep non-tail recursion can
  go before `stack overflow` is up to the implementation: the interpreter
  allows 10,000 nested calls, and compiled code allows as many as the
  WebAssembly engine's stack holds.

## 7. Builtins

### 7.1 Input and output

| Builtin | Type | Behaviour |
| --- | --- | --- |
| `print(s)` | `fn(String) -> () ! io` | writes the bytes of `s` |
| `println(s)` | `fn(String) -> () ! io` | writes `s` and a newline |
| `read_input()` | `fn() -> String ! io` | all of standard input, as bytes |
| `panic(s)` | `fn(String) -> a ! fail` | stops with `panic: s` |

### 7.2 Strings

| Builtin | Type | Behaviour |
| --- | --- | --- |
| `a ++ b` | `String, String -> String` | concatenation; `string too long` past 2^24 - 1 bytes |
| `int_to_string(n)` | `fn(Int) -> String` | decimal, with `-` for negatives |
| `string_length(s)` | `fn(String) -> Int` | number of bytes |
| `substring(s, i, j)` | `fn(String, Int, Int) -> String` | bytes `i` to `j - 1`, after clamping `i` to `[0, len]` and `j` to `[i, len]`; never fails |
| `char_code_at(s, i)` | `fn(String, Int) -> Int ! fail` | the byte at `i` (0 to 255), or `index out of bounds` |
| `char_from_code(n)` | `fn(Int) -> String` | the one-byte string holding `n` mod 256 |

### 7.3 Arrays

Arrays are values. `array_set` and `array_push` return a new array and never
change the one they are given. The implementation updates the array in place
when nothing else refers to it (§8). That is invisible to the program except
in its speed.

| Builtin | Type | Behaviour |
| --- | --- | --- |
| `array_make(n, x)` | `fn(Int, a) -> Array<a> ! fail` | `n` copies of `x`; `index out of bounds` if `n < 0`, `out of memory` if `n > 2^24 - 1` |
| `array_empty()` | `fn() -> Array<a>` | the empty array |
| `array_length(a)` | `fn(Array<a>) -> Int` | number of elements |
| `array_get(a, i)` | `fn(Array<a>, Int) -> a ! fail` | element `i`, or `index out of bounds` |
| `array_set(a, i, x)` | `fn(Array<a>, Int, a) -> Array<a> ! fail` | `a` with element `i` replaced by `x`, or `index out of bounds` |
| `array_push(a, x)` | `fn(Array<a>, a) -> Array<a>` | `a` with `x` added at the end; `out of memory` past 2^24 - 1 elements |

### 7.4 The prelude

The prelude is ordinary Lumen 2 source (`src/prelude.js`), checked with the
program: `fold rev_append reverse append map filter flat_map concat each
length sum is_empty range any all contains find head nth take drop zip min
max abs unwrap_or map_option sort_by sort join show_list repeat_string
array_from_list array_to_list`. Their types are inferred like any other
function's. `lumen2 check` prints them for a program that uses them.

## 8. Implementation guarantees

These properties of the compiler are not visible to a program's output, but
the test suite checks them.

- **No garbage collector, no leaks.** Memory is managed by reference counting
  with Perceus-style precise insertion of increments and decrements. Every
  object is freed as soon as it becomes unreachable, at the latest when the
  variable that holds the last reference is last used. Values are immutable,
  so there are no cycles. A program that finishes has freed every object.
- **In-place updates of unique values.** `array_set` and `array_push` write
  in place when the array is not shared. When a match arm takes apart a
  constructor that nothing else refers to and builds one of the same size,
  the new value reuses the old cell (Perceus reuse). So `reverse` of a list
  that is not used again, or inserting into a tree held only once, allocates
  nothing new.
- **Constant stack** for tail calls, for freeing long lists and for comparing
  long lists.

## 9. Conformance

The compiler is checked against the interpreter by differential fuzzing.
Random well-typed programs are run by the interpreter and by the compiled
WebAssembly in three modes: normal; paranoid, where freed memory is never
reused and any access to a freed object stops the program; and without
reuse. All four runs must agree on the output and on the error, and every
run that finishes must have freed every object it allocated. Planted bugs
in the compiler (`test/fuzz.js`, `MUTANTS`) check that this harness catches
the mistakes it is meant to catch.
