// nostr-bch-bind v1 (BIND-SPEC.md): reference create/verify + the test vectors, with throwaway keys derived from labels.
// The browser-safe part (message, signmessage, verifyBinding, resolve) lives in bindverify.mjs; this file adds the
// cashscript-built wc-tx proof signer and the vectors.
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { secp256k1, sha256, hash160, encodeCashAddress, decodeCashAddress, binToHex, utf8ToBin, encodeLockingBytecodeP2pkh } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo } from 'cashscript';
import { writeFileSync } from 'node:fs';
import { PROTO, PROOF_LOCKTIME, bindingMessage, signMessage, createBindingEvent, verifyBinding, resolve } from './bindverify.mjs';
export * from './bindverify.mjs';

// --- BCH proof 2b signer (the verifier is in bindverify.mjs)
export async function signWcTx(priv, addr, m, tamperHash, locktime = PROOF_LOCKTIME) {
  const p = new MockNetworkProvider(); p.addUtxo(addr, randomUtxo({ satoshis: 10000n })); const [u] = await p.getUtxos(addr);
  const h = tamperHash ?? binToHex(sha256.hash(utf8ToBin(m)));
  let tb = new TransactionBuilder({ provider: p }).addInput(u, new SignatureTemplate(priv).unlockP2PKH())
    .addOpReturnOutput([PROTO, '0x' + h]).addOutput({ to: encodeLockingBytecodeP2pkh(decodeCashAddress(addr).payload), amount: u.satoshis - 300n });
  if (locktime) tb = tb.setLocktime(locktime);
  const hex = tb.build();
  const pkh = decodeCashAddress(addr).payload;
  return JSON.stringify({ tx: hex, source: { valueSatoshis: String(u.satoshis), lockingBytecode: binToHex(encodeLockingBytecodeP2pkh(pkh)) } });
}
if (import.meta.url === `file://${process.argv[1]}`) {
// --- vectors (throwaway keys from labels; never fund these addresses)
const k = (label) => sha256.hash(utf8ToBin('nostr-bch-bind test key: ' + label));
const nsecA = k('nostr A'), nsecB = k('nostr B'), bchA = k('bch A');
const addrA = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: hash160(secp256k1.derivePublicKeyCompressed(bchA)) }).address;
const T = 1794000000, npubA = getPublicKey(nsecA), npubB = getPublicKey(nsecB);
const mA = bindingMessage(npubA, addrA, T);
const V = [];
const add = (name, expect, ev) => { const r = verifyBinding(ev); V.push({ name, expect, result: r, event: ev });
  console.log((r.ok === expect ? 'ok  ' : 'FAIL'), name, '->', r.ok ? 'valid' : r.reason); };
add('valid signmessage binding', true, createBindingEvent(nsecA, addrA, T, 'signmessage', signMessage(bchA, mA)));
add('valid wc-tx binding', true, createBindingEvent(nsecA, addrA, T, 'wc-tx', await signWcTx(bchA, addrA, mA)));
const otherAddr = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: hash160(secp256k1.derivePublicKeyCompressed(k('bch other'))) }).address;
add('wrong address in content', false, createBindingEvent(nsecA, addrA, T, 'signmessage', signMessage(bchA, mA), bindingMessage(npubA, otherAddr, T)));
add('event signed by a different npub', false, createBindingEvent(nsecB, addrA, T, 'signmessage', signMessage(bchA, mA), mA));
add('created far from created_at (replay)', false, createBindingEvent(nsecA, addrA, T + 86400, 'signmessage', signMessage(bchA, mA), mA));
add('signmessage by a different BCH key', false, createBindingEvent(nsecA, addrA, T, 'signmessage', signMessage(k('bch other'), mA)));
add('wc-tx proof that could be broadcast (locktime 0)', false, createBindingEvent(nsecA, addrA, T, 'wc-tx', await signWcTx(bchA, addrA, mA, undefined, 0)));
add('wc-tx OP_RETURN with a different hash', false, createBindingEvent(nsecA, addrA, T, 'wc-tx', await signWcTx(bchA, addrA, mA, '00'.repeat(32))));
const tampered = { ...createBindingEvent(nsecA, addrA, T, 'signmessage', signMessage(bchA, mA)), created_at: T + 1 };
add('event edited after signing', false, tampered);
const revoke = finalizeEvent({ kind: 30078, created_at: T + 600, content: 'revoked', tags: [['d', `bch-bind:${addrA}`], ['i', `bch:${addrA}`]] }, nsecA);
const rr = resolve([V[0].event, revoke], addrA); console.log(rr.ok === false && rr.reason === 'revoked' ? 'ok  ' : 'FAIL', 'revocation overrides an older binding ->', rr.reason);
V.push({ name: 'revocation overrides an older binding', expect: false, result: rr, events: [V[0].event, revoke] });
const r2 = resolve([V[0].event], addrA); console.log(r2.ok ? 'ok  ' : 'FAIL', 'resolve without revocation ->', r2.ok ? `npub ${r2.npub.slice(0, 12)}… → ${r2.addr}` : r2.reason);
writeFileSync(new URL('../test/bind-vectors.json', import.meta.url), JSON.stringify({ spec: 'nostr-bch-bind v1', note: 'throwaway keys derived from sha256("nostr-bch-bind test key: <label>"); never fund', vectors: V }, null, 1));
const bad = V.filter(v => (v.result.ok === true) !== v.expect).length + (rr.ok ? 1 : 0) + (r2.ok ? 0 : 1);
console.log(`\n${V.length} vectors, ${bad} failed`); process.exit(bad ? 1 : 0);
}
