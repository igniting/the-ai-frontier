// transform/examples/orders.lm in C. Appends the output line to out and
// returns 1, or returns 0 to drop the line.

#include "lib.h"

static int euro_area(str c) {
  static const char *codes[] = { "AT", "BE", "DE", "ES", "FI", "FR", "IE", "IT", "NL", "PT" };
  for (int i = 0; i < 10; i++) if (str_eq(c, codes[i])) return 1;
  return 0;
}

int transform(long long n, str line, buf *out, buf *scratch) {
  if (n == 1) { buf_cstr(out, "order,customer,country,total"); return 1; }
  str row[16];
  int k = fields(line, row, 16, scratch);
  str country = field(row, k, 2);
  long long quantity, price;
  if (!parse_int(field(row, k, 3), &quantity) || !parse_decimal(field(row, k, 4), 2, &price)) abort();
  long long total = quantity * price;
  if (total >= 10000 && euro_area(country)) {
    csv_field(out, field(row, k, 0)); buf_put(out, ",", 1);
    buf_put(out, "c", 1); buf_int(out, hash(field(row, k, 1)) % 1000000); buf_put(out, ",", 1);
    csv_field(out, country); buf_put(out, ",", 1);
    show_decimal(out, total, 2);
    return 1;
  }
  return 0;
}
