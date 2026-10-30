// The Lumen runtime, written directly in WebAssembly (via the instruction
// builder in wasm.js). It provides allocation, a copying garbage collector,
// structural equality/ordering and string primitives.
//
// Memory layout
//   [0, 64)                 scratch buffer (int_to_string)
//   [STACK_BASE, STACK_END) shadow stack: GC roots (one slot per traced local)
//   [STATIC_BASE, ...)      static data: string literals, static closures
//   [HEAP_BASE, ...)        two semispaces; grown at the end of memory
//
// Heap objects start with a header word: (size << 9) | (kind << 1) | 1.
// Headers are always odd and pointers are always 4-byte aligned (even), so
// during collection an even first word means "already forwarded; this is
// the new address". Immediates (ints, bools, nullary constructors) are odd,
// so the collector can tell pointers from data with no type information.
//
// Garbage collection is Cheney's algorithm: copy every object reachable from
// the shadow stack into to-space, then scan to-space breadth-first,
// forwarding each field. When a collection leaves the heap more than half
// full, both semispaces are reallocated at twice the size.

export const TAG_ARRAY = 253;
export const TAG_CLOSURE = 254;
export const TAG_STRING = 255;
export const header = (kind, size) => ((size << 9) | (kind << 1) | 1) | 0;
export const MAX_STRING = (1 << 23) - 1;
export const MAX_ARRAY = (1 << 23) - 1; // elements; the header's size field has 23 bits

export const ERR = {
  DIV_ZERO: 1, COMPARE_FN: 2, PANIC: 3, INDEX: 4, STACK: 5, OOM: 6, FUEL: 7, MATCH: 8, STR_LEN: 9, BAD_ROOT: 10,
};
export const ERR_MESSAGES = {
  1: 'division by zero',
  2: 'cannot compare functions',
  4: 'index out of bounds',
  5: 'stack overflow',
  6: 'out of memory',
  7: 'out of fuel (the program ran too long)',
  8: 'match failure',
  9: 'string too long',
  10: 'internal error: invalid GC root',
};

// ------------------------------------------------------------ mini-DSL --
// Instruction sequences may be nested arrays; seq() flattens them.
export function seq(...parts) {
  const out = [];
  const walk = (p) => {
    if (typeof p[0] === 'string') out.push(p);
    else for (const x of p) walk(x);
  };
  walk(parts);
  return out;
}
export const c = (n) => ['i32.const', n | 0];
export const lg = (n) => ['local.get', n];
export const ls = (n) => ['local.set', n];
export const lt = (n) => ['local.tee', n];
export const gg = (n) => ['global.get', n];
export const gs = (n) => ['global.set', n];
export const ld = (off = 0) => ['i32.load', off];
export const st = (off = 0) => ['i32.store', off];
export const call = (f) => ['call', f];
const o = (name) => [name];
const if_ = (type, then, els) => seq(['if', null, type], then, els ? [['else'], els] : [], ['end']);
// while (!cond) { body }  — `exitWhen` leaves a non-zero value to exit.
const loop = (name, exitWhen, body) =>
  seq(['block', `$${name}_done`, null], ['loop', `$${name}`, null], exitWhen, ['br_if', `$${name}_done`], body, ['br', `$${name}`], ['end'], ['end']);
const ret = (...x) => seq(x, o('return'));
const kindOf = (ptrCode) => seq(ptrCode, ld(), c(1), o('i32.shr_u'), c(255), o('i32.and'));
const lenOf = (ptrCode) => seq(ptrCode, ld(), c(9), o('i32.shr_u'));
const toBool = () => seq(c(1), o('i32.shl'), c(1), o('i32.or'));
const objBytes = (lenCode) => seq(lenCode, c(3), o('i32.add'), c(-4), o('i32.and'), c(4), o('i32.add'));
const trap = (code) => seq(c(code), call('$rt:trap'));

const I32 = (name) => ({ name, type: 'i32' });

export function addRuntime(mod, layout, opts) {
  const fn = (name, params, results, locals, body, comment) =>
    mod.addFunc({ name, params: params.map(I32), results, locals: locals.map(I32), body: seq(body), comment });

  mod.addImport('env', 'print', '$host:print', ['i32', 'i32'], []);
  mod.addImport('env', 'error', '$host:error', ['i32', 'i32'], []);
  mod.addImport('env', 'input_len', '$host:input_len', [], ['i32']);
  mod.addImport('env', 'input_copy', '$host:input_copy', ['i32'], []);

  fn('$rt:trap', ['$code'], [], [], [lg('$code'), c(0), call('$host:error'), o('unreachable')],
    'Reports a runtime error to the host, which throws; never returns.');

  // Shadow-stack helpers for runtime functions that allocate: their pointer
  // arguments must be visible to (and updated by) the collector.
  const pushRoots = (...names) => seq(
    gg('$sp'), ls('$fp'),
    gg('$sp'), c(4 * names.length), o('i32.add'), gs('$sp'),
    names.map((n, i) => seq(lg('$fp'), lg(n), st(4 * i))),
  );
  const popRoots = (...names) => seq(names.map((n, i) => seq(lg('$fp'), ld(4 * i), ls(n))), lg('$fp'), gs('$sp'));

  // ---------------------------------------------------------- allocation --
  fn('$rt:alloc', ['$bytes'], ['i32'], ['$p'], [
    gg('$hp'), lt('$p'), lg('$bytes'), o('i32.add'), gg('$from_end'), o('i32.gt_u'),
    opts.gcStress ? [o('drop'), c(1)] : [],
    if_(null, [lg('$bytes'), call('$rt:gc'), gg('$hp'), ls('$p')]),
    lg('$p'), lg('$bytes'), o('i32.add'), gs('$hp'),
    // Under -O, compiled code bumps $hp inline, so allocated bytes are
    // tallied per collection instead (see $rt:gc and $alloc_mark).
    opts.optimize ? [] : [gg('$alloc_bytes'), lg('$bytes'), o('i64.extend_i32_u'), o('i64.add'), gs('$alloc_bytes')],
    lg('$p'),
  ], opts.gcStress ? 'Bump allocator. GC STRESS MODE: collects on every allocation.' : 'Bump allocator; collects when the semispace is full.');

  // Growth policy. By default the semispaces grow when a collection leaves
  // them more than half full. Under -O they grow when live data plus the
  // pending request exceeds a quarter, so each collection copies less per
  // byte allocated, at the cost of up to twice the memory.
  const grow = opts.optimize
    ? [
      lg('$live'), lg('$need'), o('i32.add'), ls('$base'),
      lg('$base'), lg('$size'), c(2), o('i32.shr_u'), o('i32.gt_u'),
    ]
    : [lg('$live'), lg('$need'), o('i32.add'), c(1), o('i32.shl'), lg('$size'), o('i32.gt_u')];
  const target = opts.optimize
    ? [
      lg('$base'), c(0x0fffffff), o('i32.gt_u'), if_(null, trap(ERR.OOM)), // could never fit in memory
      lg('$base'), c(2), o('i32.shl'), ls('$base'),
    ]
    : [lg('$live'), lg('$need'), o('i32.add'), c(1), o('i32.shl'), ls('$base')];
  const tally = opts.optimize
    ? [gg('$alloc_bytes'), gg('$hp'), gg('$alloc_mark'), o('i32.sub'), o('i64.extend_i32_u'), o('i64.add'), gs('$alloc_bytes')]
    : [];
  fn('$rt:gc', ['$need'], [], ['$live', '$size', '$base'], [
    tally,
    call('$rt:collect'),
    gg('$hp'), gg('$from_start'), o('i32.sub'), ls('$live'),
    gg('$from_end'), gg('$from_start'), o('i32.sub'), ls('$size'),
    grow,
    if_(null, [
      target,
      lg('$size'), c(1), o('i32.shl'), ls('$size'),
      lg('$size'), lg('$base'), lg('$size'), lg('$base'), o('i32.gt_u'), o('select'),
      c(0xffff), o('i32.add'), c(-0x10000), o('i32.and'), ls('$size'),
      ['memory.size'], c(16), o('i32.shl'), ls('$base'),
      lg('$size'), c(15), o('i32.shr_u'), ['memory.grow'], c(-1), o('i32.eq'),
      if_(null, trap(ERR.OOM)),
      lg('$base'), gs('$to_start'),
      lg('$base'), lg('$size'), o('i32.add'), gs('$to_end'),
      call('$rt:collect'),
      lg('$base'), lg('$size'), o('i32.add'), gs('$to_start'),
      lg('$base'), lg('$size'), c(1), o('i32.shl'), o('i32.add'), gs('$to_end'),
    ]),
    opts.optimize ? [gg('$hp'), gs('$alloc_mark')] : [],
  ], opts.optimize ? 'Collects garbage, then grows the semispaces if they are more than a quarter full.' : 'Collects garbage, then doubles the semispaces if they are more than half full.');

  // Paranoid mode (-O with GC stress): popped frames are poisoned (see
  // codegen), and every root must be 0, an immediate, static data or an
  // allocated heap object, so a slot the frame-zeroing elision wrongly left
  // stale traps at once instead of corrupting the heap only sometimes.
  const paranoid = opts.optimize && opts.gcStress;
  const checkRoot = paranoid
    ? seq(lg('$p'), ld(), ls('$h'),
      lg('$h'), o('i32.eqz'), lg('$h'), c(1), o('i32.and'), o('i32.or'),
      lg('$h'), c(layout.STACK_END), o('i32.ge_u'), lg('$h'), gg('$heap_base'), o('i32.lt_u'), o('i32.and'), o('i32.or'),
      lg('$h'), gg('$from_start'), o('i32.ge_u'), lg('$h'), gg('$hp'), o('i32.lt_u'), o('i32.and'), o('i32.or'),
      o('i32.eqz'), if_(null, trap(ERR.BAD_ROOT)))
    : [];
  fn('$rt:collect', [], [], ['$p', '$scan', '$h', '$end'], [
    gg('$gc_count'), c(1), o('i32.add'), gs('$gc_count'),
    gg('$to_start'), gs('$next'),
    // 1. Forward every root on the shadow stack.
    c(layout.STACK_BASE), ls('$p'),
    loop('roots', [lg('$p'), gg('$sp'), o('i32.ge_u')], [
      checkRoot,
      lg('$p'), lg('$p'), ld(), call('$rt:forward'), st(),
      lg('$p'), c(4), o('i32.add'), ls('$p'),
    ]),
    // 2. Cheney scan: forward the fields of every object copied so far.
    gg('$to_start'), ls('$scan'),
    loop('scan', [lg('$scan'), gg('$next'), o('i32.ge_u')], [
      lg('$scan'), ld(), ls('$h'),
      lg('$h'), c(1), o('i32.shr_u'), c(255), o('i32.and'), c(TAG_STRING), o('i32.eq'),
      if_(null,
        [lg('$scan'), objBytes([lg('$h'), c(9), o('i32.shr_u')]), o('i32.add'), ls('$scan')],
        [
          lg('$scan'), c(4), o('i32.add'), ls('$p'),
          lg('$p'), lg('$h'), c(9), o('i32.shr_u'), c(2), o('i32.shl'), o('i32.add'), ls('$end'),
          loop('fields', [lg('$p'), lg('$end'), o('i32.ge_u')], [
            lg('$p'), lg('$p'), ld(), call('$rt:forward'), st(),
            lg('$p'), c(4), o('i32.add'), ls('$p'),
          ]),
          lg('$end'), ls('$scan'),
        ]),
    ]),
    // 3. Flip the semispaces.
    gg('$from_start'), gg('$to_start'), gs('$from_start'), gs('$to_start'),
    gg('$from_end'), gg('$to_end'), gs('$from_end'), gs('$to_end'),
    gg('$next'), gs('$hp'),
    // In stress mode, poison the old space so any dangling pointer misbehaves loudly.
    opts.gcStress ? [gg('$to_start'), c(0x55), gg('$to_end'), gg('$to_start'), o('i32.sub'), ['memory.fill']] : [],
  ], "Cheney's copying collector: roots are the shadow stack.");

  fn('$rt:forward', ['$v'], ['i32'], ['$h', '$n', '$new'], [
    lg('$v'), c(1), o('i32.and'), if_(null, ret(lg('$v'))), // immediate
    lg('$v'), gg('$from_start'), o('i32.lt_u'), if_(null, ret(lg('$v'))), // static data
    lg('$v'), gg('$from_end'), o('i32.ge_u'), if_(null, ret(lg('$v'))),
    lg('$v'), ld(), lt('$h'), c(1), o('i32.and'), o('i32.eqz'), if_(null, ret(lg('$h'))), // already forwarded
    lg('$h'), c(1), o('i32.shr_u'), c(255), o('i32.and'), c(TAG_STRING), o('i32.eq'),
    if_('i32',
      objBytes([lg('$h'), c(9), o('i32.shr_u')]),
      [lg('$h'), c(9), o('i32.shr_u'), c(2), o('i32.shl'), c(4), o('i32.add')]),
    ls('$n'),
    gg('$next'), lt('$new'), lg('$v'), lg('$n'), ['memory.copy'],
    gg('$next'), lg('$n'), o('i32.add'), gs('$next'),
    lg('$v'), lg('$new'), st(), // leave a forwarding pointer
    lg('$new'),
  ], 'Copies one object to to-space (once) and returns its new address.');

  // ------------------------------------------------ equality / ordering --
  fn('$rt:eq', ['$a', '$b'], ['i32'], ['$h', '$k', '$n', '$i'], [
    ['loop', '$top', null],
    lg('$a'), lg('$b'), o('i32.or'), c(1), o('i32.and'),
    if_(null, ret(lg('$a'), lg('$b'), o('i32.eq'))), // at least one immediate
    lg('$a'), ld(), lt('$h'), c(1), o('i32.shr_u'), c(255), o('i32.and'), lt('$k'),
    c(TAG_CLOSURE), o('i32.eq'), if_(null, trap(ERR.COMPARE_FN)),
    lg('$k'), c(TAG_STRING), o('i32.eq'), if_(null, ret(lg('$a'), lg('$b'), call('$rt:str_eq'))),
    lg('$h'), lg('$b'), ld(), o('i32.ne'), if_(null, ret(c(0))), // different constructor
    lg('$h'), c(9), o('i32.shr_u'), lt('$n'), o('i32.eqz'), if_(null, ret(c(1))),
    c(0), ls('$i'),
    loop('fields', [lg('$i'), lg('$n'), c(1), o('i32.sub'), o('i32.ge_s')], [
      lg('$a'), lg('$i'), c(2), o('i32.shl'), o('i32.add'), ld(4),
      lg('$b'), lg('$i'), c(2), o('i32.shl'), o('i32.add'), ld(4),
      call('$rt:eq'), o('i32.eqz'), if_(null, ret(c(0))),
      lg('$i'), c(1), o('i32.add'), ls('$i'),
    ]),
    // Iterate (rather than recurse) on the last field, so long lists don't use stack.
    lg('$a'), lg('$n'), c(2), o('i32.shl'), o('i32.add'), ld(), ls('$a'),
    lg('$b'), lg('$n'), c(2), o('i32.shl'), o('i32.add'), ld(), ls('$b'),
    ['br', '$top'],
    ['end'],
    o('unreachable'),
  ], 'Structural equality. Returns raw 0/1.');

  fn('$rt:compare', ['$a', '$b'], ['i32'], ['$ka', '$kb', '$n', '$i', '$r'], [
    ['loop', '$top', null],
    lg('$a'), lg('$b'), o('i32.and'), c(1), o('i32.and'),
    if_(null, ret(lg('$a'), lg('$b'), o('i32.gt_s'), lg('$a'), lg('$b'), o('i32.lt_s'), o('i32.sub'))),
    // A nullary constructor (immediate) vs one with fields (block): order by constructor index.
    lg('$a'), c(1), o('i32.and'),
    if_(null, ret(lg('$a'), c(1), o('i32.shr_s'), kindOf(lg('$b')), o('i32.lt_s'), if_('i32', c(-1), c(1)))),
    lg('$b'), c(1), o('i32.and'),
    if_(null, ret(kindOf(lg('$a')), lg('$b'), c(1), o('i32.shr_s'), o('i32.lt_s'), if_('i32', c(-1), c(1)))),
    kindOf(lg('$a')), lt('$ka'), c(TAG_CLOSURE), o('i32.eq'), if_(null, trap(ERR.COMPARE_FN)),
    lg('$ka'), c(TAG_STRING), o('i32.eq'), if_(null, ret(lg('$a'), lg('$b'), call('$rt:str_cmp'))),
    kindOf(lg('$b')), lt('$kb'), lg('$ka'), o('i32.ne'),
    if_(null, ret(lg('$ka'), lg('$kb'), o('i32.lt_s'), if_('i32', c(-1), c(1)))),
    // Same kind, different size: only arrays; the shorter one is smaller.
    lenOf(lg('$a')), lenOf(lg('$b')), o('i32.ne'),
    if_(null, ret(lenOf(lg('$a')), lenOf(lg('$b')), o('i32.lt_u'), if_('i32', c(-1), c(1)))),
    lenOf(lg('$a')), lt('$n'), o('i32.eqz'), if_(null, ret(c(0))),
    c(0), ls('$i'),
    loop('fields', [lg('$i'), lg('$n'), c(1), o('i32.sub'), o('i32.ge_s')], [
      lg('$a'), lg('$i'), c(2), o('i32.shl'), o('i32.add'), ld(4),
      lg('$b'), lg('$i'), c(2), o('i32.shl'), o('i32.add'), ld(4),
      call('$rt:compare'), lt('$r'), if_(null, ret(lg('$r'))),
      lg('$i'), c(1), o('i32.add'), ls('$i'),
    ]),
    lg('$a'), lg('$n'), c(2), o('i32.shl'), o('i32.add'), ld(), ls('$a'),
    lg('$b'), lg('$n'), c(2), o('i32.shl'), o('i32.add'), ld(), ls('$b'),
    ['br', '$top'],
    ['end'],
    o('unreachable'),
  ], 'Structural ordering: constructor index (arrays: length), then fields left to right. Returns raw -1/0/1.');

  // ------------------------------------------------------------- strings --
  fn('$rt:str_eq', ['$a', '$b'], ['i32'], ['$n', '$i'], [
    lg('$a'), lg('$b'), o('i32.eq'), if_(null, ret(c(1))),
    lenOf(lg('$a')), lt('$n'), lenOf(lg('$b')), o('i32.ne'), if_(null, ret(c(0))),
    c(0), ls('$i'),
    loop('bytes', [lg('$i'), lg('$n'), o('i32.ge_u')], [
      lg('$a'), lg('$i'), o('i32.add'), ['i32.load8_u', 4],
      lg('$b'), lg('$i'), o('i32.add'), ['i32.load8_u', 4],
      o('i32.ne'), if_(null, ret(c(0))),
      lg('$i'), c(1), o('i32.add'), ls('$i'),
    ]),
    c(1),
  ]);

  fn('$rt:str_cmp', ['$a', '$b'], ['i32'], ['$la', '$lb', '$i', '$x', '$y'], [
    lenOf(lg('$a')), ls('$la'), lenOf(lg('$b')), ls('$lb'),
    c(0), ls('$i'),
    loop('bytes', [lg('$i'), lg('$la'), o('i32.ge_u'), lg('$i'), lg('$lb'), o('i32.ge_u'), o('i32.or')], [
      lg('$a'), lg('$i'), o('i32.add'), ['i32.load8_u', 4], lt('$x'),
      lg('$b'), lg('$i'), o('i32.add'), ['i32.load8_u', 4], lt('$y'),
      o('i32.ne'), if_(null, ret(lg('$x'), lg('$y'), o('i32.lt_u'), if_('i32', c(-1), c(1)))),
      lg('$i'), c(1), o('i32.add'), ls('$i'),
    ]),
    lg('$la'), lg('$lb'), o('i32.gt_u'), lg('$la'), lg('$lb'), o('i32.lt_u'), o('i32.sub'),
  ]);

  const newString = (lenLocal) => seq(
    objBytes(lg(lenLocal)), call('$rt:alloc'), ls('$p'),
    lg('$p'), lg(lenLocal), c(9), o('i32.shl'), c((TAG_STRING << 1) | 1), o('i32.or'), st(),
  );

  fn('$rt:concat', ['$a', '$b'], ['i32'], ['$la', '$lb', '$n', '$p', '$fp'], [
    lenOf(lg('$a')), lt('$la'), o('i32.eqz'), if_(null, ret(lg('$b'))),
    lenOf(lg('$b')), lt('$lb'), o('i32.eqz'), if_(null, ret(lg('$a'))),
    lg('$la'), lg('$lb'), o('i32.add'), lt('$n'), c(MAX_STRING), o('i32.gt_u'), if_(null, trap(ERR.STR_LEN)),
    pushRoots('$a', '$b'),
    newString('$n'),
    popRoots('$a', '$b'),
    lg('$p'), c(4), o('i32.add'), lg('$a'), c(4), o('i32.add'), lg('$la'), ['memory.copy'],
    lg('$p'), c(4), o('i32.add'), lg('$la'), o('i32.add'), lg('$b'), c(4), o('i32.add'), lg('$lb'), ['memory.copy'],
    lg('$p'),
  ], 'String concatenation (`++`).');

  fn('$rt:int_to_string', ['$v'], ['i32'], ['$n', '$neg', '$pos', '$len', '$p'], [
    lg('$v'), c(1), o('i32.shr_s'), lt('$n'), c(0), o('i32.lt_s'), lt('$neg'),
    if_(null, [c(0), lg('$n'), o('i32.sub'), ls('$n')]),
    c(layout.SCRATCH_END), ls('$pos'),
    ['loop', '$digits', null],
    lg('$pos'), c(1), o('i32.sub'), lt('$pos'),
    lg('$n'), c(10), o('i32.rem_u'), c(48), o('i32.add'), ['i32.store8', 0],
    lg('$n'), c(10), o('i32.div_u'), lt('$n'),
    ['br_if', '$digits'],
    ['end'],
    lg('$neg'), if_(null, [lg('$pos'), c(1), o('i32.sub'), lt('$pos'), c(45), ['i32.store8', 0]]),
    c(layout.SCRATCH_END), lg('$pos'), o('i32.sub'), ls('$len'),
    newString('$len'),
    lg('$p'), c(4), o('i32.add'), lg('$pos'), lg('$len'), ['memory.copy'],
    lg('$p'),
  ]);

  fn('$rt:string_length', ['$s'], ['i32'], [], [lenOf(lg('$s')), toBool()]);

  fn('$rt:substring', ['$s', '$a', '$b'], ['i32'], ['$len', '$n', '$p', '$fp'], [
    lenOf(lg('$s')), ls('$len'),
    // start = clamp(a, 0, len); end = clamp(b, start, len)
    lg('$a'), c(1), o('i32.shr_s'), ls('$a'),
    lg('$a'), c(0), o('i32.lt_s'), if_(null, [c(0), ls('$a')]),
    lg('$a'), lg('$len'), o('i32.gt_s'), if_(null, [lg('$len'), ls('$a')]),
    lg('$b'), c(1), o('i32.shr_s'), ls('$b'),
    lg('$b'), lg('$len'), o('i32.gt_s'), if_(null, [lg('$len'), ls('$b')]),
    lg('$b'), lg('$a'), o('i32.lt_s'), if_(null, [lg('$a'), ls('$b')]),
    lg('$b'), lg('$a'), o('i32.sub'), lt('$n'), lg('$len'), o('i32.eq'), if_(null, ret(lg('$s'))),
    lg('$n'), o('i32.eqz'), if_(null, ret(c(layout.EMPTY_STRING))),
    pushRoots('$s'),
    newString('$n'),
    popRoots('$s'),
    lg('$p'), c(4), o('i32.add'), lg('$s'), c(4), o('i32.add'), lg('$a'), o('i32.add'), lg('$n'), ['memory.copy'],
    lg('$p'),
  ]);

  fn('$rt:char_code_at', ['$s', '$i'], ['i32'], [], [
    lg('$i'), c(1), o('i32.shr_s'), lt('$i'), lenOf(lg('$s')), o('i32.ge_u'), if_(null, trap(ERR.INDEX)),
    lg('$s'), lg('$i'), o('i32.add'), ['i32.load8_u', 4], toBool(),
  ]);

  fn('$rt:char_from_code', ['$c'], ['i32'], [], [
    lg('$c'), c(1), o('i32.shr_u'), c(255), o('i32.and'), c(3), o('i32.shl'), c(layout.CHAR_TABLE), o('i32.add'),
  ], 'Single-byte strings live in a static table, so this never allocates.');

  fn('$rt:print', ['$s'], ['i32'], [], [lg('$s'), c(0), call('$host:print'), c(1)]);
  fn('$rt:println', ['$s'], ['i32'], [], [lg('$s'), c(1), call('$host:print'), c(1)]);
  fn('$rt:panic', ['$s'], ['i32'], [], [c(ERR.PANIC), lg('$s'), call('$host:error'), o('unreachable')]);

  fn('$rt:read_input', [], ['i32'], ['$n', '$p'], [
    call('$host:input_len'), lt('$n'), c(MAX_STRING), o('i32.gt_u'), if_(null, trap(ERR.STR_LEN)),
    newString('$n'),
    lg('$p'), c(4), o('i32.add'), call('$host:input_copy'),
    lg('$p'),
  ], 'Returns the input the host supplied, as one string.');

  // -------------------------------------------------------------- arrays --
  // An array is a heap block of kind TAG_ARRAY whose fields are its elements,
  // so the collector scans and copies it like any constructor. Arrays are
  // the only mutable values.
  const checkIndex = seq(lg('$i'), c(1), o('i32.shr_s'), lt('$i'), lenOf(lg('$a')), o('i32.ge_u'), if_(null, trap(ERR.INDEX)));
  const element = seq(lg('$a'), lg('$i'), c(2), o('i32.shl'), o('i32.add'));
  fn('$rt:array_make', ['$n', '$x'], ['i32'], ['$len', '$p', '$i', '$fp'], [
    lg('$n'), c(1), o('i32.shr_s'), lt('$len'), c(0), o('i32.lt_s'), if_(null, trap(ERR.INDEX)),
    lg('$len'), c(MAX_ARRAY), o('i32.gt_s'), if_(null, trap(ERR.OOM)),
    pushRoots('$x'),
    lg('$len'), c(2), o('i32.shl'), c(4), o('i32.add'), call('$rt:alloc'), ls('$p'),
    popRoots('$x'),
    lg('$p'), lg('$len'), c(9), o('i32.shl'), c(TAG_ARRAY * 2 + 1), o('i32.or'), st(0),
    c(0), ls('$i'),
    loop('fill', [lg('$i'), lg('$len'), o('i32.ge_s')], [
      lg('$p'), lg('$i'), c(2), o('i32.shl'), o('i32.add'), lg('$x'), st(4),
      lg('$i'), c(1), o('i32.add'), ls('$i'),
    ]),
    lg('$p'),
  ], 'array_make(n, x): a new array holding n copies of x.');
  fn('$rt:array_get', ['$a', '$i'], ['i32'], [], [checkIndex, element, ld(4)]);
  fn('$rt:array_set', ['$a', '$i', '$x'], ['i32'], [], [checkIndex, element, lg('$x'), st(4), c(1)]);
  fn('$rt:array_length', ['$a'], ['i32'], [], [lenOf(lg('$a')), toBool()]);
}

export const BUILTIN_RUNTIME = {
  print: '$rt:print',
  println: '$rt:println',
  int_to_string: '$rt:int_to_string',
  string_length: '$rt:string_length',
  substring: '$rt:substring',
  char_code_at: '$rt:char_code_at',
  char_from_code: '$rt:char_from_code',
  panic: '$rt:panic',
  read_input: '$rt:read_input',
  array_make: '$rt:array_make',
  array_get: '$rt:array_get',
  array_set: '$rt:array_set',
  array_length: '$rt:array_length',
};
