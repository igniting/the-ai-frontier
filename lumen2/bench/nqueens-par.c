// N-queens in C on threads (OpenMP): the same search as nqueens.c, split into
// a task for each way to place the first two queens, as in nqueens-par.lm.
#include <stdio.h>
#include <stdlib.h>
static int safe(const int *q, int row, int col) {
  for (int i = row - 1, d = 1; i >= 0; i--, d++) if (q[i] == col || q[i] == col + d || q[i] == col - d) return 0;
  return 1;
}
static long long solve(int *q, int n, int row) {
  if (row == n) return 1;
  long long acc = 0;
  for (int col = 0; col < n; col++) if (safe(q, row, col)) { q[row] = col; acc += solve(q, n, row + 1); }
  return acc;
}
int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 8;
  long long total = 0;
  if (n < 2) { int q[32]; total = solve(q, n, 0); }
  else {
    #pragma omp parallel for schedule(dynamic) reduction(+:total)
    for (int t = 0; t < n * n; t++) {
      int q[32] = { t / n, t % n };
      if (safe(q, 1, q[1])) total += solve(q, n, 2);
    }
  }
  printf("%lld solutions for %d queens\n", total, n);
  return 0;
}
