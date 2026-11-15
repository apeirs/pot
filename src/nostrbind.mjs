// Nostr identity for Pot (Paytaca DID bounty): find, verify and publish nostr-bch-bind v1 bindings, and read the two
// other published formats (pennyops bch-nostr-bind.v1, bch-identity-bridge 1.0.0) under the interop rule in
// ARCHITECTURE.md. Browser-safe: global WebSocket, nostr-tools, libauth. Every event from a relay is verified here,
// in the page, before anything is shown as verified.
import { decode as nip19decode, npubEncode } from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';
import { secp256k1, hash160, binToHex, hexToBin, base64ToBin, decodeCashAddress, decodeTransaction } from '@bitauth/libauth';
import { PROTO, PROOF_LOCKTIME, bindingMessage, verifyBinding, verifySignMessage, messageHash } from './bindverify.mjs';

export { PROTO, PROOF_LOCKTIME, bindingMessage, verifyBinding };
// Three, so one relay down never hides a binding; queries stop soon after the first EOSE. (relay.damus.io was dropped:
// it answered every connection with HTTP 521 on 2026-11-15, which browsers log as a console error on every pot page.)
export const DEFAULT_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social'];
export const SIGNMESSAGE_LIMIT = 253; // the Paytaca extension signed messages of 253+ bytes differently (paytaca-app#831)
export const FORMAT = { v1: 'nostr-bch-bind v1', pennyops: 'pennyops bch-nostr-bind.v1', bib: 'bch-identity-bridge 1.0.0' };
const MAX_EVENTS = 500;

const fresh = (e) => ({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });
const tagOf = (e, k) => (Array.isArray(e?.tags) ? e.tags.find((t) => Array.isArray(t) && t[0] === k) : undefined);
const utf8Len = (s) => new TextEncoder().encode(String(s)).length;
export const shortNpub = (hex) => { const n = npubEncode(hex); return `${n.slice(0, 12)}…${n.slice(-6)}`; };

/** npub1… or 64-hex → lowercase hex, else null. */
export function npubToHex(input) {
  const s = String(input ?? '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  if (/^npub1[02-9ac-hj-np-z]+$/.test(s)) {
    try { const d = nip19decode(s); if (d.type === 'npub') return d.data; } catch { /* not an npub */ }
  }
  return null;
}
export const looksLikeNpub = (s) => /^\s*npub1/i.test(String(s ?? ''));

/** pennyops bch-nostr-bind.v1 (kind 30078, d = bch-nostr-bind): statement `bch-nostr-bind.v1:<pk>:<cashaddr>:<ts>`,
 * the BCH signmessage signature in the third element of the `i` tag. */
function verifyPennyops(ev) {
  const iTags = ev.tags.filter((t) => Array.isArray(t) && t[0] === 'i' && String(t[1]).startsWith('bch:'));
  if (iTags.length !== 1) return { ok: false, reason: 'needs exactly one bch: i tag' };
  const addr = String(iTags[0][1]).slice(4), sig = iTags[0][2];
  const parts = String(ev.content).split(':');
  if (parts.length !== 5 || parts[0] !== 'bch-nostr-bind.v1') return { ok: false, reason: 'content is not a bch-nostr-bind.v1 statement' };
  if (parts[1] !== ev.pubkey) return { ok: false, reason: 'statement pubkey is not the event signer' };
  if (`${parts[2]}:${parts[3]}` !== addr) return { ok: false, reason: 'statement address does not match the i tag' };
  if (typeof sig !== 'string') return { ok: false, reason: 'missing BCH signature' };
  if (utf8Len(ev.content) >= SIGNMESSAGE_LIMIT) return { ok: false, reason: 'too long for wallet signmessage interop (>= 253 bytes)' };
  const r = verifySignMessage(addr, ev.content, sig);
  return r === true ? { ok: true, npub: ev.pubkey, addr, created: Number(parts[4]) || ev.created_at, proofKind: 'signmessage' } : { ok: false, reason: r };
}

/**
 * Verifies one event in any of the three formats. → null for events that are not BCH bindings (other apps' kind 30078),
 * else { format, d, ok, reason?, revoked?, npub, addr, created, proofKind, eventId, checks[] }. Never throws.
 * checks: what was verified, for the page to list (label, ok).
 */
export function checkBinding(raw) {
  let ev;
  try { ev = fresh(raw); } catch { return null; }
  const d = tagOf(ev, 'd')?.[1];
  const base = { d, eventId: String(ev.id ?? ''), npub: String(ev.pubkey ?? ''), created: ev.created_at };
  let format;
  if (ev.kind === 30078 && typeof d === 'string' && d.startsWith('bch-bind:')) format = 'v1';
  else if (ev.kind === 30078 && d === 'bch-nostr-bind') format = 'pennyops';
  else if (ev.kind === 31234 && tagOf(ev, 'protocol')?.[1] === 'bch-identity-bridge') format = 'bib';
  else return null;
  let sigOk = false;
  try { sigOk = verifyEvent(ev); } catch { /* malformed */ }
  const checks = [{ label: 'Nostr signature (NIP-01 id + BIP-340 Schnorr by the npub)', ok: sigOk }];
  if (!sigOk) return { ...base, format, ok: false, reason: 'bad nostr id or signature', checks };
  if (format === 'bib') {
    const addr = tagOf(ev, 'bch')?.[1];
    return { ...base, format, addr, ok: false, unverifiable: true, checks: [...checks, { label: 'BCH signature published with the event', ok: false }],
      reason: 'bch-identity-bridge keeps its BCH signature off the relays, so this claim cannot be checked from Nostr alone' };
  }
  if (format === 'pennyops') {
    const v = verifyPennyops(ev);
    checks.push({ label: 'BCH signed message by the address (Electron Cash / Paytaca / Cashonize format)', ok: v.ok });
    return { ...base, format, ...v, ok: v.ok, checks };
  }
  const v = verifyBinding(ev);
  const addr = v.addr ?? d.slice(9);
  if (v.revoked) return { ...base, format, addr, ok: false, revoked: true, reason: 'binding revoked', checks };
  const proof = tagOf(ev, 'proof');
  const len = utf8Len(ev.content);
  checks.push(
    { label: `Binding message: ${len} bytes, under the ${SIGNMESSAGE_LIMIT}-byte limit every known wallet signs the same`, ok: len < SIGNMESSAGE_LIMIT },
    { label: 'Message names this npub, this address and the event time; d and i tags match', ok: v.ok || !/content|tags|created|npub/.test(v.reason ?? '') },
    { label: proof?.[1] === 'wc-tx' ? 'BCH proof: unbroadcastable wallet-signed transaction (locktime 2100) committing to the message'
      : 'BCH proof: signed message by the address (Electron Cash / Paytaca / Cashonize format)', ok: v.ok },
  );
  return { ...base, format, addr, ok: v.ok, reason: v.reason, created: v.created ?? ev.created_at, proofKind: proof?.[1], checks };
}

/** The public key that made the BCH proof of a verified binding (for "judge by npub"): signmessage recovers it,
 * a wc-tx proof carries it in its P2PKH unlocking script. Returns hex or null; checked against the address. */
export function bindingPubkey(raw) {
  try {
    const ev = fresh(raw);
    const v = checkBinding(ev);
    if (!v?.ok) return null;
    let pub = null;
    const proof = ev.kind === 30078 && v.format === 'v1' ? tagOf(ev, 'proof') : ['proof', 'signmessage', tagOf(ev, 'i')?.[2]];
    if (proof[1] === 'signmessage') {
      const s = base64ToBin(proof[2]);
      if (s[0] < 31 || s[0] > 34) return null; // only compressed keys can be a judge key
      pub = secp256k1.recoverPublicKeyCompressed(s.slice(1), s[0] - 31, messageHash(ev.content));
    } else if (proof[1] === 'wc-tx') {
      const t = decodeTransaction(hexToBin(JSON.parse(proof[2]).tx));
      const u = t.inputs[0].unlockingBytecode;
      const sigLen = u[0];
      if (u[1 + sigLen] === 33) pub = u.slice(2 + sigLen, 2 + sigLen + 33);
    }
    if (!(pub instanceof Uint8Array)) return null;
    const d = decodeCashAddress(v.addr);
    return typeof d !== 'string' && binToHex(hash160(pub)) === binToHex(d.payload) ? binToHex(pub) : null;
  } catch { return null; }
}

/**
 * Picks what a set of events says, per the rules: per binding slot (v1: npub + d; pennyops: npub) the newest event that
 * verifies decides, a signed `revoked` (v1) drops the slot; across slots the newest valid binding wins.
 * bch-identity-bridge claims are reported in `unverifiable`, never chosen.
 * → { best, valid[], revoked[], skipped[], unverifiable[] }
 */
export function pickBindings(events, { addr } = {}) {
  const byId = new Map();
  for (const e of events) {
    const c = checkBinding(e);
    if (!c || byId.get(c.eventId)?.c.ok) continue; // a forged copy (same id, bad sig) never shadows the real one
    byId.set(c.eventId, { c, e });
  }
  const slots = new Map(), skipped = [], unverifiable = [];
  for (const { c, e } of byId.values()) {
    if (c.format === 'bib') { unverifiable.push(c); continue; }
    if (c.reason === 'bad nostr id or signature') { skipped.push(c); continue; }
    const key = c.format === 'v1' ? `${c.npub}|${c.d}` : `${c.npub}|pennyops`;
    (slots.get(key) ?? slots.set(key, []).get(key)).push({ c, e });
  }
  const valid = [], revoked = [];
  for (const list of slots.values()) {
    list.sort((a, b) => b.e.created_at - a.e.created_at || (a.c.eventId < b.c.eventId ? -1 : 1));
    for (const { c, e } of list) {
      if (c.revoked) { revoked.push(c); break; }
      if (c.ok) { valid.push({ ...c, event: fresh(e) }); break; }
      skipped.push(c);
    }
  }
  const sameAddr = (a) => !addr || String(a).toLowerCase() === String(addr).toLowerCase();
  const chosen = valid.filter((v) => sameAddr(v.addr)).sort((a, b) => b.created - a.created);
  return { best: chosen[0] ?? null, valid: chosen, revoked, skipped, unverifiable };
}

// ---------- relays
/** One REQ (one or more filters) to one relay. Resolves (never rejects) with {relay, status, events, error?}. */
export function queryRelay(url, filters, { timeoutMs = 6000, WebSocketImpl = globalThis.WebSocket, signal } = {}) {
  return new Promise((resolve) => {
    const events = []; let done = false, ws;
    const sub = 'pot' + Math.random().toString(36).slice(2, 10);
    const finish = (status, error) => {
      if (done) return; done = true; clearTimeout(timer);
      try { if (ws?.readyState === 1) ws.send(JSON.stringify(['CLOSE', sub])); ws?.close(); } catch { /* gone */ }
      resolve({ relay: url, status, events, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => finish('timeout', `no answer in ${timeoutMs} ms`), timeoutMs);
    signal?.addEventListener('abort', () => finish('timeout', 'cut off: other relays already answered'));
    try { ws = new WebSocketImpl(url); } catch (e) { finish('error', 'bad relay url: ' + (e?.message ?? e)); return; }
    ws.onopen = () => { try { ws.send(JSON.stringify(['REQ', sub, ...filters])); } catch (e) { finish('error', String(e?.message ?? e)); } };
    ws.onmessage = (m) => {
      let d; try { d = JSON.parse(typeof m.data === 'string' ? m.data : new TextDecoder().decode(m.data)); } catch { return; }
      if (!Array.isArray(d) || d[1] !== sub) return;
      if (d[0] === 'EVENT' && d[2] && typeof d[2] === 'object') { events.push(d[2]); if (events.length >= MAX_EVENTS) finish('eose'); }
      else if (d[0] === 'EOSE') finish('eose');
      else if (d[0] === 'CLOSED') finish('closed', String(d[2] ?? 'closed by relay'));
    };
    ws.onerror = () => finish('error', 'connection failed');
    ws.onclose = () => finish('error', 'connection closed before EOSE');
  });
}

/** Asks all relays in parallel; once one has sent EOSE the others get graceMs more. */
export async function queryRelays(filters, { relays = DEFAULT_RELAYS, timeoutMs = 6000, graceMs = 1500, WebSocketImpl } = {}) {
  const cut = new AbortController(); let grace;
  const answers = await Promise.all(relays.map((r) => queryRelay(r, filters, { timeoutMs, signal: cut.signal, ...(WebSocketImpl ? { WebSocketImpl } : {}) })
    .then((a) => { if (a.status === 'eose' && !grace) grace = setTimeout(() => cut.abort(), graceMs); return a; })));
  clearTimeout(grace);
  const answered = answers.filter((a) => a.status === 'eose' || a.events.length);
  const status = answers.map(({ relay, status: s, error, events }) => ({ relay, status: s, events: events.length, ...(error ? { error } : {}) }));
  if (!answered.length) {
    throw Object.assign(new Error(`Couldn't reach any Nostr relay (${answers.map((a) => `${a.relay.replace('wss://', '')}: ${a.error ?? a.status}`).join('; ')}).`), { code: 'NO_RELAY', relays: status });
  }
  const seen = new Map();
  for (const a of answers) for (const e of a.events) if (e && typeof e.id === 'string' && !seen.has(e.id + e.sig)) seen.set(e.id + e.sig, e);
  return { events: [...seen.values()], relays: status, answered: answered.length };
}

/** npub → its newest valid BCH binding. Throws (code BAD_NPUB | NO_BINDING | NO_RELAY) with a sentence for the page. */
export async function resolveNpub(npub, opts = {}) {
  const hex = npubToHex(npub);
  if (!hex) throw Object.assign(new Error('That is not an npub1… or a 64-character hex Nostr key.'), { code: 'BAD_NPUB' });
  const q = await queryRelays([{ kinds: [30078], authors: [hex], limit: MAX_EVENTS }, { kinds: [31234], authors: [hex], limit: 50 }], opts);
  const r = pickBindings(q.events.filter((e) => e.pubkey === hex), { addr: opts.addr });
  if (opts.prefix) r.valid = r.valid.filter((v) => v.addr.startsWith(opts.prefix + ':'));
  r.best = r.valid[0] ?? null;
  if (!r.best) {
    const why = r.skipped.length ? `the binding found failed verification (${[...new Set(r.skipped.map((s) => s.reason))].join('; ')})`
      : r.revoked.length ? 'its binding was revoked'
        : r.unverifiable.length ? 'it only has a bch-identity-bridge claim, whose BCH signature is not on the relays'
          : `no binding found on ${q.answered} relay${q.answered > 1 ? 's' : ''}`;
    throw Object.assign(new Error(`No valid BCH binding for this npub: ${why}. Ask for a BCH address instead, or for a binding made on the Pot identity page.`),
      { code: 'NO_BINDING', ...r, relays: q.relays });
  }
  return { ...r, npub: hex, relays: q.relays };
}

/** BCH address → the npubs with a valid binding to it (newest first), via the indexed `i` tag. */
export async function findByAddress(addr, opts = {}) {
  const q = await queryRelays([{ kinds: [30078], '#i': [`bch:${addr}`], limit: MAX_EVENTS }], opts);
  return { ...pickBindings(q.events, { addr }), relays: q.relays };
}

/** Sends one signed event to each relay; → [{relay, ok, message}] (ok = the relay's NIP-20 OK). */
export function publishEvent(ev, { relays = DEFAULT_RELAYS, timeoutMs = 8000, WebSocketImpl = globalThis.WebSocket } = {}) {
  return Promise.all(relays.map((url) => new Promise((resolve) => {
    let ws, done = false;
    const end = (ok, message) => { if (done) return; done = true; clearTimeout(t); try { ws?.close(); } catch { /* gone */ } resolve({ relay: url, ok, message }); };
    const t = setTimeout(() => end(false, 'no answer'), timeoutMs);
    try { ws = new WebSocketImpl(url); } catch (e) { end(false, String(e?.message ?? e)); return; }
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', ev]));
    ws.onmessage = (m) => {
      let d; try { d = JSON.parse(typeof m.data === 'string' ? m.data : new TextDecoder().decode(m.data)); } catch { return; }
      if (Array.isArray(d) && d[0] === 'OK' && d[1] === ev.id) end(!!d[2], String(d[3] ?? ''));
    };
    ws.onerror = () => end(false, 'connection failed');
    ws.onclose = () => end(false, 'closed before answering');
  })));
}

/** The unsigned v1 binding event (for NIP-07 signEvent or nostr-tools finalizeEvent). */
export function unsignedBinding(npubHex, addr, created, proofKind, proof) {
  return { kind: 30078, created_at: created, content: bindingMessage(npubHex, addr, created),
    tags: [['d', `bch-bind:${addr}`], ['i', `bch:${addr}`], ['proof', proofKind, proof], ['alt', 'BCH address binding (nostr-bch-bind v1)']] };
}
