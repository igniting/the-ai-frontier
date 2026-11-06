// Edit distance in C: the same dynamic programming over two rows.
#include <stdio.h>
#include <stdlib.h>
static void gen(long long *a, int n, long long x) {
  for (int i = 0; i < n; i++) { x = (x * 1103515245 + 12345) % 2147483648LL; a[i] = (x / 65536) % 4; }
}
static long long min3(long long a, long long b, long long c) { return a < b ? (a < c ? a : c) : (b < c ? b : c); }
int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 1000;
  long long *s = malloc(n * sizeof(long long)), *t = malloc(n * sizeof(long long));
  long long *prev = malloc((n + 1) * sizeof(long long)), *cur = malloc((n + 1) * sizeof(long long));
  gen(s, n, 1); gen(t, n, 2);
  for (int j = 0; j <= n; j++) prev[j] = j;
  for (int i = 1; i <= n; i++) {
    cur[0] = i;
    for (int j = 1; j <= n; j++) cur[j] = min3(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] == t[j - 1] ? 0 : 1));
    long long *tmp = prev; prev = cur; cur = tmp;
  }
  printf("edit distance %lld\n", prev[n]);
  return 0;
}
