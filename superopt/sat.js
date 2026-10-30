// A CDCL SAT solver: two watched literals, first-UIP clause learning, VSIDS
// decisions with a binary heap, phase saving and Luby restarts.
//
// Every learned clause is recorded, in order, as a proof. When the formula is
// unsatisfiable the proof ends with the empty clause, and superopt/rup.js can
// check it independently of this solver — so a bug here cannot silently
// certify a wrong optimization.
//
// Literals are non-zero integers (DIMACS style): v or -v for variable v >= 1.

export function solve(numVars, clauses, { conflictLimit = Infinity } = {}) {
  const n = numVars;
  const lit = (l) => (l > 0 ? 2 * l : 2 * -l + 1); // literal -> index
  const neg = (x) => x ^ 1;
  const varOf = (x) => x >> 1;

  const assign = new Int8Array(n + 1); // 0 unassigned, 1 true, -1 false
  const level = new Int32Array(n + 1);
  const reason = new Array(n + 1).fill(null);
  const phase = new Int8Array(n + 1).fill(-1);
  const activity = new Float64Array(n + 1);
  const watches = Array.from({ length: 2 * n + 2 }, () => []);
  const trail = [];
  const trailLim = [];
  let qhead = 0;
  let inc = 1;
  const proof = [];
  const db = [];

  const value = (x) => { // value of literal index x: 1 true, -1 false, 0 unassigned
    const a = assign[varOf(x)];
    return (x & 1) ? -a : a;
  };

  // ------------------------------------------------------------ VSIDS heap
  const heap = [];
  const pos = new Int32Array(n + 1).fill(-1);
  const less = (a, b) => activity[a] > activity[b];
  const swap = (i, j) => { const t = heap[i]; heap[i] = heap[j]; heap[j] = t; pos[heap[i]] = i; pos[heap[j]] = j; };
  const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; swap(i, p); i = p; } };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < heap.length && less(heap[l], heap[m])) m = l;
      if (r < heap.length && less(heap[r], heap[m])) m = r;
      if (m === i) return;
      swap(i, m);
      i = m;
    }
  };
  const heapInsert = (v) => { if (pos[v] >= 0) return; pos[v] = heap.length; heap.push(v); up(heap.length - 1); };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    pos[top] = -1;
    if (heap.length) { heap[0] = last; pos[last] = 0; down(0); }
    return top;
  };
  const bump = (v) => {
    activity[v] += inc;
    if (activity[v] > 1e100) { for (let i = 1; i <= n; i++) activity[i] *= 1e-100; inc *= 1e-100; }
    if (pos[v] >= 0) up(pos[v]);
  };
  for (let v = 1; v <= n; v++) heapInsert(v);

  const enqueue = (x, from) => {
    const v = varOf(x);
    assign[v] = (x & 1) ? -1 : 1;
    level[v] = trailLim.length;
    reason[v] = from;
    trail.push(x);
  };

  // --------------------------------------------------------- load clauses
  for (const c of clauses) {
    const cl = [...new Set(c.map(lit))];
    if (cl.some((x) => cl.includes(neg(x)))) continue; // tautology
    if (cl.length === 0) return { sat: false, proof: [[]] };
    if (cl.length === 1) {
      const val = value(cl[0]);
      if (val === -1) return { sat: false, proof: [[]] };
      if (val === 0) enqueue(cl[0], null);
      continue;
    }
    db.push(cl);
    watches[neg(cl[0])].push(cl);
    watches[neg(cl[1])].push(cl);
  }

  function propagate() {
    while (qhead < trail.length) {
      const x = trail[qhead++]; // x became true; visit clauses watching ¬x
      const ws = watches[x];
      let i = 0, j = 0;
      while (i < ws.length) {
        const c = ws[i++];
        if (c[0] === neg(x)) { c[0] = c[1]; c[1] = neg(x); }
        if (value(c[0]) === 1) { ws[j++] = c; continue; }
        let found = false;
        for (let k = 2; k < c.length; k++) {
          if (value(c[k]) !== -1) {
            c[1] = c[k];
            c[k] = neg(x);
            watches[neg(c[1])].push(c);
            found = true;
            break;
          }
        }
        if (found) continue;
        ws[j++] = c;
        if (value(c[0]) === -1) {
          while (i < ws.length) ws[j++] = ws[i++];
          ws.length = j;
          return c; // conflict
        }
        enqueue(c[0], c);
      }
      ws.length = j;
    }
    return null;
  }

  const seen = new Uint8Array(n + 1);
  function analyze(conflict) {
    const learnt = [0];
    let counter = 0;
    let p = -1;
    let c = conflict;
    let idx = trail.length - 1;
    const dl = trailLim.length;
    do {
      for (let k = (p === -1 ? 0 : 1); k < c.length; k++) {
        const q = c[k];
        const v = varOf(q);
        if (!seen[v] && level[v] > 0) {
          seen[v] = 1;
          bump(v);
          if (level[v] >= dl) counter++;
          else learnt.push(q);
        }
      }
      while (!seen[varOf(trail[idx])]) idx--;
      p = trail[idx--];
      c = reason[varOf(p)];
      seen[varOf(p)] = 0;
      counter--;
    } while (counter > 0);
    learnt[0] = neg(p);
    for (let k = 1; k < learnt.length; k++) seen[varOf(learnt[k])] = 0;
    let back = 0;
    if (learnt.length > 1) {
      let m = 1;
      for (let k = 2; k < learnt.length; k++) if (level[varOf(learnt[k])] > level[varOf(learnt[m])]) m = k;
      [learnt[1], learnt[m]] = [learnt[m], learnt[1]];
      back = level[varOf(learnt[1])];
    }
    return { learnt, back };
  }

  function cancelUntil(lvl) {
    if (trailLim.length <= lvl) return;
    for (let k = trail.length - 1; k >= trailLim[lvl]; k--) {
      const v = varOf(trail[k]);
      phase[v] = assign[v];
      assign[v] = 0;
      reason[v] = null;
      heapInsert(v);
    }
    trail.length = trailLim[lvl];
    qhead = trail.length;
    trailLim.length = lvl;
  }

  const luby = (i) => {
    let size = 1, seq = 0;
    while (size < i + 1) { seq++; size = 2 * size + 1; }
    while (size - 1 !== i) { size = (size - 1) >> 1; seq--; i %= size; }
    return 2 ** seq;
  };

  const toDimacs = (cl) => cl.map((x) => (x & 1 ? -varOf(x) : varOf(x)));
  let conflicts = 0;
  let restarts = 0;
  let budget = 100 * luby(0);

  if (propagate()) return { sat: false, proof: [[]], conflicts };
  for (;;) {
    const conflict = propagate();
    if (conflict) {
      conflicts++;
      if (trailLim.length === 0) {
        proof.push([]);
        return { sat: false, proof, conflicts };
      }
      if (conflicts > conflictLimit) return { sat: null, conflicts };
      const { learnt, back } = analyze(conflict);
      proof.push(toDimacs(learnt));
      cancelUntil(back);
      if (learnt.length === 1) enqueue(learnt[0], null);
      else {
        db.push(learnt);
        watches[neg(learnt[0])].push(learnt);
        watches[neg(learnt[1])].push(learnt);
        enqueue(learnt[0], learnt);
      }
      inc *= 1 / 0.95;
      if (--budget <= 0) { restarts++; budget = 100 * luby(restarts); cancelUntil(0); }
    } else {
      if (heap.length === 0 || trail.length === n) {
        const model = new Int8Array(n + 1);
        for (let v = 1; v <= n; v++) model[v] = assign[v] || -1;
        return { sat: true, model, conflicts };
      }
      let v;
      do { v = heap.length ? heapPop() : 0; } while (v && assign[v] !== 0);
      if (!v) continue;
      trailLim.push(trail.length);
      enqueue(phase[v] === 1 ? 2 * v : 2 * v + 1, null);
    }
  }
}
