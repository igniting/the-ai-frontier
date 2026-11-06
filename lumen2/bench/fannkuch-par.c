// fannkuch-redux in C on threads (OpenMP): the permutations are split into
// blocks by index, and each block starts from its first permutation, unranked
// from the index. The same split as fannkuch-par.lm.
#include <stdio.h>
#include <stdlib.h>
static long long fact[17];
static void block(int n, long long lo, long long hi, long long *checksum, int *maxflips) {
  int p[16], pp[16], count[16];
  long long idx = lo;
  for (int i = 0; i < n; i++) p[i] = i;
  for (int i = n - 1; i > 0; i--) {
    int d = (int)(idx / fact[i]);
    count[i] = d;
    idx %= fact[i];
    for (int j = 0; j <= i; j++) pp[j] = p[j];
    for (int j = 0; j <= i; j++) p[j] = j + d <= i ? pp[j + d] : pp[j + d - i - 1];
  }
  long long cs = 0; int mf = 0;
  for (long long k = lo; ; k++) {
    int q[16], flips = 0;
    for (int j = 0; j < n; j++) q[j] = p[j];
    for (int f; (f = q[0]) != 0; flips++)
      for (int a = 0, b = f; a < b; a++, b--) { int t = q[a]; q[a] = q[b]; q[b] = t; }
    if (flips > mf) mf = flips;
    cs += k % 2 == 0 ? flips : -flips;
    if (k + 1 >= hi) break;
    // The next permutation: rotate p[0..i] left by one, for i = 1, 2, ... while count[i] wraps.
    for (int i = 1; ; i++) {
      int first = p[0];
      for (int j = 0; j < i; j++) p[j] = p[j + 1];
      p[i] = first;
      if (++count[i] <= i) break;
      count[i] = 0;
    }
  }
  *checksum = cs; *maxflips = mf;
}
int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 7;
  if (n < 1 || n > 16) { printf("n must be between 1 and 16\n"); return 0; }
  fact[0] = 1;
  for (int i = 1; i <= 16; i++) fact[i] = fact[i - 1] * i;
  long long blocks = n >= 4 ? (long long)n * (n - 1) * (n - 2) : 1, size = fact[n] / blocks;
  long long checksum = 0; int maxflips = 0;
  #pragma omp parallel for schedule(dynamic) reduction(+:checksum) reduction(max:maxflips)
  for (long long b = 0; b < blocks; b++) {
    long long c; int m;
    block(n, b * size, (b + 1) * size, &c, &m);
    checksum += c;
    if (m > maxflips) maxflips = m;
  }
  printf("%lld\nPfannkuchen(%d) = %d\n", checksum, n, maxflips);
  return 0;
}
