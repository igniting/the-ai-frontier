// transform/examples/match.lm in C, with the known names read from a file
// (see load_known), for transform/bench/simulate.js. Appends the output line
// to out and returns 1.

#include <stdio.h>
#include "lib.h"

// The known names, one per line, from the file KNOWN_NAMES names (read
// before main): reference data kept in a file, as C and Python programs
// usually keep it.
static char **known;
static int nknown;
__attribute__((constructor)) static void load_known(void) {
  const char *path = getenv("KNOWN_NAMES");
  FILE *f = path ? fopen(path, "r") : NULL;
  if (!f) { fprintf(stderr, "match-file: set KNOWN_NAMES to a file of names\n"); exit(2); }
  char *line = NULL; size_t cap = 0; ssize_t r;
  while ((r = getline(&line, &cap, f)) > 0) {
    if (line[r - 1] == '\n') line[--r] = 0;
    if (r == 0) continue;
    known = realloc(known, (nknown + 1) * sizeof *known);
    known[nknown++] = strdup(line);
  }
  free(line); fclose(f);
}

// The edit distance between s and t, over two rows on the stack (or the
// heap, for long strings).
static int distance(str s, const char *t, size_t tn) {
  int stack[2][256], *prev = stack[0], *cur = stack[1], *heap = NULL;
  if (tn + 1 > 256) { heap = malloc(2 * (tn + 1) * sizeof(int)); prev = heap; cur = heap + tn + 1; }
  for (size_t j = 0; j <= tn; j++) prev[j] = (int)j;
  for (size_t i = 1; i <= s.n; i++) {
    cur[0] = (int)i;
    char c = s.p[i - 1];
    for (size_t j = 1; j <= tn; j++) {
      int cost = c == t[j - 1] ? 0 : 1;
      int a = prev[j] + 1, b = cur[j - 1] + 1, d = prev[j - 1] + cost;
      cur[j] = a < b ? (a < d ? a : d) : (b < d ? b : d);
    }
    int *x = prev; prev = cur; cur = x;
  }
  int r = prev[tn];
  free(heap);
  return r;
}

int transform(long long n, str line, buf *out, buf *scratch) {
  if (n == 1) { buf_cstr(out, "id,match,distance"); return 1; }
  str row[16];
  int k = fields(line, row, 16, scratch);
  str company = field(row, k, 1);
  char small[256], *low = company.n <= sizeof small ? small : malloc(company.n);
  for (size_t i = 0; i < company.n; i++) { char c = company.p[i]; low[i] = c >= 'A' && c <= 'Z' ? c + 32 : c; }
  str s = { low, company.n };
  const char *name = ""; int d = 1000000;
  for (int i = 0; i < nknown; i++) { int e = distance(s, known[i], strlen(known[i])); if (e < d) { name = known[i]; d = e; } }
  if (low != small) free(low);
  csv_field(out, field(row, k, 0)); buf_put(out, ",", 1);
  if (d <= 3) { buf_cstr(out, name); buf_put(out, ",", 1); buf_int(out, d); }
  else buf_put(out, ",", 1);
  return 1;
}
