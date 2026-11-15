// nostr-bch-bind v1 (BIND-SPEC.md): the browser-safe half of bind.mjs (message, signmessage, verify, resolve).
// No cashscript, no node: imports, so it bundles for the browser. bind.mjs re-exports all of it.
import { finalizeEvent, verifyEvent, getPublicKey } from 'nostr-tools/pure';
import { secp256k1, sha256, hash160, decodeCashAddress, binToHex, hexToBin, binToBase64, base64ToBin,
  utf8ToBin, decodeTransaction, createVirtualMachineBch, encodeLockingBytecodeP2pkh } from '@bitauth/libauth';

export const PROTO = 'nostr-bch-bind:v1';
const MAGIC = utf8ToBin('Bitcoin Signed Message:\n');
const varint = (n) => n < 253 ? [n] : [253, n & 255, n >> 8];
const sha256d = (b) => sha256.hash(sha256.hash(b));
const msgHash = (m) => { const b = utf8ToBin(m); return sha256d(Uint8Array.from([...varint(MAGIC.length), ...MAGIC, ...varint(b.length), ...b])); };
/** sha256d of the Bitcoin-signed-message preimage: what a signmessage signature signs. */
export const messageHash = msgHash;

export const bindingMessage = (npubHex, addr, created) => `${PROTO}\nnpub:${npubHex}\nbch:${addr}\ncreated:${created}`;
const parse = (c) => { const L = c.split('\n'); if (L.length !== 4 || L[0] !== PROTO) return null;
  const g = (i, k) => L[i].startsWith(k + ':') ? L[i].slice(k.length + 1) : null;
  return { npub: g(1, 'npub'), bch: g(2, 'bch'), created: Number(g(3, 'created')) }; };

// --- BCH proof 2a: signmessage (compact recoverable ECDSA, base64; header 31+recId = compressed)
export function signMessage(priv, m) { const r = secp256k1.signMessageHashRecoverableCompact(priv, msgHash(m));
  return binToBase64(Uint8Array.from([31 + r.recoveryId, ...r.signature])); }
export function verifySignMessage(addr, m, b64) {
  const s = base64ToBin(b64); if (s.length !== 65) return 'bad signature length';
  // header 27-30 = uncompressed key (e.g. an imported old WIF in Electron Cash), 31-34 = compressed; the address is the
  // hash160 of the key in that form, so accepting both stays sound.
  if (s[0] < 27 || s[0] > 34) return 'bad signature header';
  const comp = s[0] >= 31, rec = s[0] - (comp ? 31 : 27);
  const pub = (comp ? secp256k1.recoverPublicKeyCompressed : secp256k1.recoverPublicKeyUncompressed)(s.slice(1), rec, msgHash(m));
  if (typeof pub === 'string') return pub;
  const d = decodeCashAddress(addr); if (typeof d === 'string') return d;
  return binToHex(hash160(pub)) === binToHex(d.payload) ? true : 'signature is not by this address';
}
// --- BCH proof 2b: wc-tx (non-broadcast tx spending one UTXO of the address to OP_RETURN PROTO sha256(message))
// The proof is published, so anyone can try to broadcast it. Two guards: a far-future locktime (2100-01-01, non-final
// sequence) makes it unminable, and the value goes back to the same address minus a small fee, so even then nothing is lost.
export const PROOF_LOCKTIME = 4102444800;
const vm = createVirtualMachineBch();
export function verifyWcTx(addr, m, proof) {
  const { tx, source } = JSON.parse(proof); const t = decodeTransaction(hexToBin(tx)); if (typeof t === 'string') return t;
  const lb = hexToBin(source.lockingBytecode);
  if (binToHex(lb) !== binToHex(encodeLockingBytecodeP2pkh(decodeCashAddress(addr).payload))) return 'source output is not this address';
  if (t.inputs.length !== 1) return 'proof tx must have one input';
  if (t.outputs.length > 2 || (t.outputs[1] && binToHex(t.outputs[1].lockingBytecode) !== binToHex(lb))) return 'proof tx may only return change to the same address';
  if (t.locktime < PROOF_LOCKTIME || t.inputs[0].sequenceNumber === 0xffffffff) return 'proof tx is broadcastable (needs locktime >= 2100-01-01 and a non-final sequence)';
  const ok = vm.verify({ transaction: t, sourceOutputs: [{ lockingBytecode: lb, valueSatoshis: BigInt(source.valueSatoshis) }] });
  if (ok !== true) return 'tx does not verify: ' + ok;
  const want = '6a' + binToHex(Uint8Array.from([PROTO.length])) + binToHex(utf8ToBin(PROTO)) + '20' + binToHex(sha256.hash(utf8ToBin(m)));
  return binToHex(t.outputs[0].lockingBytecode) === want ? true : 'OP_RETURN does not commit to this message';
}

// --- Nostr side
export function createBindingEvent(nsec, addr, created, kind, proof, content) {
  const npub = getPublicKey(nsec);
  return finalizeEvent({ kind: 30078, created_at: created, content: content ?? bindingMessage(npub, addr, created),
    tags: [['d', `bch-bind:${addr}`], ['i', `bch:${addr}`], ['proof', kind, proof], ['alt', 'BCH address binding (nostr-bch-bind v1)']] }, nsec);
}
// nostr-tools caches a passed verifyEvent() on the object (a symbol that {...spread} copies), so an event edited after
// verification still "verifies". Always verify a fresh copy of the wire fields.
const fresh = (e) => ({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });
// Events come from public relays, so a malformed one (non-array tags, bad proof JSON, bad hex) must give a reason, not throw.
export function verifyBinding(ev) {
  try { return verifyBindingUnsafe(ev); } catch (e) { return { ok: false, reason: 'malformed event: ' + (e?.message ?? e) }; }
}
function verifyBindingUnsafe(ev) {
  ev = fresh(ev);
  if (!verifyEvent(ev)) return { ok: false, reason: 'bad nostr id or signature' };
  if (ev.kind !== 30078) return { ok: false, reason: 'wrong kind' };
  const tag = (k) => ev.tags.find(t => t[0] === k);
  const d = tag('d')?.[1] ?? ''; if (!d.startsWith('bch-bind:')) return { ok: false, reason: 'missing d tag' };
  const addr = d.slice(9);
  if (ev.content === 'revoked') return { ok: false, revoked: true, addr, reason: 'binding revoked' };
  if (new TextEncoder().encode(ev.content).length >= 253) return { ok: false, reason: 'too long for wallet signmessage interop (>= 253 bytes)' };
  const c = parse(ev.content); if (!c) return { ok: false, reason: 'content is not a v1 binding message' };
  if (c.npub !== ev.pubkey) return { ok: false, reason: 'content npub is not the event signer' };
  if (c.bch !== addr || tag('i')?.[1] !== `bch:${addr}`) return { ok: false, reason: 'address in content does not match the tags' };
  if (Math.abs(c.created - ev.created_at) > 300) return { ok: false, reason: 'created is not the event time (±5 min)' };
  const p = tag('proof'); if (!p) return { ok: false, reason: 'missing proof' };
  const r = p[1] === 'signmessage' ? verifySignMessage(addr, ev.content, p[2]) : p[1] === 'wc-tx' ? verifyWcTx(addr, ev.content, p[2]) : 'unknown proof kind';
  return r === true ? { ok: true, npub: ev.pubkey, addr, created: c.created } : { ok: false, reason: r };
}
// latest valid binding wins; a newer revocation (same d) removes it
export function resolve(events, addr) {
  const mine = events.filter(e => e.tags.some(t => t[0] === 'd' && t[1] === `bch-bind:${addr}`)).sort((a, b) => b.created_at - a.created_at);
  for (const e of mine) { const v = verifyBinding(e); if (v.revoked) return { ok: false, reason: 'revoked' }; if (v.ok) return v; }
  return { ok: false, reason: 'no valid binding' };
}
