// transform/examples/orders.lm in JavaScript.

const EURO_AREA = new Set(['AT', 'BE', 'DE', 'ES', 'FI', 'FR', 'IE', 'IT', 'NL', 'PT']);

function transform(n, line) {
  if (n === 1) return 'order,customer,country,total';
  const row = fields(line);
  const country = field(row, 2);
  const quantity = parseInt_(field(row, 3));
  const price = parseDecimal(field(row, 4), 2);
  if (quantity === null || price === null) throw new Error(`not an order: ${line}`);
  const total = quantity * price;
  if (total >= 10000 && EURO_AREA.has(country)) {
    return csv([field(row, 0), `c${hash(field(row, 1)) % 1000000}`, country, showDecimal(total, 2)]);
  }
  return null;
}
