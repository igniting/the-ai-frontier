// The prelude, written in Lumen 2 and checked like any other code. Every
// higher-order function here is effect-polymorphic: `map` performs exactly
// the effects of the function it is given.

export const PRELUDE = `
type Option<a> { None, Some(a) }
type Result<a, e> { Ok(a), Err(e) }
type List<a> { Nil, Cons(a, List<a>) }

fn fold(xs, acc, f) {
  match xs { [] -> acc, [x, ..rest] -> fold(rest, f(acc, x), f) }
}
fn rev_append(xs, ys) {
  match xs { [] -> ys, [x, ..rest] -> rev_append(rest, [x, ..ys]) }
}
fn reverse(xs) { rev_append(xs, []) }
fn append(xs, ys) { rev_append(reverse(xs), ys) }
fn map(xs, f) { reverse(fold(xs, [], |acc, x| [f(x), ..acc])) }
fn filter(xs, keep) { reverse(fold(xs, [], |acc, x| if keep(x) { [x, ..acc] } else { acc })) }
fn flat_map(xs, f) { reverse(fold(xs, [], |acc, x| rev_append(f(x), acc))) }
fn concat(xss) { flat_map(xss, |xs| xs) }
fn each(xs, f) {
  match xs { [] -> (), [x, ..rest] -> { f(x); each(rest, f) } }
}
fn length(xs) { fold(xs, 0, |n, _| n + 1) }
fn sum(xs) { fold(xs, 0, |a, x| a + x) }
fn is_empty(xs) { match xs { [] -> true, _ -> false } }
fn range(lo, hi) {
  fn go(i, acc) { if i < lo { acc } else { go(i - 1, [i, ..acc]) } }
  go(hi - 1, [])
}
fn any(xs, p) { match xs { [] -> false, [x, ..rest] -> if p(x) { true } else { any(rest, p) } } }
fn all(xs, p) { match xs { [] -> true, [x, ..rest] -> if p(x) { all(rest, p) } else { false } } }
fn contains(xs, y) { any(xs, |x| x == y) }
fn find(xs, p) { match xs { [] -> None, [x, ..rest] -> if p(x) { Some(x) } else { find(rest, p) } } }
fn head(xs) { match xs { [] -> None, [x, .._] -> Some(x) } }
fn nth(xs, n) { match xs { [] -> None, [x, ..rest] -> if n == 0 { Some(x) } else { nth(rest, n - 1) } } }
fn take(xs, n) {
  fn go(xs, n, acc) { match xs { [] -> reverse(acc), [x, ..rest] -> if n <= 0 { reverse(acc) } else { go(rest, n - 1, [x, ..acc]) } } }
  go(xs, n, [])
}
fn drop(xs, n) { match xs { [] -> [], [_, ..rest] -> if n <= 0 { xs } else { drop(rest, n - 1) } } }
fn zip(xs, ys) {
  fn go(xs, ys, acc) {
    match (xs, ys) { ([x, ..xr], [y, ..yr]) -> go(xr, yr, [(x, y), ..acc]), _ -> reverse(acc) }
  }
  go(xs, ys, [])
}
fn min(a, b) { if a <= b { a } else { b } }
fn max(a, b) { if a >= b { a } else { b } }
fn abs(n) { if n < 0 { 0 - n } else { n } }
fn unwrap_or(o, default) { match o { Some(x) -> x, None -> default } }
fn map_option(o, f) { match o { Some(x) -> Some(f(x)), None -> None } }
fn sort_by(xs, less) {
  fn merge(xs, ys, acc) {
    match (xs, ys) {
      ([], _) -> rev_append(acc, ys),
      (_, []) -> rev_append(acc, xs),
      ([x, ..xr], [y, ..yr]) -> if less(y, x) { merge(xs, yr, [y, ..acc]) } else { merge(xr, ys, [x, ..acc]) },
    }
  }
  fn split(xs, l, r) { match xs { [] -> (l, r), [x, ..rest] -> split(rest, r, [x, ..l]) } }
  fn go(xs) {
    match xs {
      [] -> [],
      [x] -> [x],
      _ -> { let (l, r) = split(xs, [], []); merge(go(l), go(r), []) },
    }
  }
  go(xs)
}
fn sort(xs) { sort_by(xs, |a, b| a < b) }
fn join(xs, sep) {
  match xs { [] -> "", [x] -> x, [x, ..rest] -> x ++ sep ++ join(rest, sep) }
}
fn show_list(xs, show) { "[" ++ join(map(xs, show), ", ") ++ "]" }
fn repeat_string(s, n) { if n <= 0 { "" } else { s ++ repeat_string(s, n - 1) } }
fn array_from_list(xs) {
  match xs {
    [] -> array_empty(),
    [x, .._] -> { fn fill(a, xs, i) { match xs { [] -> a, [y, ..rest] -> fill(array_set(a, i, y), rest, i + 1) } } fill(array_make(length(xs), x), xs, 0) },
  }
}
fn array_to_list(a) {
  fn go(i, acc) { if i < 0 { acc } else { go(i - 1, [array_get(a, i), ..acc]) } }
  go(array_length(a) - 1, [])
}
`;
