// Unit tests for planSweep (sweep.mjs), plus an integration check against the real Pot contract on the mock network:
// the planned sweep must pass the contract's fee cap, and sweeping everything must fail it.
import { planSweep, leftNote, DUST } from './sweep.mjs';
import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo, placeholderSignature, placeholderPublicKey } from 'cashscript';
import { secp256k1, hash160, encodeCashAddress, generatePrivateKey, encodeTransaction } from '@bitauth/libauth';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '-', String(e?.message ?? e).split('\n')[0].slice(0, 300)); }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };
const throws = (fn, re) => { try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message); return; } throw new Error('did not throw'); };
const U = (...vals) => vals.map((v, i) => ({ txid: 'aa'.repeat(31) + String(i).padStart(2, '0'), vout: 0, satoshis: BigInt(v) }));
const lin = (base, per) => (ins) => base + per * ins.length; // bytes model for unit tests

// ---------- unit
await t('one UTXO: taken, fee from bytes', () => {
  const p = planSweep(U(20000), { maxFee: 2000n, bytesFn: lin(100, 300) });
  eq(p.inputs.length, 1); eq(p.left.length, 0); eq(p.bytes, 400); eq(p.fee, 400n); eq(p.amount, 19600n); eq(leftNote(p), '');
});
await t('all fit: take all, payout = total - fee', () => {
  const p = planSweep(U(20000, 1000, 900), { maxFee: 2000n, bytesFn: lin(100, 300) });
  eq(p.inputs.length, 3); eq(p.fee, 1000n); eq(p.amount, 20900n); eq(p.left.length, 0);
});
await t('over the cap: largest kept, smallest left', () => {
  const p = planSweep(U(700, 20000, 650, 900, 800, 1000, 600, 750, 5000, 640), { maxFee: 2000n, bytesFn: lin(100, 300) });
  eq(p.inputs.length, 6, 'inputs'); eq(p.fee, 1900n);
  eq(p.inputs.map((u) => u.satoshis).join(), '20000,5000,1000,900,800,750');
  eq(p.left.map((u) => u.satoshis).join(), '700,650,640,600'); eq(p.leftSats, 2590n);
  eq(leftNote(p), '4 small top-ups left for a later sweep (2,590 sats)');
});
await t('exactly at the limit: fee == maxFee is allowed', () => {
  const p = planSweep(U(10000, 1000, 1000), { maxFee: 2000n, bytesFn: lin(500, 500) }); // 3 inputs = 2000 bytes
  eq(p.inputs.length, 3); eq(p.fee, 2000n); eq(p.amount, 10000n);
});
await t('one byte over the limit: last (smallest) input dropped', () => {
  const p = planSweep(U(10000, 1000, 999), { maxFee: 2000n, bytesFn: lin(501, 500) }); // 3 inputs = 2001 bytes
  eq(p.inputs.length, 2); eq(p.fee, 1501n); eq(p.left[0].satoshis, 999n); eq(leftNote(p), '1 small top-up left for a later sweep (999 sats)');
});
await t('fractional fee rate rounds up', () => {
  const p = planSweep(U(10000), { maxFee: 2000n, feeRatePerByte: 1.1, bytesFn: () => 401 }); // 441.1 -> 442
  eq(p.fee, 442n);
});
await t('fee rate pushes inputs out (2 sat/byte)', () => {
  const p = planSweep(U(20000, 1000, 1000, 1000), { maxFee: 2000n, feeRatePerByte: 2, bytesFn: lin(100, 300) }); // k=3: 2000
  eq(p.inputs.length, 3); eq(p.fee, 2000n);
});
await t('all dust: payout would be below 546 -> readable error', () => {
  throws(() => planSweep(U(550, 550), { maxFee: 2000n, bytesFn: lin(300, 300) }), /below the 546 sat minimum/);
});
await t('several dust top-ups that together clear dust are swept', () => {
  const p = planSweep(U(600, 600, 600), { maxFee: 2000n, bytesFn: lin(100, 250) });
  eq(p.inputs.length, 3); eq(p.amount, 950n);
});
await t('output exactly at dust (546) is allowed', () => {
  const p = planSweep(U(946), { maxFee: 2000n, bytesFn: () => 400 }); eq(p.amount, DUST);
});
await t('output at 545 is refused', () => {
  throws(() => planSweep(U(945), { maxFee: 2000n, bytesFn: () => 400 }), /below the 546/);
});
await t('coin worth less than its input fee is left out (payout not reduced)', () => {
  const p = planSweep(U(3000, 100, 100), { maxFee: 2000n, bytesFn: lin(200, 400) }); // fee-wise all 3 fit (1400), payout <0
  eq(p.inputs.length, 1); eq(p.amount, 2400n); eq(p.left.length, 2);
});
await t('even one input above the cap -> readable error', () => {
  throws(() => planSweep(U(100000), { maxFee: 2000n, bytesFn: () => 2500 }), /Even one UTXO needs a 2500 sat fee/);
});
await t('empty pot -> error', () => { throws(() => planSweep([], { maxFee: 2000n, bytesFn: lin(1, 1) }), /empty/); });
await t('missing bytesFn -> TypeError', () => { throws(() => planSweep(U(1000), { maxFee: 2000n }), /bytesFn/); });
await t('does not mutate the input array; ties are deterministic', () => {
  const us = U(800, 800, 800, 800); const before = us.map((u) => u.txid).join();
  const a = planSweep(us, { maxFee: 1000n, bytesFn: lin(100, 300) }), b = planSweep([...us].reverse(), { maxFee: 1000n, bytesFn: lin(100, 300) });
  eq(us.map((u) => u.txid).join(), before, 'input order'); eq(a.inputs.map((u) => u.txid).join(), b.inputs.map((u) => u.txid).join(), 'tie order');
  eq(a.inputs.length, 3);
});
await t('number maxFee and valueSatoshis shape accepted', () => {
  const p = planSweep([{ valueSatoshis: 5000n }, { valueSatoshis: 700n }], { maxFee: 2000, bytesFn: lin(100, 300) }); eq(p.inputs.length, 2);
});
await t('large pot (300 top-ups): binary search keeps the biggest that fit', () => {
  const vals = Array.from({ length: 300 }, (_, i) => 600 + i);
  let calls = 0; const p = planSweep(U(...vals), { maxFee: 2000n, bytesFn: (ins) => { calls++; return 100 + 250 * ins.length; } });
  eq(p.inputs.length, 7); eq(p.inputs.at(-1).satoshis, 893n); if (calls > 15) throw new Error('too many size builds: ' + calls);
});

// ---------- integration with the real contract (mock network, real Schnorr sigs, sizes from placeholder builds)
const artifact = JSON.parse(readFileSync(new URL('./Pot.json', import.meta.url)));
const key = () => { const priv = generatePrivateKey(() => Uint8Array.from(randomBytes(32))); const pub = secp256k1.derivePublicKeyCompressed(priv);
  return { pub, pkh: hash160(pub), sig: new SignatureTemplate(priv), addr: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(pub) }).address }; };
const poster = key(), judge = key(), winner = key();
const DEADLINE = 1000;
const setup = async (vals) => {
  const provider = new MockNetworkProvider();
  const c = new Contract(artifact, [poster.pkh, judge.pub, BigInt(DEADLINE), 2000n], { provider, addressType: 'p2sh32' });
  for (const v of vals) provider.addUtxo(c.address, randomUtxo({ satoshis: BigInt(v) }));
  return { provider, c, utxos: await provider.getUtxos(c.address) };
};
const tx = ({ provider, c }, kind, ins, amount, real) => {
  let tb = new TransactionBuilder({ provider });
  for (const u of ins) tb = tb.addInput(u, kind === 'award'
    ? c.unlock.award(real ? judge.sig : placeholderSignature())
    : c.unlock.refund(real ? poster.pub : placeholderPublicKey(), real ? poster.sig : placeholderSignature()));
  tb = tb.addOutput({ to: kind === 'award' ? winner.addr : poster.addr, amount });
  return kind === 'refund' ? tb.setLocktime(DEADLINE) : tb;
};
const sizeOf = (env, kind) => (ins) => encodeTransaction(tx(env, kind, ins, 1000n, false).buildLibauthTransaction(true)).length; // as web/app.js

for (const kind of ['award', 'refund']) {
  const vals = [20000, 1000, 950, 900, 850, 800, 750, 700, 650];
  await t(`${kind}: 9 UTXOs on the real contract -> plan passes, sweep-all fails the fee cap`, async () => {
    const env = await setup(vals);
    const p = planSweep(env.utxos, { maxFee: 2000n, bytesFn: sizeOf(env, kind) });
    if (!p.left.length) throw new Error('expected some left out, got all ' + p.inputs.length);
    const sent = await tx(env, kind, p.inputs, p.amount, true).send();
    eq(sent.hex.length / 2, p.bytes, 'signed size = placeholder size');
    const all = sizeOf(env, kind)(env.utxos), total = env.utxos.reduce((s, u) => s + u.satoshis, 0n);
    let rejected = false;
    try { await tx(env, kind, env.utxos, total - BigInt(all), true).send(); } catch (e) { rejected = /line (21|37)/.test(e.message) || /maxFee|total - maxFee/.test(e.message); }
    if (!rejected) throw new Error('sweep-all at 1 sat/byte was not rejected by the fee cap');
    console.log(`      ${kind}: swept ${p.inputs.length}, left ${p.left.length}, ${p.bytes} bytes, fee ${p.fee}; all ${env.utxos.length} would be ${all} bytes`);
  });
  await t(`${kind}: a lone 700-sat UTXO -> readable dust error, not a cashscript fee error`, async () => {
    const env = await setup([700]);
    throws(() => planSweep(env.utxos, { maxFee: 2000n, bytesFn: sizeOf(env, kind) }), /below the 546 sat minimum/);
  });
  await t(`${kind}: a lone 1200-sat UTXO -> swept, accepted`, async () => {
    const env = await setup([1200]);
    const p = planSweep(env.utxos, { maxFee: 2000n, bytesFn: sizeOf(env, kind) });
    await tx(env, kind, p.inputs, p.amount, true).send();
  });
  await t(`${kind}: 3 UTXOs on the real contract -> all taken and accepted`, async () => {
    const env = await setup([20000, 5000, 1000]);
    const p = planSweep(env.utxos, { maxFee: 2000n, bytesFn: sizeOf(env, kind) });
    eq(p.inputs.length, 3); await tx(env, kind, p.inputs, p.amount, true).send();
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
