# The Lumen 2 language

This document defines Lumen 2. The reference interpreter (`src/interp.js`)
is the executable form of the dynamic semantics, and the compiler
(`compiler/`, written in Lumen 2) of the static semantics: the errors, the
types and effects, and the proofs. Where this text and either of them
disagree, that is a bug in one of them.

A Lumen 2 program is a set of type, trait, impl, function and property
declarations, usually with a `main` function. Programs are pure except for
*effects* that types track: four capabilities (`input`, `output`, `clock`,
`random`) and `fail` (an operation that can stop the program with an error).
The checker infers every type and effect. An annotation is a claim that the
checker verifies, not a hint it trusts. A partial operation, such as
indexing an array, has the `fail` effect only when the checker cannot prove
that it succeeds.

## 1. Lexical structure

- **Comments.** `//` to the end of the line, and `/* ... */`, which nest.
- **Identifiers.** `[A-Za-z_][A-Za-z0-9_]*`. Names that start with an
  upper-case letter are types, constructors and traits. All other names are
  variables, functions and type variables. `_` alone is the wildcard pattern.
- **Keywords.** `fn let if else match type true false trait impl for where
  property`.
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
| `Array<T>` | arrays with value semantics (§10.3), at most 2^24 - 1 elements |
| `fn(T1, ...) -> R ! E` | functions, with effect row `E` |
| `Name<T1, ...>` | user-declared algebraic data types |
| `{v: T \| p}` | a refinement of `T` (§6), only in some annotations |

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

A type variable can carry trait constraints (§5). A function that compares
values of type `a` has `where a: Ord` in its signature; one that shows them
has `where a: Show`.

## 3. Effects and capabilities

An effect row is a set of labels, optionally ending in an effect variable
that stands for "whatever else". The labels are:

| Label | Performed by |
| --- | --- |
| `input` | `read_input`, `read_line` |
| `output` | `print`, `println` |
| `clock` | `clock_ms` |
| `random` | `random_int` |
| `fail` | `panic`, and partial operations not proved safe (§6) |

| Written | Meaning |
| --- | --- |
| `! {}` | pure: no effects |
| `! output` | may write output |
| `! {output, fail}` | may write output and may fail |
| `! io` | shorthand for `! {input, output, clock, random}` |
| `! e` | performs exactly the effects `e` (an effect variable) |
| `! {output \| e}` | writes output, plus the effects `e` |

A function type with no `!` in an annotation is pure.

**Inference.** The effects of a function body are the union of the effects
of the operations it performs, including calls to functions and closures,
which perform the callee's effects. Higher-order functions are
*effect-polymorphic*. The prelude's `map` has type

```
map : fn(List<a>, fn(a) -> b ! e) -> List<b> ! e
```

so `map(xs, |x| x + 1)` is pure and `map(xs, |x| { println("hi"); x })`
writes output.

**Claims.** An annotation `-> T ! E` on a function is checked. If the body
can perform an effect that `E` does not allow, the checker reports the
operation responsible:

```
error: `/` (division by zero) can fail, but `average` is declared without `fail`
```

A closure passed where a function type is expected must not perform more
effects than that type allows.

**Capabilities.** The four capabilities are granted to `main` by whoever
runs the program. `lumen2 run` grants `output`; `--allow input,clock,random`
(or `--allow all`) grants more. With a grant, `main` is checked as if it
were annotated with the granted capabilities plus `fail`, so a program that
would use an ungranted capability is rejected before it runs, at the call
responsible:

```
error: calling `roll` can use randomness, but `main` was not granted `random`
```

An annotated `main` may not claim a capability it was not granted. `fail`
is not a capability; it is always allowed in `main`.

**Untracked failures.** Three runtime errors can happen in pure code and are
deliberately not tracked: `integer overflow`, `out of memory` and
`string too long`. Tracking them would put `fail` on nearly every function.
They are the analogue of running out of stack in other languages.

## 4. Declarations and expressions

```
program   := (typedecl | fndecl | traitdecl | impldecl | property)*
typedecl  := "type" Upper ("<" lower ("," lower)* ">")? "{" ctor ("," ctor)* ","? "}"
ctor      := Upper ("(" type ("," type)* ")")?
fndecl    := "fn" lower "(" (param ("," param)*)? ")" ("->" type)? effect? block
param     := lower (":" type)?
effect    := "!" ( "{" (label ("," label)*)? ("|" lower)? "}" | label | lower )
traitdecl := "trait" Upper "{" ("fn" lower "(" param ("," param)* ")" ("->" type)? effect? ";"?)* "}"
impldecl  := "impl" Upper "for" type ("where" lower ":" Upper ("+" Upper)* ("," ...)*)? "{" fndecl* "}"
property  := "property" lower "(" (param ("," param)*)? ")" block
type      := ... | "{" lower ":" type "|" expr "}"      -- a refinement (§6)
block     := "{" stmt* expr? "}"
stmt      := "let" pattern (":" type)? "=" expr ";"
           | fndecl                         -- a local function
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

**Scoping.** Top-level functions, properties and trait methods are visible
everywhere, including before their definition, and top-level functions may
be mutually recursive. A local function can call itself and earlier local
functions. Names resolve in this order: local variables; the program's
functions and trait methods; the prelude's functions and trait methods;
builtins. So a program's own function hides a prelude function or method of
the same name. Local names are lexically scoped and may shadow earlier
ones.

## 5. Traits

A trait declares method signatures in terms of `Self`. The parameters need
types, and the first must be `Self`, whose value selects the implementation.
A signature may declare effects; without them the method is pure.

```
trait Area { fn area(x: Self) -> Int }
```

An impl gives the methods for one type *head*: a type name applied to
distinct type variables, or a tuple of distinct type variables.

```
impl Area for Shape { fn area(s) { match s { Sq(n) -> n * n, Rect(w, h) -> w * h } } }
impl Area for List<a> where a: Area { fn area(xs) { sum(map(xs, area)) } }
```

- A type has at most one impl of each trait, which must give every method.
- Each method is checked against the trait's signature, with `Self` the
  impl's type, including its effects: a method of a pure trait cannot print.
- A method must work for every instance of the impl's type variables, and
  may only rely on the constraints its `where` clause declares; the error
  names the missing constraint.
- A method's type is its signature with `Self` a type variable constrained
  by the trait. Using a method at a type with no impl is a type error, and a
  generic function that uses one is generalized with the constraint:
  `fn describe(x) { show(x) ++ "!" }` has type `fn(a) -> String where a: Show`.
- Methods are resolved at compile time. The compiled code calls the impl's
  function directly; there are no dictionaries and no dynamic dispatch.

Two traits are built in:

```
trait Ord { fn compare(a: Self, b: Self) -> Int }
trait Show { fn show(x: Self) -> String }
```

**`Ord`** orders values. Every type without functions in it is ordered
structurally (§9) unless the program gives it an `impl Ord`. The impl's
`compare` returns a negative number, zero or a positive number. It is then
used wherever the type is compared: by `==` (equal when `compare` returns
0), `<` and the other operators, by `sort`, and inside structural
comparisons of types that contain it, such as `List<Version>`.

**`Show`** turns values into text. The prelude implements it for `Int`,
`String` (in double quotes), `Bool`, `()`, lists (`[1, 2]`), arrays
(`#[1, 2]`) and tuples of up to four elements. The checker derives an impl
for every other type whose fields are all showable, unless the program
writes one, for example `Node(Leaf, 1, Leaf)`. Only a type declared in the
program can have its own `impl Ord` or `impl Show`.

## 6. Refinement types and proved operations

A refinement `{v: T | p}` is the type `T` restricted to values `v` for which
the predicate `p` holds. It may annotate the parameters and the result of
a named function, and a `let` that binds one variable. `T` must be `Int`,
`Array` or `String`.

```
fn get(a: Array<Int>, i: {i: Int | 0 <= i && i < array_length(a)}) -> Int { array_get(a, i) }
fn clamp_index(i: Int, n: {n: Int | n > 0}) -> {r: Int | 0 <= r && r < n} { ... }
```

**Predicates** use integer and Boolean constants; variables (the refined
value, the function's parameters and, in a local function, enclosing
variables); `+`, `-`, unary `-`, and `*` with a constant on one side;
comparisons of integers; `&&`, `||` and `!`; and `array_length(x)` and
`string_length(x)` of a variable. Integers in predicates are mathematical
integers. This fragment is decidable, and the checker decides it.

**Partial operations** are `/` and `%` (the divisor must not be 0),
`array_get`, `array_set` and `char_code_at` (the index must be in bounds),
and `array_make` (the length must not be negative). Each one is a proof
obligation. When it is proved, the operation has no `fail` effect.
Otherwise it keeps `fail`; that is not an error unless an effect annotation
forbids it, and then the message gives a counterexample:

```
error: calling `array_get` can fail, but `f` is declared without `fail`
  = note: could not prove that the index is in bounds: for example when array_length(a) = 3, i = 3
```

**Refinements** are proved, not checked at run time. A call must prove each
refined parameter, a function must prove its refined result at its end, and
a refined `let` must prove its value. Failing to prove one is a compile
error with a counterexample. Inside the function, refined parameters are
assumed; after a call, the callee's refined result is assumed. A function
with refined parameters can only be called directly, by name: a call
through a function value could not be checked. Lambda parameters cannot be
refined.

**Element refinements** describe every element of an array. In the
parameters and the result of a named function, the element type of an
`Array` may itself be a refinement, to any depth:

```
fn sum_at(a: Array<Int>, ix: Array<{k: Int | 0 <= k && k < array_length(a)}>, i: {i: Int | 0 <= i}, acc: Int) -> Int {
  if i < array_length(ix) { sum_at(a, ix, i + 1, acc + array_get(a, array_get(ix, i))) } else { acc }
}
fn total(rows: Array<{r: Array<{x: Int | 0 <= x && x < 10}> | array_length(r) >= 1}>) -> Int { ... }
```

The predicate may mention the function's other parameters (here `a`), so an
array of indices can be tied to the array they index. A caller must prove
the predicate for every element it could have put in the array, and the
function assumes it for every element it reads. The checker tracks what an
array's elements can be, as a set of possibilities, each holding under the
conditions of the path that produced it:
- `array_make(n, x)` has elements that are all `x`; `array_empty()` has none;
- `array_set(a, i, x)` and `array_push(a, x)` have the elements of `a`, or `x`;
- a parameter or a call's result with an element refinement has elements
  that satisfy it;
- after an `if` or `match` the elements are those of the branch that ran.

`array_get` of such an array returns a value that is one of the
possibilities (and, for nested refinements, its own elements are known the
same way). Element refinements cannot annotate a `let`. Arrays of other
element types, lists and strings carry no element facts.

**What the checker knows** on a path through a function:
- the integer values of variables, as linear terms;
- the lengths of arrays and strings, including through `array_set`,
  `array_push`, `array_make`, `array_empty`, `++` and literals;
- the conditions of enclosing `if`s (negated in `else`), `&&` and `||`;
- integer literal arms of a `match` (and their negation in later arms), and
  guards;
- refined parameters, and the refined results of functions called;
- the success of every partial operation already performed on the path:
  after `array_get(a, i)` returns, `i` is in bounds;
- the quotient and remainder of division by a constant `c >= 1`: `x / c` is
  the `q` with `x = c * q + r`, where `0 <= r < c` when `x >= 0` and
  `-c < r <= 0` otherwise, and `x % c` is that `r` (when `c` is a power of
  two, the quotient is given to the SAT solver as a shift circuit);
- the elements of arrays, as described under element refinements;
- after an `if` or `match`, what one of its branches learned: since one of
  them ran to its end, the disjunction of the facts each one added (its
  conditions, the refined results of its calls, its partial operations)
  holds afterwards.

Values never change, so a fact about a variable holds wherever the variable
is visible, including inside closures created on that path.

## 7. Properties

```
property reverse_twice(xs: List<Int>) { reverse(reverse(xs)) == xs }
```

A property states a law of the program. Its parameters need concrete types
without type variables or functions (refinements are allowed), its body
must be a `Bool`, and it may fail but have no other effect. A property is
also an ordinary function the program can call. A program made only of
properties needs no `main`.

`lumen2 test` checks each property on generated inputs (100 cases by
default, small inputs first, with integer edge cases such as 0, -1 and the
64-bit limits). A refined parameter's inputs are drawn until one satisfies
the refinement. A case fails when the property returns `false` or stops
with a runtime error. A failing case is shrunk to a minimal one and printed
as Lumen source, ready to paste into a program. Cases run in the reference
interpreter. Passing cases are replayed as one compiled program, and a
counterexample is replayed compiled; the compiled code must agree.

## 8. Static semantics

Lumen 2 uses Hindley–Milner inference with row-polymorphic effects and trait
constraints.

- Top-level functions are grouped into strongly connected components of the
  call graph. Each component is inferred together and then generalized, so
  top-level functions are polymorphic in types, effects and constraints.
  Local bindings, lambdas and local functions are monomorphic. Impl methods
  are checked after all functions, against their trait's signature.
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
- **Comparisons** need `Ord` (§5), which every type without functions has.
- **Partial operations and refinements** are proved as described in §6.
  Checking runs in three passes: types first, treating every partial
  operation as safe; then the proofs; then types and effects again, with
  only the proved operations safe.
- A program must have a function `main` with no parameters, unless it
  declares properties.

## 9. Dynamic semantics

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
- **Ordering** follows `Ord`. A type with an `impl Ord` is compared by its
  `compare`. Every other type is compared structurally: integers
  numerically, `false < true`, and strings by bytes (lexicographic, with a
  proper prefix first). Tuples and constructor fields compare left to
  right. Constructors of different kinds compare by their order in the type
  declaration: `None < Some(_)`, and `[] < [x, ..]`. Arrays compare by
  length first, then element by element. Comparing long lists takes
  constant stack.
- **Trait methods** run the impl selected by the type of their first
  argument.
- **Runtime errors.** A runtime error stops the program; the output printed
  so far is kept. The messages are `integer overflow`, `division by zero`,
  `index out of bounds`, `panic: <message>`, `out of memory`,
  `string too long` and `stack overflow`. How deep non-tail recursion can
  go before `stack overflow` is up to the implementation: the interpreter
  allows 10,000 nested calls, and compiled code allows as many as the
  WebAssembly engine's stack holds.
- **Proved facts are never false.** The interpreter re-checks every
  refinement and every operation proved safe as it runs. A failure would be
  a bug in the checker, not in the program, and is reported as
  `internal error: something the checker proved was false`.

## 10. Builtins

### 10.1 Input, output and the host

| Builtin | Type | Behaviour |
| --- | --- | --- |
| `print(s)` | `fn(String) -> () ! output` | writes the bytes of `s` |
| `println(s)` | `fn(String) -> () ! output` | writes `s` and a newline |
| `read_input()` | `fn() -> String ! input` | all of standard input, as bytes |
| `read_line()` | `fn() -> String ! input` | the next line of standard input, with its newline; `""` at the end |
| `clock_ms()` | `fn() -> Int ! clock` | the time in milliseconds |
| `random_int(lo, hi)` | `fn(Int, Int) -> Int ! random` | a number between `lo` and `hi` inclusive (in either order) |
| `panic(s)` | `fn(String) -> a ! fail` | stops with `panic: s` |

`read_line` keeps its own position, separate from `read_input`, which always
returns the whole input. Every line it returns before the end has at least
its newline, so `""` means the input is exhausted. A program that reads a
line at a time can process input longer than the longest string. Either
builtin stops with `string too long` if what it would return is longer
than 2^24 - 1 bytes.

The clock and the random numbers come from the host. A seeded host
(`lumen2 run --seed N`) makes `random_int` reproducible. In tests, a
simulated clock advances by one millisecond per reading.

### 10.2 Strings

| Builtin | Type | Behaviour |
| --- | --- | --- |
| `a ++ b` | `String, String -> String` | concatenation; `string too long` past 2^24 - 1 bytes |
| `int_to_string(n)` | `fn(Int) -> String` | decimal, with `-` for negatives |
| `string_length(s)` | `fn(String) -> Int` | number of bytes |
| `substring(s, i, j)` | `fn(String, Int, Int) -> String` | bytes `i` to `j - 1`, after clamping `i` to `[0, len]` and `j` to `[i, len]`; never fails |
| `char_code_at(s, i)` | `fn(String, Int) -> Int ! fail` | the byte at `i` (0 to 255), or `index out of bounds` |
| `char_from_code(n)` | `fn(Int) -> String` | the one-byte string holding `n` mod 256 |
| `concat_strings(xs)` | `fn(List<String>) -> String` | the strings joined, in linear time; `string too long` past 2^24 - 1 bytes |

### 10.3 Arrays

Arrays are values. `array_set` and `array_push` return a new array and never
change the one they are given. The implementation updates the array in place
when nothing else refers to it (§11). That is invisible to the program except
in its speed.

| Builtin | Type | Behaviour |
| --- | --- | --- |
| `array_make(n, x)` | `fn(Int, a) -> Array<a> ! fail` | `n` copies of `x`; `index out of bounds` if `n < 0`, `out of memory` if `n > 2^24 - 1` |
| `array_empty()` | `fn() -> Array<a>` | the empty array |
| `array_length(a)` | `fn(Array<a>) -> Int` | number of elements |
| `array_get(a, i)` | `fn(Array<a>, Int) -> a ! fail` | element `i`, or `index out of bounds` |
| `array_set(a, i, x)` | `fn(Array<a>, Int, a) -> Array<a> ! fail` | `a` with element `i` replaced by `x`, or `index out of bounds` |
| `array_push(a, x)` | `fn(Array<a>, a) -> Array<a>` | `a` with `x` added at the end; `out of memory` past 2^24 - 1 elements |

The `fail` in these types applies only at call sites the checker cannot
prove safe (§6).

### 10.4 The prelude

The prelude is ordinary Lumen 2 source (`src/prelude.js`, which the
compiler is built with), checked with the program. It declares the traits `Ord` and `Show` and the `Show` impls for
built-in types. Its functions are `fold rev_append reverse append map
filter flat_map concat each length sum is_empty range any all contains find
head nth take drop zip min max abs unwrap_or map_option sort_by sort
intersperse join show_list repeat_string array_from_list array_to_list`.
Their types are inferred like any other function's, and `lumen2 check`
prints them for a program that uses them. `array_to_list` is pure because a
refinement on its loop index proves every access in bounds.

## 11. Implementation guarantees

These properties of the compiler are not visible to a program's output, but
the compiler checks them, and so does the test suite.

- **No garbage collector, no leaks.** Memory is managed by reference counting
  with Perceus-style precise insertion of increments and decrements. Every
  object is freed as soon as it becomes unreachable, at the latest when the
  variable that holds the last reference is last used. Values are immutable,
  so there are no cycles. A program that finishes has freed every object.
- **Proved rewrite rules.** The code generator's output is rewritten with
  peephole rules found by a superoptimizer. Each rule is proved, for all
  inputs that satisfy its side conditions, by a SAT refutation that an
  independent checker validates; `superopt/verify.js` re-proves them.
- **In-place updates of unique values.** `array_set` and `array_push` write
  in place when the array is not shared. When a match arm takes apart a
  constructor that nothing else refers to and builds one of the same size,
  the new value reuses the old cell (Perceus reuse). So `reverse` of a list
  that is not used again, or inserting into a tree held only once, allocates
  nothing new.
- **Constant stack** for tail calls (including a call that is the right
  operand of `&&` or `||` in tail position), for freeing long lists and for
  comparing long lists.
- **Certified passes.** Every compile checks the compiler's own output with
  independent checkers, and refuses to produce code if one rejects it:
  - the monomorphic IR is type-checked instruction by instruction;
  - its reference counting is replayed along every path: no use after the
    last reference is released, no leak at a return, every reuse token used
    or freed exactly once;
  - every proof behind §6 is a DRUP refutation of a bit-blasted formula,
    checked by a RUP checker that shares no code with the SAT solver;
  - the WebAssembly engine validates the module.

  `lumen2 certify` reports these checks and writes the proofs in the
  standard DIMACS and DRUP formats, which external checkers such as
  drat-trim read.

## 12. Conformance

The compiler is checked against the interpreter by differential fuzzing.
Random well-typed programs are generated over lists, trees, options, tuples,
strings, arrays and closures. They use traits, refinements, guarded and
unguarded partial operations, and the clock and random capabilities, with a
seeded host. Each program is run by the interpreter and by the compiled
WebAssembly in three modes: normal; paranoid, where freed memory is never
reused and any access to a freed object stops the program; and without
reuse. All four runs must agree on the output and on the error, and every
run that finishes must have freed every object it allocated. Planted bugs
in the compiler, the verifier and the SAT solver (`test/fuzz.js`,
`MUTANTS`) check that this harness and the certificate checkers catch the
mistakes they are meant to catch.
