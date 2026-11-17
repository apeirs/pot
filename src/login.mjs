// Challenge-response login with a nostr-bch-bind identity (the Paytaca DID bounty's "an independent app verifies the link
// and authenticates by challenge-response"). Browser-safe, no server: any app can import this file.
//
// 1. The app issues a challenge: its domain, the npub that wants to log in, a fresh random nonce and the time.
// 2. The npub's BCH address (found through its verified binding on Nostr) signs the challenge: a standard signed message,
//    or, for wallets that sign over WizardConnect (which has no sign-message request), the same never-minable proof
//    transaction the binding uses, committing to sha256(challenge).
// 3. The app checks: the challenge is one it issued, for its own domain, unused and under 5 minutes old; the binding is
//    valid and belongs to that npub; the signature is by the bound address. A nonce logs in once.
import { verifySignMessage, verifyWcTx } from './bindverify.mjs';

export const LOGIN_PROTO = 'nostr-bch-bind:login:v1';
export const LOGIN_TTL = 300; // seconds a challenge stays valid
export const LOGIN_SKEW = 30; // seconds of clock skew tolerated for an "issued" in the future
export const POT_DOMAIN = 'apeir.dk/online/pot';

const nowSec = () => Math.floor(Date.now() / 1000);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
/** 16 random bytes as hex, from the platform CSPRNG (browser or Node 19+). */
export const newNonce = () => hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));

/** The text the BCH address signs. Kept far under 253 bytes so every wallet signs it the same way. */
export const loginChallenge = ({ domain, npub, nonce, issued }) =>
  `${LOGIN_PROTO}\ndomain:${domain}\nnpub:${npub}\nnonce:${nonce}\nissued:${issued}`;

/** → { domain, npub, nonce, issued } or null. Strict: exactly these five lines, in this order. */
export function parseChallenge(text) {
  const L = String(text ?? '').split('\n');
  if (L.length !== 5 || L[0] !== LOGIN_PROTO) return null;
  const g = (i, k) => (L[i].startsWith(k + ':') ? L[i].slice(k.length + 1) : null);
  const c = { domain: g(1, 'domain'), npub: g(2, 'npub'), nonce: g(3, 'nonce'), issued: Number(g(4, 'issued')) };
  if (!c.domain || !/^[0-9a-f]{64}$/.test(c.npub ?? '') || !/^[0-9a-f]{32}$/.test(c.nonce ?? '') || !Number.isInteger(c.issued)) return null;
  return c;
}

/**
 * One app's login desk. issue() hands out a challenge and remembers its nonce; verify() accepts each nonce once.
 * opts: { domain, ttl = 300, now = () => unix seconds }
 */
export function makeLoginVerifier({ domain, ttl = LOGIN_TTL, now = nowSec } = {}) {
  if (!domain) throw new Error('A login verifier needs the app domain.');
  const pending = new Map(); // nonce -> issued
  const used = new Set();
  const prune = () => { const t = now(); for (const [n, at] of pending) if (t - at > ttl) pending.delete(n); };

  function issue(npubHex) {
    if (!/^[0-9a-f]{64}$/.test(npubHex ?? '')) throw new Error('Login needs the npub as 64 hex characters.');
    prune();
    const nonce = newNonce(), issued = now();
    pending.set(nonce, issued);
    return { text: loginChallenge({ domain, npub: npubHex, nonce, issued }), nonce, issued, expires: issued + ttl };
  }

  /**
   * challenge: the issued text, exactly. proofKind: 'signmessage' (base64) or 'wc-tx' (the binding's proof JSON).
   * binding: a verified binding for the npub ({ ok, npub, addr }, e.g. resolveNpub().best), looked up by the caller.
   * → { ok, reason?, npub, addr, checks: [{ label, ok }] }. Never throws.
   */
  function verify({ challenge, proofKind, proof, binding }) {
    const checks = [];
    const out = (ok, reason) => ({ ok, reason, npub: c?.npub ?? null, addr: binding?.addr ?? null, checks });
    const step = (label, ok) => { checks.push({ label, ok }); return ok; };
    const c = parseChallenge(challenge);
    if (!step('the challenge is a login challenge', !!c)) return out(false, 'not a login challenge');
    if (!step(`it is for this app (${domain})`, c.domain === domain)) return out(false, `the challenge is for ${c.domain}, not ${domain}`);
    if (!step('the nonce is not used yet', !used.has(c.nonce))) return out(false, 'this challenge was already used to log in (replay)');
    if (!step('this app issued the nonce', pending.has(c.nonce) && pending.get(c.nonce) === c.issued)) return out(false, 'this app did not issue that challenge');
    const age = now() - c.issued;
    if (!step(`signed within ${Math.round(ttl / 60)} minutes`, age <= ttl && age >= -LOGIN_SKEW)) {
      if (age > ttl) pending.delete(c.nonce);
      return out(false, age > ttl ? 'the challenge expired; ask for a new one' : 'the challenge is dated in the future');
    }
    if (!step('the npub has a verified binding on Nostr', !!(binding?.ok && binding.addr))) return out(false, 'no verified binding for this npub');
    if (!step('the binding belongs to the npub in the challenge', binding.npub === c.npub)) return out(false, 'the binding is for another npub');
    let r;
    try {
      r = proofKind === 'signmessage' ? verifySignMessage(binding.addr, challenge, String(proof ?? '').trim())
        : proofKind === 'wc-tx' ? verifyWcTx(binding.addr, challenge, proof) : 'unknown proof kind';
    } catch (e) { r = 'malformed proof: ' + (e?.message ?? e); }
    if (!step('the bound BCH address signed this challenge', r === true)) return out(false, r);
    pending.delete(c.nonce); used.add(c.nonce);
    return out(true);
  }

  return { domain, ttl, issue, verify };
}
