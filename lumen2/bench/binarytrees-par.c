// binary-trees in C on threads (OpenMP): the same work as binarytrees.c, with
// the depths computed in parallel, as in binarytrees-par.lm.
#include <stdio.h>
#include <stdlib.h>
typedef struct Node { struct Node *l, *r; } Node;
static Node *make(int d) {
  Node *n = malloc(sizeof(Node));
  if (d == 0) { n->l = n->r = NULL; } else { n->l = make(d - 1); n->r = make(d - 1); }
  return n;
}
static long long check(Node *t) { return t->l ? 1 + check(t->l) + check(t->r) : 1; }
static void release(Node *t) { if (t->l) { release(t->l); release(t->r); } free(t); }
int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 10;
  int max = n < 6 ? 6 : n;
  Node *s = make(max + 1); printf("stretch tree of depth %d\t check: %lld\n", max + 1, check(s)); release(s);
  Node *long_lived = make(max);
  int count = (max - 4) / 2 + 1;
  long long iters[32], sums[32];
  #pragma omp parallel for schedule(dynamic)
  for (int k = 0; k < count; k++) {
    int d = 4 + 2 * k;
    long long it = 1LL << (max - d + 4), sum = 0;
    for (long long i = 0; i < it; i++) { Node *t = make(d); sum += check(t); release(t); }
    iters[k] = it; sums[k] = sum;
  }
  for (int k = 0; k < count; k++) printf("%lld\t trees of depth %d\t check: %lld\n", iters[k], 4 + 2 * k, sums[k]);
  printf("long lived tree of depth %d\t check: %lld\n", max, check(long_lived));
  release(long_lived);
  return 0;
}
