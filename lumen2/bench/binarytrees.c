// binary-trees in C: the same algorithm, one malloc per node, freed after each check.
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
  for (int d = 4; d <= max; d += 2) {
    long long iters = 1LL << (max - d + 4), sum = 0;
    for (long long i = 0; i < iters; i++) { Node *t = make(d); sum += check(t); release(t); }
    printf("%lld\t trees of depth %d\t check: %lld\n", iters, d, sum);
  }
  printf("long lived tree of depth %d\t check: %lld\n", max, check(long_lived));
  release(long_lived);
  return 0;
}
