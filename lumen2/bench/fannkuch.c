// fannkuch-redux in C: the same algorithm, on fixed-size arrays.
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 7;
  if (n < 1 || n > 16) { printf("n must be between 1 and 16\n"); return 0; }
  int perm[16], perm1[16], count[16];
  int maxflips = 0, permcount = 0, r = n;
  long long checksum = 0;
  for (int i = 0; i < n; i++) perm1[i] = i;
  for (;;) {
    while (r != 1) { count[r - 1] = r; r--; }
    for (int i = 0; i < n; i++) perm[i] = perm1[i];
    int flips = 0, k;
    while ((k = perm[0]) != 0) {
      for (int i = 0, j = k; i < j; i++, j--) { int t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
      flips++;
    }
    if (flips > maxflips) maxflips = flips;
    checksum += (permcount % 2 == 0) ? flips : -flips;
    for (;;) {
      if (r == n) { printf("%lld\nPfannkuchen(%d) = %d\n", checksum, n, maxflips); return 0; }
      int perm0 = perm1[0];
      for (int i = 0; i < r; i++) perm1[i] = perm1[i + 1];
      perm1[r] = perm0;
      if (--count[r] > 0) break;
      r++;
    }
    permcount++;
  }
}
