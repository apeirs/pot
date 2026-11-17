// Tests of challenge-response login (src/login.mjs): a bound BCH address signs a fresh challenge, the app checks it against
// the npub's verified binding. Valid signmessage and wc-tx logins, a wrong address, an expired challenge, a replayed nonce,
// a forged or foreign challenge, and the binding found over (mock) relays. Throwaway keys from labels only; never fund.
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { secp256k1, sha256, hash160, utf8ToBin, encodeCashAddress } from '@bitauth/libauth';
import { signMessage, bindingMessage } from '../src/bindverify.mjs';
import { signWcTx } from '../src/bind.mjs';
import { checkBinding, resolveNpub, unsignedBinding, SIGNMESSAGE_LIMIT } from '../src/nostrbind.mjs';
import { makeLoginVerifier, loginChallenge, parseChallenge, LOGIN_TTL, POT_DOMAIN } from '../src/login.mjs';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '-', String(e?.message ?? e).split('\n')[0].slice(0, 300)); }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };
const k = (label) => sha256.hash(utf8ToBin('nostr-bch-bind test key: ' + label));
const addrOf = (priv) => encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: hash160(secp256k1.derivePublicKeyCompressed(priv)) }).address;
const nsecA = k('nostr A'), nsecB = k('nostr B'), bchA = k('bch A'), bchB = k('bch B');
const npubA = getPublicKey(nsecA), npubB = getPublicKey(nsecB), addrA = addrOf(bchA), addrB = addrOf(bchB);
const T = 1794000000;
const bindEvent = (nsec, priv, addr) => finalizeEvent(unsignedBinding(getPublicKey(nsec), addr, T, 'signmessage',
  signMessage(priv, bindingMessage(getPublicKey(nsec), addr, T))), nsec);
const bindingA = checkBinding(bindEvent(nsecA, bchA, addrA)); // npub A <-> address A, verified like the page does
const bindingB = checkBinding(bindEvent(nsecB, bchB, addrB));
/** a desk with a clock we move by hand */
const desk = (domain = POT_DOMAIN) => { const clock = { t: T + 1000 }; return { clock, v: makeLoginVerifier({ domain, now: () => clock.t }) }; };

await t('setup: both test bindings verify', () => { eq(bindingA.ok, true, bindingA.reason); eq(bindingB.ok, true, bindingB.reason); });

await t('challenge: five lines, parses back, under the signmessage limit, and is not a binding message', () => {
  const { v } = desk(); const ch = v.issue(npubA);
  const c = parseChallenge(ch.text);
  eq(c.domain, POT_DOMAIN); eq(c.npub, npubA); eq(c.nonce, ch.nonce); eq(c.issued, ch.issued); eq(ch.expires - ch.issued, LOGIN_TTL);
  if (new TextEncoder().encode(ch.text).length >= SIGNMESSAGE_LIMIT) throw new Error('challenge too long for wallets');
  eq(checkBinding({ ...bindEvent(nsecA, bchA, addrA), content: ch.text }).ok, false, 'a challenge as binding content');
  eq(parseChallenge(ch.text + '\nextra:1'), null); eq(parseChallenge(ch.text.replace(ch.nonce, 'zz')), null);
});

await t('two challenges get different nonces', () => { const { v } = desk(); if (v.issue(npubA).nonce === v.issue(npubA).nonce) throw new Error('same nonce'); });

await t('valid login: signmessage by the bound address -> logged in as npub / address', () => {
  const { v } = desk(); const ch = v.issue(npubA);
  const r = v.verify({ challenge: ch.text, proofKind: 'signmessage', proof: signMessage(bchA, ch.text), binding: bindingA });
  eq(r.ok, true, r.reason); eq(r.npub, npubA); eq(r.addr, addrA); eq(r.checks.every((c) => c.ok), true);
});

await t('valid login: wc-tx proof (the never-minable tx a WizardConnect wallet signs) over the challenge', async () => {
  const { v } = desk(); const ch = v.issue(npubA);
  const r = v.verify({ challenge: ch.text, proofKind: 'wc-tx', proof: await signWcTx(bchA, addrA, ch.text), binding: bindingA });
  eq(r.ok, true, r.reason);
});

await t('wrong address: a signature by another BCH key is refused, and the nonce stays usable for a retry', () => {
  const { v } = desk(); const ch = v.issue(npubA);
  const bad = v.verify({ challenge: ch.text, proofKind: 'signmessage', proof: signMessage(bchB, ch.text), binding: bindingA });
  eq(bad.ok, false); eq(bad.reason, 'signature is not by this address');
  eq(v.verify({ challenge: ch.text, proofKind: 'signmessage', proof: signMessage(bchA, ch.text), binding: bindingA }).ok, true);
});

await t('wrong address: a binding of another npub (whose address did sign) does not log in the challenged npub', () => {
  const { v } = desk(); const ch = v.issue(npubA);
  const r = v.verify({ challenge: ch.text, proofKind: 'signmessage', proof: signMessage(bchB, ch.text), binding: bindingB });
  eq(r.ok, false); eq(r.reason, 'the binding is for another npub');
});

await t('expired: a challenge signed after 5 minutes is refused (and at exactly 5 minutes still accepted)', () => {
  const { v, clock } = desk(); const ch = v.issue(npubA), sig = signMessage(bchA, ch.text);
  clock.t += LOGIN_TTL + 1;
  const r = v.verify({ challenge: ch.text, proofKind: 'signmessage', proof: sig, binding: bindingA });
  eq(r.ok, false); eq(r.reason, 'the challenge expired; ask for a new one');
  clock.t -= LOGIN_TTL + 1; // the expired nonce was dropped: going back in time does not revive it
  eq(v.verify({ challenge: ch.text, proofKind: 'signmessage', proof: sig, binding: bindingA }).reason, 'this app did not issue that challenge');
  const d2 = desk(); const ch2 = d2.v.issue(npubA); d2.clock.t += LOGIN_TTL;
  eq(d2.v.verify({ challenge: ch2.text, proofKind: 'signmessage', proof: signMessage(bchA, ch2.text), binding: bindingA }).ok, true);
});

await t('replayed nonce: the same signed challenge logs in once only', () => {
  const { v } = desk(); const ch = v.issue(npubA), sig = signMessage(bchA, ch.text);
  eq(v.verify({ challenge: ch.text, proofKind: 'signmessage', proof: sig, binding: bindingA }).ok, true);
  const again = v.verify({ challenge: ch.text, proofKind: 'signmessage', proof: sig, binding: bindingA });
  eq(again.ok, false); eq(again.reason, 'this challenge was already used to log in (replay)');
});

await t('forged challenge: a well-formed challenge this app never issued is refused', () => {
  const { v, clock } = desk(); v.issue(npubA);
  const forged = loginChallenge({ domain: POT_DOMAIN, npub: npubA, nonce: 'ab'.repeat(16), issued: clock.t });
  const r = v.verify({ challenge: forged, proofKind: 'signmessage', proof: signMessage(bchA, forged), binding: bindingA });
  eq(r.ok, false); eq(r.reason, 'this app did not issue that challenge');
});

await t('another app\'s challenge: a login signed for evil.example does not work here, even with a stolen nonce', () => {
  const { v } = desk(); const ch = v.issue(npubA);
  const foreign = loginChallenge({ ...parseChallenge(ch.text), domain: 'evil.example' });
  const r = v.verify({ challenge: foreign, proofKind: 'signmessage', proof: signMessage(bchA, foreign), binding: bindingA });
  eq(r.ok, false); eq(r.reason, `the challenge is for evil.example, not ${POT_DOMAIN}`);
});

await t('cross-use: the binding\'s own signature (a different message) is not a login', () => {
  const { v } = desk(); const ch = v.issue(npubA);
  const r = v.verify({ challenge: ch.text, proofKind: 'signmessage', proof: signMessage(bchA, bindingMessage(npubA, addrA, T)), binding: bindingA });
  eq(r.ok, false); eq(r.reason, 'signature is not by this address');
});

await t('garbage proofs and missing bindings give a reason, never a throw', () => {
  const { v } = desk(); const ch = v.issue(npubA);
  for (const [kind, proof] of [['signmessage', 'not base64!'], ['signmessage', ''], ['wc-tx', '{not json'], ['wc-tx', '{"tx":"00","source":{}}'], ['carrier-pigeon', 'x']]) {
    const r = v.verify({ challenge: ch.text, proofKind: kind, proof, binding: bindingA });
    eq(r.ok, false, kind); if (!r.reason) throw new Error('no reason for ' + kind);
  }
  eq(v.verify({ challenge: ch.text, proofKind: 'signmessage', proof: signMessage(bchA, ch.text), binding: null }).reason, 'no verified binding for this npub');
  eq(v.verify({ challenge: 'hello', proofKind: 'signmessage', proof: 'x', binding: bindingA }).reason, 'not a login challenge');
});

await t('end to end: the binding is found over relays by npub, then the challenge is signed and verified', async () => {
  const store = [bindEvent(nsecA, bchA, addrA)];
  class WS {
    constructor() { setTimeout(() => this.onopen?.(), 5); }
    send(s) {
      const d = JSON.parse(s); if (d[0] !== 'REQ') return;
      const reply = (m) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 2);
      for (const e of store) if (d.slice(2).some((f) => (!f.authors || f.authors.includes(e.pubkey)) && (!f.kinds || f.kinds.includes(e.kind)))) reply(['EVENT', d[1], e]);
      reply(['EOSE', d[1]]);
    }
    close() {}
  }
  const found = await resolveNpub(npubEncode(npubA), { relays: ['wss://a'], WebSocketImpl: WS, timeoutMs: 400, graceMs: 30, prefix: 'bitcoincash' });
  const { v } = desk(); const ch = v.issue(npubA);
  const r = v.verify({ challenge: ch.text, proofKind: 'signmessage', proof: signMessage(bchA, ch.text), binding: found.best });
  eq(r.ok, true, r.reason); eq(r.addr, addrA);
});

await t('a verifier needs a domain and a hex npub', () => {
  let n = 0; try { makeLoginVerifier({}); } catch { n++; } try { desk().v.issue(npubEncode(npubA)); } catch { n++; }
  eq(n, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
