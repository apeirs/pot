// Mock-network test of BountyEscrow: award, refund after deadline, and the failures that must fail.
import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo } from 'cashscript';
import { secp256k1, hash160, encodeCashAddress, generatePrivateKey } from '@bitauth/libauth';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const artifact = JSON.parse(readFileSync(new URL('../contracts/BountyEscrow.json', import.meta.url)));
const key = () => {
  const priv = generatePrivateKey(() => Uint8Array.from(randomBytes(32)));
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  const pkh = hash160(pub);
  return { priv, pub, pkh, addr: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address };
};
const poster = key(), winner = key(), stranger = key();
const DEADLINE = 1000n, MAXFEE = 2000n, POT = 100000n;

let pass = 0, fail = 0;
async function expect(name, shouldWork, fn) {
  try { await fn(); if (shouldWork) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name, '(went through, should not)'); } }
  catch (e) { if (/missing its lockingBytecode|is not a function/.test(e.message)) { fail++; console.log('SETUP', name, e.message.slice(0,200)); return; } if (!shouldWork) { pass++; console.log('ok  ', name, '-> rejected:', String(e.message).split('\n')[0].slice(0, 90)); } else { fail++; console.log('FAIL', name, String(e.message).slice(0, 400)); } }
}

function setup() {
  const provider = new MockNetworkProvider();
  const c = new Contract(artifact, [poster.pkh, DEADLINE, MAXFEE], { provider, addressType: 'p2sh32' });
  const utxo = randomUtxo({ satoshis: POT });
  provider.addUtxo(c.address, utxo);
  return { provider, c };
}
const send = async (p, fn, signer, to, amount, locktime = 0) => {
  const { provider, c } = await p;
  const [utxo] = await provider.getUtxos(c.address);
  const tb = new TransactionBuilder({ provider })
    .addInput(utxo, c.unlock[fn](signer.pub, new SignatureTemplate(signer.priv)))
    .addOutput({ to, amount });
  if (locktime) tb.setLocktime(locktime);
  return tb.send();
};

await expect('award to winner by poster', true, () => send(setup(), 'award', poster, winner.addr, POT - 1000n));
await expect('award signed by a stranger', false, () => send(setup(), 'award', stranger, winner.addr, POT - 1000n));
await expect('award back to the poster (self-award)', false, () => send(setup(), 'award', poster, poster.addr, POT - 1000n));
await expect('award skimming above the fee cap', false, () => send(setup(), 'award', poster, winner.addr, POT - 5000n));
await expect('refund before the deadline', false, () => send(setup(), 'refund', poster, poster.addr, POT - 1000n, 999));
await expect('refund after the deadline', true, () => send(setup(), 'refund', poster, poster.addr, POT - 1000n, 1000));
await expect('refund after deadline to someone else', false, () => send(setup(), 'refund', poster, stranger.addr, POT - 1000n, 1000));
await expect('refund by a stranger after deadline', false, () => send(setup(), 'refund', stranger, poster.addr, POT - 1000n, 1000));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
