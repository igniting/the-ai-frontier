// The story page: wires the inline live demos to Web Workers.

const $ = (id) => document.getElementById(id);
const num = (n) => n.toLocaleString('en-US');
const ms = (x) => (x < 10 ? `${x.toFixed(1)} ms` : `${Math.round(x)} ms`);
const secs = (x) => (x < 1000 ? ms(x) : `${(x / 1000).toFixed(1)} s`);
const kib = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);

// Old playground links (…/#nqueens) now live on their own page.
const SECTIONS = new Set([...document.querySelectorAll('section[id], article[id], header[id]')].map((s) => s.id));
const toPlayground = () => { if (location.hash && !SECTIONS.has(location.hash.slice(1))) location.replace(`playground.html${location.hash}`); };
toPlayground();
addEventListener('hashchange', toPlayground);

function worker(path) {
  try { return new Worker(new URL(path, import.meta.url), { type: 'module' }); } catch { return null; }
}
const unsupported = (el) => { el.textContent = 'This browser could not start a Web Worker, so this demo cannot run here. The playground page has the same features.'; };

// One request/response channel to the story worker.
let storyWorker = null, nextId = 1;
const pending = new Map();
function ask(msg) {
  storyWorker ??= worker('./story-worker.js');
  if (!storyWorker) return Promise.reject(new Error('no worker'));
  storyWorker.onmessage = ({ data }) => { pending.get(data.id)?.(data); pending.delete(data.id); };
  const id = nextId++;
  return new Promise((resolve) => { pending.set(id, resolve); storyWorker.postMessage({ ...msg, id }); });
}

// ------------------------------------------------------------- try it --
$('try-run').addEventListener('click', async () => {
  const out = $('try-out'), meta = $('try-meta'), btn = $('try-run');
  btn.disabled = true;
  out.className = 'out';
  out.textContent = 'Compiling…';
  meta.textContent = '';
  try {
    const r = await ask({ type: 'run', source: $('try-code').value, optimize: $('try-opt').checked });
    if (!r.ok) { out.className = 'out err'; out.textContent = r.error; return; }
    out.textContent = r.output + (r.error ? `runtime error: ${r.error}` : '');
    meta.innerHTML = `Compiled to <b>${kib(r.bytes)}</b> of WebAssembly in ${ms(r.compileMs)} · ran in ${ms(r.timeMs)} · executed <b>${num(r.instructions)}</b> wasm instructions<br>Inferred: <code>${r.signatures.filter((s) => !s.startsWith('main ')).map(escape).join('</code>, <code>')}</code>`;
  } catch { unsupported(out); } finally { btn.disabled = false; }
});
const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// ------------------------------------------------------------- fuzzer --
let fuzz = null, fuzzStart = 0;
$('fuzz-run').addEventListener('click', () => {
  const btn = $('fuzz-run');
  if (fuzz) { fuzz.terminate(); fuzz = null; btn.textContent = 'Resume'; return; }
  fuzz = worker('../playground/fuzz-worker.js');
  if (!fuzz) { unsupported($('fuzz-program')); return; }
  btn.textContent = 'Stop';
  fuzzStart = performance.now();
  const base = { programs: +$('fz-programs').dataset.n || 0, agreed: +$('fz-agreed').dataset.n || 0, mismatches: +$('fz-mismatches').dataset.n || 0 };
  const set = (id, n) => { $(id).dataset.n = n; $(id).textContent = num(n); };
  fuzz.onmessage = ({ data: m }) => {
    if (m.type === 'progress') {
      set('fz-programs', base.programs + m.totals.programs);
      set('fz-agreed', base.agreed + m.totals.agreed);
      set('fz-mismatches', base.mismatches + m.totals.mismatches);
      $('fz-rate').textContent = (m.totals.programs / ((performance.now() - fuzzStart) / 1000)).toFixed(1);
      $('fuzz-program').textContent = m.source.split('\n').slice(-14).join('\n');
      $('fuzz-caption').textContent = `Latest program, seed ${m.seed}${m.error ? `, which ends in the runtime error “${m.error}” in all five runs` : ''}:`;
    } else if (m.type === 'mismatch') {
      $('fuzz-caption').textContent = `Disagreement at seed ${m.seed}: ${m.detail}`;
      $('fuzz-program').textContent = m.source;
    }
  };
  fuzz.postMessage({ seed: Math.floor(Math.random() * 1e9), size: 2 });
});

// ------------------------------------------------------------ bootstrap --
let selfhost = null;
$('boot-run').addEventListener('click', () => {
  const btn = $('boot-run');
  selfhost ??= worker('../playground/selfhost-worker.js');
  if (!selfhost) { unsupported($('boot-verdict')); return; }
  btn.disabled = true;
  for (const td of document.querySelectorAll('#boot-table td:not(:first-child)')) td.textContent = '…';
  $('boot-verdict').hidden = true;
  selfhost.onmessage = ({ data: m }) => {
    if (m.type === 'stage') {
      const cells = document.querySelector(`#boot-table tr[data-stage="${m.n}"]`).children;
      cells[1].textContent = ms(m.ms);
      cells[2].textContent = kib(m.bytes);
      cells[3].textContent = m.sha ? `${m.sha.slice(0, 16)}…` : 'n/a';
      cells[3].title = m.sha ?? '';
      return;
    }
    btn.disabled = false;
    const v = $('boot-verdict');
    v.hidden = false;
    v.className = `verdict ${m.identical ? 'ok' : 'bad'}`;
    v.textContent = m.type === 'failed' ? `Failed: ${m.message}`
      : m.identical ? '✓ All three binaries are identical, byte for byte. The compiler, compiled by itself, reproduces itself.' : '✗ The stages differ.';
  };
  selfhost.postMessage({ type: 'bootstrap' });
});

// ---------------------------------------------------------------- prover --
// (a >>> 1) == 0, written as stack code with the value `a` already on the stack.
const LHS = [['i32.const', 1], ['i32.shr_u'], ['i32.eqz']];
const CANDIDATES = [
  ['a <=u 1', [['i32.const', 1], ['i32.le_u']]],
  ['a == 0', [['i32.eqz']]],
  ['a <u 2', [['i32.const', 2], ['i32.lt_u']]],
  ['a <= 1 (signed)', [['i32.const', 1], ['i32.le_s']]],
  ['(a & -2) == 0', [['i32.const', -2], ['i32.and'], ['i32.eqz']]],
  ['a <u 1', [['i32.const', 1], ['i32.lt_u']]],
];
const proverBody = document.querySelector('#prover tbody');
for (const [label] of CANDIDATES) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><code>${escape(label)}</code></td><td class="verdict-cell">not asked yet</td>`;
  proverBody.append(tr);
}
$('prove-run').addEventListener('click', async () => {
  const btn = $('prove-run');
  btn.disabled = true;
  const rows = proverBody.querySelectorAll('tr');
  try {
    for (let i = 0; i < CANDIDATES.length; i++) {
      const cell = rows[i].children[1];
      cell.className = 'verdict-cell';
      cell.textContent = 'proving…';
      const r = await ask({ type: 'prove', inputs: 1, lhs: LHS, rhs: CANDIDATES[i][1] });
      if (r.proved) {
        cell.className = 'verdict-cell ok';
        cell.textContent = `✓ equal for all 2³² inputs · ${r.trivial ? 'identical circuits' : `${num(r.lemmas)} learned clauses, each re-checked`} · ${ms(r.ms)}`;
      } else if (r.unknown) {
        cell.textContent = 'gave up (conflict limit)';
      } else {
        cell.className = 'verdict-cell bad';
        cell.textContent = `✗ counterexample: a = ${r.input[0]}, where the original gives ${r.lhs} but this gives ${r.rhs}`;
      }
    }
  } catch { unsupported(rows[0].children[1]); } finally { btn.disabled = false; }
});

// ----------------------------------------------------------- all rules --
$('rules-run').addEventListener('click', () => {
  const btn = $('rules-run'), out = $('rules-out');
  const w = worker('../playground/rules-worker.js');
  if (!w) { unsupported(out); return; }
  btn.disabled = true;
  let done = 0;
  w.onmessage = ({ data: m }) => {
    if (m.type === 'rule') {
      done++;
      $('rules-bar').style.width = `${(done / 40) * 100}%`;
      out.textContent = `Rule ${m.id}: ${m.ok ? '✓' : '✗'} (${done} proved)`;
    } else {
      btn.disabled = false;
      w.terminate();
      $('rules-bar').style.width = '100%';
      out.textContent = `All ${m.rules} rules re-proved in ${ms(m.ms)}: ${num(m.lemmas)} learned clauses, every one re-checked by the independent checker.`;
    }
  };
  w.postMessage({});
});

// --------------------------------------------------------- instructions --
$('count-run').addEventListener('click', async () => {
  const btn = $('count-run'), out = $('count-out');
  btn.disabled = true;
  out.hidden = false;
  $('count-note').textContent = 'Compiling and running both builds…';
  try {
    const r = await ask({ type: 'compare', name: $('count-program').value });
    if (!r.ok) { $('count-note').textContent = 'Something went wrong compiling this example.'; return; }
    const max = Math.max(r.base.instructions, r.opt.instructions);
    const bar = (id, v) => { $(`${id}-bar`).style.width = `${(v.instructions / max) * 100}%`; $(`${id}-val`).textContent = num(v.instructions); };
    bar('cb', r.base);
    bar('co', r.opt);
    const saved = (1 - r.opt.instructions / r.base.instructions) * 100;
    $('count-note').textContent = `${saved.toFixed(1)}% fewer instructions executed. -O applied proved rules at ${num(r.opt.rewrites)} places in this program, alongside its other passes. `
      + `${r.same ? `Both builds printed the same ${num(r.outputBytes)} bytes` : 'The outputs DIFFER'}; binaries ${kib(r.base.bytes)} and ${kib(r.opt.bytes)}.`;
  } catch { unsupported($('count-note')); } finally { btn.disabled = false; }
});

// --------------------------------------------------------- Schur numbers --
let schur = null;
function proveSchur(k, n) {
  const buttons = [$('schur3'), $('schur4')];
  schur?.terminate();
  schur = worker('./schur-worker.js');
  const cell = (step) => document.querySelector(`#schur-steps tr[data-step="${step}"] td:last-child`);
  const verdict = $('schur-verdict'), groupsEl = $('schur-groups');
  if (!schur) { unsupported(cell('encode')); return; }
  buttons.forEach((b) => { b.disabled = true; });
  for (const td of document.querySelectorAll('#schur-steps td:last-child')) { td.className = 'verdict-cell'; td.textContent = '…'; }
  verdict.hidden = true;
  groupsEl.hidden = true;
  const mark = (step, ok, text) => { const c = cell(step); c.className = `verdict-cell ${ok ? 'ok' : 'bad'}`; c.textContent = text; };
  schur.onmessage = ({ data: m }) => {
    if (m.step === 'encode') mark('encode', m.agree, `${m.agree ? '✓' : '✗'} ${num(m.clauses[0])} and ${num(m.clauses[1])} clauses, ${m.agree ? 'identical' : 'DIFFERENT'}`);
    else if (m.step === 'witness' && !m.done) cell('witness').textContent = `searching… ${num(m.progress)} clauses learned`;
    else if (m.step === 'witness') {
      mark('witness', m.ok, m.ok ? `✓ found in ${secs(m.ms)}; every group is sum-free` : `✗ ${m.error}`);
      if (m.groups) { groupsEl.hidden = false; groupsEl.textContent = m.groups.map((g, i) => `group ${i + 1}: ${g.join(' ')}`).join('\n'); }
    } else if (m.step === 'refute' && !m.done) cell('refute').textContent = `${num(m.progress)} clauses learned so far…`;
    else if (m.step === 'refute') mark('refute', !m.sat, m.sat ? '✗ a split exists?!' : `✓ refuted: ${num(m.lemmas)} learned clauses in ${secs(m.ms)}`);
    else if (m.step === 'check' && !m.done) cell('check').textContent = `checked ${num(m.progress)} of ${num(m.total)}…`;
    else if (m.step === 'check') mark('check', m.ok, m.ok ? `✓ all ${num(m.lemmas)} steps valid (${secs(m.ms)})` : `✗ rejected: ${m.reason}`);
    else if (m.step === 'done' || m.step === 'failed') {
      buttons.forEach((b) => { b.disabled = false; });
      verdict.hidden = false;
      verdict.className = `verdict ${m.proved ? 'ok' : 'bad'}`;
      verdict.textContent = m.step === 'failed' ? `Failed: ${m.message}`
        : m.proved ? `✓ Proved: S(${k}) = ${n}. 1 to ${n} can be split into ${k} sum-free groups, and 1 to ${n + 1} cannot.` : 'Not proved.';
    }
  };
  schur.postMessage({ k, n });
}
$('schur3').addEventListener('click', () => proveSchur(3, 13));
$('schur4').addEventListener('click', () => proveSchur(4, 44));

// --------------------------------------------------------- Schur puzzle --
// Split 1..n into k groups by hand; numbers in a group holding x, y and x + y are flagged.
const LETTERS = ['', 'A', 'B', 'C'];
const pz = { k: 2, n: 5, groups: [] };
function pzRender(focus = -1) {
  const bad = new Set();
  let first = null;
  for (let x = 1; x <= pz.n; x++) {
    for (let y = x; x + y <= pz.n; y++) {
      const g = pz.groups[x];
      if (g && pz.groups[y] === g && pz.groups[x + y] === g) {
        bad.add(x); bad.add(y); bad.add(x + y);
        first ??= `Group ${LETTERS[g]} contains ${x === y ? `${x} and ${x + y}` : `${x}, ${y} and ${x + y}`}, and ${x} + ${y} = ${x + y}.`;
      }
    }
  }
  const box = $('pz-chips');
  box.replaceChildren(...Array.from({ length: pz.n }, (_, i) => {
    const v = i + 1, g = pz.groups[v] ?? 0;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${g ? ` g${g}` : ''}${bad.has(v) ? ' bad' : ''}`;
    b.innerHTML = `${v}<small>${g ? LETTERS[g] : '·'}</small>`;
    b.setAttribute('aria-label', `${v}, ${g ? `group ${LETTERS[g]}` : 'no group'}${bad.has(v) ? ', in conflict' : ''}`);
    b.addEventListener('click', () => { pz.groups[v] = (g + 1) % (pz.k + 1); pzRender(i); });
    return b;
  }));
  if (focus >= 0) box.children[focus].focus();
  const placed = pz.groups.filter(Boolean).length;
  $('pz-status').textContent = first ?? (placed === pz.n
    ? `All ${pz.n} numbers placed with no conflict. That should be impossible, since S(${pz.k}) = ${pz.n - 1}.`
    : `${placed} of ${pz.n} placed, no conflict so far. ${placed === pz.n - 1 && !pz.groups[pz.n] ? `Now try to place ${pz.n}.` : 'Keep going.'}`);
}
$('pz-k').addEventListener('change', (e) => { pz.k = +e.target.value; pz.n = pz.k === 2 ? 5 : 14; pz.groups = []; pzRender(); });
$('pz-clear').addEventListener('click', () => { pz.groups = []; pzRender(); });
// A valid split of 1..n-1: {1, 4}, {2, 3} for two groups; {1, 4, 10, 13}, {2, 3, 11, 12}, {5, ..., 9} for three.
const SPLITS = { 2: [[1, 4], [2, 3]], 3: [[1, 4, 10, 13], [2, 3, 11, 12], [5, 6, 7, 8, 9]] };
$('pz-show').addEventListener('click', () => {
  pz.groups = [];
  SPLITS[pz.k].forEach((nums, g) => nums.forEach((v) => { pz.groups[v] = g + 1; }));
  pzRender();
});
pzRender();
