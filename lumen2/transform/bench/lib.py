# The transform library in Python, as transform/lib.lm defines it (on
# well-formed input), for the Python baseline: udf.py runs a transform
# written in Python with these functions in its namespace.

import csv as _csv


def fields(line):
    if '"' not in line:
        return line.split(',')
    return next(_csv.reader((line,)))


def field(row, i):
    return row[i] if 0 <= i < len(row) else ''


def parse_int(s):
    t = s[1:] if s.startswith('-') else s
    if not (0 < len(t) <= 18 and t.isascii() and t.isdigit()):
        return None
    return int(s)


def parse_decimal(s, places):
    neg = s.startswith('-')
    t = s[1:] if neg else s
    whole, dot, frac = t.partition('.')
    digits = whole + frac
    if not digits or not (digits.isascii() and digits.isdigit()) or len(frac) > places or len(whole) + places > 18:
        return None
    n = int(digits) * 10 ** (places - len(frac))
    return -n if neg else n


def show_decimal(n, places):
    if places <= 0:
        return str(n)
    p = 10 ** places
    a = abs(n)
    return f"{'-' if n < 0 else ''}{a // p}.{a % p:0{places}d}"


def csv(xs):
    return ','.join('"' + x.replace('"', '""') + '"' if any(c in x for c in ',"\n\r') else x for x in xs)


def hash(s):
    h = 0
    for b in s.encode():
        h = (h * 257 + b + 1) % 4294967291
    return h
