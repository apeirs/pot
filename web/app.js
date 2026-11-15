// Pot: the page. A static site with no backend: the pot's terms travel in its link, its state is read from the chain
// over Electrum, and every transaction is signed by the user's wallet over WizardConnect.
//
// Views (by URL hash): #/ home · #/new create · #/p/<pot link> one pot (balance, history, top-up, award, refund) ·
// #/bind Nostr identity (web/bind.js).
// Network: mainnet by default, chipnet with ?net=chipnet. Each network keeps its own wallet session and pot list.
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager, loadSession, clearSession } from '@wizardconnect/dapp';
import { binToHex, hexToBin, hash160, cashAddressToLockingBytecode } from '@bitauth/libauth';
import qrcode from 'qrcode-generator';
import { NETWORKS, FailoverProvider, checkAddress, normalizeAddress, SERVER_ERROR } from '../src/net.mjs';
import { readPot, encodePotMeta } from '../src/potread.mjs';
import {
  MAX_FEE, MIN_TOPUP, MIN_POT, newSalt, checkParams, encodePotLink, decodePotLink, potContract, p2pkhAddress,
  pkhAddress, heightForTime, timeForHeight, wcRequest, buildPayment, buildSweep, bip21,
} from '../src/pot.mjs';
import { makeIdentity } from './bind.js';

// ---------- network and constants
const query = new URLSearchParams(location.search);
const asked = query.get('net');
const NET = asked === 'chipnet' ? NETWORKS.chipnet : NETWORKS.mainnet;
const OTHER = NET.name === 'mainnet' ? NETWORKS.chipnet : NETWORKS.mainnet;
const RELAY = 'wss://relay.riften.net:443';
const SESSION_KEY = `pot-wc-session-${NET.name}`;
const POTS_KEY = `pot-pots-${NET.name}`;
const SOURCE = 'https://github.com/apeirs/pot/blob/main/contracts/Pot.cash';
const SCAN = 10; // wallet addresses read per chain (receive, change)
const RELAY_TIMEOUT_MS = 15000;
const RESUME_TIMEOUT_MS = 20000;
const FEATURED = { // pot links shown on the home page
  mainnet: [
    { title: 'BLAZE 2026 demo pot', role: 'open: add to it', link: '1.a4bec748b68981eff89f7f37f855237b17d3f909.02259a322083854c4f76b91595c6f7630bcdcdb6407b66d3b09d0f9e3ef2683095.979645.5000.2ab2c2e8333f7708' },
    { title: 'Pot mainnet demo: review the Pot contract', role: 'funded, topped up and awarded', link: '1.a4bec748b68981eff89f7f37f855237b17d3f909.02259a322083854c4f76b91595c6f7630bcdcdb6407b66d3b09d0f9e3ef2683095.977865.5000.08788b65839dcd5d' },
    { title: 'Pot mainnet demo B: the refund path', role: 'refunded after its deadline', link: '1.a4bec748b68981eff89f7f37f855237b17d3f909.02259a322083854c4f76b91595c6f7630bcdcdb6407b66d3b09d0f9e3ef2683095.977443.5000.805a23cfd99dae88' },
  ],
  chipnet: [],
};

const TEXT = {
  rejected: "The wallet didn't sign. Nothing was sent.",
  relayDown: "Can't reach the WizardConnect relay right now, so no wallet can connect. Try again in a minute. "
    + 'To add to a pot without connecting, pay the QR code on its page from any BCH wallet.',
  testnetWallet: 'This wallet is set to a test network (it sent a testnet key). This page uses real BCH on mainnet. '
    + 'Switch the wallet to mainnet, or use the chipnet page.',
  chipnetWallet: 'This wallet holds chipnet test coins and nothing on mainnet: it looks like it is set to chipnet. '
    + 'Switch it to mainnet and connect again, or use the chipnet page.',
  mainnetWallet: 'This wallet holds real mainnet BCH and no chipnet coins: it looks like it is set to mainnet. '
    + 'This page is the chipnet test version. Switch the wallet to chipnet, or use the mainnet page.',
  notJudge: 'Only the judge can award this pot. Connect the judge’s wallet.',
  notPoster: 'Only the poster can take the pot back.',
  winnerIsParty: "The winner can't be the poster or the judge.",
  gift: 'Top-ups are gifts to the pot. If nobody wins, they go back to the poster, not to you.',
};

// ---------- small helpers
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off: pots live for this visit */ } },
};
const otherNetUrl = () => {
  const u = new URL(location.href);
  if (OTHER.name === 'chipnet') u.searchParams.set('net', 'chipnet'); else u.searchParams.delete('net');
  return u.toString();
};
const netQuery = NET.name === 'chipnet' ? '?net=chipnet' : '';
const potUrl = (link) => `${location.origin}${location.pathname}${netQuery}#/p/${link}`;
const bch = (sats) => {
  const s = BigInt(sats ?? 0), neg = s < 0n, a = neg ? -s : s;
  return `${neg ? '-' : ''}${a / 100000000n}.${String(a % 100000000n).padStart(8, '0')} BCH`;
};
/** ` "Title"` for a wallet prompt, or nothing when the pot has no title. */
const named = (title) => (title ? ` "${title}"` : '');
const satsText = (sats) => `${Number(sats ?? 0).toLocaleString('en')} sats`;
function parseBch(text) {
  const m = /^\s*(\d{0,8})(?:\.(\d{0,8}))?\s*$/.exec(String(text ?? ''));
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || '0') * 100000000n + BigInt((m[2] ?? '').padEnd(8, '0') || '0');
}
const dateText = (ms) => new Date(ms).toLocaleString(undefined,
  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function span(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
const short = (s, n = 10) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);
const txLink = (txid, label = `${txid.slice(0, 12)}…`) =>
  `<a class="mono" href="${esc(NET.txUrl(txid))}" target="_blank" rel="noopener">${esc(label)}</a>`;
const addrLink = (a, label = a) =>
  `<a class="mono" href="${esc(NET.addressUrl(a))}" target="_blank" rel="noopener">${esc(label)}</a>`;
const qrSvg = (data) => { const q = qrcode(0, 'M'); q.addData(data); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
const sameLock = (a, b) => {
  const x = cashAddressToLockingBytecode(a), y = cashAddressToLockingBytecode(b);
  return typeof x !== 'string' && typeof y !== 'string' && binToHex(x.bytecode) === binToHex(y.bytecode);
};

// ---------- state (window.__pot is read by the end-to-end test)
const state = (window.__pot = {
  net: NET.name, view: null, uri: null, qrUri: null, relayConnected: false, connected: false, resumed: false,
  readyCount: 0, walletName: null, addr: null, judgeKey: null, pkh: null, balance: null, height: null,
  pot: null, txs: [], busy: false, busyText: '', errors: [], refused: null, lastLink: null, notice: null,
});
const ui = { title: '', url: '', amount: '0.0002', date: '', height: '', judge: 'me', judgeKey: '', topup: '0.0001', winner: '' };
const provider = new FailoverProvider(NET);
let dapp = null, relay = null, readyHandled = false, abort = null, relayTimer = null, resumeTimer = null;
const id = makeIdentity({
  $, esc, NET, state, provider, getDapp: () => dapp, walletCoins: () => walletCoins(), setMsg: (...a) => setMsg(...a),
  setBusy: (...a) => setBusy(...a), action: (fn) => action(fn), copy: (...a) => copy(...a), addrLink: (...a) => addrLink(...a), short,
  checkAddress, normalizeAddress, setAbort: (a) => { abort = a; },
});

function fail(e) {
  const m = String(e?.message ?? e);
  state.errors.push(m);
  console.info('[pot]', m); // shown on the page; not a page error
  setMsg('err', m);
}
function setMsg(kind, text, html = '') {
  state.notice = text ? { kind, text } : null;
  const el = $('msg');
  if (!el) return;
  el.className = text ? `msg ${kind}` : 'msg';
  el.innerHTML = text ? `${esc(text)}${html}` : '';
  if (text && kind === 'err') el.scrollIntoView({ block: 'nearest' });
}

// ---------- wallet: pairing, resume, wrong-network checks
function startRelay(existingCredentials) {
  readyHandled = false;
  state.relayConnected = false;
  dapp = new DappConnectionManager('Pot', `${location.origin}${location.pathname}icon.svg`, { session: { key: SESSION_KEY } });
  relay = initiateDappRelay((p) => {
    dapp.updateConnection(p.client, p.status);
    const s = p.status?.status;
    if (s === 'connected') { state.relayConnected = true; if (state.notice?.text === TEXT.relayDown) setMsg(); }
    if (s === 'reconnecting' && state.connected) setMsg('info', 'Lost the link to the wallet relay; reconnecting…');
  }, { explicitRelayUrls: [RELAY], ...(existingCredentials ? { existingCredentials } : {}) });
  dapp.attachRelay(relay);
  dapp.on('walletready', onReady);
  dapp.on('disconnect', (reason) => {
    console.info('[pot] wallet disconnected', reason);
    clearSession(SESSION_KEY);
    resetWallet();
    setMsg('info', 'The wallet disconnected.');
  });
  clearTimeout(relayTimer);
  relayTimer = setTimeout(() => { if (!state.relayConnected && !state.connected) { state.errors.push(TEXT.relayDown); setMsg('err', TEXT.relayDown); } },
    RELAY_TIMEOUT_MS);
}

async function stopRelay() {
  clearTimeout(relayTimer); clearTimeout(resumeTimer);
  const d = dapp, r = relay;
  dapp = null; relay = null;
  try { await d?.destroy(); } catch { /* already stopped */ }
  try { r?.cleanup?.(); } catch { /* already closed */ }
}

function resetWallet() {
  Object.assign(state, { connected: false, resumed: false, walletName: null, addr: null, judgeKey: null, pkh: null, balance: null, uri: null, qrUri: null });
  readyHandled = false;
  renderWallet();
  render();
}

async function connect() {
  try {
    await stopRelay();
    clearSession(SESSION_KEY); // a new pairing replaces any stale session
    state.refused = null; setMsg();
    startRelay(null);
    state.uri = relay.uri; state.qrUri = relay.qrUri ?? relay.uri;
    renderWallet();
  } catch (e) { fail(e); }
}

async function disconnect() {
  try { await dapp?.sendDisconnect('user disconnected'); } catch { /* best effort */ }
  await stopRelay();
  clearSession(SESSION_KEY);
  resetWallet();
}

function tryResume() {
  const s = loadSession(SESSION_KEY);
  if (!s?.privateKey || !s?.secret || !s?.walletPublicKey) return;
  try {
    startRelay({ privateKey: s.privateKey, secret: s.secret, walletPublicKey: s.walletPublicKey });
    state.resumed = true;
    state.walletName = s.walletName ?? 'wallet';
    renderWallet();
    resumeTimer = setTimeout(() => {
      if (!state.connected) setMsg('info', `${state.walletName} hasn't answered yet. Open it to reconnect, or connect again.`);
    }, RESUME_TIMEOUT_MS);
  } catch (e) { console.warn('[pot] resume failed', e); clearSession(SESSION_KEY); }
}

async function refuseWallet(text) {
  state.refused = text;
  state.errors.push(text);
  try { await dapp?.sendDisconnect('wrong network'); } catch { /* best effort */ }
  await stopRelay();
  clearSession(SESSION_KEY);
  resetWallet();
  setMsg('err', text, ` <a href="${esc(otherNetUrl())}">Open the ${OTHER.name} page</a>.`);
}

async function onReady(msg) {
  state.readyCount++;
  if (readyHandled) return; // wallet_ready can arrive twice
  readyHandled = true;
  clearTimeout(resumeTimer);
  try {
    // WizardConnect has no network field. Two checks instead: a testnet key (tpub) on mainnet, and, for an empty
    // wallet, coins on the other network only.
    const paths = dapp.getSessionPaths?.() ?? [];
    if (NET.name === 'mainnet' && paths.some((p) => /^tpub/.test(String(p.xpub)))) return await refuseWallet(TEXT.testnetWallet);
    const pub0 = dapp.getPubkey(0, 0n);
    if (!pub0) throw new Error('The wallet did not share an address. Connect again.');
    Object.assign(state, {
      connected: true, walletName: msg?.wallet_name ?? dapp.walletName ?? state.walletName ?? 'wallet',
      addr: p2pkhAddress(pub0, NET.prefix), judgeKey: binToHex(pub0), pkh: binToHex(hash160(pub0)), uri: null, qrUri: null,
    });
    if (state.notice?.kind !== 'err') setMsg();
    renderWallet();
    await refreshWallet();
    if (state.balance === '0' && await hasCoinsOn(OTHER, pub0)) {
      return await refuseWallet(NET.name === 'mainnet' ? TEXT.chipnetWallet : TEXT.mainnetWallet);
    }
    render();
  } catch (e) { fail(e); }
}

async function hasCoinsOn(net, pub0) {
  try {
    const p = new FailoverProvider(net, { timeoutMs: 6000 });
    return (await p.getUtxos(p2pkhAddress(pub0, net.prefix))).length > 0;
  } catch { return false; } // can't tell: allow
}

/** The wallet's coins on this network: receive and change addresses 0..SCAN-1. */
async function walletCoins() {
  const paths = [];
  for (const [name, child] of [['receive', 0], ['change', 1]]) {
    if (!dapp?.hasPath(child)) continue;
    for (let i = 0; i < SCAN; i++) {
      const pub = dapp.getPubkey(child, BigInt(i));
      if (pub) paths.push({ name, i, address: p2pkhAddress(pub, NET.prefix) });
    }
  }
  const lists = await Promise.all(paths.map((p) => provider.getUtxos(p.address)));
  return lists.flatMap((us, k) => us.map((u) => ({ utxo: u, address: paths[k].address, path: [paths[k].name, paths[k].i] })));
}

async function refreshWallet() {
  if (!state.connected) return;
  try {
    const coins = await walletCoins();
    state.balance = String(coins.filter((c) => !c.utxo.token).reduce((s, c) => s + c.utxo.satoshis, 0n));
    state.hasTokens = coins.some((c) => c.utxo.token);
  } catch (e) { state.balance = null; console.warn('[pot] wallet read failed', e); }
  renderWallet();
}

// ---------- signing and sending
async function signAndSend({ wcObj, inputPaths }, label) {
  abort = new AbortController();
  setBusy('Check your wallet: confirm or reject the request there.', true);
  let resp;
  try {
    resp = await dapp.signTransaction(wcRequest(wcObj, inputPaths), { signal: abort.signal });
  } catch (e) {
    console.info('[pot] sign request ended', e);
    throw new Error(TEXT.rejected);
  } finally { abort = null; }
  if (resp?.error || !resp?.signedTransaction) throw new Error(`${TEXT.rejected}${resp?.error ? ` (${resp.error})` : ''}`);
  setBusy('Sending…');
  let txid;
  try { txid = await provider.sendRawTransaction(resp.signedTransaction); } catch (e) { throw new Error(explainReject(e)); }
  state.txs.push({ label, txid });
  return txid;
}

function explainReject(e) {
  const m = String(e?.message ?? e);
  if (m === SERVER_ERROR) return `${SERVER_ERROR}. Nothing was sent.`;
  if (/non-final|locktime/i.test(m)) return 'The refund is not open yet: the chain has not reached the deadline block.';
  if (/missing|spent|conflict|already/i.test(m)) return 'Some of these coins were spent a moment ago (another award, refund or top-up). Reload and try again.';
  if (/fee|priority/i.test(m)) return 'The network wants a higher fee for this transaction. Nothing was sent.';
  return `The network refused this transaction, so nothing was sent. (${m.slice(0, 160)})`;
}

function setBusy(text, cancellable = false) {
  state.busy = !!text; state.busyText = text || '';
  const el = $('busy');
  if (el) {
    el.hidden = !text;
    el.innerHTML = text ? `<span class="spinner"></span> ${esc(text)}${cancellable ? ' <button id="cancel" class="link">Cancel</button>' : ''}` : '';
    if (cancellable) $('cancel').onclick = () => abort?.abort();
  }
  document.querySelectorAll('button[data-act]').forEach((b) => { b.disabled = state.busy || b.dataset.off === '1'; });
}

const action = (fn) => async (...a) => {
  if (state.busy) return;
  setMsg();
  setBusy('Working…');
  try { await fn(...a); } catch (e) { fail(e); }
  setBusy('');
};

async function waitFor(check, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { if (await check()) return true; } catch { /* retry */ }
    await sleep(1500);
  }
  return false;
}

// ---------- pots this browser knows
const myPots = () => store.get(POTS_KEY, []);
function rememberPot(link, extra = {}) {
  const pots = myPots().filter((p) => p.link !== link);
  const old = myPots().find((p) => p.link === link) ?? {};
  pots.unshift({ ...old, link, ...extra, seen: Date.now() });
  store.set(POTS_KEY, pots.slice(0, 30));
}

// ---------- views
function render() {
  const h = location.hash || '#/';
  if (h.startsWith('#/new')) return viewCreate();
  if (h.startsWith('#/bind')) return id.viewBind();
  if (h.startsWith('#/p/')) return viewPot(decodeURIComponent(h.slice(4)));
  return viewHome();
}

function viewHome() {
  state.view = 'home';
  const pots = myPots();
  const featured = FEATURED[NET.name];
  $('view').innerHTML = `
    <section class="intro">
      <p>A <b>pot</b> is a bounty locked in a Bitcoin Cash contract. The poster funds it and names a judge and a deadline.</p>
      <ul>
        <li>Only the judge can pay it out, and only to one winner.</li>
        <li>After the deadline, the poster can take it back. Before it, nobody can.</li>
        <li>Anyone can add to it.</li>
      </ul>
      <p class="muted">No account and no server: the pot's terms are in its link, its money is on chain, and your wallet signs every step.</p>
      <p><a class="btn" href="#/new">Create a pot</a> <a class="btn ghost" href="#/bind" id="nav-bind">Nostr identity</a></p>
      <p class="muted">Pay a winner, or name a judge, by their npub: <a href="#/bind">bind your BCH address to your Nostr key</a>.</p>
    </section>
    ${featured.length ? `<section><h2>Featured</h2>${featured.map(potRow).join('')}</section>` : ''}
    <section>
      <h2>Your pots</h2>
      ${pots.length ? pots.map(potRow).join('') : '<p class="muted">Pots you create or open on this device show up here.</p>'}
    </section>
    <section>
      <h2>Open a pot</h2>
      <form id="openform" class="row"><input id="openlink" placeholder="Pot link" aria-label="Pot link"><button>Open</button></form>
    </section>`;
  $('openform').onsubmit = (ev) => {
    ev.preventDefault();
    const v = $('openlink').value.trim();
    const link = v.includes('#/p/') ? v.slice(v.indexOf('#/p/') + 4) : v;
    try { decodePotLink(link); location.hash = `#/p/${link}`; } catch (e) { setMsg('err', e.message); }
  };
}

function potRow(p) {
  const link = typeof p === 'string' ? p : p.link;
  let params;
  try { params = decodePotLink(link); } catch { return ''; }
  const title = p.title || `Pot ending at block ${params.deadline.toLocaleString('en')}`;
  return `<a class="potrow" href="#/p/${esc(link)}"><b>${esc(title)}</b><span class="muted">${p.role ? esc(p.role) + ' · ' : ''}deadline block ${params.deadline.toLocaleString('en')}</span></a>`;
}

function viewCreate() {
  state.view = 'create';
  if (!ui.date) {
    const d = new Date(Date.now() + 3 * 86400000);
    d.setMinutes(0, 0, 0);
    ui.date = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  $('view').innerHTML = `
    <section>
      <h2>Create a pot</h2>
      <form id="createform" class="form">
        <label>Title <span class="muted">(up to 60 characters, stored on chain)</span>
          <input id="f-title" maxlength="60" required value="${esc(ui.title)}" placeholder="Fix the login bug in #42"></label>
        <label>Link <span class="muted">(the task, issue or post; optional)</span>
          <input id="f-url" type="url" value="${esc(ui.url)}" placeholder="https://"></label>
        <label>Amount in BCH <span class="muted">(at least ${bch(MIN_POT)})</span>
          <input id="f-amount" inputmode="decimal" value="${esc(ui.amount)}"></label>
        <div class="hint" id="f-amount-hint"></div>
        <label>Deadline <input id="f-date" type="datetime-local" value="${esc(ui.date)}"></label>
        <details id="f-height-box" ${ui.height ? 'open' : ''}><summary>Set the deadline as a block height instead</summary>
          <label>Block height <input id="f-height" inputmode="numeric" value="${esc(ui.height)}" placeholder="e.g. ${(state.height ?? 0) + 432}"></label>
        </details>
        <div class="hint" id="f-deadline-hint"></div>
        <fieldset><legend>Judge</legend>
          <label class="radio"><input type="radio" name="judge" value="me" ${ui.judge === 'me' ? 'checked' : ''}> Me</label>
          <div class="muted">Hunters can trust that the pot stays locked until the deadline, but you decide the winner.</div>
          <label class="radio"><input type="radio" name="judge" value="other" ${ui.judge === 'other' ? 'checked' : ''}> Someone else</label>
          <div class="muted">You can't take the pot back before the deadline, and you can't award it.</div>
          <input id="f-judge" class="mono" placeholder="Their npub, or their judge key (66 hex, from 'Your judge key' in their Pot wallet panel)" value="${esc(ui.judgeKey)}" ${ui.judge === 'me' ? 'hidden' : ''}>
          <div class="hint" id="f-judge-hint" ${ui.judge === 'me' ? 'hidden' : ''}></div>
        </fieldset>
        <p class="muted">Network fee cap per award or refund: ${satsText(MAX_FEE)}. Each pot gets a fresh random salt, so two pots never share an address.</p>
        <button data-act="create" id="create">Create and fund</button>
        <div class="muted" id="create-note"></div>
      </form>
    </section>`;
  const bind = (id, key) => { $(id).oninput = () => { ui[key] = $(id).value; hints(); }; };
  bind('f-title', 'title'); bind('f-url', 'url'); bind('f-amount', 'amount'); bind('f-date', 'date'); bind('f-height', 'height'); bind('f-judge', 'judgeKey');
  document.querySelectorAll('input[name=judge]').forEach((r) => { r.onchange = () => { ui.judge = r.value; $('f-judge').hidden = $('f-judge-hint').hidden = ui.judge === 'me'; }; });
  $('createform').onsubmit = (ev) => { ev.preventDefault(); createPot(); };
  const hints = () => {
    const sats = parseBch(ui.amount);
    $('f-amount-hint').textContent = sats === null ? 'Enter an amount such as 0.001' : satsText(sats);
    const tip = state.height;
    if (!tip) { $('f-deadline-hint').textContent = 'Reading the block height…'; return; }
    const h = deadlineHeight(tip);
    judgeHint();
    $('f-deadline-hint').textContent = h ? `≈ ${dateText(timeForHeight(h, tip))} (block ${h.toLocaleString('en')}). Blocks come about every 10 minutes, so the date is approximate.` : 'Pick a date in the future.';
  };
  const judgeHint = () => {
    const el = $('f-judge-hint'), v = ui.judgeKey.trim();
    if (!el) return;
    if (!id.looksLikeNpub(v)) { el.textContent = ''; return; }
    const r = id.resolveCached(v, () => { if (state.view === 'create') judgeHint(); });
    el.innerHTML = r.pending ? '<span class="spinner"></span> Looking up this npub’s BCH binding…'
      : r.error ? `<span class="err">${esc(r.error)}</span>`
        : r.pub ? `<span class="ok">✓ ${esc(id.shortNpub(r.hex))}</span> is bound to ${esc(short(r.best.addr.split(':')[1], 12))}: judge key ${esc(short(r.pub, 10))}`
          : '<span class="err">This binding has no key that can judge (it was signed with an uncompressed key). Ask for their judge key instead.</span>';
  };
  hints();
  $('create-note').textContent = state.connected ? '' : 'Connect a wallet first (top right).';
  $('create').dataset.off = state.connected ? '0' : '1';
  setBusy(state.busyText);
}

function deadlineHeight(tip) {
  if (String(ui.height).trim()) { const h = Number(ui.height); return Number.isInteger(h) && h > 0 ? h : null; }
  const t = Date.parse(ui.date);
  return Number.isFinite(t) && t > Date.now() ? heightForTime(t, tip) : null;
}

const createPot = action(async () => {
  if (!state.connected) throw new Error('Connect a wallet first.');
  const title = ui.title.trim(), url = ui.url.trim();
  if (!title) throw new Error('Give the pot a title.');
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error('The link must start with https:// or http://.');
  const amount = parseBch(ui.amount);
  if (amount === null || amount < MIN_POT) throw new Error(`The amount must be at least ${bch(MIN_POT)}.`);
  const tip = await provider.getBlockHeight();
  state.height = tip;
  const deadline = deadlineHeight(tip);
  if (!deadline) throw new Error('Pick a deadline in the future.');
  if (deadline < tip || (NET.name === 'mainnet' && deadline <= tip)) throw new Error(`The deadline block must be after the current block (${tip}).`);
  let judgePk = state.judgeKey;
  if (ui.judge === 'other' && id.looksLikeNpub(ui.judgeKey)) {
    setBusy('Looking up the judge’s npub on Nostr…');
    const r = await id.resolveNow(ui.judgeKey.trim());
    if (!r.pub) throw new Error('This npub’s binding has no key that can judge. Ask for their judge key instead.');
    judgePk = r.pub;
  } else if (ui.judge === 'other') {
    judgePk = ui.judgeKey.trim().toLowerCase();
    if (!/^0[23][0-9a-f]{64}$/.test(judgePk)) throw new Error('The judge key must be 66 hex characters starting with 02 or 03.');
  }
  const params = checkParams({ posterPkh: state.pkh, judgePk, deadline, maxFee: Number(MAX_FEE), salt: newSalt() });
  const C = potContract(params, provider);
  const meta = encodePotMeta(title, url);
  const coins = await walletCoins();
  const tx = buildPayment({
    provider, coins, to: C.address, amount, extraOutputs: [{ to: meta, amount: 0n }], changeTo: state.addr,
    userPrompt: `Create the pot${named(title)}: lock ${bch(amount)} until block ${deadline}`,
  });
  const txid = await signAndSend(tx, 'create');
  const link = encodePotLink(params);
  state.lastLink = link;
  rememberPot(link, { title, role: ui.judge === 'me' ? 'poster and judge' : 'poster', fundTxid: txid, address: C.address });
  ui.title = ''; ui.url = ''; ui.height = '';
  setBusy('Waiting for the pot to show up on the network…');
  await waitFor(async () => (await provider.getUtxos(C.address)).some((u) => u.txid === txid));
  location.hash = `#/p/${link}`;
  setMsg('ok', 'Pot created. Share its link with the hunters.');
});

// ---------- pot view
async function viewPot(link) {
  state.view = 'pot';
  let params;
  try { params = decodePotLink(link); } catch (e) {
    state.pot = { link, error: e.message };
    $('view').innerHTML = `<section><h2>Pot</h2><p class="err">${esc(e.message)}</p><p><a href="#/">Home</a></p></section>`;
    return;
  }
  const address = potContract(params, provider).address;
  if (state.pot?.link !== link) state.pot = { link, params, address, loaded: false };
  renderPot();
  await loadPot();
}

async function loadPot() {
  const pot = state.pot;
  if (!pot?.params) return;
  pot.loading = true; pot.error = null;
  renderPot();
  try {
    const [r, tip] = await Promise.all([
      readPot(pot.address, { posterPkh: pot.params.posterPkh, servers: NET.servers }),
      provider.getBlockHeight(),
    ]);
    if (state.pot !== pot) return;
    Object.assign(pot, {
      loaded: true, utxos: r.utxos.filter((u) => !u.token), sats: String(r.balanceSats), history: r.history,
      historyTotal: r.historyTotal, meta: r.meta && r.meta.byPoster !== false ? r.meta : null, server: r.server,
    });
    state.height = tip;
    rememberPot(pot.link, { title: pot.meta?.title ?? '', address: pot.address });
  } catch (e) {
    pot.error = e.message === SERVER_ERROR ? SERVER_ERROR : `Couldn't read this pot: ${e.message}`;
  }
  pot.loading = false;
  if (state.pot === pot) renderPot();
}

function renderPot() {
  const pot = state.pot;
  if (!pot?.params) return;
  const { params, address } = pot;
  const tip = state.height;
  const open = tip !== null && tip >= params.deadline;
  const deadlineMs = tip ? timeForHeight(params.deadline, tip) : null;
  const isJudge = state.connected && state.judgeKey === params.judgePk;
  const isPoster = state.connected && state.pkh === params.posterPkh;
  const sats = BigInt(pot.sats ?? 0), coins = pot.utxos?.length ?? 0;
  const posterAddr = pkhAddress(params.posterPkh, NET.prefix);
  const judgeAddr = p2pkhAddress(hexToBin(params.judgePk), NET.prefix);
  const title = pot.meta?.title || 'Untitled pot';
  const safeUrl = pot.meta?.url && /^https?:\/\//i.test(pot.meta.url) ? pot.meta.url : null;
  const deadlineLine = !tip ? `Deadline: block ${params.deadline.toLocaleString('en')}`
    : open ? `Deadline passed (block ${params.deadline.toLocaleString('en')}): the poster can take the pot back.`
      : `Refund to the poster opens at block ${params.deadline.toLocaleString('en')} (≈ ${dateText(deadlineMs)}), in about ${span(deadlineMs - Date.now())}.`;
  const topupSats = parseBch(ui.topup);
  const uri = bip21(address, topupSats && topupSats >= MIN_TOPUP ? topupSats : null, title.slice(0, 40));
  const hist = (pot.history ?? []).map((h) => `<li><span class="kind">${esc(h.kind)}</span> ${satsText(h.sats)} ${txLink(h.txid)}${h.height > 0 ? '' : ' <span class="muted">(unconfirmed)</span>'}</li>`).join('');

  $('view').innerHTML = `
    <section class="pothead">
      <h2 id="pot-title">${esc(title)}</h2>
      ${safeUrl ? `<div><a href="${esc(safeUrl)}" target="_blank" rel="noopener nofollow">${esc(safeUrl)}</a></div>` : ''}
      ${pot.loading && !pot.loaded ? '<div class="skeleton">Reading the pot from the chain…</div>' : ''}
      ${pot.error ? `<div class="err">${esc(pot.error)} <button class="link" id="retry">Retry</button></div>` : ''}
      ${pot.loaded ? `
        <div class="amount" id="pot-amount">${bch(sats)}</div>
        <div class="muted">${satsText(sats)} in ${coins} coin${coins === 1 ? '' : 's'}${pot.loading ? ' · updating…' : ''}</div>
        ${!coins && !(pot.history ?? []).length ? `<div class="info">This pot is empty: nobody has funded it on ${NET.name} yet. If it was made on ${OTHER.name}, <a href="${esc(otherNetUrl())}">open it there</a>.</div>` : ''}
        ${!coins && (pot.history ?? []).length ? '<div class="info">This pot is empty or was paid out. Its history is below.</div>' : ''}` : ''}
      <div class="status ${open ? 'open' : ''}" id="pot-deadline">${esc(deadlineLine)}</div>
      <ul class="facts">
        <li>Only the judge (${isJudge ? '<b>you</b>' : addrLink(judgeAddr, short(judgeAddr.split(':')[1]))}${id.badgeSlot(judgeAddr)}) can award it</li>
        <li>Refund to the poster (${isPoster ? '<b>you</b>' : addrLink(posterAddr, short(posterAddr.split(':')[1]))}${id.badgeSlot(posterAddr)}) opens at the deadline</li>
        <li>Anyone can add to it</li>
      </ul>
      <div class="row"><input class="mono" readonly id="pot-link" value="${esc(potUrl(pot.link))}" aria-label="Pot link"><button id="copy-link">Copy link</button></div>
    </section>

    <section id="topup">
      <h3>Add to this pot</h3>
      <div class="row"><label>Amount in BCH <input id="t-amount" inputmode="decimal" value="${esc(ui.topup)}"></label>
        <button data-act="topup" id="topup-send" ${state.connected ? '' : 'data-off="1"'}>Send from my wallet</button></div>
      <p class="warn">${esc(TEXT.gift)}</p>
      ${state.hasTokens ? '<p class="warn">Your wallet holds CashTokens. Pot never sends them; don’t send tokens to a pot from another app, they would be lost.</p>' : ''}
      <details ${state.connected ? '' : 'open'}><summary>Or pay from any BCH wallet</summary>
        <div class="qrbox"><div id="topup-qr" class="qr">${qrSvg(uri)}</div>
        <div><div class="mono small" id="topup-uri">${esc(uri)}</div>
        <p class="muted">Scan with any BCH wallet${NET.name === 'chipnet' ? ' set to chipnet' : ''}. Minimum ${bch(MIN_TOPUP)}: smaller top-ups cost more in fees to pay out than they add.</p></div></div>
      </details>
    </section>

    <section id="award">
      <h3>Award</h3>
      ${isJudge ? `
        <label>Winner's BCH address or npub <input id="w-addr" class="mono" value="${esc(ui.winner)}" placeholder="${NET.prefix}:q… or npub1…"></label>
        <div class="hint" id="w-hint"></div>
        <button data-act="award" id="award-send" ${coins ? '' : 'data-off="1"'}>Award the pot</button>`
      : `<p class="muted">${state.connected ? esc(TEXT.notJudge) : 'The judge connects their wallet here to pay the winner.'}</p>`}
    </section>

    <section id="refund">
      <h3>Refund</h3>
      ${isPoster ? `
        <p class="muted">${open ? 'The deadline has passed: you can take the pot back to your wallet.' : `Opens at block ${params.deadline.toLocaleString('en')}${deadlineMs ? `, in about ${esc(span(deadlineMs - Date.now()))}` : ''}.`}</p>
        <button data-act="refund" id="refund-send" ${open && coins ? '' : 'data-off="1"'}>Take the pot back</button>`
      : `<p class="muted">${state.connected ? esc(TEXT.notPoster) : 'After the deadline, the poster can take the pot back here.'}</p>`}
    </section>

    <section id="history">
      <h3>History</h3>
      ${hist ? `<ul class="hist">${hist}</ul>${pot.historyTotal > (pot.history?.length ?? 0) ? `<p class="muted">Showing ${pot.history.length} of ${pot.historyTotal}: the first and the newest.</p>` : ''}` : `<p class="muted">${pot.loaded ? 'No transactions yet.' : '…'}</p>`}
    </section>

    <details class="how"><summary>How this works</summary>
      <p>The pot is a CashScript contract at ${addrLink(address)}. Its address is the hash of the contract code and these terms, so the link is all the page needs:</p>
      <ul class="mono small">
        <li>poster: ${esc(params.posterPkh)} (hash of ${esc(posterAddr)})</li>
        <li>judge key: ${esc(params.judgePk)}</li>
        <li>deadline: block ${params.deadline}</li>
        <li>fee cap: ${params.maxFee} sats</li>
        <li>salt: ${esc(params.salt)}</li>
      </ul>
      <p><b>award</b>: the judge signs; one output to anyone but the poster or the judge; it takes every pot coin it spends minus at most the fee cap.
        <b>refund</b>: from the deadline block, the poster signs and the coins go back to the poster's address.
        Anything else, such as mixing in coins of another contract, is refused by the network.
        <a href="${SOURCE}" target="_blank" rel="noopener">Contract source</a></p>
      ${pot.server ? `<p class="muted">Read from ${esc(pot.server)}.</p>` : ''}
    </details>`;

  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
  on('retry', 'onclick', () => loadPot());
  on('copy-link', 'onclick', () => copy(potUrl(pot.link), 'copy-link'));
  on('t-amount', 'oninput', () => {
    ui.topup = $('t-amount').value;
    const s = parseBch(ui.topup);
    const u = bip21(address, s && s >= MIN_TOPUP ? s : null, title.slice(0, 40));
    $('topup-qr').innerHTML = qrSvg(u); $('topup-uri').textContent = u;
  });
  on('topup-send', 'onclick', () => topUp());
  on('award-send', 'onclick', () => award());
  on('refund-send', 'onclick', () => refund());
  on('w-addr', 'oninput', () => { ui.winner = $('w-addr').value; winnerHint(); });
  if ($('w-hint')) winnerHint();
  setBusy(state.busyText);

  function winnerHint() {
    const w = winnerTarget(ui.winner), err = w.pending ? '' : winnerError(ui.winner);
    $('w-hint').innerHTML = !ui.winner.trim() ? `Pays all ${coins} coin${coins === 1 ? '' : 's'} (up to 15 per award), minus a network fee of at most ${satsText(params.maxFee)}.`
      : w.pending ? '<span class="spinner"></span> Looking up this npub’s BCH binding on Nostr…'
        : err ? `<span class="err">${esc(err)}</span>`
          : `Pays the pot to ${esc(short(w.addr, 14))}${w.npub ? ` (<span class="ok">✓ verified binding of ${esc(id.shortNpub(w.npub))}</span>)` : ''}, minus a network fee of at most ${satsText(params.maxFee)}. The wallet shows the exact amount.`;
  }
}

/** The winner field (address or npub) → { addr, npub? } | { error } | { pending } (npub lookups are cached for the visit). */
function winnerTarget(text) {
  if (!id.looksLikeNpub(text)) {
    const error = checkAddress(text, NET);
    return error ? { error } : { addr: normalizeAddress(text, NET) };
  }
  const r = id.resolveCached(text.trim(), () => $('w-addr')?.dispatchEvent(new Event('input')));
  if (r.pending) return { pending: true };
  return r.error ? { error: r.error } : { addr: r.best.addr, npub: r.hex };
}

function partyError(a) {
  const p = state.pot.params;
  return sameLock(a, pkhAddress(p.posterPkh, NET.prefix)) || sameLock(a, p2pkhAddress(hexToBin(p.judgePk), NET.prefix)) ? TEXT.winnerIsParty : '';
}

function winnerError(text) {
  const w = winnerTarget(text);
  if (w.pending) return 'Still looking up this npub. Try again in a moment.';
  return w.error || partyError(w.addr);
}

async function copy(text, id) {
  try { await navigator.clipboard.writeText(text); const b = $(id); if (b) { const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = t; }, 1500); } }
  catch { prompt('Copy this:', text); }
}

const topUp = action(async () => {
  const pot = state.pot;
  const amount = parseBch(ui.topup);
  if (amount === null || amount < MIN_TOPUP) throw new Error(`A top-up must be at least ${bch(MIN_TOPUP)}: smaller ones cost more in fees to pay out than they add.`);
  const coins = await walletCoins();
  const tx = buildPayment({ provider, coins, to: pot.address, amount, changeTo: state.addr,
    userPrompt: `Add ${bch(amount)} to the pot${named(pot.meta?.title)}. A gift: if nobody wins, it goes to the poster.` });
  const txid = await signAndSend(tx, 'top-up');
  setBusy('Waiting for the network…');
  await waitFor(async () => (await provider.getUtxos(pot.address)).some((u) => u.txid === txid));
  pot.topupTxid = txid;
  await Promise.all([loadPot(), refreshWallet()]);
  setMsg('ok', `Added ${bch(amount)} to the pot.`, ` ${txLink(txid)}`);
});

async function sweep(kind) {
  const pot = state.pot, p = pot.params;
  let to, locktime = 0, npubNote = '';
  if (kind === 'award') {
    if (state.judgeKey !== p.judgePk) throw new Error(TEXT.notJudge);
    if (id.looksLikeNpub(ui.winner)) { // look it up again now: a cached binding may have been replaced or revoked
      setBusy('Looking up the winner’s npub on Nostr…');
      const r = await id.resolveNow(ui.winner.trim());
      to = r.best.addr; npubNote = ` (${id.shortNpub(r.hex)})`;
      const err = partyError(to);
      if (err) throw new Error(err);
    } else {
      const err = winnerError(ui.winner);
      if (err) throw new Error(err);
      to = normalizeAddress(ui.winner, NET);
    }
  } else {
    if (state.pkh !== p.posterPkh) throw new Error(TEXT.notPoster);
    const tip = await provider.getBlockHeight();
    state.height = tip;
    if (tip < p.deadline) {
      throw new Error(`The refund opens at block ${p.deadline} (≈ ${dateText(timeForHeight(p.deadline, tip))}).`);
    }
    to = pkhAddress(p.posterPkh, NET.prefix);
    locktime = tip; // >= deadline, and final for the next block
  }
  const utxos = (await provider.getUtxos(pot.address)).filter((u) => !u.token);
  if (!utxos.length) throw new Error('This pot is empty.');
  const tx = buildSweep({
    provider, params: p, kind, utxos, to, locktime, signPath: ['receive', 0],
    userPrompt: (plan) => (kind === 'award'
      ? `Award the pot${named(pot.meta?.title)}: ${bch(plan.amount)} to ${to}${npubNote}`
      : `Refund the pot${named(pot.meta?.title)}: ${bch(plan.amount)} back to you`),
  });
  const txid = await signAndSend(tx, kind);
  pot[`${kind}Txid`] = txid;
  setBusy('Waiting for the network…');
  const spent = new Set(tx.plan.inputs.map((u) => `${u.txid}:${u.vout}`));
  await waitFor(async () => !(await provider.getUtxos(pot.address)).some((u) => spent.has(`${u.txid}:${u.vout}`)));
  await Promise.all([loadPot(), refreshWallet()]);
  setMsg('ok', `${kind === 'award' ? 'Awarded' : 'Refunded'} ${bch(tx.plan.amount)}.${tx.note ? ` ${tx.note}.` : ''}`, ` ${txLink(txid)}`);
}
const award = action(() => sweep('award'));
const refund = action(() => sweep('refund'));

// ---------- wallet panel
function renderWallet() {
  const el = $('wallet');
  if (state.connected) {
    el.innerHTML = `
      <div><b>${esc(state.walletName)}</b> <span class="muted">on ${NET.name}</span></div>
      <div class="mono small">${addrLink(state.addr, short(state.addr.split(':')[1], 12))}</div>
      <div>${state.balance === null ? '<span class="muted">balance …</span>' : `${bch(state.balance)}`}</div>
      <details><summary>Your judge key</summary>
        <div class="mono small" id="judgekey">${esc(state.judgeKey)}</div>
        <button id="copy-judge" class="link">Copy</button>
        <div class="muted">Give this to a poster who wants you as the judge of their pot.</div></details>
      <button id="disconnect" class="link">Disconnect</button>`;
    $('copy-judge').onclick = () => copy(state.judgeKey, 'copy-judge');
    $('disconnect').onclick = () => disconnect();
  } else if (state.uri) {
    el.innerHTML = `
      <div>Scan with a WizardConnect wallet${NET.name === 'chipnet' ? ' set to chipnet' : ''} (Cashonize, Paytaca, Selene):</div>
      <div class="qr" id="qr">${qrSvg(state.qrUri)}</div>
      <div class="row"><a class="btn small" href="${esc(state.uri)}">Open in wallet</a><button id="copy-uri" class="link">Copy link</button><button id="stop" class="link">Cancel</button></div>
      <div class="mono tiny" id="uri">${esc(state.uri)}</div>`;
    $('copy-uri').onclick = () => copy(state.uri, 'copy-uri');
    $('stop').onclick = () => disconnect();
  } else if (state.resumed) {
    el.innerHTML = `<div>Reconnecting to ${esc(state.walletName)}…</div><button id="connect" class="link">Connect again</button> <button id="forget" class="link">Forget</button>`;
    $('connect').onclick = () => connect();
    $('forget').onclick = () => disconnect();
  } else {
    el.innerHTML = '<button id="connect">Connect wallet</button>';
    $('connect').onclick = () => connect();
  }
}

// ---------- start
function banner() {
  const b = $('netbanner');
  if (NET.name === 'mainnet') {
    b.className = 'banner mainnet';
    b.innerHTML = `<b>MAINNET</b> · real BCH. Pots lock real money. <a href="${esc(otherNetUrl())}">Try it on chipnet</a> with free test coins.`;
  } else {
    b.className = 'banner chipnet';
    b.innerHTML = `<b>CHIPNET</b> · test coins with no value. <a href="${esc(otherNetUrl())}">Mainnet version</a>.`;
  }
  if (asked && asked !== 'chipnet' && asked !== 'mainnet') b.innerHTML += ` (Unknown network "${esc(asked)}": showing mainnet.)`;
  document.title = NET.name === 'mainnet' ? 'Pot · BCH bounties' : 'Pot · chipnet';
}

async function tick() {
  try { state.height = await provider.getBlockHeight(); } catch (e) { console.warn('[pot] tip read failed', e?.message); }
  if (state.view === 'create') $('f-deadline-hint') && $('f-date').dispatchEvent(new Event('input'));
  if (state.view === 'pot' && !state.busy && state.pot?.loaded) renderPotKeepingInputs();
}
function renderPotKeepingInputs() {
  const focus = document.activeElement?.id;
  renderPot();
  if (focus && $(focus)) $(focus).focus();
}

banner();
renderWallet();
window.addEventListener('hashchange', () => { setMsg(); render(); });
tryResume();
render();
tick();
setInterval(tick, 60000);
