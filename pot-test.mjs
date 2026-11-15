// Mock-network tests of Pot (judge award, top-up sweep, refund) and the attacks that must fail.
import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo } from 'cashscript';
import { secp256k1, hash160, encodeCashAddress, generatePrivateKey } from '@bitauth/libauth';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const artifact = JSON.parse(readFileSync(new URL('./Pot.json', import.meta.url)));
const key = () => {
  const priv = generatePrivateKey(() => Uint8Array.from(randomBytes(32)));
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  const pkh = hash160(pub);
  return { priv, pub, pkh, sig: new SignatureTemplate(priv), addr: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address };
};
const poster = key(), judge = key(), winner = key(), stranger = key();
const DEADLINE = 1000n, MAXFEE = 2000n;

let pass = 0, fail = 0;
async function expect(name, shouldWork, fn) {
  try { await fn(); if (shouldWork) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name, '(went through, should not)'); } }
  catch (e) { const m = String(e.message); if (/missing its lockingBytecode|is not a function|Cannot read/.test(m)) { fail++; console.log('SETUP', name, m.slice(0, 200)); return; }
    if (!shouldWork) { pass++; console.log('ok  ', name, '-> rejected:', m.split('\n')[0].slice(0, 80)); } else { fail++; console.log('FAIL', name, m.slice(0, 400)); } }
}

// A pot with the given UTXO values (first = the funding, the rest = top-ups). Returns provider, contract, its utxos.
async function pot(values, judgePk = judge.pub) {
  const provider = new MockNetworkProvider();
  const c = new Contract(artifact, [poster.pkh, judgePk, DEADLINE, MAXFEE], { provider, addressType: 'p2sh32' });
  for (const v of values) provider.addUtxo(c.address, randomUtxo({ satoshis: v }));
  return { provider, c, utxos: await provider.getUtxos(c.address) };
}
const sum = (u) => u.reduce((a, x) => a + x.satoshis, 0n);

// award: the judge signs; all given contract utxos in, one output
async function award({ provider, c, utxos }, signer, to, amount, extra = (tb) => tb) {
  let tb = new TransactionBuilder({ provider });
  for (const u of utxos) tb = tb.addInput(u, c.unlock.award(signer.sig));
  tb = extra(tb).addOutput({ to, amount });
  return tb.send();
}
async function refund({ provider, c, utxos }, signer, to, amount, locktime) {
  let tb = new TransactionBuilder({ provider });
  for (const u of utxos) tb = tb.addInput(u, c.unlock.refund(signer.pub, signer.sig));
  return tb.addOutput({ to, amount }).setLocktime(locktime).send();
}

// --- award
await expect('judge awards a single-UTXO pot to the winner', true, async () => { const p = await pot([100000n]); return award(p, judge, winner.addr, 99000n); });
await expect('judge awards a pot plus 2 top-ups in one sweep', true, async () => { const p = await pot([100000n, 30000n, 5000n]); return award(p, judge, winner.addr, sum(p.utxos) - 1500n); });
await expect('award signed by the poster (not the judge)', false, async () => { const p = await pot([100000n]); return award(p, poster, winner.addr, 99000n); });
await expect('award signed by a stranger', false, async () => { const p = await pot([100000n]); return award(p, stranger, winner.addr, 99000n); });
await expect('award to the poster', false, async () => { const p = await pot([100000n]); return award(p, judge, poster.addr, 99000n); });
await expect('award to the judge', false, async () => { const p = await pot([100000n]); return award(p, judge, judge.addr, 99000n); });
await expect('award skimming above the fee cap', false, async () => { const p = await pot([100000n]); return award(p, judge, winner.addr, 95000n); });
await expect('sweep of 3 UTXOs paying out only 2 of them (skim the top-up)', false, async () => { const p = await pot([100000n, 30000n, 5000n]); return award(p, judge, winner.addr, 130000n); });
await expect('award with a second output (change to the judge)', false, async () => { const p = await pot([100000n]); return award(p, judge, winner.addr, 50000n, (tb) => tb.addOutput({ to: judge.addr, amount: 49000n })); });
await expect('award mixing in a foreign P2PKH input', false, async () => {
  const p = await pot([100000n]); const s = randomUtxo({ satoshis: 50000n }); p.provider.addUtxo(stranger.addr, s); const [su] = await p.provider.getUtxos(stranger.addr);
  return award(p, judge, winner.addr, 149000n, (tb) => tb.addInput(su, stranger.sig.unlockP2PKH())); });
await expect('award mixing inputs of two different pots (same judge)', false, async () => {
  const a = await pot([100000n]); const b = new Contract(artifact, [stranger.pkh, judge.pub, DEADLINE, MAXFEE], { provider: a.provider, addressType: 'p2sh32' });
  a.provider.addUtxo(b.address, randomUtxo({ satoshis: 40000n })); const [bu] = await a.provider.getUtxos(b.address);
  return award(a, judge, winner.addr, 139000n, (tb) => tb.addInput(bu, b.unlock.award(judge.sig))); });
// --- refund
await expect('refund before the deadline', false, async () => { const p = await pot([100000n]); return refund(p, poster, poster.addr, 99000n, 999); });
await expect('refund at the deadline, sweeping 2 UTXOs', true, async () => { const p = await pot([100000n, 20000n]); return refund(p, poster, poster.addr, 119000n, 1000); });
await expect('refund after the deadline to someone else', false, async () => { const p = await pot([100000n]); return refund(p, poster, stranger.addr, 99000n, 1000); });
await expect('refund by the judge after the deadline', false, async () => { const p = await pot([100000n]); return refund(p, judge, poster.addr, 99000n, 1000); });
await expect('refund skimming above the fee cap', false, async () => { const p = await pot([100000n, 20000n]); return refund(p, poster, poster.addr, 100000n, 1000); });
await expect('judge can still award after the deadline', true, async () => { const p = await pot([100000n]); return award(p, judge, winner.addr, 99000n); });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
