// cc -O2 -fopenmp udf.c orders.c -o udf; OMP_NUM_THREADS=N ./udf < input > output
// Runs a transform written in C (orders.c) on every line, the way the Lumen 2
// harness does: 4096 lines at a time, 64 lines to a task, on N threads, the
// results printed in order. Nothing checks the transform.

#include <stdio.h>
#include "lib.h"

int transform(long long n, str line, buf *out, buf *scratch);

#define BATCH 4096
#define CHUNK 64

int main(void) {
  static char *lines[BATCH];
  static size_t lens[BATCH], caps[BATCH];
  static buf outs[BATCH / CHUNK], scratch[BATCH / CHUNK];
  long long first = 1;
  for (;;) {
    int k = 0;
    while (k < BATCH) {
      ssize_t r = getline(&lines[k], &caps[k], stdin);
      if (r <= 0) break;
      size_t n = (size_t)r;
      if (n > 0 && lines[k][n - 1] == '\n') n--;
      if (n > 0 && lines[k][n - 1] == '\r') n--;
      lens[k++] = n;
    }
    if (k == 0) break;
    int chunks = (k + CHUNK - 1) / CHUNK;
    #pragma omp parallel for schedule(dynamic, 1)
    for (int c = 0; c < chunks; c++) {
      buf *o = &outs[c];
      o->n = 0;
      for (int i = c * CHUNK; i < k && i < (c + 1) * CHUNK; i++) {
        size_t mark = o->n;
        if (transform(first + i, (str){ lines[i], lens[i] }, o, &scratch[c])) buf_put(o, "\n", 1);
        else o->n = mark;
      }
    }
    for (int c = 0; c < chunks; c++) fwrite(outs[c].p, 1, outs[c].n, stdout);
    first += k;
  }
  return 0;
}
