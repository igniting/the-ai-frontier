# transform/examples/match.lm in Python.

KNOWN = [
    'north field supply', 'north harbor foods', 'north line logistics', 'north peak software',
    'north river energy', 'north gate textiles', 'north ridge pharma', 'north brook media',
    'blue field supply', 'blue harbor foods', 'blue line logistics', 'blue peak software',
    'blue river energy', 'blue gate textiles', 'blue ridge pharma', 'blue brook media',
    'silver field supply', 'silver harbor foods', 'silver line logistics', 'silver peak software',
    'silver river energy', 'silver gate textiles', 'silver ridge pharma', 'silver brook media',
    'red field supply', 'red harbor foods', 'red line logistics', 'red peak software',
    'red river energy', 'red gate textiles', 'red ridge pharma', 'red brook media',
    'green field supply', 'green harbor foods', 'green line logistics', 'green peak software',
    'green river energy', 'green gate textiles', 'green ridge pharma', 'green brook media',
    'iron field supply', 'iron harbor foods', 'iron line logistics', 'iron peak software',
    'iron river energy', 'iron gate textiles', 'iron ridge pharma', 'iron brook media',
    'oak field supply', 'oak harbor foods', 'oak line logistics', 'oak peak software',
    'oak river energy', 'oak gate textiles', 'oak ridge pharma', 'oak brook media',
    'stone field supply', 'stone harbor foods', 'stone line logistics', 'stone peak software',
    'stone river energy', 'stone gate textiles', 'stone ridge pharma', 'stone brook media',
]

LOWER = str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')


def distance(s, t):
    m = len(t) + 1
    prev = list(range(m))
    for i in range(1, len(s) + 1):
        cur = [i] * m
        c = s[i - 1]
        for j in range(1, m):
            cost = 0 if c == t[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[m - 1]


def transform(n, line):
    if n == 1:
        return 'id,match,distance'
    row = fields(line)
    s = field(row, 1).translate(LOWER)
    name, d = '', 1000000
    for x in KNOWN:
        e = distance(s, x)
        if e < d:
            name, d = x, e
    return csv([field(row, 0), name, str(d)] if d <= 3 else [field(row, 0), '', ''])
