// The sum of (-1)^(i+1) / i for i = 1 to n (about ln 2), on every core with
// OpenMP's reduction: each thread adds up its own part, and the parts are
// added together. Which parts there are depends on how many threads run it,
// and floating-point addition does not associate, so neither does the result.
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  long n = argc > 1 ? atol(argv[1]) : 1000;
  double s = 0.0;
  #pragma omp parallel for reduction(+:s) schedule(static)
  for (long i = 1; i <= n; i++) s += (i % 2 == 1 ? 1.0 : -1.0) / (double)i;
  printf("%.17g\n", s);
  return 0;
}
