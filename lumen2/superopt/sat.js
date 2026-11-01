// A CDCL SAT solver that writes a DRUP proof when it finds a formula
// unsatisfiable: the superoptimizer's, for proving rewrite rules. (The
// compiler has its own, in compiler/32-sat.lm, the same algorithm.)
//
// Clauses use DIMACS literals: v or -v for variable v >= 1. On UNSAT the
// proof is the list of clauses the solver learned, in order, ending with the
// empty clause. Each learned clause follows from the formula and the clauses
// before it by unit propagation (it is RUP), so src/rup.js, which shares no code
// with this file, can check the whole refutation independently. Nothing this
// solver says is trusted: an UNSAT answer counts only once its proof checks.
//
// The solver is the textbook design: two watched literals, first-UIP
// learning, VSIDS with a binary heap, phase saving and Luby restarts. It
// never deletes learned clauses, so the proof needs no deletion steps.

export function solve(nvars, clauses, { maxConflicts = 200000, mutant = null } = {}) {
  const proof = [];
  // Internal literals: 2v for v, 2v + 1 for -v.
  const enc = (d) => (d > 0 ? 2 * d : -2 * d + 1);
  const dec = (l) => (l & 1 ? -(l >> 1) : l >> 1);
  if (mutant === 'sat-claims-unsat') return { status: 'unsat', proof: [[]] };

  const n = nvars;
  const val = new Int8Array(n + 1); // 0 unassigned, 1 true, -1 false
  const level = new Int32Array(n + 1);
  const reason = new Int32Array(n + 1).fill(-1);
  const phase = new Int8Array(n + 1).fill(-1);
  const activity = new Float64Array(n + 1);
  const seen = new Uint8Array(n + 1);
  const trail = new Int32Array(n + 1);
  let trailLen = 0, qhead = 0;
  const trailLim = [];
  const db = []; // clauses as Int32Array of internal literals
  const watches = Array.from({ length: 2 * n + 2 }, () => []);
  const litVal = (l) => (l & 1 ? -val[l >> 1] : val[l >> 1]);

  // VSIDS order: a max-heap of variables by activity.
  const heap = [], pos = new Int32Array(n + 1).fill(-1);
  let inc = 1;
  const less = (a, b) => activity[a] > activity[b];
  const up = (i) => {
    const v = heap[i];
    while (i > 0) { const p = (i - 1) >> 1; if (!less(v, heap[p])) break; heap[i] = heap[p]; pos[heap[i]] = i; i = p; }
    heap[i] = v; pos[v] = i;
  };
  const down = (i) => {
    const v = heap[i];
    for (;;) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
      if (!less(heap[c], v)) break;
      heap[i] = heap[c]; pos[heap[i]] = i; i = c;
    }
    heap[i] = v; pos[v] = i;
  };
  const insert = (v) => { if (pos[v] >= 0) return; pos[v] = heap.length; heap.push(v); up(heap.length - 1); };
  const popMax = () => {
    const v = heap[0];
    const last = heap.pop();
    pos[v] = -1;
    if (heap.length) { heap[0] = last; pos[last] = 0; down(0); }
    return v;
  };
  const bump = (v) => {
    activity[v] += inc;
    if (activity[v] > 1e100) { for (let i = 1; i <= n; i++) activity[i] *= 1e-100; inc *= 1e-100; }
    if (pos[v] >= 0) up(pos[v]);
  };
  for (let v = 1; v <= n; v++) insert(v);

  const assign = (l, from) => {
    const v = l >> 1;
    val[v] = l & 1 ? -1 : 1;
    level[v] = trailLim.length;
    reason[v] = from;
    trail[trailLen++] = l;
  };

  function addClause(lits) {
    const idx = db.length;
    db.push(lits);
    if (lits.length >= 2) { watches[lits[0] ^ 1].push(idx); watches[lits[1] ^ 1].push(idx); }
    return idx;
  }

  // Unit propagation; returns a conflicting clause index or -1.
  function propagate() {
    while (qhead < trailLen) {
      const falsified = trail[qhead++] ^ 1; // this literal just became false
      const ws = watches[falsified ^ 1];
      let i = 0, j = 0;
      while (i < ws.length) {
        const ci = ws[i++];
        const c = db[ci];
        if (c[0] === falsified) { c[0] = c[1]; c[1] = falsified; }
        if (litVal(c[0]) === 1) { ws[j++] = ci; continue; }
        let moved = false;
        for (let k = 2; k < c.length; k++) {
          if (litVal(c[k]) !== -1) {
            c[1] = c[k]; c[k] = falsified;
            watches[c[1] ^ 1].push(ci);
            moved = true;
            break;
          }
        }
        if (moved) continue;
        ws[j++] = ci;
        if (litVal(c[0]) === -1) {
          while (i < ws.length) ws[j++] = ws[i++];
          ws.length = j;
          return ci;
        }
        assign(c[0], ci);
      }
      ws.length = j;
    }
    return -1;
  }

  function backtrack(lvl) {
    if (trailLim.length <= lvl) return;
    const stop = trailLim[lvl];
    for (let i = trailLen - 1; i >= stop; i--) {
      const v = trail[i] >> 1;
      phase[v] = val[v];
      val[v] = 0;
      reason[v] = -1;
      insert(v);
    }
    trailLen = stop;
    qhead = stop;
    trailLim.length = lvl;
  }

  // First-UIP conflict analysis: returns [learned clause, backtrack level].
  function analyze(confl) {
    const learnt = [0];
    let pathC = 0, p = -1, idx = trailLen - 1;
    const cur = trailLim.length;
    for (;;) {
      const c = db[confl];
      for (let k = p === -1 ? 0 : 1; k < c.length; k++) {
        const q = c[k];
        const v = q >> 1;
        if (seen[v] || level[v] === 0) continue;
        seen[v] = 1;
        bump(v);
        if (level[v] === cur) pathC++;
        else learnt.push(q);
      }
      while (!seen[trail[idx] >> 1]) idx--;
      p = trail[idx--];
      confl = reason[p >> 1];
      seen[p >> 1] = 0;
      pathC--;
      if (pathC === 0) break;
      // The reason clause has p as its first literal (it was assigned from c[0]).
      const rc = db[confl];
      if (rc[0] !== p) { const k = rc.indexOf(p); rc[k] = rc[0]; rc[0] = p; }
    }
    learnt[0] = p ^ 1;
    let bt = 0, max = 1;
    for (let k = 1; k < learnt.length; k++) if (level[learnt[k] >> 1] > bt) { bt = level[learnt[k] >> 1]; max = k; }
    if (learnt.length > 1) { const t = learnt[1]; learnt[1] = learnt[max]; learnt[max] = t; }
    for (const q of learnt) seen[q >> 1] = 0;
    inc *= 1 / 0.95;
    return [learnt, bt];
  }

  const unsat = () => { proof.push([]); return { status: 'unsat', proof }; };

  // Load the formula; units are assigned at level 0.
  for (const c of clauses) {
    const lits = [...new Set(c.map(enc))];
    if (lits.some((l) => lits.includes(l ^ 1))) continue; // a tautology
    if (!lits.length) return unsat();
    if (lits.length === 1) {
      const l = lits[0];
      if (litVal(l) === -1) return unsat();
      if (litVal(l) === 0) assign(l, addClause(Int32Array.from(lits)));
      continue;
    }
    addClause(Int32Array.from(lits));
  }
  if (propagate() !== -1) return unsat();

  // The Luby sequence 1 1 2 1 1 2 4 ..., which scales the restart intervals.
  const luby = (i) => {
    for (let k = 1; ; k++) {
      if (i === (1 << k) - 1) return 1 << (k - 1);
      if (i < (1 << k) - 1) return luby(i - (1 << (k - 1)) + 1);
    }
  };

  let conflicts = 0, restarts = 0, budget = 100 * luby(1);
  for (;;) {
    const confl = propagate();
    if (confl !== -1) {
      conflicts++;
      if (trailLim.length === 0) return unsat();
      const [learnt, bt] = analyze(confl);
      proof.push(learnt.map(dec));
      backtrack(bt);
      if (learnt.length === 1) assign(learnt[0], -1);
      else assign(learnt[0], addClause(Int32Array.from(learnt)));
      if (conflicts >= maxConflicts) return { status: 'unknown' };
      if (--budget <= 0) { restarts++; budget = 100 * luby(restarts + 1); backtrack(0); }
      continue;
    }
    // Decide.
    let v = 0;
    while (heap.length) { const w = popMax(); if (val[w] === 0) { v = w; break; } }
    if (!v) {
      const model = new Int8Array(n + 1);
      for (let i = 1; i <= n; i++) model[i] = val[i] === 1 ? 1 : 0;
      return { status: 'sat', model };
    }
    trailLim.push(trailLen);
    assign(phase[v] === 1 ? 2 * v : 2 * v + 1, -1);
  }
}
