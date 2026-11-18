// Pot: Nostr identity. The #/bind view (bind a BCH address to a Nostr key, publish it, look one up) and the helpers the
// pot page uses: a verified npub next to the poster and the judge, "pay by npub" for the winner, "judge by npub" on create.
//
// Nostr keys made or pasted here live in this page's memory only: never stored, never sent. The BCH proof is signed by
// the wallet: over WizardConnect as an unbroadcastable transaction (locktime 2100, never sent), or pasted as a signed
// message from any wallet with Sign Message (Paytaca, Electron Cash, Cashonize). Every event is verified in the page.
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { decode as nip19decode, npubEncode, nsecEncode } from 'nostr-tools/nip19';
import {
  DEFAULT_RELAYS, FORMAT, SIGNMESSAGE_LIMIT, bindingMessage, bindingPubkey, checkBinding, findByAddress, looksLikeNpub,
  npubToHex, publishEvent, resolveNpub, unsignedBinding,
} from '../src/nostrbind.mjs';
import { buildBindProof, wcRequest } from '../src/pot.mjs';
import { makeLoginVerifier, POT_DOMAIN, LOGIN_TTL } from '../src/login.mjs';
import { makeTryIt } from '../src/tryit.mjs';

const DEMO_NPUB = 'npub1dw38lu4qufjs85t6m6hwgk0v5we8puwlyzed9yj3rjjav6skjvnqjuhuns'; // judge of the featured mainnet pots (test/mainnet-binding.json)
const MIN_COIN = 846n; // proof fee 300 + dust 546: the coin the wallet signs over must be at least this

/** ctx: { $, esc, NET, state, provider, getDapp, walletCoins, setMsg, setBusy, action, copy, addrLink, short, checkAddress, normalizeAddress, setAbort } */
export function makeIdentity(ctx) {
  const { $, esc, NET, state } = ctx;
  const npubText = (hex) => npubEncode(hex);
  const shortNpub = (hex) => { const n = npubEncode(hex); return `${n.slice(0, 12)}…${n.slice(-6)}`; };
  const njump = (hex) => `https://njump.me/${npubEncode(hex)}`;
  const fmtName = (f) => FORMAT[f] ?? f;
  const shortAddr = (a) => ctx.short(String(a ?? '').split(':').pop(), 12);
  const b = (window.__potBind = { key: null, keySource: null, addr: '', created: 0, proof: null, proofKind: null, event: null, check: null, published: null, lookup: null });
  let sk = null; // Uint8Array secret key (generated or pasted); never leaves this closure
  const desk = makeLoginVerifier({ domain: POT_DOMAIN }); // this page is the "independent app" of the login demo
  const L = (window.__potLogin = { npub: '', pending: false, error: '', binding: null, challenge: null, result: null, session: null });
  const act = (fn) => (...a) => ctx.action(fn)(...a); // ctx.action is defined after this module is set up
  let TRY = null; // the no-wallet demo: { d (src/tryit.mjs, public data only), attacks: { name: results } }; its keys stay inside makeTryIt
  Object.defineProperty(window, '__potTry', { configurable: true, get: () => TRY && { npub: TRY.d.me.npub, addr: TRY.d.me.addr,
    binding: TRY.d.binding.result.ok, nip39: TRY.d.nip39.result.ok, login: TRY.d.login.result.ok,
    attacks: Object.fromEntries(Object.entries(TRY.attacks).map(([k, v]) => [k, v.map((r) => ({ ok: r.ok, reason: r.reason }))])) } });

  // ---------- badges on the pot page (cached per address for this visit)
  const byAddr = new Map();
  function lookupAddr(addr) {
    if (!byAddr.has(addr)) {
      byAddr.set(addr, { pending: true });
      findByAddress(addr, { timeoutMs: 6000 })
        .then((r) => byAddr.set(addr, { best: r.best, valid: r.valid }))
        .catch((e) => byAddr.set(addr, { error: e.message }))
        .finally(() => paintBadges());
    }
    return byAddr.get(addr);
  }
  function badgeHtml(addr) {
    const r = lookupAddr(addr);
    if (r.pending || r.error || !r.best) return '';
    const more = r.valid.length > 1 ? ` <span class="muted">+${r.valid.length - 1}</span>` : '';
    return ` · <a class="idbadge" href="#/bind?q=${esc(npubText(r.best.npub))}" title="${esc(`Verified ${fmtName(r.best.format)} binding: the npub and the address both signed it. Open to see every check. Event ${r.best.eventId}`)}">✓ ${esc(shortNpub(r.best.npub))}</a>${more}`;
  }
  function paintBadges() {
    document.querySelectorAll('[data-idaddr]').forEach((el) => { el.innerHTML = badgeHtml(el.dataset.idaddr); });
  }
  const badgeSlot = (addr) => `<span data-idaddr="${esc(addr)}">${badgeHtml(addr)}</span>`;

  // ---------- npub → address (winner) and npub → key (judge), cached per npub for this visit
  const byNpub = new Map();
  function resolveCached(text, onDone) {
    const hex = npubToHex(text);
    if (!hex) return { error: 'That is not a valid npub.' };
    if (!byNpub.has(hex)) {
      byNpub.set(hex, { pending: true });
      resolveNpub(hex, { prefix: NET.prefix, timeoutMs: 6000 })
        .then((r) => byNpub.set(hex, { hex, best: r.best, pub: bindingPubkey(r.best.event, r.best.addr) }))
        .catch((e) => byNpub.set(hex, { hex, error: e.message }))
        .finally(() => onDone?.());
    }
    return byNpub.get(hex);
  }
  /** Fresh lookup at the moment of paying: the cache may be minutes old. */
  async function resolveNow(text) {
    const hex = npubToHex(text);
    if (!hex) throw new Error('That is not a valid npub.');
    const r = await resolveNpub(hex, { prefix: NET.prefix, timeoutMs: 8000 });
    const out = { hex, best: r.best, pub: bindingPubkey(r.best.event, r.best.addr) };
    byNpub.set(hex, out);
    return out;
  }

  // ---------- #/bind view
  function viewBind() {
    state.view = 'bind';
    const hq = new URLSearchParams((location.hash.split('?')[1] ?? ''));
    const q = hq.get('q')?.trim() ?? ''; // #/bind?q=npub… (pot badges link here)
    const lq = hq.get('login')?.trim() ?? ''; // #/bind?login=npub… opens the login demo for that npub
    const tq = hq.has('try'); // #/bind?try runs the no-wallet demo
    const connected = state.connected;
    if (connected) b.addr = state.addr;
    const nip07 = typeof window.nostr?.signEvent === 'function';
    $('view').innerHTML = `
      <section>
        <h2>Nostr identity</h2>
        <p>Bind a BCH address to a Nostr key, so people can pay you, or name you as a judge, by your npub. Both keys sign one short
          message; the result is a public Nostr event anyone can check without trusting this page or a server.
          Pot shows a ✓ npub next to a bound poster or judge.</p>
      </section>
      <section id="b-try">
        <h3>Try it without a wallet</h3>
        <p>One click runs the whole flow with throwaway keys made in this page: a BCH key and a separate Nostr key sign one binding, the page
          verifies it with the same checks it applies to events from the relays, then logs in with it by challenge-response. Then try to cheat.</p>
        <p class="muted small">The throwaway secret keys are never stored, shown or published, and the address is never funded. They are gone when you leave the page.</p>
        <p><button id="b-try-run">${TRY ? 'Run it again with new keys' : 'Try it with throwaway keys'}</button></p>
        <div id="b-try-box">${tryHtml()}</div>
      </section>
      <section id="b-step1">
        <h3>1. Your BCH address</h3>
        ${connected ? `<p>Connected: ${ctx.addrLink(state.addr)} <span class="muted">(${esc(state.walletName)}, receive address 0)</span></p>`
          : `<p class="muted">Connect a wallet (top right) to sign in this page, or paste an address and sign the message in any wallet with Sign Message.</p>
             <input id="b-addr" class="mono" placeholder="${esc(NET.prefix)}:q…" value="${esc(b.addr)}" aria-label="BCH address">
             <div class="hint" id="b-addr-hint"></div>`}
      </section>
      <section id="b-step2">
        <h3>2. Your Nostr key</h3>
        <fieldset><legend>Sign the Nostr event with</legend>
          <label class="radio"><input type="radio" name="b-key" value="nip07" ${nip07 ? '' : 'disabled'} ${b.keySource === 'nip07' ? 'checked' : ''}> My Nostr extension (NIP-07)${nip07 ? '' : ' <span class="muted">(none found in this browser)</span>'}</label>
          <label class="radio"><input type="radio" name="b-key" value="new" ${b.keySource === 'new' ? 'checked' : ''}> A new key made in this page</label>
          <label class="radio"><input type="radio" name="b-key" value="paste" ${b.keySource === 'paste' ? 'checked' : ''}> My nsec, pasted</label>
          <div id="b-key-box"></div>
        </fieldset>
        <p class="muted small">Keys made or pasted here stay in this page's memory: they are never stored or sent, and are gone when you leave the page.</p>
      </section>
      <section id="b-step3">
        <h3>3. The binding message</h3>
        <div id="b-msg-box"></div>
      </section>
      <section id="b-step4">
        <h3>4. Check and publish</h3>
        <div id="b-check-box"><p class="muted">The event and its check appear here once both keys have signed.</p></div>
      </section>
      <section id="b-lookup">
        <h3>Look up a binding</h3>
        <form id="b-lookup-form" class="row"><input id="b-q" class="mono" placeholder="npub1… or ${esc(NET.prefix)}:q…" aria-label="npub or BCH address" value="${esc(b.lookup?.q ?? '')}"><button>Look up</button></form>
        <div id="b-lookup-box">${b.lookup ? lookupHtml(b.lookup) : NET.name === 'mainnet' ? `<p class="muted">Example: <a href="#/bind?q=${DEMO_NPUB}">the demo pot's judge</a>, bound on mainnet with Paytaca.</p>` : ''}</div>
      </section>
      <section id="b-login">
        <h3>Log in with a bound identity</h3>
        <p>How any other app can check that you control an identity: it gives you a fresh challenge, the BCH address bound to your npub
          signs it, and the app verifies that signature against the binding on Nostr. Here this page plays the app; it keeps no account and
          sends nothing to a server.</p>
        <form id="b-login-form" class="row"><input id="b-login-npub" class="mono" placeholder="npub1…" aria-label="npub to log in as" value="${esc(L.npub)}"><button>Get a challenge</button></form>
        <div id="b-login-box">${loginHtml()}</div>
      </section>
      <details class="how"><summary>How a binding is checked</summary>
        <p>The binding is a Nostr event (kind 30078, <span class="mono">d = bch-bind:&lt;address&gt;</span>) whose content is the message in step 3. It is valid when:</p>
        <ul>
          <li>its Nostr signature is by the npub (NIP-01 id, BIP-340 Schnorr);</li>
          <li>the message names that npub, that address and the event time, and stays under ${SIGNMESSAGE_LIMIT} bytes;</li>
          <li>the address signed the same message: a standard signed message (Paytaca, Electron Cash, Cashonize), or a wallet-signed
            transaction that commits to the message's hash and can never be mined (locktime year 2100), for wallets that sign over WizardConnect.</li>
        </ul>
        <p>Newest valid binding wins; a newer signed event with content <span class="mono">revoked</span> ends one. Pot also reads and verifies
          NIP-39 claims (kind 10011, <span class="mono">["i", "bch:&lt;address&gt;", &lt;signed message&gt;]</span> over NIP-39's text
          <span class="mono">Verifying that I control the following Nostr public key: &lt;npub&gt;</span>) and bindings in the
          <span class="mono">bch-nostr-bind.v1</span> format (Cashonize). <span class="mono">bch-identity-bridge</span> claims are shown greyed out:
          their BCH signature isn't published, so nobody can check them from Nostr alone.
          Relays: ${DEFAULT_RELAYS.map((r) => `<span class="mono">${esc(r.replace('wss://', ''))}</span>`).join(', ')}.</p>
        <p>Login: the challenge names this site (<span class="mono">${esc(POT_DOMAIN)}</span>), the npub, a random 16-byte nonce and the time. It is
          accepted when this page issued that nonce less than ${LOGIN_TTL / 60} minutes ago and it was not used before, the npub's binding verifies,
          and the bound address signed the challenge (signed message, or the never-sent proof transaction). Each nonce logs in once.
          Other apps can do the same with <span class="mono">src/login.mjs</span>.</p>
      </details>`;

    document.querySelectorAll('input[name=b-key]').forEach((r) => { r.onchange = () => { if (b.keySource !== r.value) { b.keySource = r.value; sk = null; b.key = null; resetProof(); } paintKey(); paintMsg(); }; });
    const a = $('b-addr');
    if (a) a.oninput = () => { b.addr = a.value.trim(); resetProof(); addrHint(); paintMsg(); };
    $('b-lookup-form').onsubmit = (ev) => { ev.preventDefault(); lookup($('b-q').value.trim()); };
    $('b-login-form').onsubmit = (ev) => { ev.preventDefault(); startLogin($('b-login-npub').value.trim()); };
    wireLogin();
    $('b-try-run').onclick = () => runTry();
    wireTry();
    addrHint(); paintKey(); paintMsg(); paintCheck();
    if (q && b.hashQ !== q) { // once per link, so a re-render (wallet connects) keeps a lookup typed by hand
      b.hashQ = q; $('b-q').value = q; lookup(q);
      $('b-lookup').scrollIntoView({ block: 'start' });
    }
    if (tq && !b.hashTry) { b.hashTry = true; runTry(); $('b-try').scrollIntoView({ block: 'start' }); }
    if (lq && b.hashLogin !== lq) {
      b.hashLogin = lq; $('b-login-npub').value = lq; startLogin(lq);
      $('b-login').scrollIntoView({ block: 'start' });
    }
    ctx.setBusy(state.busyText);
  }

  function resetProof() { b.proof = null; b.proofKind = null; b.event = null; b.check = null; b.published = null; b.created = 0; }
  const addrOk = () => !!b.addr && !ctx.checkAddress(b.addr, NET);
  const bindAddr = () => (state.connected ? state.addr : ctx.normalizeAddress(b.addr, NET));

  function addrHint() {
    const el = $('b-addr-hint');
    if (!el) return;
    const err = b.addr ? ctx.checkAddress(b.addr, NET) : '';
    el.innerHTML = err ? `<span class="err">${esc(err)}</span>` : '';
  }

  function paintKey() {
    const box = $('b-key-box');
    if (!box) return;
    if (b.keySource === 'nip07') {
      box.innerHTML = b.key ? `<p>Extension key: <span class="mono">${esc(npubText(b.key))}</span></p>` : '<button id="b-nip07" class="btn small">Ask the extension for my npub</button>';
      const btn = $('b-nip07');
      if (btn) btn.onclick = async () => {
        try { const pk = await window.nostr.getPublicKey(); if (!/^[0-9a-f]{64}$/.test(pk)) throw new Error('The extension sent no key.'); b.key = pk; resetProof(); paintKey(); paintMsg(); }
        catch (e) { ctx.setMsg('err', `The Nostr extension didn't share a key. ${e?.message ?? ''}`); }
      };
    } else if (b.keySource === 'new') {
      if (!sk) { sk = generateSecretKey(); b.key = getPublicKey(sk); }
      box.innerHTML = `<p>New npub: <span class="mono" id="b-npub">${esc(npubText(b.key))}</span></p>
        <p class="warn">Save its secret key now if you want to use this npub again: nothing on this page keeps it.
          <button id="b-reveal" class="link">Show the nsec</button> <button id="b-newkey" class="link">Make another</button></p>
        <div id="b-nsec" class="mono small" hidden></div>`;
      $('b-reveal').onclick = () => { const el = $('b-nsec'); el.hidden = !el.hidden; el.textContent = el.hidden ? '' : nsecEncode(sk); };
      $('b-newkey').onclick = () => { sk = null; resetProof(); paintKey(); paintMsg(); };
    } else if (b.keySource === 'paste') {
      box.innerHTML = `<input id="b-nsec-in" type="password" class="mono" autocomplete="off" placeholder="nsec1…" aria-label="nsec">
        <div class="hint" id="b-nsec-hint">${b.key ? `npub: <span class="mono">${esc(npubText(b.key))}</span>` : ''}</div>`;
      $('b-nsec-in').oninput = (ev) => {
        const v = ev.target.value.trim();
        sk = null; b.key = null;
        try { const d = nip19decode(v); if (d.type === 'nsec') { sk = d.data; b.key = getPublicKey(sk); } } catch { /* not an nsec yet */ }
        ev.target.value = sk ? '••••••••' : v; // the nsec is held in memory, not in the field
        $('b-nsec-hint').innerHTML = b.key ? `npub: <span class="mono">${esc(npubText(b.key))}</span>` : (v ? '<span class="err">Not a valid nsec.</span>' : '');
        resetProof(); paintMsg();
      };
    } else box.innerHTML = '';
  }

  function paintMsg() {
    const box = $('b-msg-box');
    if (!box) return;
    if (!(state.connected || addrOk()) || !b.key) { box.innerHTML = '<p class="muted">Pick an address and a Nostr key first.</p>'; paintCheck(); return; }
    if (!b.created) b.created = Math.floor(Date.now() / 1000);
    const addr = bindAddr(), msg = bindingMessage(b.key, addr, b.created), len = new TextEncoder().encode(msg).length;
    box.innerHTML = `<pre class="mono small" id="b-msg">${esc(msg)}</pre>
      <p class="muted small">${len} bytes (every known wallet signs messages under ${SIGNMESSAGE_LIMIT} bytes the same way).</p>
      <p>Now the address signs it:</p>
      ${state.connected ? `<p><button data-act="bind-wc" id="b-wc">Sign with ${esc(state.walletName)}</button></p>
        <p class="muted small">Your wallet is asked to sign a transaction that can never be sent: it is locked until the year 2100 and is not broadcast.
          It carries the message's hash and moves no money; it only proves that this address signed.</p>` : ''}
      <details ${state.connected ? '' : 'open'}><summary>${state.connected ? 'Or paste a signed message' : 'Paste a signed message'}</summary>
        <p class="muted small">In a wallet with Sign Message (Paytaca, Electron Cash, Cashonize), sign the message above exactly, with the address ${esc(shortAddr(addr))}, and paste the signature (base64).</p>
        <div class="row"><button id="b-copymsg" class="link">Copy the message</button></div>
        <div class="row"><input id="b-sig" class="mono" placeholder="H… or I… (base64 signature)" aria-label="Signature"><button id="b-sig-use">Use this signature</button></div>
      </details>`;
    $('b-copymsg').onclick = () => ctx.copy(msg, 'b-copymsg');
    $('b-sig-use').onclick = () => useProof('signmessage', $('b-sig').value.trim());
    const wc = $('b-wc');
    if (wc) wc.onclick = () => signWithWallet();
    paintCheck();
    ctx.setBusy(state.busyText);
  }

  /** The connected wallet signs a never-sent transaction committing to msg (WizardConnect has no sign-message request). */
  async function walletProof(msg, userPrompt) {
    const dapp = ctx.getDapp();
    if (!state.connected || !dapp) throw new Error('Connect a wallet first.');
    const addr = state.addr;
    const coins = (await ctx.walletCoins()).filter((c) => c.address === addr && !c.utxo.token && c.utxo.satoshis >= MIN_COIN)
      .sort((x, y) => (x.utxo.satoshis < y.utxo.satoshis ? -1 : 1));
    if (!coins.length) throw new Error(`The wallet needs a coin of at least ${MIN_COIN} sats on ${addr} to sign the proof (nothing is spent). Or paste a signed message instead.`);
    const p = buildBindProof({ provider: ctx.provider, coin: coins[0], message: msg, userPrompt });
    const abort = new AbortController();
    ctx.setAbort(abort);
    ctx.setBusy('Check your wallet: it asks for a signature only. This transaction is never sent.', true);
    let resp;
    try { resp = await dapp.signTransaction(wcRequest(p.wcObj, p.inputPaths), { signal: abort.signal }); }
    catch (e) { console.info('[pot] bind sign ended', e); throw new Error("The wallet didn't sign. Nothing was sent."); }
    finally { ctx.setAbort(null); }
    if (resp?.error || !resp?.signedTransaction) throw new Error(`The wallet didn't sign.${resp?.error ? ` (${resp.error})` : ''}`);
    return p.proof(resp.signedTransaction);
  }

  const signWithWallet = act(async () => {
    const msg = bindingMessage(b.key, state.addr, b.created);
    await useProof('wc-tx', await walletProof(msg, `Signature only, never sent: bind ${state.addr} to ${shortNpub(b.key)} on Nostr`));
  });

  // ---------- try it without a wallet (src/tryit.mjs)
  function runTry() {
    try { TRY = { d: makeTryIt({ prefix: NET.prefix, domain: POT_DOMAIN }), attacks: {} }; }
    catch (e) { TRY = null; ctx.setMsg('err', `The demo failed: ${e?.message ?? e}`); return; }
    const ok = TRY.d.binding.result.ok && TRY.d.login.result.ok;
    ctx.setMsg(ok ? 'ok' : 'err', ok ? 'Throwaway identity bound, verified and logged in. Now try to cheat (below).' : 'The demo did not verify; see below.');
    paintTry();
  }
  const ATTACKS = [
    ['copied', 'Copy the proof to another npub'],
    ['borrowed', 'Claim the address with another key'],
    ['edited', 'Edit the event, replay the login'],
  ];
  const verdictLine = (r, okText) => `<p class="${r.ok ? 'ok' : 'err'}"><b>${r.ok ? `✓ ${okText}` : `✗ Not valid: ${esc(r.reason)}`}</b></p>`;
  function tryHtml() {
    if (!TRY) return '';
    const d = TRY.d, bR = d.binding.result, nR = d.nip39.result, lR = d.login.result;
    const attackRows = (name) => (TRY.attacks[name] ?? []).map((r) => `<li class="${r.ok ? 'ok' : 'err'}" data-try-result="${name}">${r.ok ? '✓ accepted (this is a bug)' : '✗ refused'}: ${esc(r.what)}.
      <br><span class="small">Reason: <b>${esc(r.reason)}</b></span></li>`).join('');
    return `<div class="trybox" id="b-try-out">
      <p><b>1. Two throwaway keys.</b> Nostr: <span class="mono small">${esc(npubText(d.me.npub))}</span><br>
        BCH: <span class="mono small">${esc(d.me.addr)}</span></p>
      <p><b>2. Both keys sign one binding message</b> (Nostr: the event signature; BCH: a standard signed message):</p>
      <pre class="mono small">${esc(d.binding.message)}</pre>
      <div id="b-try-bind">${verdictLine(bR, `Valid binding: ${esc(shortNpub(bR.npub))} ↔ ${esc(shortAddr(bR.addr))}`)}${checksHtml(bR)}</div>
      <details><summary>The event (nostr-bch-bind v1, kind 30078)</summary><pre class="mono small">${esc(JSON.stringify(d.binding.event, null, 1))}</pre></details>
      <div id="b-try-nip39">${verdictLine(nR, 'The same identity as a NIP-39 claim (kind 10011, <span class="mono">["i", "bch:&lt;address&gt;", &lt;signature&gt;]</span>) verifies too')}</div>
      <details><summary>The NIP-39 event</summary><pre class="mono small">${esc(JSON.stringify(d.nip39.event, null, 1))}</pre></details>
      <p><b>3. Log in.</b> This page issues a challenge; the throwaway BCH address signs it:</p>
      <pre class="mono small">${esc(d.login.challenge.text)}</pre>
      <div id="b-try-login">${verdictLine(lR, `Logged in as <span class="mono">${esc(npubText(lR.npub ?? d.me.npub))}</span> / <span class="mono">${esc(lR.addr ?? '')}</span>`)}${checksHtml(lR)}</div>
      <p><b>4. Now try to cheat.</b> Each button forges something with a second throwaway identity; the same checks must refuse it.</p>
      <div class="row">${ATTACKS.map(([n, label]) => `<button class="btn small ghost" id="b-try-${n}" data-try="${n}">${esc(label)}</button>`).join('')}</div>
      <ul class="checks" id="b-try-attacks">${ATTACKS.map(([n]) => attackRows(n)).join('')}</ul>
      <p class="muted small">Nothing here was published or sent. A real binding is made in steps 1 to 4 below, with your wallet and your Nostr key.</p>
    </div>`;
  }
  function wireTry() {
    document.querySelectorAll('[data-try]').forEach((el) => { el.onclick = () => {
      const n = el.dataset.try;
      try { TRY.attacks[n] = TRY.d.attack(n); } catch (e) { ctx.setMsg('err', String(e?.message ?? e)); return; }
      const all = TRY.attacks[n].every((r) => !r.ok);
      ctx.setMsg(all ? 'ok' : 'err', all ? `Refused: ${TRY.attacks[n].map((r) => r.reason).join('; ')}.` : 'A forgery was accepted. Please report this.');
      paintTry();
    }; });
  }
  function paintTry() {
    const box = $('b-try-box');
    if (!box) return;
    box.innerHTML = tryHtml(); wireTry();
    const run = $('b-try-run'); if (run) run.textContent = TRY ? 'Run it again with new keys' : 'Try it with throwaway keys';
  }

  // ---------- login (challenge-response)
  async function startLogin(text) {
    L.npub = text; L.error = ''; L.binding = null; L.challenge = null; L.result = null;
    const hex = npubToHex(text);
    if (!hex) { L.error = 'That is not a valid npub.'; paintLogin(); return; }
    L.pending = true; paintLogin();
    try {
      const r = await resolveNpub(hex, { prefix: NET.prefix, timeoutMs: 8000 });
      L.binding = { ...r.best, ok: true };
      L.challenge = desk.issue(hex);
    } catch (e) { L.error = e.message; }
    L.pending = false; paintLogin();
  }

  function finishLogin(kind, proof) {
    if (!L.challenge || !L.binding) return;
    if (!proof) { ctx.setMsg('err', 'Paste the signature first.'); return; }
    L.result = desk.verify({ challenge: L.challenge.text, proofKind: kind, proof, binding: L.binding });
    if (L.result.ok) L.session = { npub: L.result.npub, addr: L.result.addr, at: Math.floor(Date.now() / 1000) };
    ctx.setMsg(L.result.ok ? 'ok' : 'err', L.result.ok ? `Logged in as ${shortNpub(L.result.npub)}.` : `Login refused: ${L.result.reason}.`);
    paintLogin();
  }

  const loginWithWallet = act(async () => {
    const proof = await walletProof(L.challenge.text, `Signature only, never sent: log in to ${POT_DOMAIN} as ${shortNpub(L.binding.npub)}`);
    finishLogin('wc-tx', proof);
  });

  const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 19);
  function loginHtml() {
    const s = L.session ? `<p class="ok" id="b-login-session"><b>✓ Logged in as ${esc(shortNpub(L.session.npub))} / ${esc(shortAddr(L.session.addr))}</b>
      <span class="muted small">since ${hhmm(L.session.at)} UTC · <button id="b-logout" class="link">Log out</button></span></p>` : '';
    if (L.pending) return `${s}<p class="muted"><span class="spinner"></span> Finding the npub's binding on the relays…</p>`;
    if (L.error) return `${s}<p class="err">${esc(L.error)}</p>`;
    const r = L.result;
    const verdict = r ? `<p class="${r.ok ? 'ok' : 'err'}" id="b-login-verdict"><b>${r.ok ? `✓ Logged in as <span class="mono">${esc(npubText(r.npub))}</span> / <span class="mono">${esc(r.addr)}</span>` : `✗ Not logged in: ${esc(r.reason)}`}</b></p>${checksHtml(r)}` : '';
    if (!L.challenge) return s || '<p class="muted">Enter an npub that has a binding. The page finds its BCH address on Nostr and issues a challenge for that address to sign.</p>';
    const c = L.challenge, addr = L.binding.addr, used = r?.ok;
    const canWallet = state.connected && state.addr === addr;
    return `${s}<p>Bound address: ${ctx.addrLink(addr)} <span class="muted small">(${esc(fmtName(L.binding.format))}, verified)</span></p>
      <pre class="mono small" id="b-login-msg">${esc(c.text)}</pre>
      <p class="muted small">Challenge valid until ${hhmm(c.expires)} UTC (${LOGIN_TTL / 60} minutes), for one login.${used ? ' Used: ask for a new one to log in again.' : ''}</p>
      ${used ? '' : `${canWallet ? `<p><button data-act="login-wc" id="b-login-wc">Sign with ${esc(state.walletName)}</button>
          <span class="muted small">a transaction locked until 2100 that is never sent; it only proves the address signed</span></p>`
        : state.connected ? `<p class="muted small">The connected wallet's address is not the bound one; paste a signed message instead.</p>` : ''}
        <div class="row"><button id="b-login-copy" class="link">Copy the challenge</button></div>
        <p class="muted small">Sign the challenge exactly with ${esc(shortAddr(addr))} in a wallet with Sign Message (Paytaca, Electron Cash, Cashonize) and paste the signature:</p>
        <div class="row"><input id="b-login-sig" class="mono" placeholder="H… or I… (base64 signature)" aria-label="Login signature"><button id="b-login-use">Log in</button></div>`}
      ${verdict}`;
  }
  function wireLogin() {
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    on('b-login-copy', () => ctx.copy(L.challenge.text, 'b-login-copy'));
    on('b-login-use', () => finishLogin('signmessage', $('b-login-sig').value.trim()));
    on('b-login-wc', () => loginWithWallet());
    on('b-logout', () => { L.session = null; L.result = null; paintLogin(); });
  }
  function paintLogin() {
    const box = $('b-login-box');
    if (!box) return;
    box.innerHTML = loginHtml(); wireLogin();
    ctx.setBusy(state.busyText);
  }

  async function useProof(kind, proof) {
    try {
      if (!proof) throw new Error('Paste the signature first.');
      const unsigned = unsignedBinding(b.key, bindAddr(), b.created, kind, proof);
      let ev;
      if (b.keySource === 'nip07') {
        ev = await window.nostr.signEvent(unsigned);
        if (ev?.pubkey !== b.key) throw new Error('The Nostr extension signed with a different key.');
      } else {
        if (!sk) throw new Error('Pick a Nostr key first.');
        ev = finalizeEvent(unsigned, sk);
      }
      b.proof = proof; b.proofKind = kind; b.event = ev; b.check = checkBinding(ev); b.published = null;
      ctx.setMsg(b.check?.ok ? 'ok' : 'err', b.check?.ok ? 'Both signatures check out. Publish it so others can find it.' : `This binding doesn't verify: ${b.check?.reason ?? 'unknown event'}.`);
    } catch (e) { ctx.setMsg('err', e.message); }
    paintCheck();
  }

  function checksHtml(c) {
    return `<ul class="checks">${c.checks.map((k) => `<li class="${k.ok ? 'ok' : 'err'}">${k.ok ? '✓' : '✗'} ${esc(k.label)}</li>`).join('')}</ul>`;
  }

  function paintCheck() {
    const box = $('b-check-box');
    if (!box) return;
    if (!b.event || !b.check) { box.innerHTML = '<p class="muted">The event and its check appear here once both keys have signed.</p>'; return; }
    const c = b.check;
    box.innerHTML = `<p class="${c.ok ? 'ok' : 'err'}" id="b-verdict"><b>${c.ok ? 'Valid binding' : `Not valid: ${esc(c.reason)}`}</b> · ${esc(shortNpub(c.npub))} ↔ ${esc(shortAddr(c.addr))}</p>
      ${checksHtml(c)}
      <p class="muted small">Checked in this page, before anything is sent.</p>
      <details><summary>The event</summary><pre class="mono small" id="b-event">${esc(JSON.stringify(b.event, null, 1))}</pre></details>
      ${c.ok ? `<p><button data-act="bind-pub" id="b-publish">Publish to ${DEFAULT_RELAYS.length} relays</button></p>` : ''}
      <div id="b-pub-box">${b.published ? pubHtml(b.published) : ''}</div>`;
    const pb = $('b-publish');
    if (pb) pb.onclick = () => publish();
    ctx.setBusy(state.busyText);
  }

  const pubHtml = (res) => `<ul class="checks">${res.map((r) => `<li class="${r.ok ? 'ok' : 'err'}">${r.ok ? '✓' : '✗'} ${esc(r.relay.replace('wss://', ''))}${r.ok ? '' : `: ${esc(r.message || 'refused')}`}</li>`).join('')}</ul>
    ${res.some((r) => r.ok) ? `<p>Published. Event id <span class="mono small">${esc(b.event.id)}</span> · <a href="${esc(njump(b.event.pubkey))}" target="_blank" rel="noopener">view the npub</a></p>` : ''}`;

  const publish = act(async () => {
    if (!b.event || !b.check?.ok) throw new Error('Nothing valid to publish.');
    ctx.setBusy('Publishing to the relays…');
    b.published = await publishEvent(b.event, { relays: DEFAULT_RELAYS });
    byAddr.delete(b.check.addr); byNpub.delete(b.check.npub);
    const n = b.published.filter((r) => r.ok).length;
    ctx.setMsg(n ? 'ok' : 'err', n ? `Published to ${n} of ${b.published.length} relays.` : 'No relay accepted the event. Try again in a minute.');
    paintCheck();
  });

  // ---------- lookup
  async function lookup(q) {
    if (!q) return;
    b.lookup = { q, pending: true };
    $('b-lookup-box').innerHTML = '<p class="muted"><span class="spinner"></span> Asking the relays…</p>';
    try {
      if (looksLikeNpub(q) || /^[0-9a-f]{64}$/i.test(q)) {
        let r;
        try { r = await resolveNpub(q, { prefix: NET.prefix }); } catch (e) { if (e.code !== 'NO_BINDING') throw e; r = { ...e, best: null, error: e.message }; }
        b.lookup = { q, kind: 'npub', r };
      } else {
        const err = ctx.checkAddress(q, NET);
        if (err) throw new Error(err);
        b.lookup = { q, kind: 'addr', r: await findByAddress(ctx.normalizeAddress(q, NET)) };
      }
    } catch (e) { b.lookup = { q, error: e.message }; }
    const box = $('b-lookup-box');
    if (box) box.innerHTML = lookupHtml(b.lookup);
  }

  function lookupHtml(l) {
    if (l.pending) return '<p class="muted">Asking the relays…</p>';
    if (l.error && !l.r) return `<p class="err">${esc(l.error)}</p>`;
    const r = l.r, rows = [];
    for (const v of r.valid ?? []) {
      rows.push(`<div class="potrow"><b class="ok">✓ ${esc(shortNpub(v.npub))} ↔ ${esc(shortAddr(v.addr))}</b>
        <span class="muted">${esc(fmtName(v.format))} · ${esc(new Date(v.created * 1000).toISOString().slice(0, 16).replace('T', ' '))} UTC${v.proofKind ? ` · proof: ${esc(v.proofKind)}` : ''}</span>${checksHtml(v)}</div>`);
    }
    for (const v of r.unverifiable ?? []) {
      rows.push(`<div class="potrow grey"><b>? ${esc(shortNpub(v.npub))} ↔ ${esc(shortAddr(v.addr))}</b><span class="muted">${esc(fmtName(v.format))}: unverifiable. ${esc(v.reason)}</span></div>`);
    }
    for (const v of r.skipped ?? []) rows.push(`<div class="potrow grey"><b class="err">✗ ${esc(shortNpub(v.npub))}</b><span class="muted">${esc(fmtName(v.format))}: ${esc(v.reason)}</span></div>`);
    for (const v of r.revoked ?? []) rows.push(`<div class="potrow grey"><b>${esc(shortNpub(v.npub))} ↔ ${esc(shortAddr(v.addr))}</b><span class="muted">revoked</span></div>`);
    const answered = (r.relays ?? []).filter((x) => x.status === 'eose').length;
    return `${l.error ? `<p class="err">${esc(l.error)}</p>` : ''}${rows.join('') || '<p class="muted">No binding found.</p>'}
      ${r.relays ? `<p class="muted small">${answered} of ${r.relays.length} relays answered. Each event was verified in this page.</p>` : ''}`;
  }

  return { viewBind, badgeSlot, paintBadges, resolveCached, resolveNow, shortNpub, looksLikeNpub, onConnect: () => { if (state.view === 'bind') viewBind(); } };
}
