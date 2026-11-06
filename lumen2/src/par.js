// par_map on threads: the control block the main thread and the workers share,
// and the loop each of them runs. Node only (worker_threads); runtime.js loads
// this when a program was compiled in threads mode.
//
// Control block (Int32Array on a SharedArrayBuffer): the task's generation,
// the next index to take, the limit (no index at or above it is started), the
// number of workers still running the task, how many have started (and
// whether one failed to), the stop flag, and how many indices a thread takes
// at a time; then a slot per thread: the index of the element that failed
// (-1 if none), how it failed (1: a runtime error, a: its code; 2: panic, a
// and b: the message's address and length; 3: stack overflow; 4: an internal
// error), and the instance's live and allocation counts.
export const CTRL = { gen: 0, next: 1, limit: 2, running: 3, ready: 4, stop: 5, startError: 6, block: 7 };
const SLOTS = 8;
const SLOT_SIZE = 6;
export const slotOf = (tid) => SLOTS + tid * SLOT_SIZE;

// Takes blocks of indices until none is left below the limit, and computes
// each block's elements in order. An element that fails lowers the limit to
// its index: every index below it was already taken, by some thread that
// finishes it (or fails sooner), so the lowest failing index found is the
// first one a sequential map would have stopped at.
export function work(ctrl, item, record) {
  const block = ctrl[CTRL.block];
  for (;;) {
    const lo = Atomics.add(ctrl, CTRL.next, block);
    const hi = lo + block;
    for (let i = lo; i < hi; i++) {
      if (i >= Atomics.load(ctrl, CTRL.limit)) return;
      try {
        item(i);
      } catch (e) {
        record(i, e);
        let lim = Atomics.load(ctrl, CTRL.limit);
        while (i < lim) {
          const prev = Atomics.compareExchange(ctrl, CTRL.limit, lim, i);
          if (prev === lim) break;
          lim = prev;
        }
        return;
      }
    }
  }
}

// A pool of count - 1 workers (the main thread is the count-th), each with an
// instance of the module on the shared memory.
export function makePool(module, memory, count) {
  const { Worker } = process.getBuiltinModule('node:worker_threads');
  const workers = Math.max(0, count - 1);
  const ctrl = new Int32Array(new SharedArrayBuffer(4 * (SLOTS + SLOT_SIZE * (workers + 1))));
  const threads = [];
  for (let t = 1; t <= workers; t++) {
    const w = new Worker(new URL('./par-worker.js', import.meta.url), { workerData: { module, memory, ctrl, tid: t }, resourceLimits: { stackSizeMb: 256 } });
    w.unref();
    w.on('error', () => {});
    threads.push(w);
  }
  // Wait for them to start (they run on their own while this thread blocks).
  for (let r; (r = Atomics.load(ctrl, CTRL.ready)) < workers;) {
    if (Atomics.wait(ctrl, CTRL.ready, r, 60000) === 'timed-out') throw new Error('par_map: the worker threads did not start');
  }
  if (Atomics.load(ctrl, CTRL.startError)) throw new Error('par_map: a worker thread could not start');

  return {
    threads: workers + 1,
    // Runs a task of n elements on every thread; item(i) computes element i on
    // this one. Returns the first failure, as { index, kind, a, b, error }, or null.
    run(n, item) {
      for (let t = 0; t <= workers; t++) ctrl[slotOf(t)] = -1;
      Atomics.store(ctrl, CTRL.next, 0);
      Atomics.store(ctrl, CTRL.limit, n);
      // Blocks small enough that every thread gets several (to share the work
      // out evenly), and at most 64 elements.
      Atomics.store(ctrl, CTRL.block, Math.max(1, Math.min(64, Math.floor(n / (16 * (workers + 1))))));
      Atomics.store(ctrl, CTRL.running, workers);
      Atomics.add(ctrl, CTRL.gen, 1);
      Atomics.notify(ctrl, CTRL.gen);
      let mine = null;
      work(ctrl, item, (i, e) => { mine = { index: i, error: e }; });
      for (let r; (r = Atomics.load(ctrl, CTRL.running)) !== 0;) Atomics.wait(ctrl, CTRL.running, r);
      let first = mine;
      for (let t = 1; t <= workers; t++) {
        const s = slotOf(t);
        const i = ctrl[s];
        if (i >= 0 && (first === null || i < first.index)) first = { index: i, kind: ctrl[s + 1], a: ctrl[s + 2], b: ctrl[s + 3], error: null };
      }
      return first;
    },
    // The workers' live and allocation counts (to add to the main thread's).
    counts() {
      let live = 0, allocs = 0;
      for (let t = 1; t <= workers; t++) { live += ctrl[slotOf(t) + 4]; allocs += ctrl[slotOf(t) + 5]; }
      return { live, allocs };
    },
    close() {
      Atomics.store(ctrl, CTRL.stop, 1);
      Atomics.add(ctrl, CTRL.gen, 1);
      Atomics.notify(ctrl, CTRL.gen);
      for (const w of threads) w.terminate();
    },
  };
}

// How many threads to use: LUMEN2_THREADS, or one per core.
export function threadCount() {
  const env = Number(process.env.LUMEN2_THREADS);
  if (env >= 1) return Math.floor(env);
  return process.getBuiltinModule('node:os').availableParallelism();
}

// The module's starting memory size, from its custom section (threads mode).
export function minPages(module) {
  const [sec] = WebAssembly.Module.customSections(module, 'lumen2.threads');
  const b = new Uint8Array(sec);
  let n = 0, shift = 0;
  for (let i = 0; i < b.length; i++) { n |= (b[i] & 0x7f) << shift; shift += 7; if (!(b[i] & 0x80)) break; }
  return n;
}
