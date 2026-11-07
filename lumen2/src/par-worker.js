// A thread for par_map (see runtime.js): an instance of the program's module
// on the shared memory, computing elements of each parallel task as the main
// thread posts it. The function it runs cannot do input or output (the
// checker makes sure), so the only host calls it can make are failures.

import { workerData } from 'node:worker_threads';
import { CTRL, work, slotOf } from './par.js';
import { floatHost } from './floats.js';

const { module, memory, ctrl, tid } = workerData;

class Failure { constructor(kind, a, b) { this.kind = kind; this.a = a; this.b = b; } }
const impossible = () => { throw new Failure(4, 0, 0); };
const env = {
  memory,
  write: impossible, input_len: impossible, input_read: impossible, line_len: impossible, line_read: impossible,
  clock: impossible, random: impossible, par: impossible,
  fail: (code) => { throw new Failure(1, code, 0); },
  panic: (ptr, len) => { throw new Failure(2, ptr, len); },
  // Floats as text: pure, so a parallel task may use them.
  ...floatHost((ptr, len) => new Uint8Array(memory.buffer, ptr, len)),
};

let instance;
try {
  instance = new WebAssembly.Instance(module, { env });
  instance.exports.par_init();
} catch (e) {
  Atomics.store(ctrl, CTRL.startError, 1);
  Atomics.add(ctrl, CTRL.ready, 1);
  Atomics.notify(ctrl, CTRL.ready);
  throw e;
}
Atomics.add(ctrl, CTRL.ready, 1);
Atomics.notify(ctrl, CTRL.ready);

const slot = slotOf(tid);
const record = (i, e) => {
  const [kind, a, b] = e instanceof Failure ? [e.kind, e.a, e.b] : e instanceof RangeError && /call stack/i.test(e.message) ? [3, 0, 0] : [4, 0, 0];
  ctrl[slot + 1] = kind; ctrl[slot + 2] = a; ctrl[slot + 3] = b;
  Atomics.store(ctrl, slot, i);
};

let gen = 0;
for (;;) {
  Atomics.wait(ctrl, CTRL.gen, gen);
  gen = Atomics.load(ctrl, CTRL.gen);
  if (Atomics.load(ctrl, CTRL.stop)) break;
  work(ctrl, (i) => instance.exports.par_item(i), record);
  ctrl[slot + 4] = instance.exports.live.value;
  ctrl[slot + 5] = instance.exports.allocs.value;
  if (Atomics.sub(ctrl, CTRL.running, 1) === 1) Atomics.notify(ctrl, CTRL.running);
}
