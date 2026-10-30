// Code generation: reference-counted IR -> WebAssembly.
//
// Values. Int is an i64. Bool, () and the constructors of a type whose
// constructors carry no fields are i32 immediates. Everything else is an i32
// pointer to a heap object, except that a constructor without fields is the
// immediate value of its tag; no heap object lives below address 1024, so a
// value under 1024 is never a pointer.
//
// Heap objects start with a header: the reference count (i32, offset 0) and a
// tag (i32, offset 4). Fields follow in 8-byte slots from offset 8.
//   constructor  tag = constructor index, fields = its arguments
//   tuple        tag = 0
//   String       offset 4 = length in bytes, bytes from offset 8
//   Array        offset 4 = length, offset 8 = capacity, elements from offset 16
//   closure      tag = table index of its code, slot 0 = table index of the
//                function that releases its captures, captures from slot 1
// A negative count marks a static object (string literals, closures without
// captures), which is never freed. A count of 0 marks a freed object; touching
// one is the runtime error `use after free`, which a correct compiler never
// produces. In paranoid mode freed memory is never reused, so every use of a
// dangling pointer is caught.
//
// Memory is allocated in power-of-two size classes with a free list per class.
// The `live` global counts allocated objects; a program that has finished must
// have freed everything, so `live` must be 0 (the test harness checks this).

import { Module } from './wasm.js';
import { lowerProgram, tkey, valtype } from './lower.js';
import { perceus, makeHeapTest } from './perceus.js';
import { insertReuse } from './reuse.js';
import { substParams } from './types.js';
import { makeHost } from './host.js';

export const FAILURES = ['', 'integer overflow', 'division by zero', 'index out of bounds', 'out of memory', 'string too long', 'use after free'];
const OVERFLOW = 1, DIVZERO = 2, BOUNDS = 3, OOM = 4, STRLONG = 5, UAF = 6;
const IMM = 1024; // values below this are immediates
const FREE_LISTS = 64; // one i32 list head per size class
const SCRATCH = 256; // digit buffer for int_to_string
const DATA = 1024; // static objects start here
const MAX_ARRAY = 2 ** 24 - 1;
const MAX_STRING = 2 ** 24 - 1;
const MAX_PAGES = 16384; // 1 GiB
const INT_MIN = -(1n << 63n);

// Instruction helpers. A body is a nested list of instructions; flat() expands it.
const get = (n) => ['local.get', n];
const set = (n) => ['local.set', n];
const tee = (n) => ['local.tee', n];
const i32 = (v) => ['i32.const', v];
const i64 = (v) => ['i64.const', v];
const call = (f) => ['call', f];
const fail = (code) => [i32(code), call('rt_fail'), ['unreachable']];
const flat = (x) => (Array.isArray(x) && typeof x[0] === 'string' ? [x] : x.flatMap(flat));

// Options: paranoid (never reuse freed memory), reuse (Perceus reuse, on by
// default) and mutant (plant a known bug; see test/fuzz.js).
export function compileProgram(program, { paranoid = false, reuse = true, mutant = null } = {}) {
  const ir = lowerProgram(program);
  const isHeap = makeHeapTest(program.adts);
  for (const f of ir.fns) {
    perceus(f, isHeap, mutant);
    if (reuse) insertReuse(f, program.adts, mutant);
  }

  const m = new Module();
  const made = new Set();
  const data = [];
  const dataAddr = () => DATA + data.length;

  const fn = (name, params, results, locals, body) => m.addFunc({
    name,
    params: params.map(([n, t]) => ({ name: n, type: t })),
    results,
    locals: locals.map(([n, t]) => ({ name: n, type: t })),
    body: flat(body),
  });

  const isInt = (t) => t.k === 'con' && t.name === 'Int';
  const adt = (t) => (t.k === 'con' ? program.adts.get(t.name) : undefined);
  const load = (t, off) => [valtype(t) === 'i64' ? 'i64.load' : 'i32.load', off];
  const store = (t, off) => [valtype(t) === 'i64' ? 'i64.store' : 'i32.store', off];
  const chk = () => (paranoid ? [call('rt_chk')] : []);

  function variants(t) {
    const d = adt(t);
    const sub = new Map(d.params.map((p, i) => [p, t.args[i]]));
    return d.ctors.map((c) => ({ idx: c.idx, fields: c.fieldTypes.map((f) => substParams(f, sub)) }));
  }

  // ------------------------------------------------------------ static data --
  function pushI32(v) { for (let i = 0; i < 4; i++) data.push((v >>> (8 * i)) & 0xff); }
  const pad = () => { while (data.length % 8) data.push(0); };
  const strings = new Map();
  function staticString(s) {
    if (!strings.has(s)) {
      pad();
      strings.set(s, dataAddr());
      pushI32(-1); pushI32(s.length);
      for (let i = 0; i < s.length; i++) data.push(s.charCodeAt(i) & 0xff);
      pad();
    }
    return strings.get(s);
  }
  const closures = new Map();
  function staticClosure(name) {
    if (!closures.has(name)) {
      pad();
      closures.set(name, dataAddr());
      pushI32(-1); pushI32(m.tableSlot(name)); pushI32(0); pushI32(0);
    }
    return closures.get(name);
  }

  // ---------------------------------------------------------------- runtime --
  m.importFunc('env', 'write', 'host_write', ['i32', 'i32'], []);
  m.importFunc('env', 'input_len', 'host_input_len', [], ['i32']);
  m.importFunc('env', 'input_read', 'host_input_read', ['i32'], []);
  m.importFunc('env', 'fail', 'host_fail', ['i32'], []);
  m.importFunc('env', 'panic', 'host_panic', ['i32', 'i32'], []);
  m.importFunc('env', 'clock', 'host_clock', [], ['i64']);
  m.importFunc('env', 'random', 'host_random', ['i64', 'i64'], ['i64']);
  m.addGlobal('hp', 'i32', true, 0);
  m.addGlobal('live', 'i32', true, 0);
  m.addGlobal('allocs', 'i32', true, 0);

  fn('rt_fail', [['code', 'i32']], [], [], [get('code'), call('host_fail'), ['unreachable']]);

  // Size class of an allocation: log2 of the block size, at least 16 bytes.
  fn('rt_class', [['size', 'i32']], ['i32'], [], [
    get('size'), i32(16), ['i32.le_u'], ['if', null, 'i32'], i32(4),
    ['else'], i32(32), get('size'), i32(1), ['i32.sub'], ['i32.clz'], ['i32.sub'], ['end'],
  ]);

  const head = (c) => [get(c), i32(2), ['i32.shl']];
  fn('rt_alloc', [['size', 'i32']], ['i32'], [['c', 'i32'], ['p', 'i32'], ['top', 'i32']], [
    get('size'), call('rt_class'), set('c'),
    ['block', 'have', null],
    paranoid ? [] : [
      head('c'), ['i32.load', FREE_LISTS], tee('p'), ['if'],
      head('c'), get('p'), ['i32.load', 8], ['i32.store', FREE_LISTS], ['br', 'have'], ['end'],
    ],
    ['global.get', 'hp'], set('p'),
    ['global.get', 'hp'], i32(1), get('c'), ['i32.shl'], ['i32.add'], ['global.set', 'hp'],
    ['memory.size'], i32(16), ['i32.shl'], set('top'),
    ['global.get', 'hp'], get('top'), ['i32.gt_u'], ['if'],
    ['global.get', 'hp'], get('top'), ['i32.sub'], i32(65535), ['i32.add'], i32(16), ['i32.shr_u'],
    ['memory.grow'], i32(-1), ['i32.eq'], ['if'], fail(OOM), ['end'], ['end'],
    ['end'],
    get('p'), i32(1), ['i32.store', 0],
    ['global.get', 'live'], i32(1), ['i32.add'], ['global.set', 'live'],
    ['global.get', 'allocs'], i32(1), ['i32.add'], ['global.set', 'allocs'],
    get('p'),
  ]);

  fn('rt_free', [['p', 'i32'], ['size', 'i32']], [], [['c', 'i32']], [
    get('p'), i32(0), ['i32.store', 0],
    ['global.get', 'live'], i32(1), ['i32.sub'], ['global.set', 'live'],
    paranoid ? [] : [
      get('size'), call('rt_class'), set('c'),
      get('p'), head('c'), ['i32.load', FREE_LISTS], ['i32.store', 8],
      head('c'), get('p'), ['i32.store', FREE_LISTS],
    ],
  ]);

  // dup: one more reference. Immediates and static objects are not counted.
  fn('rt_dup', [['p', 'i32']], ['i32'], [['rc', 'i32']], [
    get('p'), i32(IMM), ['i32.ge_u'], ['if'],
    get('p'), ['i32.load', 0], tee('rc'), i32(0), ['i32.gt_s'], ['if'],
    get('p'), get('rc'), i32(1), ['i32.add'], ['i32.store', 0],
    ['else'], get('rc'), ['i32.eqz'], ['if'], fail(UAF), ['end'], ['end'],
    ['end'], get('p'),
  ]);

  // One reference fewer; returns 1 when that was the last one and the object must be freed.
  fn('rt_release', [['p', 'i32']], ['i32'], [['rc', 'i32']], [
    get('p'), i32(IMM), ['i32.lt_u'], ['if'], i32(0), ['return'], ['end'],
    get('p'), ['i32.load', 0], tee('rc'), i32(1), ['i32.gt_s'], ['if'],
    get('p'), get('rc'), i32(1), ['i32.sub'], ['i32.store', 0], i32(0), ['return'], ['end'],
    get('rc'), i32(1), ['i32.eq'], ['if'], i32(1), ['return'], ['end'],
    get('rc'), ['i32.eqz'], ['if'], fail(UAF), ['end'],
    i32(0),
  ]);

  // Paranoid mode: every read through a pointer checks that the object is live.
  fn('rt_chk', [['p', 'i32']], ['i32'], [], [
    get('p'), i32(IMM), ['i32.ge_u'], ['if'], get('p'), ['i32.load', 0], ['i32.eqz'], ['if'], fail(UAF), ['end'], ['end'], get('p'),
  ]);

  fn('rt_tag', [['p', 'i32']], ['i32'], [], [
    get('p'), i32(IMM), ['i32.lt_u'], ['if', null, 'i32'], get('p'), ['else'], get('p'), chk(), ['i32.load', 4], ['end'],
  ]);

  // Checked 64-bit arithmetic.
  const binI64 = (name, body) => fn(name, [['a', 'i64'], ['b', 'i64']], ['i64'], [['r', 'i64']], body);
  binI64('int_add', [
    get('a'), get('b'), ['i64.add'], set('r'),
    mutant === 'add-no-overflow' ? [] : [get('a'), get('r'), ['i64.xor'], get('b'), get('r'), ['i64.xor'], ['i64.and'], i64(0), ['i64.lt_s'], ['if'], fail(OVERFLOW), ['end']],
    get('r'),
  ]);
  binI64('int_sub', [
    get('a'), get('b'), ['i64.sub'], set('r'),
    get('a'), get('b'), ['i64.xor'], get('a'), get('r'), ['i64.xor'], ['i64.and'], i64(0), ['i64.lt_s'], ['if'], fail(OVERFLOW), ['end'],
    get('r'),
  ]);
  binI64('int_mul', [
    get('a'), ['i64.eqz'], get('b'), ['i64.eqz'], ['i32.or'], ['if'], i64(0), ['return'], ['end'],
    get('a'), i64(-1), ['i64.eq'], get('b'), i64(INT_MIN), ['i64.eq'], ['i32.and'],
    get('b'), i64(-1), ['i64.eq'], get('a'), i64(INT_MIN), ['i64.eq'], ['i32.and'], ['i32.or'], ['if'], fail(OVERFLOW), ['end'],
    get('a'), get('b'), ['i64.mul'], tee('r'), get('b'), ['i64.div_s'], get('a'), ['i64.ne'], ['if'], fail(OVERFLOW), ['end'],
    get('r'),
  ]);
  binI64('int_div', [
    get('b'), ['i64.eqz'], ['if'], fail(DIVZERO), ['end'],
    get('a'), i64(INT_MIN), ['i64.eq'], get('b'), i64(-1), ['i64.eq'], ['i32.and'], ['if'], fail(OVERFLOW), ['end'],
    get('a'), get('b'), ['i64.div_s'],
  ]);
  binI64('int_rem', [
    get('b'), ['i64.eqz'], ['if'], fail(DIVZERO), ['end'],
    get('a'), get('b'), ['i64.rem_s'],
  ]);
  fn('int_neg', [['a', 'i64']], ['i64'], [], [
    get('a'), i64(INT_MIN), ['i64.eq'], ['if'], fail(OVERFLOW), ['end'], i64(0), get('a'), ['i64.sub'],
  ]);

  // Strings.
  const len = (p) => [get(p), chk(), ['i32.load', 4]];
  fn('str_new', [['n', 'i32']], ['i32'], [['p', 'i32']], [
    get('n'), i32(MAX_STRING), ['i32.gt_u'], ['if'], fail(STRLONG), ['end'],
    get('n'), i32(8), ['i32.add'], call('rt_alloc'), tee('p'), get('n'), ['i32.store', 4], get('p'),
  ]);
  fn('str_concat', [['a', 'i32'], ['b', 'i32']], ['i32'], [['la', 'i32'], ['lb', 'i32'], ['p', 'i32']], [
    len('a'), set('la'), len('b'), set('lb'),
    get('la'), get('lb'), ['i32.add'], call('str_new'), set('p'),
    get('p'), i32(8), ['i32.add'], get('a'), i32(8), ['i32.add'], get('la'), ['memory.copy'],
    get('p'), i32(8), ['i32.add'], get('la'), ['i32.add'], get('b'), i32(8), ['i32.add'], get('lb'), ['memory.copy'],
    get('p'),
  ]);
  // Joins a List<String> (Cons cells: head at 8, tail at 16; Nil is the immediate 0).
  fn('str_concat_list', [['xs', 'i32']], ['i32'], [['c', 'i32'], ['n', 'i64'], ['p', 'i32'], ['at', 'i32'], ['s', 'i32']], [
    get('xs'), set('c'),
    ['block', 'sized', null], ['loop', 'size', null],
    get('c'), i32(IMM), ['i32.lt_u'], ['br_if', 'sized'],
    get('n'), get('c'), chk(), ['i32.load', 8], ['i32.load', 4], ['i64.extend_i32_u'], ['i64.add'], set('n'),
    get('c'), ['i32.load', 16], set('c'), ['br', 'size'], ['end'], ['end'],
    get('n'), i64(MAX_STRING), ['i64.gt_u'], ['if'], fail(STRLONG), ['end'],
    get('n'), ['i32.wrap_i64'], call('str_new'), tee('p'), i32(8), ['i32.add'], set('at'),
    get('xs'), set('c'),
    ['block', 'done', null], ['loop', 'copy', null],
    get('c'), i32(IMM), ['i32.lt_u'], ['br_if', 'done'],
    get('c'), ['i32.load', 8], set('s'),
    get('at'), get('s'), i32(8), ['i32.add'], get('s'), ['i32.load', 4], ['memory.copy'],
    get('at'), get('s'), ['i32.load', 4], ['i32.add'], set('at'),
    get('c'), ['i32.load', 16], set('c'), ['br', 'copy'], ['end'], ['end'],
    get('p'),
  ]);
  fn('str_cmp', [['a', 'i32'], ['b', 'i32']], ['i32'], [['la', 'i32'], ['lb', 'i32'], ['n', 'i32'], ['i', 'i32'], ['ca', 'i32'], ['cb', 'i32']], [
    len('a'), set('la'), len('b'), set('lb'),
    get('la'), get('lb'), get('la'), get('lb'), ['i32.lt_u'], ['select'], set('n'),
    ['block', 'done', null], ['loop', 'next', null],
    get('i'), get('n'), ['i32.ge_u'], ['br_if', 'done'],
    get('a'), get('i'), ['i32.add'], ['i32.load8_u', 8], set('ca'),
    get('b'), get('i'), ['i32.add'], ['i32.load8_u', 8], set('cb'),
    get('ca'), get('cb'), ['i32.ne'], ['if'], i32(-1), i32(1), get('ca'), get('cb'), ['i32.lt_u'], ['select'], ['return'], ['end'],
    get('i'), i32(1), ['i32.add'], set('i'), ['br', 'next'],
    ['end'], ['end'],
    get('la'), get('lb'), ['i32.gt_u'], get('la'), get('lb'), ['i32.lt_u'], ['i32.sub'],
  ]);
  fn('int_to_string', [['n', 'i64']], ['i32'], [['neg', 'i32'], ['i', 'i32'], ['p', 'i32']], [
    i32(SCRATCH + 32), set('i'),
    get('n'), i64(0), ['i64.lt_s'], set('neg'),
    get('neg'), ['i32.eqz'], ['if'], i64(0), get('n'), ['i64.sub'], set('n'), ['end'],
    // n <= 0 from here on, so the most negative Int needs no special case.
    ['loop', 'digit', null],
    get('i'), i32(1), ['i32.sub'], set('i'),
    get('i'), i64(0), get('n'), i64(10), ['i64.rem_s'], ['i64.sub'], ['i32.wrap_i64'], i32(48), ['i32.add'], ['i32.store8', 0],
    get('n'), i64(10), ['i64.div_s'], tee('n'), ['i64.eqz'], ['i32.eqz'], ['br_if', 'digit'],
    ['end'],
    get('neg'), ['if'], get('i'), i32(1), ['i32.sub'], tee('i'), i32(45), ['i32.store8', 0], ['end'],
    i32(SCRATCH + 32), get('i'), ['i32.sub'], call('str_new'), set('p'),
    get('p'), i32(8), ['i32.add'], get('i'), i32(SCRATCH + 32), get('i'), ['i32.sub'], ['memory.copy'],
    get('p'),
  ]);
  fn('str_length', [['s', 'i32']], ['i64'], [], [len('s'), ['i64.extend_i32_u']]);
  fn('str_sub', [['s', 'i32'], ['a', 'i64'], ['b', 'i64']], ['i32'], [['n', 'i64'], ['p', 'i32']], [
    len('s'), ['i64.extend_i32_u'], set('n'),
    get('a'), i64(0), ['i64.lt_s'], ['if'], i64(0), set('a'), ['end'],
    get('a'), get('n'), ['i64.gt_s'], ['if'], get('n'), set('a'), ['end'],
    get('b'), get('a'), ['i64.lt_s'], ['if'], get('a'), set('b'), ['end'],
    get('b'), get('n'), ['i64.gt_s'], ['if'], get('n'), mutant === 'substring-end' ? [i64(1), ['i64.sub']] : [], set('b'), ['end'],
    get('b'), get('a'), ['i64.sub'], ['i32.wrap_i64'], call('str_new'), set('p'),
    get('p'), i32(8), ['i32.add'], get('s'), i32(8), ['i32.add'], get('a'), ['i32.wrap_i64'], ['i32.add'],
    get('b'), get('a'), ['i64.sub'], ['i32.wrap_i64'], ['memory.copy'],
    get('p'),
  ]);
  fn('str_code_at', [['s', 'i32'], ['i', 'i64']], ['i64'], [], [
    get('i'), len('s'), ['i64.extend_i32_u'], ['i64.ge_u'], ['if'], fail(BOUNDS), ['end'],
    get('s'), get('i'), ['i32.wrap_i64'], ['i32.add'], ['i32.load8_u', 8], ['i64.extend_i32_u'],
  ]);
  fn('str_from_code', [['c', 'i64']], ['i32'], [['p', 'i32']], [
    i32(1), call('str_new'), tee('p'), get('c'), ['i32.wrap_i64'], ['i32.store8', 8], get('p'),
  ]);
  const newline = staticString('\n');
  fn('str_print', [['s', 'i32']], [], [], [get('s'), i32(8), ['i32.add'], len('s'), call('host_write')]);
  fn('str_println', [['s', 'i32']], [], [], [get('s'), call('str_print'), i32(newline + 8), i32(1), call('host_write')]);
  fn('str_read_input', [], ['i32'], [['p', 'i32']], [
    call('host_input_len'), call('str_new'), tee('p'), i32(8), ['i32.add'], call('host_input_read'), get('p'),
  ]);
  fn('str_panic', [['s', 'i32']], [], [], [get('s'), i32(8), ['i32.add'], len('s'), call('host_panic'), ['unreachable']]);

  // Arrays. The element code depends on the element type, so each element type
  // gets its own copy of the array builtins.
  fn('arr_new', [['n', 'i32'], ['cap', 'i32']], ['i32'], [['p', 'i32']], [
    get('cap'), i32(3), ['i32.shl'], i32(16), ['i32.add'], call('rt_alloc'), tee('p'), get('n'), ['i32.store', 4],
    get('p'), get('cap'), ['i32.store', 8], get('p'),
  ]);
  fn('arr_length', [['a', 'i32']], ['i64'], [], [len('a'), ['i64.extend_i32_u']]);
  const slot = (a, i) => [get(a), get(i), i32(3), ['i32.shl'], ['i32.add']];

  function arrayFns(T) {
    const k = tkey(T);
    const name = (op) => `array_${op}:${k}`;
    if (made.has(name('get'))) return name;
    made.add(name('get'));
    const vt = valtype(T);
    const heap = isHeap(T);
    const AT = { k: 'con', name: 'Array', args: [T] };
    const dupAll = (p, n) => (heap ? [
      i32(0), set('j'), ['block', 'dd', null], ['loop', 'dl', null], get('j'), get(n), ['i32.ge_u'], ['br_if', 'dd'],
      slot(p, 'j'), load(T, 16), call('rt_dup'), ['drop'], get('j'), i32(1), ['i32.add'], set('j'), ['br', 'dl'], ['end'], ['end'],
    ] : []);
    fn(name('make'), [['n', 'i64'], ['x', vt]], ['i32'], [['p', 'i32'], ['i', 'i32'], ['len', 'i32']], [
      get('n'), i64(0), ['i64.lt_s'], ['if'], fail(BOUNDS), ['end'],
      get('n'), i64(MAX_ARRAY), ['i64.gt_s'], ['if'], fail(OOM), ['end'],
      get('n'), ['i32.wrap_i64'], tee('len'), get('len'), call('arr_new'), set('p'),
      ['block', 'done', null], ['loop', 'next', null], get('i'), get('len'), ['i32.ge_u'], ['br_if', 'done'],
      slot('p', 'i'), get('x'), heap ? [call('rt_dup')] : [], store(T, 16),
      get('i'), i32(1), ['i32.add'], set('i'), ['br', 'next'], ['end'], ['end'],
      heap ? [get('x'), call(dropFn(T))] : [],
      get('p'),
    ]);
    const bounds = [get('i'), len('a'), ['i64.extend_i32_u'], ['i64.ge_u'], ['if'], fail(BOUNDS), ['end'], get('i'), ['i32.wrap_i64'], set('ix')];
    fn(name('get'), [['a', 'i32'], ['i', 'i64']], [vt], [['ix', 'i32']], [
      bounds, slot('a', 'ix'), load(T, 16), heap ? [call('rt_dup')] : [],
    ]);
    fn(name('set'), [['a', 'i32'], ['i', 'i64'], ['x', vt]], ['i32'], [['ix', 'i32'], ['b', 'i32'], ['n', 'i32'], ['j', 'i32']], [
      bounds,
      get('a'), ['i32.load', 0], i32(1), [mutant === 'array-set-shared' ? 'i32.ge_s' : 'i32.eq'], ['if'],
      // Unique: update in place.
      heap ? [slot('a', 'ix'), load(T, 16), set('b')] : [],
      slot('a', 'ix'), get('x'), store(T, 16),
      heap ? [get('b'), call(dropFn(T))] : [],
      get('a'), ['return'], ['end'],
      // Shared: copy, then update the copy.
      len('a'), set('n'), get('n'), get('n'), call('arr_new'), set('b'),
      get('b'), i32(16), ['i32.add'], get('a'), i32(16), ['i32.add'], get('n'), i32(3), ['i32.shl'], ['memory.copy'],
      dupAll('b', 'n'),
      heap ? [slot('b', 'ix'), load(T, 16), call(dropFn(T))] : [],
      slot('b', 'ix'), get('x'), store(T, 16),
      get('a'), call(dropFn(AT)),
      get('b'),
    ]);
    fn(name('push'), [['a', 'i32'], ['x', vt]], ['i32'], [['n', 'i32'], ['cap', 'i32'], ['b', 'i32'], ['j', 'i32'], ['uniq', 'i32']], [
      len('a'), set('n'), get('a'), ['i32.load', 8], set('cap'),
      get('n'), i32(MAX_ARRAY), ['i32.ge_u'], ['if'], fail(OOM), ['end'],
      get('a'), ['i32.load', 0], i32(1), ['i32.eq'], set('uniq'),
      get('uniq'), get('n'), get('cap'), ['i32.lt_u'], ['i32.and'], ['if'],
      slot('a', 'n'), get('x'), store(T, 16), get('a'), get('n'), i32(1), ['i32.add'], ['i32.store', 4], get('a'), ['return'], ['end'],
      // Grow geometrically into a new array.
      get('n'), i32(1), ['i32.add'],
      i32(4), get('n'), i32(1), ['i32.shl'], get('n'), i32(4), ['i32.lt_u'], ['select'], set('cap'),
      get('cap'), i32(MAX_ARRAY), ['i32.gt_u'], ['if'], i32(MAX_ARRAY), set('cap'), ['end'],
      get('cap'), call('arr_new'), set('b'),
      get('b'), i32(16), ['i32.add'], get('a'), i32(16), ['i32.add'], get('n'), i32(3), ['i32.shl'], ['memory.copy'],
      get('uniq'), ['if'],
      // The elements moved: free the old block without releasing them.
      get('a'), get('a'), ['i32.load', 8], i32(3), ['i32.shl'], i32(16), ['i32.add'], call('rt_free'),
      ['else'], dupAll('b', 'n'), get('a'), call(dropFn(AT)), ['end'],
      slot('b', 'n'), get('x'), store(T, 16),
      get('b'),
    ]);
    return name;
  }

  // ---------------------------------------------------- per-type functions --
  // drop:T releases one reference to a heap value of type T. The last heap
  // field is released by a tail call, so dropping a long list takes constant stack.
  function dropFn(t) {
    const name = t.k === 'fun' ? 'drop:fun' : `drop:${tkey(t)}`;
    if (made.has(name)) return name;
    made.add(name);
    const release = [get('p'), call('rt_release'), ['i32.eqz'], ['if'], ['return'], ['end']];
    const locals = [];
    // Loads the fields, frees the object, then releases the heap fields.
    const fields = (tys, base, size, prefix) => {
      const vs = tys.map((ft, i) => { const v = `${prefix}${i}`; locals.push([v, valtype(ft)]); return { v, ft, i }; });
      const heapFields = vs.filter(({ ft }) => isHeap(ft)).slice(0, mutant === 'drop-skip-last-field' ? -1 : undefined);
      return [
        heapFields.map(({ v, ft, i }) => [get('p'), load(ft, base + 8 * i), set(v)]),
        get('p'), i32(size), call('rt_free'),
        heapFields.map(({ v, ft }, j) => [get(v), j === heapFields.length - 1 ? ['return_call', dropFn(ft)] : call(dropFn(ft))]),
      ];
    };
    let body;
    if (t.k === 'fun') {
      body = [release, get('p'), get('p'), ['i32.load', 8], ['call_indirect', { params: ['i32'], results: [] }]];
    } else if (t.k === 'tuple') {
      body = [release, fields(t.elems, 8, 8 + 8 * t.elems.length, 'f')];
    } else if (t.name === 'String') {
      body = [release, get('p'), get('p'), ['i32.load', 4], i32(8), ['i32.add'], call('rt_free')];
    } else if (t.name === 'Array') {
      const T = t.args[0];
      locals.push(['i', 'i32'], ['n', 'i32']);
      body = [release,
        isHeap(T) ? [
          get('p'), ['i32.load', 4], set('n'),
          ['block', 'done', null], ['loop', 'next', null], get('i'), get('n'), ['i32.ge_u'], ['br_if', 'done'],
          slot('p', 'i'), load(T, 16), call(dropFn(T)), get('i'), i32(1), ['i32.add'], set('i'), ['br', 'next'], ['end'], ['end'],
        ] : [],
        get('p'), get('p'), ['i32.load', 8], i32(3), ['i32.shl'], i32(16), ['i32.add'], call('rt_free')];
    } else {
      locals.push(['tag', 'i32']);
      body = [release, get('p'), ['i32.load', 4], set('tag'),
        variants(t).filter((v) => v.fields.length).map((v) => [
          get('tag'), i32(v.idx), ['i32.eq'], ['if'], fields(v.fields, 8, 8 + 8 * v.fields.length, `f${v.idx}_`), ['return'], ['end'],
        ])];
    }
    fn(name, [['p', 'i32']], [], locals, body);
    return name;
  }

  // reuse:T releases one reference; when it was the last, it releases the
  // fields and returns the cell for a new constructor instead of freeing it.
  function reuseFn(t) {
    const name = `reuse:${tkey(t)}`;
    if (made.has(name)) return name;
    made.add(name);
    const releaseFields = (tys) => tys.map((ft, i) => (isHeap(ft) ? [get('p'), load(ft, 8 + 8 * i), call(dropFn(ft))] : []));
    const body = t.k === 'tuple' ? releaseFields(t.elems)
      : variants(t).filter((v) => v.fields.length).map((v) => [get('p'), ['i32.load', 4], i32(v.idx), ['i32.eq'], ['if'], releaseFields(v.fields), ['end']]);
    const shared = mutant === 'reuse-shared' ? [get('p'), i32(IMM), ['i32.ge_u'], ['if'], get('p'), ['return'], ['end']] : [];
    fn(name, [['p', 'i32']], ['i32'], [], [get('p'), call('rt_release'), ['i32.eqz'], ['if'], shared, i32(0), ['return'], ['end'], body, get('p')]);
    return name;
  }

  // cmp:T compares two values of type T structurally: -1, 0 or 1. The last
  // field is compared by a tail call, so comparing long lists takes constant stack.
  function cmpFn(t) {
    const name = `cmp:${tkey(t)}`;
    if (made.has(name)) return name;
    made.add(name);
    const vt = valtype(t);
    const locals = [['c', 'i32']];
    const fields = (tys) => tys.map((ft, i) => {
      const operands = [get('a'), load(ft, 8 + 8 * i), get('b'), load(ft, 8 + 8 * i)];
      if (i === tys.length - 1) return [operands, ['return_call', cmpFn(ft)]];
      return [operands, call(cmpFn(ft)), tee('c'), ['if'], get('c'), ['return'], ['end']];
    });
    let body;
    const user = mutant === 'ord-ignore-impl' ? null : ir.ordImpls.get(tkey(t));
    if (user) {
      // The program's own compare takes ownership of its arguments; these are borrowed.
      const own = (x) => (isHeap(t) ? [get(x), call('rt_dup')] : [get(x)]);
      locals.push(['r', 'i64']);
      body = [own('a'), own('b'), call(user), tee('r'), i64(0), ['i64.gt_s'], get('r'), i64(0), ['i64.lt_s'], ['i32.sub']];
    } else if (isInt(t)) body = [get('a'), get('b'), ['i64.gt_s'], get('a'), get('b'), ['i64.lt_s'], ['i32.sub']];
    else if (t.k === 'tuple') body = [fields(t.elems), i32(0)];
    else if (t.k === 'con' && t.name === 'String') body = [get('a'), get('b'), call('str_cmp')];
    else if (t.k === 'con' && t.name === 'Array') {
      const T = t.args[0];
      locals.push(['i', 'i32'], ['n', 'i32']);
      body = [
        get('a'), ['i32.load', 4], get('b'), ['i32.load', 4], ['i32.ne'], ['if'],
        i32(-1), i32(1), get('a'), ['i32.load', 4], get('b'), ['i32.load', 4], ['i32.lt_u'], ['select'], ['return'], ['end'],
        get('a'), ['i32.load', 4], set('n'),
        ['block', 'done', null], ['loop', 'next', null], get('i'), get('n'), ['i32.ge_u'], ['br_if', 'done'],
        slot('a', 'i'), load(T, 16), slot('b', 'i'), load(T, 16), call(cmpFn(T)), tee('c'), ['if'], get('c'), ['return'], ['end'],
        get('i'), i32(1), ['i32.add'], set('i'), ['br', 'next'], ['end'], ['end'],
        i32(0),
      ];
    } else if (t.k === 'con' && !isHeap(t)) {
      body = [get('a'), get('b'), ['i32.gt_u'], get('a'), get('b'), ['i32.lt_u'], ['i32.sub']];
    } else {
      locals.push(['ta', 'i32'], ['tb', 'i32']);
      body = [
        get('a'), call('rt_tag'), set('ta'), get('b'), call('rt_tag'), set('tb'),
        mutant === 'cmp-ignore-tag' ? [] : [get('ta'), get('tb'), ['i32.ne'], ['if'], i32(-1), i32(1), get('ta'), get('tb'), ['i32.lt_u'], ['select'], ['return'], ['end']],
        variants(t).filter((v) => v.fields.length).map((v) => [get('ta'), i32(v.idx), ['i32.eq'], ['if'], fields(v.fields), ['end']]),
        i32(0),
      ];
    }
    fn(name, [['a', vt], ['b', vt]], ['i32'], locals, body);
    return name;
  }

  // ------------------------------------------------------- IR functions --
  const sigOf = (fty) => ({ params: ['i32', ...fty.params.map(valtype)], results: [valtype(fty.ret)] });

  function genFn(f) {
    const paramNames = new Set(f.params.map((p) => p.v));
    const locals = [...f.vars].filter(([v]) => !paramNames.has(v)).map(([v, t]) => [v, valtype(t)]);
    locals.push(['$p', 'i32']);
    const body = [];
    const emit = (...xs) => body.push(...flat(xs));
    let labels = 0;
    const typeOf = (a) => (a.k === 'var' ? f.vars.get(a.v) : null);

    const atom = (a) => {
      switch (a.k) {
        case 'var': return get(a.v);
        case 'int': return i64(a.n);
        case 'bool': return i32(a.b ? 1 : 0);
        case 'unit': return i32(0);
        case 'str': return i32(staticString(a.s));
        default: throw new Error(`codegen: atom ${a.k}`);
      }
    };
    const atoms = (as) => as.map(atom);

    // Reads the value at a path of field indices inside x.
    const walk = (x, path, ty) => [atom(x), path.map((i, j) => [chk(), j === path.length - 1 ? load(ty, 8 + 8 * i) : ['i32.load', 8 + 8 * i]])];

    // A new object, written into the reuse token's cell when there is one.
    const newObject = (size, tag, slots, reuse) => [
      reuse ? [get(reuse), ['if', null, 'i32'], get(reuse), ['else'], i32(size), call('rt_alloc'), ['end'], set('$p'), get('$p'), i32(1), ['i32.store', 0]]
        : [i32(size), call('rt_alloc'), set('$p')],
      get('$p'), i32(tag), ['i32.store', 4],
      slots.map(({ code, ty, off }) => [get('$p'), code, store(ty, off)]),
      get('$p'),
    ];

    const PRIMS = { add: 'int_add', sub: 'int_sub', mul: 'int_mul', div: 'int_div', rem: 'int_rem' };
    const CMPS = { eq: 'eq', ne: 'ne', lt: 'lt_s', le: 'le_s', gt: 'gt_s', ge: 'ge_s' };

    function rhs(r) {
      switch (r.k) {
        case 'atom': return atom(r.a);
        case 'prim': {
          if (PRIMS[r.op]) return [atoms(r.args), call(PRIMS[r.op])];
          if (r.op === 'neg') return [atom(r.args[0]), call('int_neg')];
          if (r.op === 'not') return [atom(r.args[0]), ['i32.eqz']];
          const w = isInt(r.ty) ? 'i64' : 'i32';
          return [atoms(r.args), [`${w}.${CMPS[r.op]}`]];
        }
        case 'cmp':
          if (r.op === 'three') return [atoms(r.args), call(cmpFn(r.ty)), ['i64.extend_i32_s']];
          return [atoms(r.args), call(cmpFn(r.ty)), i32(0), [`i32.${CMPS[r.op]}`]];
        case 'call': return [atoms(r.args), call(r.fn)];
        case 'callc': return [atom(r.f), atoms(r.args), atom(r.f), ['i32.load', 4], ['call_indirect', sigOf(typeOf(r.f))]];
        case 'ctor': {
          if (!r.args.length) {
            if (r.tag >= IMM) throw new Error('codegen: too many constructors');
            return i32(r.tag);
          }
          const fts = variants(r.ty)[r.tag].fields;
          return newObject(8 + 8 * r.args.length, r.tag, r.args.map((a, i) => ({ code: atom(a), ty: fts[i], off: 8 + 8 * i })), r.reuse);
        }
        case 'tuple': return newObject(8 + 8 * r.args.length, 0, r.args.map((a, i) => ({ code: atom(a), ty: r.ty.elems[i], off: 8 + 8 * i })), r.reuse);
        case 'closure': {
          const slots = [{ code: i32(m.tableSlot(dropEnvFn(r))), ty: { k: 'con', name: 'Unit', args: [] }, off: 8 },
            ...r.captures.map((a, i) => ({ code: atom(a), ty: r.captureTys[i], off: 16 + 8 * i }))];
          return newObject(16 + 8 * r.captures.length, m.tableSlot(r.fn), slots);
        }
        case 'staticfn': return i32(staticClosure(r.fn));
        case 'field': return [walk(r.x, r.path, r.ty), isHeap(r.ty) ? call('rt_dup') : []];
        case 'peek': return walk(r.x, r.path, r.ty);
        case 'envfield': return [get('env'), chk(), load(r.ty, 16 + 8 * r.i), isHeap(r.ty) && mutant !== 'capture-no-dup' ? call('rt_dup') : []];
        case 'testtag': return [walk(r.x, r.path, r.ty), isHeap(r.ty) ? call('rt_tag') : [], i32(r.tag), ['i32.eq']];
        case 'testlit': {
          const v = walk(r.x, r.path, r.ty);
          if (r.lit.k === 'int') return [v, i64(r.lit.n), ['i64.eq']];
          if (r.lit.k === 'bool') return [v, i32(r.lit.b ? 1 : 0), ['i32.eq']];
          return [v, i32(staticString(r.lit.s)), call('str_cmp'), ['i32.eqz']];
        }
        case 'builtin': return builtin(r);
        default: throw new Error(`codegen: rhs ${r.k}`);
      }
    }

    function builtin(r) {
      const args = atoms(r.args);
      const elem = () => arrayFns(r.argTys[0].args[0]);
      switch (r.name) {
        case 'print': return [args, call('str_print'), i32(0)];
        case 'println': return [args, call('str_println'), i32(0)];
        case 'read_input': return call('str_read_input');
        case 'clock_ms': return call('host_clock');
        case 'random_int': return [args, call('host_random')];
        case 'int_to_string': return [args, call('int_to_string')];
        case 'concat_strings': return [args, call('str_concat_list')];
        case 'string_length': return [args, call('str_length')];
        case 'substring': return [args, call('str_sub')];
        case 'char_code_at': return [args, call('str_code_at')];
        case 'char_from_code': return [args, call('str_from_code')];
        case 'concat': return [args, call('str_concat')];
        case 'panic': return [args, call('str_panic'), ['unreachable']];
        case 'array_make': return [args, call(arrayFns(r.argTys[1])('make'))];
        case 'array_empty': return [i32(0), i32(0), call('arr_new')];
        case 'array_get': return [args, call(elem()('get'))];
        case 'array_set': return [args, call(elem()('set'))];
        case 'array_push': return [args, call(elem()('push'))];
        case 'array_length': return [args, call('arr_length')];
        default: throw new Error(`codegen: builtin ${r.name}`);
      }
    }

    // label === null: the expression's value is the function's result.
    function expr(e, label) {
      switch (e.k) {
        case 'let':
          if (e.rhs.k === 'expr') {
            const L = `L${labels++}`;
            emit(['block', L, valtype(f.vars.get(e.v))]);
            expr(e.rhs.e, L);
            emit(['end']);
          } else emit(rhs(e.rhs));
          emit(set(e.v));
          return expr(e.body, label);
        case 'ret':
          if (label === null && e.rhs.k === 'call') return emit(atoms(e.rhs.args), ['return_call', e.rhs.fn]);
          if (label === null && e.rhs.k === 'callc') {
            const r = e.rhs;
            return emit(atom(r.f), atoms(r.args), atom(r.f), ['i32.load', 4], ['return_call_indirect', sigOf(typeOf(r.f))]);
          }
          return emit(rhs(e.rhs), label === null ? ['return'] : ['br', label]);
        case 'if':
          emit(atom(e.c), ['if']);
          expr(e.t, label);
          emit(['else']);
          expr(e.e, label);
          return emit(['end'], ['unreachable']);
        case 'dup': emit(get(e.v), call('rt_dup'), ['drop']); return expr(e.body, label);
        case 'drop': emit(get(e.v), call(dropFn(f.vars.get(e.v)))); return expr(e.body, label);
        case 'dropreuse': emit(get(e.v), call(reuseFn(f.vars.get(e.v))), set(e.r)); return expr(e.body, label);
        case 'freetoken': emit(get(e.v), ['if'], get(e.v), i32(e.size), call('rt_free'), ['end']); return expr(e.body, label);
        case 'unreachable': return emit(['unreachable']);
        default: throw new Error(`codegen: ${e.k}`);
      }
    }

    expr(f.body, null);
    m.addFunc({
      name: f.name,
      params: f.params.map((p) => ({ name: p.v, type: valtype(p.ty) })),
      results: [valtype(f.ret)],
      locals: locals.map(([name, type]) => ({ name, type })),
      body,
    });
  }

  // Releases a closure's captures and frees it.
  function dropEnvFn(r) {
    const name = `dropenv:${r.fn}`;
    if (made.has(name)) return name;
    made.add(name);
    const tys = r.captureTys;
    const locals = tys.map((t, i) => [`c${i}`, valtype(t)]);
    const heapCaps = tys.map((t, i) => ({ t, i })).filter(({ t }) => isHeap(t));
    fn(name, [['p', 'i32']], [], locals, [
      heapCaps.map(({ t, i }) => [get('p'), load(t, 16 + 8 * i), set(`c${i}`)]),
      get('p'), i32(16 + 8 * tys.length), call('rt_free'),
      heapCaps.map(({ t, i }) => [get(`c${i}`), call(dropFn(t))]),
    ]);
    return name;
  }

  for (const f of ir.fns) genFn(f);

  const mainFn = ir.fns.find((f) => f.name === ir.main);
  fn('_start', [], [], [], [call(ir.main), isHeap(mainFn.ret) ? call(dropFn(mainFn.ret)) : ['drop']]);
  m.addExport('_start', 'func', '_start');
  m.addExport('memory', 'memory');
  m.addExport('live', 'global', 'live');
  m.addExport('allocs', 'global', 'allocs');

  // Static data, then the heap.
  pad();
  m.addData(DATA, data);
  const heapStart = (DATA + data.length + 15) & ~15;
  m.globals.find((g) => g.name === 'hp').init = heapStart;
  m.memory = { min: Math.ceil((heapStart + 65536) / 65536), max: MAX_PAGES };
  return { bytes: m.encode(), module: m, ir };
}

// ------------------------------------------------------------------ host --
export class LumenTrap extends Error {}

// Runs a compiled program. Strings are byte strings, as in the interpreter.
// Returns { output, error, live, allocs }: live is the number of objects
// still allocated when main returned, which must be 0; allocs counts every
// allocation the program made.
export function runWasm(bytes, { input = '', host = makeHost() } = {}) {
  let out = '';
  let memory = null;
  const bytesAt = (ptr, len) => new Uint8Array(memory.buffer, ptr, len);
  const asString = (b) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
  const env = {
    write: (ptr, len) => { out += asString(bytesAt(ptr, len)); },
    input_len: () => input.length,
    input_read: (ptr) => { const b = bytesAt(ptr, input.length); for (let i = 0; i < input.length; i++) b[i] = input.charCodeAt(i) & 0xff; },
    fail: (code) => { throw new LumenTrap(FAILURES[code] ?? `internal error ${code}`); },
    panic: (ptr, len) => { throw new LumenTrap(`panic: ${asString(bytesAt(ptr, len))}`); },
    clock: () => host.clock(),
    random: (lo, hi) => host.random(lo, hi),
  };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env });
  memory = instance.exports.memory;
  try {
    instance.exports._start();
  } catch (e) {
    const allocs = instance.exports.allocs.value;
    if (e instanceof LumenTrap) return { output: out, error: e.message, live: null, allocs };
    if (e instanceof RangeError && /call stack/i.test(e.message)) return { output: out, error: 'stack overflow', live: null, allocs };
    if (e instanceof WebAssembly.RuntimeError) return { output: out, error: `internal error: ${e.message}`, live: null, allocs };
    throw e;
  }
  return { output: out, error: null, live: instance.exports.live.value, allocs: instance.exports.allocs.value };
}
