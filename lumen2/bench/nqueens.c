// N-queens in C: the same search, with the placed queens in a mutable array
// (overwritten on backtracking, so nothing is allocated).
#include <stdio.h>
#include <stdlib.h>
static int q[32];
static int safe(int row, int col) {
  for (int i = row - 1, d = 1; i >= 0; i--, d++) if (q[i] == col || q[i] == col + d || q[i] == col - d) return 0;
  return 1;
}
static long long solve(int n, int row) {
  if (row == n) return 1;
  long long acc = 0;
  for (int col = 0; col < n; col++) if (safe(row, col)) { q[row] = col; acc += solve(n, row + 1); }
  return acc;
}
int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 8;
  printf("%lld solutions for %d queens\n", solve(n, 0), n);
  return 0;
}
