// Lumen playground UI.

const EXAMPLES = [
  ['hello', 'Hello, Lumen', 'A tour: algebraic data types, inference, closures and pipes.'],
  ['red_black_tree', 'Red-black trees', 'Okasaki’s rebalancing as one nested match. 50,000 inserts, then both invariants are checked.'],
  ['calculator', 'An interpreter in Lumen', 'A tokenizer, parser and evaluator for a small expression language, with errors carried in Result values.'],
  ['huffman', 'Huffman coding', 'Count frequencies, build an optimal prefix-code tree, then encode and decode a sentence.'],
  ['nqueens', 'N-queens', 'Backtracking search over immutable lists: solution counts for N = 1 to 10.'],
  ['life', 'Game of Life', 'A glider crossing a 24 × 10 torus, next to a blinker and a block.'],
  ['mandelbrot', 'Mandelbrot set', 'Fixed-point arithmetic on 31-bit integers. No floating point anywhere.'],
  ['tail_calls', 'Tail calls', '10 million loop iterations and a million mutually recursive calls in constant stack space.'],
  ['gc_torture', 'GC torture test', 'Over 100 MB of short-lived allocations while a 5,000-string list stays live. Watch the collector stats.'],
  ['type_error', 'A type error', 'Inference finds the mismatch. Nothing here is annotated.'],
  ['missing_case', 'A missing case', 'The exhaustiveness checker names the exact value that no arm handles.'],
];

// Results of `node fuzz/mutants.js --budget 500` (programs needed to expose each bug).
const MUTATION_RESULTS = [
  ['concat forgets to root its arguments before allocating', 1],
  ['substring forgets to root its argument before allocating', 1],
  ['GC scan skips the last field of every object', 1],
  ['Function prologue does not zero the shadow-stack frame', 1],
  ['Allocation loads its fields before calling alloc', 1],
  ['Captured variables read from the wrong closure slot', 11],
  ['Arguments evaluated before the callee expression', 1],
  ['Binary operators evaluate the right operand first', 6],
  ['Pattern matching skips the “is a heap block” test', 1],
  ['Ordering puts nullary constructors after ones with fields', 7],
  ['Structural equality ignores the last field', 7],
  ['Tagged multiplication forgets to untag an operand', 1],
  ['Division-by-zero check missing for %', 43],
  ['int_to_string drops the minus sign', 1],
  ['substring does not clamp a negative start', 21],
  ['String comparison treats a prefix as greater', 4],
];

const RUN_TIMEOUT_MS = 15000;
const MAX_OUTPUT = 400000;

const $ = (id) => document.getElementById(id);
const els = {
  code: $('code'), hl: $('hl'), marks: $('marks'), gutter: $('gutter'), example: $('example'), run: $('run'),
  stress: $('opt-stress'), compare: $('opt-compare'), fileName: $('file-name'), checkStatus: $('check-status'),
  note: $('example-note'), runStatus: $('run-status'), diagnostics: $('diagnostics'), out: $('out'),
  runtimeError: $('runtime-error'), runStats: $('run-stats'), sigs: $('sigs'), typesCount: $('types-count'),
  ir: $('ir'), wat: $('wat'), pipeline: $('pipeline'),
};

const store = {
  get(k, d) { try { return localStorage.getItem(`lumen:${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`lumen:${k}`, v); } catch { /* storage unavailable */ } },
};

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const ms = (x) => (x == null ? '–' : x < 10 ? `${x.toFixed(1)} ms` : `${Math.round(x)} ms`);
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);
const num = (n) => n.toLocaleString('en-US');

// ---------------------------------------------------------- highlighting --
const KEYWORDS = new Set(['fn', 'let', 'if', 'else', 'match', 'type', 'true', 'false']);
const TOKEN = /(\/\/[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?)|(\b\d[\d_]*\b)|([A-Za-z_][A-Za-z0-9_]*)|(\|>|->|=>|\+\+|==|!=|<=|>=|&&|\|\||\.\.|[+\-*/%<>=!|])/g;

export function highlight(src) {
  let out = '';
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    const [t, line, block, str, number, ident, op] = m;
    out += esc(src.slice(last, m.index));
    let cls = null;
    if (line || block) cls = 'c';
    else if (str) cls = 's';
    else if (number) cls = 'n';
    else if (ident) {
      if (KEYWORDS.has(ident)) cls = 'k';
      else if (/^[A-Z]/.test(ident)) cls = 't';
      else if (src[m.index + t.length] === '(') cls = 'f';
    } else if (op) cls = 'o';
    out += cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t);
    last = m.index + t.length;
  }
  return out + esc(src.slice(last)) + '\n';
}

function highlightWat(text) {
  return esc(text)
    .replace(/(;;[^\n]*)/g, '<span class="w-com">$1</span>')
    .replace(/(^|[\s(])(\$[^\s()]+)/g, '$1<span class="w-id">$2</span>')
    .replace(/(^\s*)(block|loop|if|else|end|br_if|br|return_call_indirect|return_call|call_indirect|call|return|unreachable)\b/gm, '$1<span class="w-kw">$2</span>')
    .replace(/(i32\.const |i64\.const |offset=)(-?\d+)/g, '$1<span class="w-num">$2</span>');
}

function highlightIr(text) {
  return esc(text)
    .replace(/(\/\/[^\n]*)/g, '<span class="w-com">$1</span>')
    .replace(/\b(fn|let|if|else|match|call|callc|alloc|closure|bind|always)\b/g, '<span class="w-kw">$1</span>')
    .replace(/(&amp;[\w.:#]+)/g, '<span class="w-id">$1</span>');
}

// ---------------------------------------------------------------- editor --
let diagnostics = [];

function renderEditor() {
  const src = els.code.value;
  els.hl.innerHTML = highlight(src);
  const lines = src.split('\n').length;
  const badLines = new Set(diagnostics.filter((d) => d.severity === 'error' && d.span).map((d) => lineOf(src, d.span.s)));
  let g = '';
  for (let i = 1; i <= lines; i++) g += `<div${badLines.has(i) ? ' class="bad"' : ''}>${i}</div>`;
  els.gutter.innerHTML = g;
  renderMarks();
  syncScroll();
}

function lineOf(src, offset) {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

function renderMarks() {
  const src = els.code.value;
  const spans = diagnostics
    .filter((d) => d.span && d.span.e >= d.span.s)
    .map((d) => ({ s: d.span.s, e: Math.max(d.span.e, d.span.s + 1), cls: d.severity }))
    .sort((a, b) => a.s - b.s);
  let out = '';
  let pos = 0;
  for (const sp of spans) {
    if (sp.s < pos) continue;
    out += esc(src.slice(pos, sp.s)) + `<mark class="${sp.cls}">${esc(src.slice(sp.s, Math.min(sp.e, src.length)) || ' ')}</mark>`;
    pos = sp.e;
  }
  els.marks.innerHTML = out + esc(src.slice(pos)) + '\n';
}

function syncScroll() {
  const { scrollTop, scrollLeft } = els.code;
  els.hl.scrollTop = els.marks.scrollTop = els.gutter.scrollTop = scrollTop;
  els.hl.scrollLeft = els.marks.scrollLeft = scrollLeft;
}

els.code.addEventListener('scroll', syncScroll);
els.code.addEventListener('input', () => {
  renderEditor();
  scheduleCheck();
});
els.code.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    runOrStop();
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    document.execCommand?.('insertText', false, '  ') || insertAtCursor('  ');
  }
});

function insertAtCursor(text) {
  const ta = els.code;
  const { selectionStart: s, selectionEnd: e } = ta;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  renderEditor();
  scheduleCheck();
}

function selectSpan(span) {
  els.code.focus();
  els.code.setSelectionRange(span.s, span.e);
  const line = lineOf(els.code.value, span.s);
  const lineHeight = parseFloat(getComputedStyle(els.code).lineHeight) || 20;
  els.code.scrollTop = Math.max(0, (line - 4) * lineHeight);
  syncScroll();
}

// ---------------------------------------------------------------- engine --
let worker = null;
let fallbackHandle = null;
let ready = false;
const queue = [];
let nextId = 1;

function startWorker() {
  ready = false;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch {
    useFallback();
    return;
  }
  const timer = setTimeout(() => { if (!ready) useFallback(); }, 4000);
  worker.onmessage = (e) => {
    if (e.data.type === 'ready') {
      ready = true;
      clearTimeout(timer);
      while (queue.length) worker.postMessage(queue.shift());
      return;
    }
    onEngineMessage(e.data);
  };
  worker.onerror = () => { if (!ready) { clearTimeout(timer); useFallback(); } };
}

async function useFallback() {
  if (fallbackHandle) return;
  worker?.terminate();
  worker = null;
  const { handle } = await import('./engine.js');
  fallbackHandle = handle;
  ready = true;
  while (queue.length) send(queue.shift());
}

function send(msg) {
  if (fallbackHandle) {
    // Main-thread fallback: a fuel limit stands in for the worker timeout.
    setTimeout(() => fallbackHandle(msg, onEngineMessage, { sync: false, fuel: 300_000_000 }).catch(showInternalError), 0);
  } else if (worker && ready) worker.postMessage(msg);
  else queue.push(msg);
}

function showInternalError(err) {
  setRunStatus('err', 'Internal compiler error', err?.message ?? String(err));
  setRunning(false);
}

// ------------------------------------------------------------ type check --
let checkId = 0;
let checkTimer = null;
function scheduleCheck() {
  clearTimeout(checkTimer);
  els.checkStatus.className = 'status-chip';
  els.checkStatus.textContent = 'checking…';
  checkTimer = setTimeout(() => {
    checkId = nextId++;
    send({ type: 'check', id: checkId, source: els.code.value });
  }, 220);
}

function applyCheck(msg) {
  diagnostics = msg.diagnostics;
  const errors = msg.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = msg.diagnostics.length - errors;
  if (errors) {
    els.checkStatus.className = 'status-chip err';
    els.checkStatus.textContent = errors === 1 ? '1 error' : `${errors} errors`;
  } else if (warnings) {
    els.checkStatus.className = 'status-chip warn';
    els.checkStatus.textContent = warnings === 1 ? 'types check · 1 warning' : `types check · ${warnings} warnings`;
  } else {
    els.checkStatus.className = 'status-chip ok';
    els.checkStatus.textContent = 'types check';
  }
  renderEditor();
  if (msg.ok) renderSignatures(msg.signatures);
  if (!running) renderDiagnostics(msg.diagnostics);
}

function renderSignatures(sigs) {
  els.typesCount.textContent = sigs.length ? String(sigs.length) : '';
  els.sigs.innerHTML = '';
  for (const s of sigs) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="name">${esc(s.name)}</span><span class="ty">${esc(s.type)}</span>`;
    b.addEventListener('click', () => selectSpan(s.span));
    li.append(b);
    els.sigs.append(li);
  }
}

function renderDiagnostics(list) {
  els.diagnostics.innerHTML = '';
  for (const d of list) {
    const pre = document.createElement('pre');
    pre.className = `diag ${d.severity}`;
    pre.textContent = d.formatted;
    if (d.span) {
      pre.style.cursor = 'pointer';
      pre.title = 'Show in editor';
      pre.addEventListener('click', () => selectSpan(d.span));
    }
    els.diagnostics.append(pre);
  }
}

// ------------------------------------------------------------------- run --
let runId = 0;
let running = false;
let runTimer = null;
let outputLength = 0;

function setRunning(on) {
  running = on;
  els.run.classList.toggle('stop', on);
  els.run.firstChild.textContent = on ? 'Stop ' : 'Run ';
}

function setRunStatus(kind, text, detail = '') {
  const badge = kind === 'ok' ? '<span class="badge ok">ok</span>' : kind === 'err' ? '<span class="badge err">error</span>' : '';
  els.runStatus.innerHTML = `${badge}<span class="msg">${esc(text)}</span>${detail ? `<span class="badge">${esc(detail)}</span>` : ''}`;
}

function runOrStop() {
  if (running) stopRun('Stopped.');
  else run();
}

function run() {
  runId = nextId++;
  setRunning(true);
  outputLength = 0;
  els.out.textContent = '';
  els.out.hidden = false;
  els.runtimeError.hidden = true;
  els.runStats.hidden = true;
  els.diagnostics.innerHTML = '';
  setRunStatus('', 'Compiling…');
  setPipeline({});
  send({ type: 'run', id: runId, source: els.code.value, options: { gcStress: els.stress.checked, compare: els.compare.checked } });
  clearTimeout(runTimer);
  if (!fallbackHandle) runTimer = setTimeout(() => stopRun(`Stopped after ${RUN_TIMEOUT_MS / 1000} s. The program may loop forever.`), RUN_TIMEOUT_MS);
}

function stopRun(message) {
  clearTimeout(runTimer);
  if (fallbackHandle) return; // cannot interrupt the main thread
  worker?.terminate();
  startWorker();
  setRunning(false);
  setRunStatus('err', message);
}

function setPipeline({ timings = {}, wasmSize, run, stats, failedAt }) {
  $('t-parse').textContent = ms(timings.parse);
  $('t-typecheck').textContent = ms(timings.typecheck);
  $('t-lower').textContent = ms(timings.lower);
  $('t-codegen').textContent = ms(timings.codegen);
  $('t-encode').textContent = ms(timings.encode);
  $('t-size').textContent = wasmSize ? bytes(wasmSize) : '–';
  $('t-run').textContent = run == null ? '–' : ms(run);
  $('t-gc').textContent = stats ? `${num(stats.gcCount)} collections · ${bytes(stats.allocatedBytes)}` : '–';
  // On a compile error, mark the phase that failed and dim the ones that never ran.
  const phases = ['parse', 'typecheck', 'lower', 'codegen', 'encode'];
  const failed = failedAt ? phases.find((p) => timings[p] == null) : null;
  let after = false;
  for (const stage of els.pipeline.querySelectorAll('.stage')) {
    const id = stage.querySelector('.v').id.slice(2);
    stage.classList.toggle('failed', id === failed);
    stage.classList.toggle('skipped', after);
    if (id === failed) {
      stage.querySelector('.v').textContent = 'error';
      after = true;
    }
  }
}

let lastCompile = null;
function onEngineMessage(msg) {
  if (msg.type === 'checked') {
    if (msg.id === checkId) applyCheck(msg);
    return;
  }
  if (msg.id !== runId) return;
  switch (msg.type) {
    case 'compiled': {
      lastCompile = msg;
      renderDiagnostics(msg.diagnostics);
      if (!msg.ok) {
        clearTimeout(runTimer);
        setRunning(false);
        diagnostics = msg.diagnostics;
        renderEditor();
        els.out.hidden = true;
        setRunStatus('err', 'Compile error', 'the program never ran');
        setPipeline({ timings: msg.timings, failedAt: true });
        return;
      }
      renderSignatures(msg.signatures);
      els.ir.innerHTML = highlightIr(msg.ir);
      els.wat.innerHTML = highlightWat(msg.wat);
      setRunStatus('', 'Running…');
      setPipeline({ timings: msg.timings, wasmSize: msg.wasmSize });
      return;
    }
    case 'output':
      if (outputLength < MAX_OUTPUT) {
        const text = msg.text.slice(0, MAX_OUTPUT - outputLength);
        els.out.append(text);
        outputLength += msg.text.length;
        if (outputLength >= MAX_OUTPUT) els.out.append('\n… output truncated');
      }
      return;
    case 'ran': {
      clearTimeout(runTimer);
      const c = lastCompile;
      setPipeline({ timings: c.timings, wasmSize: c.wasmSize, run: msg.timeMs, stats: msg.stats });
      const total = Object.values(c.timings).reduce((a, b) => a + b, 0);
      if (msg.error) {
        els.runtimeError.hidden = false;
        els.runtimeError.textContent = `runtime error: ${msg.error}`;
        setRunStatus('err', 'Runtime error', `compiled in ${ms(total)}`);
      } else {
        setRunStatus('ok', `Compiled in ${ms(total)}, ran in ${ms(msg.timeMs)}`, `${bytes(c.wasmSize)} of wasm`);
      }
      els.runStats.hidden = false;
      $('s-time').textContent = ms(msg.timeMs);
      $('s-gc').textContent = num(msg.stats.gcCount);
      $('s-alloc').textContent = bytes(msg.stats.allocatedBytes);
      $('s-live').textContent = bytes(msg.stats.liveBytes);
      $('s-heap').textContent = bytes(msg.stats.heapBytes);
      if (!els.compare.checked) setRunning(false);
      else els.runStatus.insertAdjacentHTML('beforeend', '<span class="badge" id="cmp">interpreter running…</span>');
      return;
    }
    case 'interpreted': {
      setRunning(false);
      const cmp = $('cmp');
      if (!cmp) return;
      if (msg.match) {
        cmp.className = 'badge ok';
        cmp.textContent = `interpreter agrees, byte for byte (${ms(msg.timeMs)})`;
      } else if (msg.error === 'out of fuel') {
        cmp.textContent = 'interpreter skipped: program too long for it';
      } else {
        cmp.className = 'badge err';
        cmp.textContent = 'interpreter DISAGREES';
      }
    }
  }
}

// ------------------------------------------------------------- examples --
const exampleBySlug = new Map(EXAMPLES.map(([file, title, note]) => [file.replaceAll('_', '-'), { file, title, note }]));
for (const [file, title] of EXAMPLES) els.example.add(new Option(title, file.replaceAll('_', '-')));

async function loadExample(slug, { runAfter = true } = {}) {
  const ex = exampleBySlug.get(slug) ?? exampleBySlug.get('hello');
  els.example.value = ex.file.replaceAll('_', '-');
  els.fileName.textContent = `${ex.file}.lm`;
  els.note.textContent = ex.note;
  let src;
  try {
    const res = await fetch(new URL(`../examples/${ex.file}.lm`, import.meta.url));
    if (!res.ok) throw new Error(res.statusText);
    src = await res.text();
  } catch (err) {
    src = `// Could not load examples/${ex.file}.lm (${err.message}).\nfn main() { println("Hello from WebAssembly!") }\n`;
  }
  els.code.value = src;
  els.code.scrollTop = 0;
  diagnostics = [];
  renderEditor();
  scheduleCheck();
  if (runAfter) run();
}

els.example.addEventListener('change', () => {
  history.replaceState(null, '', `#${els.example.value}`);
  if (running) stopRun('Stopped.');
  loadExample(els.example.value);
});
window.addEventListener('hashchange', () => {
  const slug = location.hash.slice(1);
  if (exampleBySlug.has(slug) && slug !== els.example.value) loadExample(slug);
});
els.run.addEventListener('click', runOrStop);
els.run.querySelector('kbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ ↵' : 'Ctrl ↵';

for (const [box, key] of [[els.stress, 'stress'], [els.compare, 'compare']]) {
  const saved = store.get(key, null);
  if (saved !== null) box.checked = saved === '1';
  box.addEventListener('change', () => store.set(key, box.checked ? '1' : '0'));
}

// ------------------------------------------------------------------ tabs --
const tabs = [...document.querySelectorAll('.tab')];
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
  store.set('tab', tab.id);
}
tabs.forEach((t) => t.addEventListener('click', () => selectTab(t)));
const savedTab = $(store.get('tab', 'tab-output'));
if (savedTab?.classList.contains('tab')) selectTab(savedTab);

// ---------------------------------------------------------------- fuzzer --
const mutBody = document.querySelector('#mutants tbody');
for (const [name, n] of MUTATION_RESULTS) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${esc(name)}</td><td class="num">${n === 1 ? '1 program' : `${n} programs`}</td>`;
  mutBody.append(tr);
}

let fuzzWorker = null;
let fuzzStart = 0;
let fuzzBase = { programs: 0, agreed: 0, runtimeErrors: 0, mismatches: 0, gcs: 0 };
let fuzzTotals = { ...fuzzBase };
const fuzzBtn = $('fuzz-toggle');

function renderFuzz(t) {
  $('f-programs').textContent = num(t.programs);
  $('f-agreed').textContent = num(t.agreed);
  $('f-errors').textContent = num(t.runtimeErrors);
  $('f-mismatches').textContent = num(t.mismatches);
  $('f-gcs').textContent = num(t.gcs);
  $('f-mismatch-card').className = `stat ${t.mismatches ? 'bad' : ''}`;
  const secs = (performance.now() - fuzzStart) / 1000;
  const session = t.programs - fuzzBase.programs;
  $('f-rate').textContent = secs > 0.5 && session > 0 ? (session / secs).toFixed(1) : '–';
}

function toggleFuzz() {
  if (fuzzWorker) {
    fuzzWorker.terminate();
    fuzzWorker = null;
    fuzzBtn.textContent = 'Resume fuzzing';
    fuzzBtn.classList.remove('stop');
    fuzzBase = { ...fuzzTotals };
    return;
  }
  try {
    fuzzWorker = new Worker(new URL('./fuzz-worker.js', import.meta.url), { type: 'module' });
  } catch {
    $('fuzz-program').textContent = 'This browser could not start a Web Worker, so the live fuzzer is unavailable here. Run it locally with: node fuzz/fuzz.js --count 1000';
    return;
  }
  fuzzStart = performance.now();
  fuzzBtn.textContent = 'Stop fuzzing';
  fuzzBtn.classList.add('stop');
  const base = { ...fuzzBase };
  fuzzWorker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      fuzzTotals = Object.fromEntries(Object.keys(base).map((k) => [k, base[k] + m.totals[k]]));
      renderFuzz(fuzzTotals);
      $('fuzz-program-title').textContent = `Latest generated program (seed ${m.seed}${m.error ? `, ended with: ${m.error}` : ''})`;
      $('fuzz-program').innerHTML = highlight(m.source);
    } else if (m.type === 'mismatch') {
      $('fuzz-program-title').textContent = `Mismatch at seed ${m.seed}: ${m.detail}`;
      $('fuzz-program').innerHTML = highlight(m.source);
    }
  };
  fuzzWorker.onerror = () => {
    $('fuzz-program').textContent = 'The fuzzer worker failed to start in this browser. Run it locally with: node fuzz/fuzz.js --count 1000';
    fuzzWorker = null;
    fuzzBtn.textContent = 'Start fuzzing';
    fuzzBtn.classList.remove('stop');
  };
  fuzzWorker.postMessage({ seed: Math.floor(Math.random() * 1e9) + fuzzTotals.programs, size: Number($('fuzz-size').value) });
}
fuzzBtn.addEventListener('click', toggleFuzz);

// ------------------------------------------------------------------ boot --
startWorker();
loadExample(location.hash.slice(1) || 'red-black-tree');
