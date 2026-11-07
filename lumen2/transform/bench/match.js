// transform/examples/match.lm in JavaScript.

const KNOWN = [
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
];

const lowerAscii = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

function distance(s, t) {
  const m = t.length + 1;
  let prev = new Array(m), cur = new Array(m);
  for (let j = 0; j < m; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    const c = s.charCodeAt(i - 1);
    for (let j = 1; j < m; j++) {
      const cost = c === t.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const x = prev; prev = cur; cur = x;
  }
  return prev[m - 1];
}

function transform(n, line) {
  if (n === 1) return 'id,match,distance';
  const row = fields(line);
  const s = lowerAscii(field(row, 1));
  let name = '', d = 1000000;
  for (const x of KNOWN) { const e = distance(s, x); if (e < d) { name = x; d = e; } }
  return csv(d <= 3 ? [field(row, 0), name, String(d)] : [field(row, 0), '', '']);
}
