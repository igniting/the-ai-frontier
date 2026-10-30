// The outside world, as far as the `clock` and `random` capabilities can see
// it. The interpreter and the compiled code take these from the same host
// object, so a seeded host with a simulated clock makes every run
// reproducible, which differential testing needs.

export function makeHost({ seed = 1, realClock = false, clockStart = 1_700_000_000_000n } = {}) {
  let state = BigInt.asUintN(64, BigInt(seed) * 0x9e3779b97f4a7c15n) || 1n;
  let now = BigInt(clockStart);
  // xorshift64*
  const next64 = () => {
    state ^= state >> 12n;
    state ^= BigInt.asUintN(64, state << 25n);
    state ^= state >> 27n;
    return BigInt.asUintN(64, state * 0x2545f4914f6cdd1dn);
  };
  return {
    // Milliseconds; the simulated clock advances by one on every reading.
    clock: () => (realClock ? BigInt(Date.now()) : now++),
    // A number in [lo, hi] (the bounds may come in either order).
    random: (lo, hi) => {
      if (lo > hi) [lo, hi] = [hi, lo];
      return lo + next64() % (hi - lo + 1n);
    },
  };
}
