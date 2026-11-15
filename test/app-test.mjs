// Tests of the page's pot logic (src/pot.mjs) on the mock network: pot links, deadline <-> date, and the create,
// top-up, award and refund transactions the page asks a wallet to sign.
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { secp256k1, hash160, binToHex, generatePrivateKey, decodeTransaction, hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { randomBytes } from 'node:crypto';
import {
  encodePotLink, decodePotLink, potContract, newSalt, heightForTime, timeForHeight, buildPayment, buildSweep, bip21,
  p2pkhAddress, MAX_FEE,
} from '../src/pot.mjs';
import { encodePotMeta } from '../src/potread.mjs';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '-', String(e?.message ?? e).split('\n')[0].slice(0, 300)); }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };
const throws = (fn, re) => { try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message); return; } throw new Error('did not throw'); };
const key = () => { const priv = generatePrivateKey(() => Uint8Array.from(randomBytes(32))); const pub = secp256k1.derivePublicKeyCompressed(priv); return { pub, pkh: hash160(pub), addr: p2pkhAddress(pub, 'bchtest') }; };
const poster = key(), judge = key(), winner = key();
const params = { posterPkh: binToHex(poster.pkh), judgePk: binToHex(judge.pub), deadline: 333000, maxFee: Number(MAX_FEE), salt: newSalt() };
const outAddr = (o) => lockingBytecodeToCashAddress({ bytecode: o.lockingBytecode, prefix: 'bchtest' }).address;

await t('pot link round-trips and rebuilds the same address', () => {
  const link = encodePotLink(params), back = decodePotLink(link);
  eq(JSON.stringify(back), JSON.stringify(params));
  const p = new MockNetworkProvider();
  eq(potContract(back, p).address, potContract(params, p).address);
});
await t('bad pot links are refused', () => {
  throws(() => decodePotLink('hello'), /not a Pot link/);
  throws(() => decodePotLink(encodePotLink({ ...params, salt: 'zz' })), /salt/);
  throws(() => decodePotLink(encodePotLink({ ...params, judgePk: '04' + 'ab'.repeat(32) })), /judge/);
  throws(() => decodePotLink(encodePotLink({ ...params, deadline: 600000000 })), /deadline/);
});
await t('two new pots with the same terms get different addresses (salt)', () => {
  const p = new MockNetworkProvider();
  if (potContract({ ...params, salt: newSalt() }, p).address === potContract({ ...params, salt: newSalt() }, p).address) throw new Error('same address');
});
await t('deadline: a date becomes the first block at or after it, and back', () => {
  const now = Date.UTC(2026, 10, 15, 12, 0), tip = 977900;
  eq(heightForTime(now + 3 * 86400e3, tip, now), tip + 432);
  eq(heightForTime(now + 601e3, tip, now), tip + 2, 'rounds up');
  eq(heightForTime(now - 86400e3, tip, now), tip + 1, 'never in the past');
  eq(timeForHeight(tip + 6, tip, now), now + 3600e3);
});
await t('bip21 top-up URI', () => {
  eq(bip21('bitcoincash:pabc', 100000n), 'bitcoincash:pabc?amount=0.001');
  eq(bip21('bitcoincash:pabc', 2000n, 'Pot top-up'), 'bitcoincash:pabc?amount=0.00002&label=Pot%20top-up');
});

const wallet = async (...vals) => {
  const provider = new MockNetworkProvider();
  for (const v of vals) provider.addUtxo(poster.addr, randomUtxo({ satoshis: BigInt(v) }));
  const coins = (await provider.getUtxos(poster.addr)).map((utxo, i) => ({ utxo, address: poster.addr, path: ['receive', 0] }));
  return { provider, coins };
};
await t('create: pays the pot, carries POT1, change back, fee from the signed size', async () => {
  const { provider, coins } = await wallet(50000, 8000);
  const C = potContract(params, provider);
  const meta = encodePotMeta('Fix the flaky test', 'https://example.org/issues/1');
  const r = buildPayment({ provider, coins, to: C.address, amount: 20000n, extraOutputs: [{ to: meta, amount: 0n }], changeTo: poster.addr, userPrompt: 'Create pot' });
  const tx = r.wcObj.transaction;
  eq(tx.inputs.length, 1, 'inputs (largest coin covers it)'); eq(tx.outputs.length, 3, 'outputs');
  eq(outAddr(tx.outputs[0]), C.address); eq(tx.outputs[0].valueSatoshis, 20000n);
  eq(tx.outputs[1].lockingBytecode[0], 0x6a, 'OP_RETURN');
  eq(outAddr(tx.outputs[2]), poster.addr);
  eq(50000n - 20000n - r.change, r.fee, 'fee');
  if (r.fee < 250n || r.fee > 450n) throw new Error('fee out of range: ' + r.fee);
  eq(JSON.stringify(r.inputPaths), JSON.stringify([[0, 'receive', 0]]));
  eq(r.wcObj.userPrompt, 'Create pot');
});
await t('top-up: uses several coins when one is not enough', async () => {
  const { provider, coins } = await wallet(3000, 2500, 1200);
  const r = buildPayment({ provider, coins, to: potContract(params, provider).address, amount: 5300n, changeTo: poster.addr });
  eq(r.wcObj.transaction.inputs.length, 3); eq(r.inputPaths.length, 3);
});
await t('top-up: a leftover below dust goes to the fee, no change output', async () => {
  const { provider, coins } = await wallet(3000, 2500);
  const r = buildPayment({ provider, coins, to: potContract(params, provider).address, amount: 5000n, changeTo: poster.addr });
  eq(r.wcObj.transaction.outputs.length, 1); eq(r.change, 0n); eq(r.fee, 500n);
});
await t('top-up: not enough coins -> readable error', async () => {
  const { provider, coins } = await wallet(1500);
  throws(() => buildPayment({ provider, coins, to: potContract(params, provider).address, amount: 5000n, changeTo: poster.addr }), /Not enough coins/);
  throws(() => buildPayment({ provider, coins: [], to: potContract(params, provider).address, amount: 5000n, changeTo: poster.addr }), /no spendable coins/);
});
await t('award: sweeps every pot coin to the winner, signed by the judge path', async () => {
  const provider = new MockNetworkProvider();
  const C = potContract(params, provider);
  for (const v of [20000n, 3000n, 2500n]) provider.addUtxo(C.address, randomUtxo({ satoshis: v }));
  const utxos = await provider.getUtxos(C.address);
  const r = buildSweep({ provider, params, kind: 'award', utxos, to: winner.addr, userPrompt: (p) => `Award ${p.amount}` });
  const tx = r.wcObj.transaction;
  eq(tx.inputs.length, 3); eq(tx.outputs.length, 1); eq(outAddr(tx.outputs[0]), winner.addr);
  eq(tx.outputs[0].valueSatoshis, 25500n - r.plan.fee);
  eq(r.wcObj.sourceOutputs[0].contract.abiFunction.name, 'award');
  eq(JSON.stringify(r.inputPaths), JSON.stringify([[0, 'receive', 0], [1, 'receive', 0], [2, 'receive', 0]]));
  eq(r.wcObj.userPrompt, `Award ${tx.outputs[0].valueSatoshis}`);
});
await t('refund: locktime set, pays the poster', async () => {
  const provider = new MockNetworkProvider();
  const C = potContract(params, provider);
  provider.addUtxo(C.address, randomUtxo({ satoshis: 20000n }));
  const r = buildSweep({ provider, params, kind: 'refund', utxos: await provider.getUtxos(C.address), to: poster.addr, locktime: 333001 });
  eq(r.wcObj.transaction.locktime, 333001); eq(outAddr(r.wcObj.transaction.outputs[0]), poster.addr);
  eq(r.wcObj.sourceOutputs[0].contract.abiFunction.name, 'refund');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
