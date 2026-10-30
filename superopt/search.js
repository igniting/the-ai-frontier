// The superoptimizer's driver: mines the compiler's own output for windows of
// straight-line code, synthesizes a shorter equivalent for each, proves it,
// generalizes its constants, and writes the surviving rules.
//
//   node superopt/search.js [--fuzz N] [--min-count N] [--budget-ms N] [--out DIR]
//
// writes DIR/superopt/rules.json (rules with their proof statistics) and
// DIR/src/rules.js (the rules the compiler's -O pass applies).
//
// Rules are found shortest-window first, and a window is only searched for
// code shorter than what the rules found so far already achieve on it, so
// every rule in the output does something the others cannot.

import { writeFileSync } from 'node:fs';
import { corpusModules, extractWindows } from './corpus.js';
import { synthesize, generalize, prove, byteCost } from './synth.js';
import { indexRules, rewriteRun, rewriteBody } from '../src/peephole.js';
import { show } from './show.js';
import { writeOutputs } from './report.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const fuzz = +opt('fuzz', 60);
const minCount = +opt('min-count', 2);
const budgetMs = +opt('budget-ms', 6000);
const outDir = opt('out', '.');

const t0 = Date.now();
const mods = corpusModules({ fuzz });
const windowsOf = (ms) => extractWindows(ms).filter((w) => w.count >= minCount)
  .sort((a, b) => a.code.length - b.code.length || b.count - a.count);
const windows = windowsOf(mods);
console.log(`${mods.length} modules, ${windows.length} windows seen at least ${minCount} times`);

const rules = [];
let index = indexRules(rules);
let searched = 0;

// Searches one window; adds a rule if it beats what the current rules achieve.
function attempt(w, origin) {
  const odd = new Set(w.odd.map((o, i) => (o ? `x${i}` : null)).filter(Boolean));
  const current = rewriteRun(w.code, index, (x) => odd.has(x));
  if (current.length <= 1) return null;
  const maxLen = Math.min(current.length - 1, w.code.length >= 6 ? 4 : 3);
  searched++;
  const found = synthesize(w, { maxLen, timeLimitMs: budgetMs });
  if (!found) return null;
  const general = generalize(w, found.rhs);
  const lhs = general ? general.lhs : w.code;
  const rhs = general ? general.rhs : found.rhs;
  // Drop "this local is odd" assumptions the proof does not need.
  let oddAssumed = w.odd;
  let proof = general ? general.proof : found.proof;
  for (let i = 0; i < oddAssumed.length; i++) {
    if (!oddAssumed[i]) continue;
    const weaker = oddAssumed.map((o, j) => o && j !== i);
    const p = prove({ odd: weaker, inputs: w.inputs }, lhs, rhs, { conflictLimit: 50000, nonneg: general?.nonneg ?? [] });
    if (p.proved) { oddAssumed = weaker; proof = p; }
  }
  const rule = {
    id: rules.length,
    lhs,
    rhs,
    odd: oddAssumed,
    ...(general?.nonneg?.length ? { nonneg: general.nonneg } : {}),
    inputs: w.inputs,
    seen: w.count,
    origin,
    example: { lhs: w.code, rhs: found.rhs },
    saves: { instructions: w.code.length - found.rhs.length, bytes: byteCost(w.code) - byteCost(found.rhs) },
    proof: summarize(proof),
  };
  rules.push(rule);
  index = indexRules(rules);
  console.log(`#${rule.id} (${origin === 'corpus' ? `${w.count}x` : origin}) ${show(rule.lhs)}  ==>  ${show(rule.rhs)}   [${rule.proof.lemmas} lemmas, RUP checked]`);
  return rule;
}

// A rule found for one comparison usually has siblings for the others that
// the corpus happened not to contain twice: search those variants directly.
const CMP2 = ['i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u', 'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u'];
// Only comparisons applied to the window's own inputs are varied (the
// box-a-comparison-result family); elsewhere variants are rarely useful.
function variants(w) {
  if (w.inputs !== 2 || !CMP2.includes(w.code[0][0])) return [];
  return CMP2.filter((op) => op !== w.code[0][0]).map((op) => ({ ...w, count: 0, code: [[op], ...w.code.slice(1)] }));
}

// Rewriting creates sequences the original code never contained (e.g. two
// adjacent constant additions after two different rules fired), so mine
// again on rewritten code until a round finds nothing new.
let round = 1, seen = windows;
for (;;) {
  const before = rules.length;
  for (const w of seen) {
    if (!attempt(w, round === 1 ? 'corpus' : `round ${round}`)) continue;
    for (const v of variants(w)) attempt(v, 'variant');
  }
  if (rules.length === before || round === 4) break;
  round++;
  for (const m of mods) for (const f of m.funcs) if (f.oddLocals) f.body = rewriteBody(f.body, index, f.oddLocals);
  seen = windowsOf(mods);
  console.log(`round ${round}: ${seen.length} windows in the rewritten corpus`);
}

function summarize(p) {
  return { vars: p.vars, clauses: p.clauses, lemmas: p.lemmas, conflicts: p.conflicts ?? 0, trivial: !!p.trivial, checked: p.checked };
}

const meta = { generated: 'node superopt/search.js', corpus: { modules: mods.length, windows: windows.length, minCount, fuzz }, rounds: round, searches: searched, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
writeFileSync(`${outDir}/superopt/rules.json`, JSON.stringify({ ...meta, rules }, null, 1) + '\n');
writeOutputs(outDir);
console.log(`${rules.length} rules from ${searched} searches in ${meta.seconds} s -> ${outDir}/superopt/rules.json, src/rules.js, superopt/RULES.md`);
