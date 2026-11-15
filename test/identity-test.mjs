// Tests of the Nostr identity layer (src/nostrbind.mjs + buildBindProof in src/pot.mjs): the stored v1 vectors, one
// vector in each rival format (test/interop-vectors.json), the pick rules, key recovery for "judge by npub", the wc-tx
// proof the page asks a wallet to sign, and resolve/lookup/publish against a mock relay. Throwaway keys from labels only.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import {
  secp256k1, sha256, hash160, utf8ToBin, binToHex, hexToBin, encodeCashAddress, decodeTransaction, encodeTransaction,
  generateSigningSerializationBch, SigningSerializationFlag, hash256,
} from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { signMessage, bindingMessage, verifyBinding } from '../src/bindverify.mjs';
import {
  checkBinding, pickBindings, bindingPubkey, npubToHex, resolveNpub, findByAddress, publishEvent, unsignedBinding, SIGNMESSAGE_LIMIT,
} from '../src/nostrbind.mjs';
import { buildBindProof, wcRequest, BIND_LOCKTIME, p2pkhAddress } from '../src/pot.mjs';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '-', String(e?.message ?? e).split('\n')[0].slice(0, 300)); }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };
const k = (label) => sha256.hash(utf8ToBin('nostr-bch-bind test key: ' + label));
const addrOf = (priv, prefix = 'bitcoincash') => encodeCashAddress({ prefix, type: 'p2pkh', payload: hash160(secp256k1.derivePublicKeyCompressed(priv)) }).address;
const nsecA = k('nostr A'), nsecB = k('nostr B'), bchA = k('bch A'), bchB = k('bch B');
const npubA = getPublicKey(nsecA), npubB = getPublicKey(nsecB), addrA = addrOf(bchA), addrB = addrOf(bchB);
const T = 1794000000;
const v1 = (nsec, priv, addr, created) => finalizeEvent(unsignedBinding(getPublicKey(nsec), addr, created, 'signmessage',
  signMessage(priv, bindingMessage(getPublicKey(nsec), addr, created))), nsec);

// ---------- rival-format vectors (written once; nostr signatures use random aux data, so they are stored)
const IV = new URL('./interop-vectors.json', import.meta.url);
if (!existsSync(IV)) {
  const st = `bch-nostr-bind.v1:${npubA}:${addrA}:${T}`;
  const penny = finalizeEvent({ kind: 30078, created_at: T, content: st,
    tags: [['d', 'bch-nostr-bind'], ['i', `bch:${addrA}`, signMessage(bchA, st)], ['statement', st]] }, nsecA);
  const bid = binToHex(sha256.hash(utf8ToBin('test binding id')));
  const content = JSON.stringify({ bch: { address: addrA, network: 'mainnet' }, bindingId: bid, createdAt: T, nonce: '00'.repeat(32),
    protocol: 'bch-identity-bridge', purpose: 'identity-binding-v1', version: '1.0.0' });
  const bib = finalizeEvent({ kind: 31234, created_at: T, content,
    tags: [['d', bid], ['bch', addrA, 'mainnet'], ['protocol', 'bch-identity-bridge', '1.0.0'], ['nonce', '00'.repeat(32)]] }, nsecA);
  writeFileSync(IV, JSON.stringify({ note: 'one event per rival format, made with the throwaway test keys of bind-vectors.json; never fund',
    vectors: [{ name: 'pennyops bch-nostr-bind.v1 (signmessage in the i tag)', expect: true, event: penny },
      { name: 'bch-identity-bridge 1.0.0 (kind 31234, BCH signature kept off-relay)', expect: false, event: bib }] }, null, 1));
}
const interop = JSON.parse(readFileSync(IV, 'utf8')).vectors;

await t('every stored v1 vector: checkBinding agrees with the expected result', () => {
  const { vectors } = JSON.parse(readFileSync(new URL('./bind-vectors.json', import.meta.url)));
  for (const v of vectors.filter((x) => x.event)) {
    const c = checkBinding(v.event);
    if (c.ok !== v.expect) throw new Error(`${v.name}: ${c.ok} (${c.reason})`);
    if (!c.ok && c.reason !== v.result.reason) throw new Error(`${v.name}: reason ${c.reason} vs ${v.result.reason}`);
  }
});

await t('pennyops vector verifies, labelled with its format, and its address and npub come out', () => {
  const c = checkBinding(interop[0].event);
  eq(c.ok, true, c.reason); eq(c.format, 'pennyops'); eq(c.addr, addrA); eq(c.npub, npubA);
});

await t('pennyops vector with another key\'s BCH signature is refused', () => {
  const st = `bch-nostr-bind.v1:${npubA}:${addrA}:${T}`;
  const ev = finalizeEvent({ kind: 30078, created_at: T, content: st, tags: [['d', 'bch-nostr-bind'], ['i', `bch:${addrA}`, signMessage(bchB, st)]] }, nsecA);
  const c = checkBinding(ev); eq(c.ok, false); eq(c.reason, 'signature is not by this address');
});

await t('bch-identity-bridge vector: Nostr signature checks, but it is reported unverifiable, never valid', () => {
  const c = checkBinding(interop[1].event);
  eq(c.ok, false); eq(c.unverifiable, true); eq(c.checks[0].ok, true); eq(c.addr, addrA);
  eq(pickBindings([interop[1].event]).best, null);
});

await t('other apps\' kind 30078 data is ignored', () => {
  eq(checkBinding(finalizeEvent({ kind: 30078, created_at: T, content: 'x', tags: [['d', 'some-app-settings']] }, nsecA)), null);
});

await t('pick: newest valid binding wins; a newer signed revocation drops its slot; a forged copy never shadows', () => {
  const old = v1(nsecA, bchA, addrA, T), newer = v1(nsecA, bchB, addrB, T + 100);
  eq(pickBindings([old, newer]).best.addr, addrB);
  const revokeB = finalizeEvent({ kind: 30078, created_at: T + 200, content: 'revoked', tags: [['d', `bch-bind:${addrB}`], ['i', `bch:${addrB}`]] }, nsecA);
  const r = pickBindings([old, newer, revokeB]);
  eq(r.best.addr, addrA); eq(r.revoked.length, 1);
  const forged = { ...old, sig: '00'.repeat(64) };
  eq(pickBindings([forged, old]).best?.eventId, old.id);
  eq(pickBindings([old, forged]).best?.eventId, old.id);
});

await t('pick by address: only bindings to that address count (address lookup)', () => {
  const a = v1(nsecA, bchA, addrA, T), b = v1(nsecB, bchB, addrB, T + 50);
  const r = pickBindings([a, b], { addr: addrA });
  eq(r.best.npub, npubA); eq(r.valid.length, 1);
});

await t('binding pubkey (judge by npub): signmessage recovers the compressed key of the address', () => {
  eq(bindingPubkey(v1(nsecA, bchA, addrA, T)), binToHex(secp256k1.derivePublicKeyCompressed(bchA)));
  eq(bindingPubkey(interop[0].event), binToHex(secp256k1.derivePublicKeyCompressed(bchA)));
  eq(bindingPubkey(interop[1].event), null);
});

// a wallet that signs P2PKH inputs the way WizardConnect wallets do (Schnorr, ALL|UTXOS|FORKID)
function walletSign(req, priv) {
  const tx = decodeTransaction(hexToBin(req.transaction.transaction));
  const sos = req.transaction.sourceOutputs.map((so) => ({ ...so, outpointTransactionHash: hexToBin(so.outpointTransactionHash.replace(/^<Uint8Array: 0x|>$/g, '')),
    lockingBytecode: hexToBin(so.lockingBytecode.replace(/^<Uint8Array: 0x|>$/g, '')), unlockingBytecode: new Uint8Array(), valueSatoshis: BigInt(String(so.valueSatoshis).replace(/n$/, '').replace(/^<bigint: /, '').replace(/n>$/, '')) }));
  const HT = SigningSerializationFlag.allOutputs | SigningSerializationFlag.utxos | SigningSerializationFlag.forkId;
  const pre = generateSigningSerializationBch({ inputIndex: 0, sourceOutputs: sos, transaction: tx }, { coveredBytecode: sos[0].lockingBytecode, signingSerializationType: new Uint8Array([HT]) });
  const sig = Uint8Array.from([...secp256k1.signMessageHashSchnorr(priv, hash256(pre)), HT]), pub = secp256k1.derivePublicKeyCompressed(priv);
  tx.inputs[0].unlockingBytecode = Uint8Array.from([sig.length, ...sig, pub.length, ...pub]);
  return binToHex(encodeTransaction(tx));
}

await t('wc-tx proof request: unbroadcastable, change to the same address, and the signed proof verifies as a binding', async () => {
  const provider = new MockNetworkProvider(), cA = addrOf(bchA, 'bchtest');
  provider.addUtxo(cA, randomUtxo({ satoshis: 50000n }));
  const [utxo] = await provider.getUtxos(cA);
  const m = bindingMessage(npubA, cA, T);
  const b = buildBindProof({ provider, coin: { utxo, address: cA, path: ['receive', 0] }, message: m, userPrompt: 'Signature only' });
  const req = wcRequest(b.wcObj, b.inputPaths);
  eq(req.transaction.broadcast, false, 'broadcast');
  const raw = decodeTransaction(hexToBin(req.transaction.transaction));
  eq(raw.locktime, BIND_LOCKTIME, 'locktime'); eq(raw.inputs[0].sequenceNumber !== 0xffffffff, true, 'non-final');
  eq(raw.outputs.length, 2); eq(raw.outputs[1].valueSatoshis, 49700n);
  const ev = finalizeEvent(unsignedBinding(npubA, cA, T, 'wc-tx', b.proof(walletSign(req, bchA))), nsecA);
  const v = verifyBinding(ev); eq(v.ok, true, v.reason);
  eq(bindingPubkey(ev), binToHex(secp256k1.derivePublicKeyCompressed(bchA)));
  const evBad = finalizeEvent(unsignedBinding(npubA, cA, T, 'wc-tx', b.proof(walletSign(req, bchB))), nsecA);
  eq(verifyBinding(evBad).ok, false, 'signed by another key');
});

await t('wc-tx proof refuses token coins and coins too small to carry it', async () => {
  const coin = (satoshis, token) => ({ utxo: { txid: '11'.repeat(32), vout: 0, satoshis, ...(token ? { token: { category: '22'.repeat(32), amount: 1n } } : {}) }, address: addrA, path: ['receive', 0] });
  for (const c of [coin(50000n, true), coin(600n)]) {
    let threw = false; try { buildBindProof({ provider: new MockNetworkProvider(), coin: c, message: 'm' }); } catch { threw = true; }
    eq(threw, true);
  }
});

await t('binding message stays under the signmessage interop limit for the longest cashaddr', () => {
  const longest = bindingMessage('f'.repeat(64), 'bitcoincash:' + 'p'.repeat(61), 9999999999);
  eq(new TextEncoder().encode(longest).length < SIGNMESSAGE_LIMIT, true);
});

await t('npubToHex: npub1 and 64-hex accepted, junk refused', () => {
  eq(npubToHex(npubEncode(npubA)), npubA); eq(npubToHex(npubA.toUpperCase()), npubA);
  eq(npubToHex('npub1xyz'), null); eq(npubToHex('bitcoincash:qq'), null);
});

// ---------- mock relay
function mockRelays(store, { dead = [] } = {}) {
  const published = [];
  class WS {
    constructor(url) { this.url = url; this.readyState = 0; setTimeout(() => { if (dead.includes(url)) { this.onerror?.(); return; } this.readyState = 1; this.onopen?.(); }, 5); }
    send(s) {
      const d = JSON.parse(s);
      const reply = (m) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 2);
      if (d[0] === 'EVENT') { published.push({ relay: this.url, ev: d[1] }); reply(['OK', d[1].id, true, '']); return; }
      if (d[0] !== 'REQ') return;
      const [, sub, ...filters] = d;
      const match = (e, f) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey))
        && (!f['#i'] || e.tags.some((tg) => tg[0] === 'i' && f['#i'].includes(tg[1])));
      for (const e of store) if (filters.some((f) => match(e, f))) reply(['EVENT', sub, e]);
      reply(['EOSE', sub]);
    }
    close() { this.readyState = 3; }
  }
  return { WS, published };
}

await t('resolve npub over relays: newest valid wins, a newer bad-proof event is skipped with its reason', async () => {
  const good = v1(nsecA, bchA, addrA, T);
  const bad = finalizeEvent(unsignedBinding(npubA, addrB, T + 60, 'signmessage', signMessage(bchA, bindingMessage(npubA, addrB, T + 60))), nsecA);
  const { WS } = mockRelays([good, bad, interop[1].event]);
  const r = await resolveNpub(npubEncode(npubA), { relays: ['wss://a', 'wss://b'], WebSocketImpl: WS, timeoutMs: 500, graceMs: 50 });
  eq(r.best.addr, addrA); eq(r.skipped[0].reason, 'signature is not by this address'); eq(r.unverifiable.length, 1);
});

await t('resolve npub: no binding / bad npub / no relay give their own errors', async () => {
  const { WS } = mockRelays([]);
  const code = async (p) => { try { await p; return 'none'; } catch (e) { return e.code; } };
  eq(await code(resolveNpub(npubEncode(npubB), { relays: ['wss://a'], WebSocketImpl: WS, timeoutMs: 300 })), 'NO_BINDING');
  eq(await code(resolveNpub('npub1nope', { relays: ['wss://a'], WebSocketImpl: WS })), 'BAD_NPUB');
  const dead = mockRelays([], { dead: ['wss://a'] });
  eq(await code(resolveNpub(npubEncode(npubB), { relays: ['wss://a'], WebSocketImpl: dead.WS, timeoutMs: 300 })), 'NO_RELAY');
});

await t('resolve npub with a network prefix: a chipnet binding does not resolve on mainnet', async () => {
  const chipAddr = addrOf(bchB, 'bchtest');
  const { WS } = mockRelays([v1(nsecB, bchB, chipAddr, T)]);
  let code = 'none'; try { await resolveNpub(npubB, { relays: ['wss://a'], WebSocketImpl: WS, timeoutMs: 300, prefix: 'bitcoincash' }); } catch (e) { code = e.code; }
  eq(code, 'NO_BINDING');
  eq((await resolveNpub(npubB, { relays: ['wss://a'], WebSocketImpl: WS, timeoutMs: 300, prefix: 'bchtest' })).best.addr, chipAddr);
});

await t('find by address (#i): our format and pennyops both found, a binding to another address is not', async () => {
  const { WS } = mockRelays([v1(nsecB, bchA, addrA, T + 5), interop[0].event, v1(nsecA, bchB, addrB, T)]);
  const r = await findByAddress(addrA, { relays: ['wss://a'], WebSocketImpl: WS, timeoutMs: 300 });
  eq(r.valid.length, 2); eq(r.best.npub, npubB); eq(r.valid[1].format, 'pennyops');
});

await t('publish: each relay\'s OK is reported', async () => {
  const { WS, published } = mockRelays([]);
  const ev = v1(nsecA, bchA, addrA, T);
  const r = await publishEvent(ev, { relays: ['wss://a', 'wss://b'], WebSocketImpl: WS });
  eq(r.filter((x) => x.ok).length, 2); eq(published.length, 2);
});

await t('real mainnet binding signed by the Paytaca extension verifies, and resolves to the demo pots\' judge key', () => {
  const { event } = JSON.parse(readFileSync(new URL('./mainnet-binding.json', import.meta.url)));
  const c = checkBinding(event);
  eq(c.ok, true, c.reason); eq(c.addr, 'bitcoincash:qzjta36gk6ycrmlcnaln07z4yda305lepy7tp7cnvp'); eq(c.proofKind, 'signmessage');
  eq(bindingPubkey(event), '02259a322083854c4f76b91595c6f7630bcdcdb6407b66d3b09d0f9e3ef2683095');
  const tampered = { ...event, content: event.content.replace('qzjta36g', 'qzjta36h') };
  eq(checkBinding(tampered).ok, false);
});

await t('p2pkhAddress helper and the test keys agree', () => { eq(p2pkhAddress(secp256k1.derivePublicKeyCompressed(bchA), 'bitcoincash'), addrA); });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
