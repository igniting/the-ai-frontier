// The Lumen standard prelude, written in Lumen. It is type-checked together
// with every program; unused functions are removed by dead-code elimination
// before code generation. List functions are tail-recursive (accumulate and
// reverse) so they work on lists with millions of elements.

export const PRELUDE = `
type Option<a> { None, Some(a) }
type Result<a, e> { Ok(a), Err(e) }
type List<a> { Nil, Cons(a, List<a>) }

// ----------------------------------------------------------------- lists --

fn fold(xs, acc, f) {
  match xs {
    [] -> acc,
    [x, ..rest] -> fold(rest, f(acc, x), f),
  }
}

fn rev_append(xs, ys) {
  match xs {
    [] -> ys,
    [x, ..rest] -> rev_append(rest, [x, ..ys]),
  }
}

fn reverse(xs) { rev_append(xs, []) }
fn append(xs, ys) { rev_append(reverse(xs), ys) }
fn fold_right(xs, acc, f) { fold(reverse(xs), acc, |acc, x| f(x, acc)) }
fn map(xs, f) { reverse(fold(xs, [], |acc, x| [f(x), ..acc])) }
fn filter(xs, keep) { reverse(fold(xs, [], |acc, x| if keep(x) { [x, ..acc] } else { acc })) }
fn flatten(xss) { fold_right(xss, [], |xs, acc| append(xs, acc)) }
fn flat_map(xs, f) { flatten(map(xs, f)) }
fn length(xs) { fold(xs, 0, |n, _| n + 1) }
fn sum(xs) { fold(xs, 0, |a, b| a + b) }
fn is_empty(xs) { match xs { [] -> true, _ -> false } }
fn each(xs, f) { fold(xs, (), |_, x| f(x)) }

fn range(lo, hi) {
  fn go(i, acc) { if i < lo { acc } else { go(i - 1, [i, ..acc]) } }
  go(hi - 1, [])
}

fn any(xs, p) {
  match xs {
    [] -> false,
    [x, ..rest] -> p(x) || any(rest, p),
  }
}

fn all(xs, p) {
  match xs {
    [] -> true,
    [x, ..rest] -> p(x) && all(rest, p),
  }
}

fn contains(xs, y) { any(xs, |x| x == y) }

fn find(xs, p) {
  match xs {
    [] -> None,
    [x, ..rest] -> if p(x) { Some(x) } else { find(rest, p) },
  }
}

fn head(xs) { match xs { [] -> None, [x, .._] -> Some(x) } }

fn nth(xs, n) {
  match xs {
    [] -> None,
    [x, ..rest] -> if n == 0 { Some(x) } else { nth(rest, n - 1) },
  }
}

fn take(xs, n) {
  fn go(xs, n, acc) {
    match xs {
      [x, ..rest] if n > 0 -> go(rest, n - 1, [x, ..acc]),
      _ -> reverse(acc),
    }
  }
  go(xs, n, [])
}

fn drop(xs, n) {
  match xs {
    [_, ..rest] if n > 0 -> drop(rest, n - 1),
    _ -> xs,
  }
}

fn zip(xs, ys) {
  fn go(xs, ys, acc) {
    match (xs, ys) {
      ([x, ..xr], [y, ..yr]) -> go(xr, yr, [(x, y), ..acc]),
      _ -> reverse(acc),
    }
  }
  go(xs, ys, [])
}

fn repeat(x, n) {
  fn go(n, acc) { if n <= 0 { acc } else { go(n - 1, [x, ..acc]) } }
  go(n, [])
}

// Stable merge sort, parameterized by a "less than or equal" function.
fn sort_by(xs, le) {
  fn merge(xs, ys, acc) {
    match (xs, ys) {
      ([], _) -> rev_append(acc, ys),
      (_, []) -> rev_append(acc, xs),
      ([x, ..xr], [y, ..yr]) ->
        if le(x, y) { merge(xr, ys, [x, ..acc]) } else { merge(xs, yr, [y, ..acc]) },
    }
  }
  let n = length(xs);
  if n <= 1 {
    xs
  } else {
    let half = n / 2;
    merge(sort_by(take(xs, half), le), sort_by(drop(xs, half), le), [])
  }
}

// Sorts any type using Lumen's built-in structural ordering.
fn sort(xs) { sort_by(xs, |a, b| a <= b) }

// ---------------------------------------------------------------- numbers --

fn min(a, b) { if a <= b { a } else { b } }
fn max(a, b) { if a >= b { a } else { b } }
fn abs(n) { if n < 0 { -n } else { n } }

fn pow(base, exp) {
  fn go(b, e, acc) {
    if e == 0 { acc }
    else if e % 2 == 1 { go(b * b, e / 2, acc * b) }
    else { go(b * b, e / 2, acc) }
  }
  go(base, exp, 1)
}

// ---------------------------------------------------------------- options --

fn unwrap_or(opt, default) { match opt { Some(x) -> x, None -> default } }

fn map_option(opt, f) { match opt { Some(x) -> Some(f(x)), None -> None } }

// ---------------------------------------------------------------- strings --

fn join(xs, sep) {
  match xs {
    [] -> "",
    [x, ..rest] -> fold(rest, x, |acc, s| acc ++ sep ++ s),
  }
}

fn show_list(xs, show) { "[" ++ join(map(xs, show), ", ") ++ "]" }

fn chars(s) {
  fn go(i, acc) { if i < 0 { acc } else { go(i - 1, [char_from_code(char_code_at(s, i)), ..acc]) } }
  go(string_length(s) - 1, [])
}

fn repeat_string(s, n) {
  fn go(n, acc) { if n <= 0 { acc } else { go(n - 1, acc ++ s) } }
  go(n, "")
}

fn pad_left(s, width, fill) { repeat_string(fill, width - string_length(s)) ++ s }

fn parse_int(s) {
  let n = string_length(s);
  fn digits(i, acc) {
    if i == n { Some(acc) } else {
      let c = char_code_at(s, i);
      if c >= 48 && c <= 57 { digits(i + 1, acc * 10 + (c - 48)) } else { None }
    }
  }
  if n == 0 { None }
  else if char_code_at(s, 0) == 45 && n > 1 { map_option(digits(1, 0), |v| -v) }
  else { digits(0, 0) }
}

fn print_int(n) { println(int_to_string(n)) }
`;
