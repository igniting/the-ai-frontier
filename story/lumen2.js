// The story's Lumen 2 chapters: wires their live demos to a worker running
// the Lumen 2 compiler (story/lumen2-worker.js).

const $ = (id) => document.getElementById(id);
const num = (n) => n.toLocaleString('en-US');
const ms = (x) => (x < 10 ? `${x.toFixed(1)} ms` : `${Math.round(x)} ms`);
const secs = (x) => (x < 1000 ? ms(x) : `${(x / 1000).toFixed(1)} s`);
const kib = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);
const unsupported = 'This browser could not start a Web Worker, so this demo cannot run here.';

let w = null, nextId = 1;
const pending = new Map();
function ask(msg, onProgress) {
  if (!w) {
    try { w = new Worker(new URL('./lumen2-worker.js', import.meta.url), { type: 'module' }); } catch { return Promise.reject(new Error(unsupported)); }
    w.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      if (data.progress) { p.onProgress?.(data); return; }
      pending.delete(data.id);
      p.resolve(data);
    };
  }
  const id = nextId++;
  return new Promise((resolve) => { pending.set(id, { resolve, onProgress }); w.postMessage({ ...msg, id }); });
}

// Disables a button while its request runs, and reports failures in place.
async function busy(btn, out, work) {
  btn.disabled = true;
  try { await work(); } catch (e) { out.className = 'out err'; out.textContent = e.message; } finally { btn.disabled = false; }
}
const showErrors = (out, errors) => { out.className = 'out err'; out.textContent = errors.join('\n\n'); };
const pad = (rows) => { const n = Math.max(...rows.map((r) => r[0].length)); return rows.map(([a, b]) => `${a.padEnd(n)} : ${b}`).join('\n'); };

// ------------------------------------------------------------ effects --
$('fx-run').addEventListener('click', () => {
  const out = $('fx-out');
  return busy($('fx-run'), out, async () => {
    const grants = $('fx-grant').checked ? ['output', 'random'] : ['output'];
    const r = await ask({ type: 'signatures', source: $('fx-code').value, grants });
    if (!r.ok) return showErrors(out, r.errors);
    out.className = 'out';
    out.textContent = pad(r.signatures.map((s) => [s.name, s.type]));
  });
});
$('fx-grant').addEventListener('change', () => $('fx-run').click());

// ------------------------------------------------------- refinements --
$('rf-run').addEventListener('click', () => {
  const out = $('rf-out');
  return busy($('rf-run'), out, async () => {
    out.className = 'out';
    out.textContent = 'Proving…';
    const r = await ask({ type: 'obligations', source: $('rf-code').value });
    if (!r.ok) return showErrors(out, r.errors);
    const lines = r.obligations.map((o) => {
      const what = o.kind === 'partial' ? o.what : `${o.what}: refinement`;
      const how = o.status === 'proved'
        ? `proved: ${o.lemmas ? `${num(o.lemmas)} learned clause${o.lemmas === 1 ? '' : 's'}` : 'propagation alone, no learned clauses'}, ${num(o.clauses)} clauses`
        : `NOT proved: ${o.counterexample ?? 'no proof found'}`;
      return `${o.status === 'proved' ? '✓' : '○'} line ${String(o.line).padEnd(3)} ${what}\n              ${how}`;
    });
    const proved = r.obligations.filter((o) => o.status === 'proved').length;
    out.textContent = `${lines.join('\n')}\n\n${proved} of ${r.obligations.length} proved and checked in ${ms(r.ms)}. Inferred:\n${pad(r.signatures.map((s) => [s.name, s.type]))}`;
  });
});

// ------------------------------------------------------------ memory --
$('mm-run').addEventListener('click', () => {
  const out = $('mm-out'), meta = $('mm-meta');
  return busy($('mm-run'), out, async () => {
    out.className = 'out';
    out.textContent = 'Compiling…';
    meta.textContent = '';
    const r = await ask({ type: 'run', source: $('mm-code').value });
    if (!r.ok) return showErrors(out, r.errors);
    out.textContent = r.output + (r.error ? `runtime error: ${r.error}` : '');
    meta.innerHTML = `<b>${num(r.allocs)}</b> allocations · <b>${r.live === null ? 'stopped early' : num(r.live)}</b> objects still live at exit · ${kib(r.bytes)} of WebAssembly, compiled in ${ms(r.compileMs)}, ran in ${ms(r.runMs)}`;
  });
});

// ------------------------------------------------------- planted bugs --
$('pb-run').addEventListener('click', () => {
  const out = $('pb-out'), verdict = $('pb-verdict');
  return busy($('pb-run'), out, async () => {
    verdict.hidden = true;
    out.hidden = true;
    const r = await ask({ type: 'plant', source: $('pb-code').value, mutant: $('pb-bug').value });
    out.hidden = false;
    if (!r.ok) return showErrors(out, r.errors);
    out.className = 'out';
    verdict.hidden = false;
    if (r.caught) {
      verdict.className = 'verdict ok';
      verdict.textContent = `✓ Caught at compile time by ${r.by}. No code was produced.`;
      out.textContent = r.message;
    } else {
      verdict.className = `verdict ${$('pb-bug').value ? 'bad' : 'ok'}`;
      verdict.textContent = $('pb-bug').value
        ? 'This bug got past the certificate checkers on this program; the dynamic checks must catch it.'
        : `Every certificate checked. The program ran, and ${r.live === 0 ? 'freed every object it allocated' : `left ${r.live} objects live`}.`;
      out.textContent = r.output + (r.error ? `runtime error: ${r.error}` : '');
    }
  });
});
$('pb-bug').addEventListener('change', () => $('pb-run').click());

// ------------------------------------------------------------- Schur --
function schur(k, n, refute) {
  const buttons = [$('l2-s3'), $('l2-s44')];
  const cell = (step) => document.querySelector(`#l2-steps tr[data-step="${step}"] td:last-child`);
  const verdict = $('l2-verdict'), groupsEl = $('l2-groups');
  const mark = (step, ok, text) => { const c = cell(step); c.className = `verdict-cell ${ok ? 'ok' : 'bad'}`; c.textContent = text; };
  buttons.forEach((b) => { b.disabled = true; });
  for (const td of document.querySelectorAll('#l2-steps td:last-child')) { td.className = 'verdict-cell'; td.textContent = '…'; }
  if (!refute) for (const s of ['refute', 'check']) cell(s).textContent = 'skipped: about five minutes';
  cell('encode').textContent = 'compiling the encoder and both solvers…';
  verdict.hidden = true;
  groupsEl.hidden = true;
  const progress = (m) => {
    if (m.step === 'encode') {
      mark('encode', m.agree, `${m.agree ? '✓' : '✗'} ${num(m.clauses[0])} and ${num(m.clauses[1])} clauses, ${m.agree ? 'identical' : 'DIFFERENT'}`);
      cell('witness').textContent = 'searching…';
    } else if (m.step === 'witness') {
      mark('witness', m.ok, m.ok ? `✓ found in ${secs(m.ms)} (${num(m.conflicts)} conflicts); every group is sum-free` : `✗ ${m.error}`);
      if (m.groups) { groupsEl.hidden = false; groupsEl.textContent = m.groups.map((g, i) => `group ${i + 1}: ${g.join(' ')}`).join('\n'); }
      cell(refute ? 'refute' : 'same').textContent = refute ? 'searching…' : 'running Lumen’s solver…';
    } else if (m.step === 'refute') {
      mark('refute', !m.sat, m.sat ? '✗ a split exists?!' : `✓ refuted: ${num(m.lemmas)} learned clauses in ${secs(m.ms)}`);
    } else if (m.step === 'check') {
      mark('check', m.ok, m.ok ? `✓ all ${num(m.lemmas)} steps valid (${secs(m.ms)})` : `✗ rejected: ${m.reason}`);
      cell('same').textContent = 'running Lumen’s solver…';
    } else if (m.step === 'same') {
      mark('same', m.same, m.same ? `✓ identical, all ${num(m.bytes)} bytes` : '✗ the outputs DIFFER');
    }
  };
  ask({ type: 'schur', k, n, refute }, progress).then((r) => {
    buttons.forEach((b) => { b.disabled = false; });
    verdict.hidden = false;
    if (!r.ok) { verdict.className = 'verdict bad'; verdict.textContent = `Failed: ${r.errors.join('; ')}`; return; }
    const ok = refute ? r.proved && r.same : r.same;
    verdict.className = `verdict ${ok ? 'ok' : 'bad'}`;
    verdict.textContent = refute
      ? (r.proved ? `✓ Proved in Lumen 2: S(${k}) = ${n}. ${r.same ? 'Lumen’s solver printed exactly the same proof.' : 'But Lumen’s solver printed something different.'}` : 'Not proved.')
      : (r.same ? `✓ Both solvers found the same split of 1 to ${n}, conflict for conflict: their outputs are byte-identical.` : 'The two solvers disagree.');
  }, (e) => { buttons.forEach((b) => { b.disabled = false; }); verdict.hidden = false; verdict.className = 'verdict bad'; verdict.textContent = e.message; });
}
$('l2-s3').addEventListener('click', () => schur(3, 13, true));
$('l2-s44').addEventListener('click', () => schur(4, 44, false));

// ---------------------------------------------------- proved heapsort --
$('hs-run').addEventListener('click', () => {
  const out = $('hs-out'), meta = $('hs-meta');
  return busy($('hs-run'), out, async () => {
    out.className = 'out';
    out.textContent = 'Proving every access, then compiling and running…';
    meta.textContent = '';
    const src = $('hs-code').value;
    const c = await ask({ type: 'obligations', source: src });
    if (!c.ok) return showErrors(out, c.errors);
    const r = await ask({ type: 'run', source: src });
    if (!r.ok) return showErrors(out, r.errors);
    const proved = c.obligations.filter((o) => o.status === 'proved').length;
    const failing = c.signatures.filter((s) => / ! .*fail|! fail/.test(s.type)).map((s) => s.name);
    const unproved = c.obligations.filter((o) => o.status !== 'proved').map((o) => `  line ${o.line}: ${o.what}: ${o.counterexample ?? 'not proved'}`);
    out.textContent = `${r.output}${r.error ? `runtime error: ${r.error}\n` : ''}\n${pad(c.signatures.map((s) => [s.name, s.type]))}`
      + (unproved.length ? `\n\nNot proved:\n${unproved.join('\n')}` : '');
    meta.innerHTML = `<b>${proved} of ${c.obligations.length}</b> obligations proved in ${secs(c.ms)} · `
      + (failing.length ? `can fail: <b>${failing.join(', ')}</b>` : '<b>no function can fail</b>, not even <code>main</code>')
      + ` · <b>${num(r.allocs)}</b> allocations · ran in ${ms(r.runMs)}`;
  });
});

// ------------------------------------------------- self-hosting, live --
$('boot2-run').addEventListener('click', () => {
  const btn = $('boot2-run'), verdict = $('boot2-verdict');
  const cell = (step) => document.querySelector(`#boot2-steps tr[data-step="${step}"] td:last-child`);
  btn.disabled = true;
  verdict.hidden = true;
  for (const td of document.querySelectorAll('#boot2-steps td:last-child')) { td.className = 'verdict-cell'; td.textContent = '…'; }
  cell('stage1').textContent = 'compiling lumen2c.lm with the reference compiler…';
  const done = (m) => `${num(m.bytes)} bytes in ${secs(m.ms)}${m.allocs ? `, ${num(m.allocs)} allocations, ${m.live === 0 ? 'nothing leaked' : `${m.live} leaked`}` : ''} · ${m.hash}`;
  ask({ type: 'bootstrap' }, (m) => {
    const c = cell(m.step);
    c.className = 'verdict-cell ok';
    c.textContent = done(m);
    const next = m.step === 'stage1' ? 'stage2' : m.step === 'stage2' ? 'stage3' : null;
    if (next) cell(next).textContent = 'compiling…';
  }).then((r) => {
    btn.disabled = false;
    verdict.hidden = false;
    if (!r.ok) { verdict.className = 'verdict bad'; verdict.textContent = `Failed: ${r.errors.join('; ')}`; return; }
    verdict.className = `verdict ${r.same ? 'ok' : 'bad'}`;
    verdict.textContent = r.same ? '✓ Fixed point: the compiler, compiled by itself, reproduced itself byte for byte.' : '✗ Stage 2 and stage 3 differ.';
  }, (e) => { btn.disabled = false; verdict.hidden = false; verdict.className = 'verdict bad'; verdict.textContent = e.message; });
});

// ------------------------------------------ the compiler compiles itself --
$('boot3-run').addEventListener('click', () => {
  const btn = $('boot3-run'), verdict = $('boot3-verdict');
  const cell = (step) => document.querySelector(`#boot3-steps tr[data-step="${step}"] td:last-child`);
  btn.disabled = true;
  verdict.hidden = true;
  for (const td of document.querySelectorAll('#boot3-steps td:last-child')) { td.className = 'verdict-cell'; td.textContent = '…'; }
  cell('load').textContent = 'fetching the compiler and its source…';
  ask({ type: 'selfCompile' }, (m) => {
    const c = cell(m.step);
    c.className = 'verdict-cell ok';
    if (m.step === 'load') { c.textContent = `${num(m.bytes)} bytes · ${m.hash} · its source: ${num(m.lines)} lines`; cell('build').textContent = 'compiling (this takes a while)…'; }
    else c.textContent = `${num(m.bytes)} bytes in ${secs(m.ms)} · ${m.hash}`;
  }).then((r) => {
    btn.disabled = false;
    verdict.hidden = false;
    if (!r.ok) { verdict.className = 'verdict bad'; verdict.textContent = `Failed: ${r.errors.join('; ')}`; return; }
    verdict.className = `verdict ${r.same ? 'ok' : 'bad'}`;
    verdict.textContent = r.same ? '✓ Fixed point: the compiler compiled its own source into itself, byte for byte.' : '✗ The output differs from the compiler that wrote it.';
  }, (e) => { btn.disabled = false; verdict.hidden = false; verdict.className = 'verdict bad'; verdict.textContent = e.message; });
});
