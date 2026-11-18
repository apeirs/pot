// "Try it without a wallet" (the #/bind demo): throwaway BCH and Nostr keys made at runtime, a nostr-bch-bind v1 binding
// signed by both, verified by the same checkBinding the page uses on relay events, a login by challenge-response with
// makeLoginVerifier, and the attacks the checks stop. Browser-safe. The two secret keys live only in this closure: they
// are never returned, stored or published, and the BCH address is never funded.
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { secp256k1, hash160, encodeCashAddress } from '@bitauth/libauth';
import { signMessage, bindingMessage } from './bindverify.mjs';
import { checkBinding, unsignedBinding, nip39Text, NIP39_KIND } from './nostrbind.mjs';
import { makeLoginVerifier } from './login.mjs';

const nowSec = () => Math.floor(Date.now() / 1000);
const wire = (e) => ({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });

/**
 * opts: { prefix = 'bitcoincash', domain, now, secretKey = generateSecretKey } (secretKey: 32 random bytes per call; tests
 * pass a fixed one). → { me, binding, nip39, login, attack(name) }, all public data: npubs, addresses, events, verdicts.
 */
export function makeTryIt({ prefix = 'bitcoincash', domain, now = nowSec, secretKey = generateSecretKey } = {}) {
  // Two separate keys per identity: the Nostr key never signs for BCH and the BCH key never signs Nostr events.
  const keys = () => {
    const nsec = secretKey(), bch = secretKey();
    const addr = encodeCashAddress({ prefix, type: 'p2pkh', payload: hash160(secp256k1.derivePublicKeyCompressed(bch)) }).address;
    return { nsec, bch, npub: getPublicKey(nsec), addr };
  };
  const mine = keys(), other = keys(); // other = someone trying to pass as us
  const created = now();
  const bind = (who, addr, bchKey, npub = who.npub) => {
    const msg = bindingMessage(npub, addr, created);
    return finalizeEvent(unsignedBinding(npub, addr, created, 'signmessage', signMessage(bchKey, msg)), who.nsec);
  };

  const event = wire(bind(mine, mine.addr, mine.bch));
  const binding = checkBinding(event);
  // the same identity as a NIP-39 claim (kind 10011), read back by the same reader
  const nip39Event = wire(finalizeEvent({ kind: NIP39_KIND, created_at: created, content: '',
    tags: [['i', `bch:${mine.addr}`, signMessage(mine.bch, nip39Text(mine.npub))]] }, mine.nsec));
  const nip39 = checkBinding(nip39Event);

  const desk = makeLoginVerifier({ domain, now });
  const challenge = desk.issue(mine.npub);
  const loginSig = signMessage(mine.bch, challenge.text);
  const login = { challenge, signature: loginSig, result: desk.verify({ challenge: challenge.text, proofKind: 'signmessage', proof: loginSig, binding }) };

  const refusal = (what, r) => ({ what, ok: r.ok, reason: r.reason, checks: r.checks });
  const attacks = {
    // A copies our published event (content and BCH proof) and signs it with A's own Nostr key, or rewrites the message to
    // name A's npub and keeps our BCH proof.
    copied: () => [
      refusal('Our message and BCH proof, copied into an event signed by another npub', checkBinding(wire(finalizeEvent(
        { kind: event.kind, created_at: event.created_at, content: event.content, tags: event.tags }, other.nsec)))),
      refusal('The message rewritten to name the other npub, our BCH proof kept', checkBinding(wire(finalizeEvent(
        unsignedBinding(other.npub, mine.addr, created, 'signmessage', event.tags.find((t) => t[0] === 'proof')[2]), other.nsec)))),
    ],
    // A claims our address, signing the BCH side with a key A owns; then tries to log in as us with that key.
    borrowed: () => {
      const claim = checkBinding(wire(bind(other, mine.addr, other.bch)));
      const ch = desk.issue(mine.npub);
      return [
        refusal('Another npub binds our BCH address, signing with its own BCH key', claim),
        refusal('A login as our npub, the challenge signed by a BCH key that is not the bound address',
          desk.verify({ challenge: ch.text, proofKind: 'signmessage', proof: signMessage(other.bch, ch.text), binding })),
      ];
    },
    // A edits our signed event to point at A's address; A replays our login signature.
    edited: () => [
      refusal('Our event with the address in the content and tags changed after signing', checkBinding({ ...event,
        content: event.content.replace(mine.addr, other.addr), tags: event.tags.map((t) => t.map((x) => (typeof x === 'string' ? x.replace(mine.addr, other.addr) : x))) })),
      refusal('Our login signature sent again (replayed nonce)',
        desk.verify({ challenge: challenge.text, proofKind: 'signmessage', proof: loginSig, binding })),
    ],
  };

  return {
    me: { npub: mine.npub, addr: mine.addr, created },
    binding: { event, message: event.content, result: binding },
    nip39: { event: nip39Event, result: nip39 },
    login,
    attack: (name) => { if (!attacks[name]) throw new Error('unknown attack ' + name); return attacks[name](); },
  };
}
