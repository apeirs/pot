// planSweep: choose which pot UTXOs an award/refund spends so the fee stays under the contract's maxFee.
// Pure (no network). If every UTXO fits, take all; otherwise take the largest ones that fit and leave the
// smallest (tiny top-ups) for a later sweep. A coin worth less than the fee it adds is left out too.
// The fee comes from the real tx size: bytesFn(inputs) -> bytes.
// Never returns an output below dust.

export const DUST = 546n; // smallest standard P2PKH output (award and refund both pay a P2PKH)

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));
const valueOf = (u) => big(u.satoshis ?? u.valueSatoshis ?? u.value);
const ceilFee = (bytes, rate) => {
  // rate may be fractional (sat/byte); work in millisats per byte to stay exact
  const milli = BigInt(Math.round(rate * 1000));
  return (BigInt(Math.ceil(bytes)) * milli + 999n) / 1000n;
};

/**
 * @param {Array<{satoshis: bigint}>} utxos  pot UTXOs (cashscript Utxo shape; valueSatoshis/value also read)
 * @param {{maxFee: bigint|number, feeRatePerByte?: number, bytesFn: (inputs: Array) => number, dust?: bigint}} opts
 * @returns {{inputs: Array, left: Array, bytes: number, fee: bigint, total: bigint, amount: bigint, leftSats: bigint}}
 * @throws Error with a readable message when nothing can be swept (empty pot, or even one UTXO would break a limit)
 */
export function planSweep(utxos, { maxFee, feeRatePerByte = 1, bytesFn, dust = DUST } = {}) {
  if (typeof bytesFn !== 'function') throw new TypeError('planSweep needs bytesFn(inputs) -> tx bytes');
  if (!(feeRatePerByte > 0)) throw new RangeError('feeRatePerByte must be > 0');
  const cap = big(maxFee), minOut = big(dust);
  const coins = [...(utxos ?? [])];
  if (!coins.length) throw new Error('The pot is empty.');
  // largest first; ties broken by outpoint so the plan is deterministic
  coins.sort((a, b) => {
    const d = valueOf(b) - valueOf(a);
    if (d) return d > 0n ? 1 : -1;
    const ka = `${a.txid ?? ''}:${a.vout ?? 0}`, kb = `${b.txid ?? ''}:${b.vout ?? 0}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const plan = (k) => {
    const inputs = coins.slice(0, k);
    const bytes = bytesFn(inputs);
    const fee = ceilFee(bytes, feeRatePerByte);
    const total = inputs.reduce((s, u) => s + valueOf(u), 0n);
    return { inputs, bytes, fee, total, amount: total - fee };
  };
  const fits = (p) => p.fee <= cap && p.amount >= minOut;

  let best = plan(coins.length);
  if (!fits(best)) {
    // largest k whose fee is under the cap (fee grows with k); binary search, then step down if the output is dust
    let lo = 0, hi = coins.length - 1; // invariant: the answer k is in [lo, hi]; k = 0 means none
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (plan(mid).fee <= cap) lo = mid; else hi = mid - 1;
    }
    best = null;
    for (let k = lo; k >= 1; k--) { const p = plan(k); if (fits(p)) { best = p; break; } }
    if (!best) {
      const one = plan(1);
      throw new Error(one.fee > cap
        ? `Even one UTXO needs a ${one.fee} sat fee, above this pot's fee cap of ${cap}.`
        : `The pot holds too little to pay out: ${one.total} sats minus a ${one.fee} sat fee is below the ${minOut} sat minimum.`);
    }
  }
  // drop trailing coins worth less than the fee they add (sweeping them would lower the payout)
  while (best.inputs.length > 1) {
    const fewer = plan(best.inputs.length - 1);
    if (!(fewer.amount > best.amount && fits(fewer))) break;
    best = fewer;
  }
  const left = coins.slice(best.inputs.length);
  return { ...best, left, leftSats: left.reduce((s, u) => s + valueOf(u), 0n) };
}

/** "3 small top-ups left for a later sweep (1,800 sats)" or '' when nothing is left out. */
export const leftNote = (p) => (p.left.length
  ? `${p.left.length} small top-up${p.left.length > 1 ? 's' : ''} left for a later sweep (${p.leftSats.toLocaleString('en')} sats)`
  : '');
