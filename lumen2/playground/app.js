// The Lumen 2 playground. The compiler runs in two Web Workers: one checks
// the program as you type, the other runs it (and its property tests), so a
// long run can be stopped without losing the analysis.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (n) => Number(n).toLocaleString('en-US');
const ms = (x) => (x < 10 ? `${x.toFixed(1)} ms` : x < 10000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(1)} s`);
const kib = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);

// A small Schur formula for the SAT solver example: split 1..n into k sum-free groups.
function schurCnf(k, n) {
  const v = (i, c) => (i - 1) * k + c;
  const cs = [];
  for (let i = 1; i <= n; i++) cs.push(Array.from({ length: k }, (_, c) => v(i, c + 1)));
  for (let c = 1; c <= k; c++) for (let x = 1; x <= n; x++) for (let y = x; x + y <= n; y++) cs.push(x === y ? [-v(x, c), -v(2 * x, c)] : [-v(x, c), -v(y, c), -v(x + y, c)]);
  cs.push([v(1, 1)], [v(2, 2)]);
  return `c Schur: split 1..${n} into ${k} sum-free groups\np cnf ${n * k} ${cs.length}\n${cs.map((c) => `${c.join(' ')} 0`).join('\n')}\n`;
}

const EXAMPLES = [
  { id: 'tour', name: 'A tour', file: 'examples/tour.lm', note: 'Types and effects are inferred; see the Types tab. The last line overflows on purpose: 64-bit integers never wrap silently.' },
  { id: 'refine', name: 'Proved array accesses', file: 'examples/refine.lm', note: 'Open the Proofs tab. Change < to <= in safe_get and the access can fail again: the checker shows a counterexample.' },
  { id: 'traits', name: 'Traits: Ord, Show and your own', file: 'examples/traits.lm' },
  { id: 'memory', name: 'Memory without a GC', file: 'examples/memory.lm', note: 'Run it and look at Allocations. The Memory tab shows insert after reference counting: drop-reuse hands the old node to the new one, so the path is rebuilt in place.' },
  { id: 'capabilities', name: 'Capabilities', file: 'examples/capabilities.lm', note: 'Untick “random” above and run: the program is rejected before it runs.' },
  { id: 'properties', name: 'Properties', file: 'examples/properties.lm', note: 'Open Properties and test them. The last two are false on purpose.' },
  { id: 'sat', name: 'A SAT solver written in Lumen 2', file: 'proofs/sat.lm', input: schurCnf(3, 14), note: 'The input is the formula “split 1..14 into 3 sum-free groups”. Run it: the solver prints its DRUP proof, one learnt clause per line, and ends with “s UNSATISFIABLE”. So S(3) = 13.' },
  { id: 'schur', name: 'The Schur encoder', file: 'proofs/schur.lm', input: '3 13', note: 'Writes the CNF for “split 1..n into k sum-free groups”; the input is “k n”.' },
];

// ---------------------------------------------------------------- workers --
function makeWorker() { return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); }
function channel() {
  let w = makeWorker(), next = 1;
  const pending = new Map();
  const hook = () => { w.onmessage = ({ data }) => { pending.get(data.id)?.(data); pending.delete(data.id); }; };
  hook();
  return {
    ask(msg) { const id = next++; return new Promise((resolve) => { pending.set(id, resolve); w.postMessage({ ...msg, id }); }); },
    reset() { w.terminate(); for (const r of pending.values()) r({ ok: false, stopped: true }); pending.clear(); w = makeWorker(); hook(); },
  };
}
const checker = channel();
const runner = channel();

// ----------------------------------------------------------------- editor --
const code = $('code'), hl = $('hl'), marks = $('marks'), gutter = $('gutter');
const KW = new Set(['fn', 'let', 'if', 'else', 'match', 'type', 'true', 'false', 'trait', 'impl', 'for', 'where', 'property']);
const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"?)|([A-Za-z_][A-Za-z0-9_]*)|(\d[\d_]*)|(->|=>|\|>|\+\+|==|!=|<=|>=|&&|\|\||[+\-*/%<>=!|])/g;
function highlight(src) {
  let out = '', last = 0;
  for (const m of src.matchAll(TOKEN)) {
    out += esc(src.slice(last, m.index));
    const [t, com, str, id, n, op] = m;
    if (com) out += `<span class="hc">${esc(t)}</span>`;
    else if (str) out += `<span class="hs">${esc(t)}</span>`;
    else if (id) {
      const call = src[m.index + t.length] === '(';
      out += KW.has(t) ? `<span class="hk">${t}</span>` : /^[A-Z]/.test(t) ? `<span class="ht">${t}</span>` : call ? `<span class="hf">${t}</span>` : t;
    } else if (n) out += `<span class="hn">${t}</span>`;
    else if (op) out += `<span class="ho">${esc(t)}</span>`;
    last = m.index + t.length;
  }
  return `${out + esc(src.slice(last))}\n`;
}
let diagSpans = [];
function paint() {
  const src = code.value;
  hl.innerHTML = highlight(src);
  // Underline each diagnostic's span.
  const spans = [...diagSpans].filter((d) => d.at).sort((a, b) => a.at.s - b.at.s);
  let m = '', at = 0;
  for (const d of spans) {
    const s = Math.max(at, d.at.s), e = Math.max(s + 1, Math.min(d.at.e, src.length));
    if (s >= src.length) continue;
    m += esc(src.slice(at, s)) + `<mark class="${d.severity}">${esc(src.slice(s, e))}</mark>`;
    at = e;
  }
  marks.innerHTML = `${m + esc(src.slice(at))}\n`;
  const lines = src.split('\n').length;
  const bad = new Set(spans.filter((d) => d.severity === 'error').map((d) => d.at.line));
  gutter.innerHTML = Array.from({ length: lines }, (_, i) => `<div${bad.has(i + 1) ? ' class="bad"' : ''}>${i + 1}</div>`).join('');
  sync();
}
function sync() {
  hl.scrollTop = marks.scrollTop = gutter.scrollTop = code.scrollTop;
  hl.scrollLeft = marks.scrollLeft = code.scrollLeft;
}
code.addEventListener('scroll', sync);
code.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: t } = code;
    code.setRangeText('  ', s, t, 'end');
    changed();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
});
const jump = (at) => {
  if (!at) return;
  code.focus();
  code.setSelectionRange(at.s, at.e);
  const line = at.line - 1;
  code.scrollTop = Math.max(0, line * 20 - code.clientHeight / 3);
  sync();
};

// --------------------------------------------------------------- analysis --
const grants = () => ['output', ...['input', 'clock', 'random'].filter((c) => $(`cap-${c}`).checked)];
let analyzeTimer = null, version = 0;
function changed() {
  paint();
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(analyze, 300);
}
code.addEventListener('input', changed);
for (const c of ['input', 'clock', 'random']) $(`cap-${c}`).addEventListener('change', analyze);

const cell = (id, v, cls = '') => { const el = $(id); el.className = `cell ${cls}`; el.querySelector('.v').textContent = v; };
function setState(text, cls) { const el = $('state'); el.className = `chip ${cls}`; el.textContent = text; }

async function analyze() {
  const v = ++version;
  setState('checking…', '');
  const r = await checker.ask({ type: 'analyze', source: code.value, grants: grants() });
  if (v !== version || r.stopped) return;
  cell('c-check', ms(r.checkMs ?? 0));
  diagSpans = r.diagnostics ?? [];
  paint();
  showDiagnostics(r.diagnostics ?? []);
  if (!r.ok) {
    setState(`${r.diagnostics.length === 1 ? 'an error' : `${r.diagnostics.length} errors`}`, 'err');
    cell('c-check', 'error', 'bad');
    return;
  }
  const warnings = r.diagnostics.length;
  setState(warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'checks', warnings ? 'warn' : 'ok');
  renderTypes(r.signatures);
  renderProofs(r.obligations);
  $('n-props').textContent = r.properties.length || '';
  propNames = r.properties;
  if (currentTab === 'memory') loadIR();
}

function showDiagnostics(list) {
  $('diags').innerHTML = list.map((d) => `<pre class="diag ${d.severity === 'warning' ? 'warning' : ''}">${esc(d.text)}</pre>`).join('');
}

const fmtType = (t) => esc(t)
  .replace(/\{([a-z_][A-Za-z0-9_]*): ([^|{}]+) \| ([^{}]*)\}/g, '<span class="ref">{$1: $2 | $3}</span>')
  .replace(/ ! (\{[^}]*\}|[a-z]+)/g, ' <span class="eff">! $1</span>');
function renderTypes(sigs) {
  $('n-types').textContent = sigs.length;
  $('sigs').innerHTML = sigs.map((s, i) => `<li><button type="button" data-i="${i}"><span class="name">${esc(s.name)}</span><span class="ty">: ${fmtType(s.type)}</span></button></li>`).join('');
  $('sigs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => jump(sigs[+b.dataset.i].at)));
}

function renderProofs(obs) {
  const proved = obs.filter((o) => o.status === 'proved');
  const partial = obs.filter((o) => o.kind === 'partial');
  const kept = partial.filter((o) => o.status !== 'proved');
  $('n-proofs').textContent = obs.length || '';
  cell('c-proofs', `${partial.length - kept.length} / ${partial.length}`, partial.length && !kept.length ? 'good' : '');
  cell('c-kept', String(kept.length));
  if (!obs.length) { $('obs').innerHTML = '<p class="hint">This program has no partial operations or refinements, so there is nothing to prove.</p>'; return; }
  const lemmas = proved.reduce((n, o) => n + o.lemmas, 0);
  const head = `<p class="hint"><b>${proved.length}</b> of ${obs.length} obligations proved, with ${num(lemmas)} checked lemmas in total.</p>`;
  $('obs').innerHTML = head + obs.map((o, i) => {
    const ok = o.status === 'proved';
    const what = o.kind === 'partial' ? o.what : `${o.what} (${o.kind === 'result' ? 'refined result' : 'refinement'})`;
    const detail = ok ? `${num(o.lemmas)} lemma${o.lemmas === 1 ? '' : 's'}, ${num(o.clauses)} clauses` : (o.counterexample ?? 'not proved');
    return `<div class="ob ${ok ? 'proved' : 'kept'}" data-i="${i}"><span class="mark">${ok ? '✓' : '○'}</span><span>${esc(what)}</span><span class="loc">${o.at ? `${o.at.line}:${o.at.col}` : ''}</span><span class="cex">${esc(detail)}</span></div>`;
  }).join('');
  $('obs').querySelectorAll('.ob').forEach((el) => el.addEventListener('click', () => jump(obs[+el.dataset.i].at)));
}

// -------------------------------------------------------------------- run --
let running = false;
function clearRun() { for (const id of ['c-compile', 'c-bytes', 'c-run', 'c-allocs', 'c-live']) cell(id, '–'); }
async function run() {
  if (running) { runner.reset(); return; }
  running = true;
  const btn = $('run');
  btn.classList.add('stop'); btn.innerHTML = 'Stop';
  selectTab('output');
  $('out').textContent = 'Compiling and running…';
  $('rterr').hidden = true;
  $('run-stats').hidden = true;
  const t = performance.now();
  const r = await runner.ask({ type: 'run', source: code.value, grants: grants(), input: $('input').value, seed: Math.floor(Math.random() * 2 ** 31), paranoid: $('opt-paranoid').checked });
  running = false;
  btn.classList.remove('stop'); btn.innerHTML = 'Run <kbd>Ctrl ↵</kbd>';
  if (r.stopped) { $('out').textContent = `Stopped after ${ms(performance.now() - t)}.`; return; }
  if (!r.ok) { $('out').textContent = ''; clearRun(); showDiagnostics(r.diagnostics); diagSpans = r.diagnostics; paint(); return; }
  showDiagnostics([]);
  $('out').textContent = r.output;
  if (r.error) { $('rterr').hidden = false; $('rterr').textContent = `runtime error: ${r.error}`; }
  cell('c-compile', ms(r.compileMs));
  cell('c-bytes', kib(r.bytes));
  cell('c-run', ms(r.runMs));
  cell('c-allocs', num(r.allocs));
  cell('c-live', r.live === null ? '–' : num(r.live), r.live === 0 ? 'good' : r.live ? 'bad' : '');
  $('run-stats').hidden = false;
  $('run-stats').innerHTML = [
    ['Compiled', `${ms(r.compileMs)}`], ['Binary', kib(r.bytes)], ['Ran', ms(r.runMs)],
    ['Allocations', num(r.allocs)], ['Live at exit', r.live === null ? 'stopped early' : num(r.live)],
  ].map(([k, v], i) => `<div class="stat${i === 4 && r.live === 0 ? ' good' : ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
}
$('run').addEventListener('click', run);
$('run-key').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ ↵' : 'Ctrl ↵';

// ------------------------------------------------------------- properties --
let propNames = [];
$('test-run').addEventListener('click', async () => {
  const btn = $('test-run');
  btn.disabled = true;
  $('props').innerHTML = `<p class="hint">Testing ${propNames.length || 'the'} propert${propNames.length === 1 ? 'y' : 'ies'}…</p>`;
  const r = await runner.ask({ type: 'test', source: code.value, runs: 100, seed: 1 });
  btn.disabled = false;
  if (!r.ok) { $('props').innerHTML = (r.diagnostics ?? []).map((d) => `<pre class="diag">${esc(d.text)}</pre>`).join(''); return; }
  if (!r.results.length) { $('props').innerHTML = '<p class="hint">This program declares no properties. Try the “Properties” example.</p>'; return; }
  const rows = r.results.map((p) => `<tr><td><code>${esc(p.name)}</code></td><td class="${p.ok ? 'ok' : 'bad'}">${p.ok ? 'holds' : 'fails'}</td><td>${p.ok ? `${p.cases} cases` : `${esc(p.reason)} on case ${p.cases}<br><code>${esc(p.counterexample.map((x) => `${x.name} = ${x.value}`).join(', '))}</code><br><span style="color:var(--muted)">shrunk in ${p.shrinks} step${p.shrinks === 1 ? '' : 's'}</span>`}</td><td>${p.compiled === 'agrees' ? 'agrees' : esc(p.compiled ?? '')}</td></tr>`).join('');
  $('props').innerHTML = `<table class="t"><thead><tr><th>Property</th><th>Result</th><th>Cases / counterexample</th><th>Compiled code</th></tr></thead><tbody>${rows}</tbody></table><p class="hint" style="margin-top:10px">${ms(r.ms)}, interpreter and compiled code together.</p>`;
});

// ----------------------------------------------------------------- memory --
const fmtIR = (t) => esc(t)
  .replace(/\b(dup|drop-reuse|drop|unpack|free)\b/g, '<span class="hrc">$1</span>')
  .replace(/(@ru\$\d+)/g, '<span class="hrc">$1</span>')
  .replace(/\b(peek)\b/g, '<span class="hk">$1</span>')
  .replace(/\b(let|ret|if|else|fn)\b/g, '<span class="hc" style="font-style:normal">$1</span>');
let irPick = null;
async function loadIR() {
  const r = await checker.ask({ type: 'ir', source: code.value, name: irPick });
  if (!r.ok) { $('ir').textContent = (r.diagnostics ?? []).map((d) => d.text).join('\n'); return; }
  const sel = $('ir-fn');
  const user = r.names.filter((n) => n.user);
  const other = r.names.filter((n) => !n.user);
  sel.innerHTML = `<optgroup label="This program">${user.map((n) => `<option${n.name === r.name ? ' selected' : ''}>${esc(n.name)}</option>`).join('')}</optgroup><optgroup label="Prelude and closures">${other.map((n) => `<option${n.name === r.name ? ' selected' : ''}>${esc(n.name)}</option>`).join('')}</optgroup>`;
  $('ir').innerHTML = fmtIR(r.text);
}
$('ir-fn').addEventListener('change', () => { irPick = $('ir-fn').value; loadIR(); });

// ------------------------------------------------------------ certificates --
$('cert-run').addEventListener('click', async () => {
  const btn = $('cert-run');
  btn.disabled = true;
  $('certs').innerHTML = '<p class="hint">Checking…</p>';
  const r = await checker.ask({ type: 'certify', source: code.value });
  btn.disabled = false;
  if (!r.ok) { $('certs').innerHTML = (r.diagnostics ?? []).map((d) => `<pre class="diag">${esc(d.text)}</pre>`).join(''); return; }
  $('certs').innerHTML = `<div class="verdict ok">Every certificate checks.</div>
    <table class="t"><tbody>
      <tr><td><b>Types</b></td><td>${num(r.types.functions)} IR functions, ${num(r.types.instructions)} instructions, all well typed</td></tr>
      <tr><td><b>Ownership</b></td><td>${num(r.ownership.functions)} functions: ${num(r.ownership.dups)} dups, ${num(r.ownership.drops)} drops, ${num(r.ownership.reuses)} reuses, ${num(r.ownership.borrowed)} borrowed parameters; balanced on every path, no leak, no use after release</td></tr>
      <tr><td><b>Proofs</b></td><td>${num(r.proved)} obligations proved (the prelude's included), ${num(r.lemmas)} lemmas, each refutation checked by a RUP checker that shares no code with the solver; ${num(r.kept)} partial operation${r.kept === 1 ? '' : 's'} keep <code>fail</code></td></tr>
      <tr><td><b>WebAssembly</b></td><td>${kib(r.bytes)}, validated by the engine</td></tr>
    </tbody></table><p class="hint" style="margin-top:10px">${ms(r.ms)}.</p>`;
});

// ------------------------------------------------------------------- tabs --
let currentTab = 'output';
function selectTab(name) {
  currentTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.panel === name)));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `p-${name}`; });
  if (name === 'memory') loadIR();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.panel)));

// --------------------------------------------------------------- examples --
const select = $('example');
select.innerHTML = EXAMPLES.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
async function load(id) {
  const ex = EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];
  select.value = ex.id;
  $('file').textContent = ex.file.split('/').pop();
  $('note').textContent = ex.note ?? '';
  $('note').hidden = !ex.note;
  $('input').value = ex.input ?? '';
  $('out').textContent = '';
  $('rterr').hidden = $('run-stats').hidden = true;
  clearRun();
  code.value = await (await fetch(new URL(`../${ex.file}`, import.meta.url))).text();
  irPick = ex.id === 'memory' ? 'insert' : null;
  code.scrollTop = 0;
  changed();
  clearTimeout(analyzeTimer);
  analyze();
}
select.addEventListener('change', () => { history.replaceState(null, '', `#${select.value}`); load(select.value); });
load(location.hash.slice(1) || 'tour');
