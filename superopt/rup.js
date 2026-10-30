// An independent checker for unsatisfiability proofs in RUP form
// (Reverse Unit Propagation, the core of the DRUP/DRAT formats).
//
// A proof is the sequence of clauses the solver learned, ending with the
// empty clause. Each lemma is accepted only if assuming the negation of all
// its literals lets unit propagation over the original clauses plus the
// already-accepted lemmas reach a conflict. The empty clause at the end then
// certifies unsatisfiability. This file shares no code with the solver.
//
// Propagation uses two watched literals over a persistent top-level trail:
// each lemma's assumptions are pushed on top of it and undone afterwards.
// (test/superopt.test.js cross-checks this against a naive implementation.)

export function checkRup(numVars, clauses, proof) {
  if (!proof.length || proof[proof.length - 1].length !== 0) return { ok: false, reason: 'proof does not end with the empty clause' };
  const code = (l) => (l > 0 ? 2 * l : -2 * l + 1);
  const val = new Int8Array(numVars + 1); // per variable: 1 true, -1 false, 0 unassigned
  const value = (x) => { const v = val[x >> 1]; return x & 1 ? -v : v; };
  const watches = Array.from({ length: 2 * numVars + 2 }, () => []); // literal -> clauses watching it
  const trail = [];
  let head = 0;
  let inconsistent = false; // the database itself propagates to a conflict

  const assign = (x) => { val[x >> 1] = x & 1 ? -1 : 1; trail.push(x); };

  // Propagates everything on the trail; returns true on conflict.
  function propagate() {
    while (head < trail.length) {
      const f = trail[head++] ^ 1; // this literal just became false
      const ws = watches[f];
      let j = 0;
      for (let i = 0; i < ws.length; i++) {
        const c = ws[i];
        if (c[0] === f) { c[0] = c[1]; c[1] = f; }
        if (value(c[0]) === 1) { ws[j++] = c; continue; }
        let moved = false;
        for (let k = 2; k < c.length; k++) {
          if (value(c[k]) !== -1) { c[1] = c[k]; c[k] = f; watches[c[1]].push(c); moved = true; break; }
        }
        if (moved) continue;
        ws[j++] = c;
        if (value(c[0]) === -1) { while (++i < ws.length) ws[j++] = ws[i]; ws.length = j; return true; }
        assign(c[0]);
      }
      ws.length = j;
    }
    return false;
  }

  // Adds a clause to the database at the top level.
  function add(lits) {
    if (inconsistent) return;
    const c = [...new Set(lits.map(code))];
    if (c.some((x) => c.includes(x ^ 1))) return; // tautology
    c.sort((a, b) => value(b) - value(a)); // true first, then unassigned, then false
    if (c.length === 0 || value(c[0]) === -1) { inconsistent = true; return; }
    if (c.length === 1 || value(c[1]) === -1) {
      if (value(c[0]) === 0) { assign(c[0]); if (propagate()) inconsistent = true; }
      if (c.length === 1) return;
    }
    watches[c[0]].push(c);
    watches[c[1]].push(c);
  }

  for (const c of clauses) add(c);
  for (let i = 0; i < proof.length; i++) {
    const lemma = proof[i];
    if (!inconsistent) {
      const mark = trail.length;
      let conflict = false;
      for (const l of lemma) {
        const x = code(l);
        if (value(x) === 1) { conflict = true; break; } // its negation contradicts the top level
        if (value(x) === 0) assign(x ^ 1);
      }
      if (!conflict) conflict = propagate();
      for (let k = trail.length - 1; k >= mark; k--) val[trail[k] >> 1] = 0;
      trail.length = mark;
      head = mark;
      if (!conflict) return { ok: false, reason: `lemma ${i} is not RUP`, lemma };
    }
    add(lemma);
  }
  return { ok: true, lemmas: proof.length };
}
