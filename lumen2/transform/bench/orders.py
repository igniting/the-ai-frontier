# transform/examples/orders.lm in Python.

EURO_AREA = {'AT', 'BE', 'DE', 'ES', 'FI', 'FR', 'IE', 'IT', 'NL', 'PT'}


def transform(n, line):
    if n == 1:
        return 'order,customer,country,total'
    row = fields(line)
    country = field(row, 2)
    quantity = parse_int(field(row, 3))
    price = parse_decimal(field(row, 4), 2)
    if quantity is None or price is None:
        raise ValueError('not an order: ' + line)
    total = quantity * price
    if total >= 10000 and country in EURO_AREA:
        return csv([field(row, 0), 'c' + str(hash(field(row, 1)) % 1000000), country, show_decimal(total, 2)])
    return None
