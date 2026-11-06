// The transform library in C, as transform/lib.lm defines it (on well-formed
// input), for the C baseline: udf.c runs a transform written in C (orders.c)
// with these functions. C checks nothing: a transform can overflow, read out
// of bounds, keep global state or do I/O, and nothing stops it.

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct { const char *p; size_t n; } str;
typedef struct { char *p; size_t n, cap; } buf;

static inline void buf_put(buf *b, const char *p, size_t n) {
  if (b->n + n > b->cap) { b->cap = (b->n + n) * 2 + 64; b->p = realloc(b->p, b->cap); }
  memcpy(b->p + b->n, p, n);
  b->n += n;
}
static inline void buf_str(buf *b, str s) { buf_put(b, s.p, s.n); }
static inline void buf_cstr(buf *b, const char *s) { buf_put(b, s, strlen(s)); }
static inline void buf_int(buf *b, long long v) {
  char t[24]; int i = 24; unsigned long long a = v < 0 ? -(unsigned long long)v : (unsigned long long)v;
  do { t[--i] = '0' + a % 10; a /= 10; } while (a);
  if (v < 0) t[--i] = '-';
  buf_put(b, t + i, 24 - i);
}

static inline int str_eq(str s, const char *c) { size_t n = strlen(c); return s.n == n && memcmp(s.p, c, n) == 0; }

// Splits a line of CSV into at most max fields. A quoted field's text is
// copied, without its quotes and with "" made ", into scratch.
static inline int fields(str line, str *row, int max, buf *scratch) {
  int k = 0;
  size_t i = 0;
  scratch->n = 0;
  if (scratch->cap < line.n) { scratch->cap = line.n * 2 + 64; scratch->p = realloc(scratch->p, scratch->cap); }
  for (;;) {
    str f;
    if (i < line.n && line.p[i] == '"') {
      size_t start = scratch->n;
      i++;
      while (i < line.n) {
        if (line.p[i] != '"') scratch->p[scratch->n++] = line.p[i++];
        else if (i + 1 < line.n && line.p[i + 1] == '"') { scratch->p[scratch->n++] = '"'; i += 2; }
        else { i++; break; }
      }
      while (i < line.n && line.p[i] != ',') i++;
      f.p = scratch->p + start; f.n = scratch->n - start;
    } else {
      size_t j = i;
      while (j < line.n && line.p[j] != ',') j++;
      f.p = line.p + i; f.n = j - i; i = j;
    }
    if (k < max) row[k++] = f;
    if (i < line.n && line.p[i] == ',') i++; else return k;
  }
}
static inline str field(const str *row, int k, int i) { return i >= 0 && i < k ? row[i] : (str){ "", 0 }; }

static inline int parse_int(str s, long long *out) {
  size_t i = 0; int neg = 0;
  if (s.n > 0 && s.p[0] == '-') { neg = 1; i = 1; }
  if (s.n - i < 1 || s.n - i > 18) return 0;
  long long v = 0;
  for (; i < s.n; i++) { if (s.p[i] < '0' || s.p[i] > '9') return 0; v = v * 10 + (s.p[i] - '0'); }
  *out = neg ? -v : v;
  return 1;
}

static inline int parse_decimal(str s, int places, long long *out) {
  size_t i = 0; int neg = 0, k = 0, frac = -1;
  long long v = 0;
  if (s.n > 0 && s.p[0] == '-') { neg = 1; i = 1; }
  for (; i < s.n; i++) {
    char c = s.p[i];
    if (c == '.' && frac < 0) frac = 0;
    else if (c >= '0' && c <= '9' && k < 18 && frac < places) { v = v * 10 + (c - '0'); k++; if (frac >= 0) frac++; }
    else return 0;
  }
  int scale = places - (frac > 0 ? frac : 0);
  if (k == 0 || k + scale > 18) return 0;
  while (scale-- > 0) v *= 10;
  *out = neg ? -v : v;
  return 1;
}

static inline void show_decimal(buf *b, long long n, int places) {
  long long p = 1;
  for (int i = 0; i < places; i++) p *= 10;
  long long a = n < 0 ? -n : n;
  if (n < 0) buf_put(b, "-", 1);
  buf_int(b, a / p);
  if (places <= 0) return;
  buf_put(b, ".", 1);
  char t[24]; long long r = a % p;
  for (int i = places - 1; i >= 0; i--) { t[i] = '0' + r % 10; r /= 10; }
  buf_put(b, t, places);
}

// One CSV field: in quotes, with " doubled, if it holds , " or a line break.
static inline void csv_field(buf *b, str s) {
  int q = 0;
  for (size_t i = 0; i < s.n; i++) if (s.p[i] == ',' || s.p[i] == '"' || s.p[i] == '\n' || s.p[i] == '\r') { q = 1; break; }
  if (!q) { buf_str(b, s); return; }
  buf_put(b, "\"", 1);
  for (size_t i = 0; i < s.n; i++) { if (s.p[i] == '"') buf_put(b, "\"", 1); buf_put(b, s.p + i, 1); }
  buf_put(b, "\"", 1);
}

static inline long long hash(str s) {
  long long h = 0;
  for (size_t i = 0; i < s.n; i++) h = (h * 257 + (unsigned char)s.p[i] + 1) % 4294967291LL;
  return h;
}
