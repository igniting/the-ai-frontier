// The self-hosted compiler in the browser. `lumenc` is Lumen's compiler
// written in Lumen (selfhost/lumenc.lm). This worker compiles it with the
// JavaScript compiler (stage 1), lets that binary compile lumenc's own
// source (stage 2), and lets stage 2 do it again (stage 3): all three must
// be byte-identical. It can also compile the editor's program with lumenc
// and compare the result with the JavaScript compiler's output.

import { compile, runWasm } from '../src/compiler.js';
import { PRELUDE } from '../src/prelude.js';

const enc = new TextEncoder();
const prelude = enc.encode(PRELUDE);
const now = () => performance.now();
const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
async function sha256(bytes) {
  try {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
  } catch { return null; } // crypto.subtle needs a secure context
}

// lumenc's input: "<mode> <prelude length>\n", the prelude, then the program.
function input(mode, program) {
  const head = enc.encode(`${mode} ${prelude.length}\n`);
  const out = new Uint8Array(head.length + prelude.length + program.length);
  out.set(head, 0); out.set(prelude, head.length); out.set(program, head.length + prelude.length);
  return out;
}

let lumencSource = null, stage1 = null;
async function source() {
  lumencSource ??= enc.encode(await (await fetch(new URL('../selfhost/lumenc.lm', import.meta.url))).text());
  return lumencSource;
}
async function getStage1(post) {
  if (stage1) return stage1;
  const src = await source();
  const t = now();
  const c = compile(new TextDecoder().decode(src));
  if (!c.ok) throw new Error(`lumenc did not compile: ${c.errors[0].message}`);
  stage1 = c.wasm;
  post?.({ type: 'stage', n: 1, ms: now() - t, bytes: stage1.length, sha: await sha256(stage1), lines: new TextDecoder().decode(src).split('\n').length });
  return stage1;
}

// lumenc reports a compile error as a panic "@start-end phase: message".
const lumencError = (e) => {
  const m = /^panic: @(\d+)-(\d+) (\w+): ([\s\S]*)$/.exec(e ?? '');
  return m ? { phase: m[3], message: m[4], start: +m[1], end: +m[2] } : { phase: 'runtime', message: e };
};

self.onmessage = async ({ data }) => {
  const post = (m) => self.postMessage({ ...m, job: data.job });
  try {
    if (data.type === 'bootstrap') {
      const s1 = await getStage1(post);
      const src = await source();
      let prev = s1;
      const stages = [s1];
      for (const n of [2, 3]) {
        const t = now();
        const r = runWasm(prev, { input: input('wasm', src) });
        if (r.error) throw new Error(`stage ${n} failed: ${r.error}`);
        const out = bytesOf(r.output);
        stages.push(out);
        post({ type: 'stage', n, ms: now() - t, bytes: out.length, sha: await sha256(out), gcs: r.stats.gcCount });
        prev = out;
      }
      post({ type: 'verdict', identical: same(stages[0], stages[1]) && same(stages[1], stages[2]) });
    } else if (data.type === 'compile') {
      const s1 = await getStage1();
      const program = enc.encode(data.source);
      const t = now();
      const r = runWasm(s1, { input: input('wasm', program) });
      const ms = now() - t;
      const ref = compile(data.source);
      if (r.error) {
        post({ type: 'compiled', ok: false, ms, lumenc: lumencError(r.error), reference: ref.ok ? null : ref.errors[0].message });
        return;
      }
      const wasm = bytesOf(r.output);
      const run = runWasm(wasm, { input: '' });
      post({
        type: 'compiled', ok: true, ms, bytes: wasm.length, identical: ref.ok && same(wasm, ref.wasm),
        referenceBytes: ref.ok ? ref.wasm.length : null, output: run.output, error: run.error,
      });
    }
  } catch (e) {
    post({ type: 'failed', message: e.message });
  }
};
