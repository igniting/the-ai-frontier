// spectral-norm (spectralnorm.lm in C).
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static double a(int i, int j) { return 1.0 / (double)((i + j) * (i + j + 1) / 2 + i + 1); }

static void times(int n, const double *v, int t, double *out) {
  for (int i = 0; i < n; i++) {
    double acc = 0.0;
    for (int j = 0; j < n; j++) acc = acc + (t ? a(j, i) : a(i, j)) * v[j];
    out[i] = acc;
  }
}
static void ata(int n, const double *v, double *out, double *w) { times(n, v, 0, w); times(n, w, 1, out); }

int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 100;
  double *u = malloc(n * sizeof(double)), *v = malloc(n * sizeof(double)), *w = malloc(n * sizeof(double));
  for (int i = 0; i < n; i++) u[i] = 1.0;
  for (int k = 0; k < 10; k++) { ata(n, u, v, w); ata(n, v, u, w); }
  double vbv = 0, vv = 0;
  for (int i = 0; i < n; i++) { vbv = vbv + u[i] * v[i]; vv = vv + v[i] * v[i]; }
  printf("%.9f\n", sqrt(vbv / vv));
  return 0;
}
