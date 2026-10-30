// The parts of the Schur proof that need no Node APIs (used by
// proofs/prove-schur.js and by the story page's worker).

export function parseDimacs(text) {
  let numVars = 0;
  const clauses = [];
  let cur = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('c') || !line.trim()) continue;
    if (line.startsWith('p')) { numVars = +line.split(/\s+/)[2]; continue; }
    for (const tok of line.trim().split(/\s+/)) {
      const x = +tok;
      if (x === 0) { clauses.push(cur); cur = []; } else cur.push(x);
    }
  }
  return { numVars, clauses };
}

// The same encoding, written again independently.
export function referenceEncoding(k, n) {
  const v = (i, c) => (i - 1) * k + c;
  const clauses = [];
  for (let i = 1; i <= n; i++) clauses.push(Array.from({ length: k }, (_, c) => v(i, c + 1)));
  for (let c = 1; c <= k; c++) {
    for (let x = 1; x <= n; x++) {
      for (let y = x; x + y <= n; y++) clauses.push(x === y ? [-v(x, c), -v(2 * x, c)] : [-v(x, c), -v(y, c), -v(x + y, c)]);
    }
  }
  if (n >= 1) clauses.push([v(1, 1)]);
  if (n >= 2 && k >= 2) clauses.push([v(2, 2)]);
  return { numVars: n * k, clauses };
}

const key = (c) => [...c].sort((a, b) => a - b).join(' ');
export function sameFormula(a, b) {
  if (a.numVars !== b.numVars || a.clauses.length !== b.clauses.length) return false;
  const count = new Map();
  for (const c of a.clauses) count.set(key(c), (count.get(key(c)) ?? 0) + 1);
  for (const c of b.clauses) { const n = count.get(key(c)); if (!n) return false; count.set(key(c), n - 1); }
  return true;
}

// Groups from a model: number i goes to the first group its literals allow.
export function groupsOf(model, k, n) {
  const truth = new Set(model.filter((l) => l > 0));
  const groups = Array.from({ length: k }, () => []);
  for (let i = 1; i <= n; i++) {
    const c = [...Array(k).keys()].find((c) => truth.has((i - 1) * k + c + 1));
    if (c === undefined) return null;
    groups[c].push(i);
  }
  return groups;
}

// Is every group sum-free (no x, y, x + y, with x = y allowed), and do they cover 1..n?
export function checkSplit(groups, n) {
  const all = groups.flat().sort((a, b) => a - b);
  if (all.length !== n || all.some((x, i) => x !== i + 1)) return 'the groups do not cover 1..n exactly once';
  for (const g of groups) {
    const set = new Set(g);
    for (const x of g) for (const y of g) if (set.has(x + y)) return `${x} + ${y} = ${x + y} in one group`;
  }
  return null;
}

// Parses what proofs/sat.lm prints: a status, then a model or a DRUP refutation.
export function parseSolverOutput(text) {
  const lines = text.split('\n');
  const status = lines.find((l) => l.startsWith('s '));
  const info = lines.find((l) => l.startsWith('c ')) ?? '';
  const conflicts = +(/(\d+) conflicts/.exec(info)?.[1] ?? 0);
  const ints = (l) => l.trim().split(/\s+/).map(Number);
  if (status === 's SATISFIABLE') {
    const v = ints(lines.find((l) => l.startsWith('v ')).slice(2));
    return { sat: true, model: v.slice(0, -1), conflicts };
  }
  if (status !== 's UNSATISFIABLE') throw new Error(`unexpected solver output: ${text.slice(0, 200)}`);
  const proof = lines.filter((l) => /^-?\d/.test(l)).map((l) => ints(l).slice(0, -1));
  return { sat: false, proof, conflicts };
}
