// transform/examples/match.lm in C. Appends the output line to out and
// returns 1.

#include "lib.h"

static const char *known[64] = {
  "north field supply", "north harbor foods", "north line logistics", "north peak software",
  "north river energy", "north gate textiles", "north ridge pharma", "north brook media",
  "blue field supply", "blue harbor foods", "blue line logistics", "blue peak software",
  "blue river energy", "blue gate textiles", "blue ridge pharma", "blue brook media",
  "silver field supply", "silver harbor foods", "silver line logistics", "silver peak software",
  "silver river energy", "silver gate textiles", "silver ridge pharma", "silver brook media",
  "red field supply", "red harbor foods", "red line logistics", "red peak software",
  "red river energy", "red gate textiles", "red ridge pharma", "red brook media",
  "green field supply", "green harbor foods", "green line logistics", "green peak software",
  "green river energy", "green gate textiles", "green ridge pharma", "green brook media",
  "iron field supply", "iron harbor foods", "iron line logistics", "iron peak software",
  "iron river energy", "iron gate textiles", "iron ridge pharma", "iron brook media",
  "oak field supply", "oak harbor foods", "oak line logistics", "oak peak software",
  "oak river energy", "oak gate textiles", "oak ridge pharma", "oak brook media",
  "stone field supply", "stone harbor foods", "stone line logistics", "stone peak software",
  "stone river energy", "stone gate textiles", "stone ridge pharma", "stone brook media",
};

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
  for (int i = 0; i < 64; i++) { int e = distance(s, known[i], strlen(known[i])); if (e < d) { name = known[i]; d = e; } }
  if (low != small) free(low);
  csv_field(out, field(row, k, 0)); buf_put(out, ",", 1);
  if (d <= 3) { buf_cstr(out, name); buf_put(out, ",", 1); buf_int(out, d); }
  else buf_put(out, ",", 1);
  return 1;
}
