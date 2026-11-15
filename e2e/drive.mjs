// End-to-end run of the page on chipnet, in headless Chrome, with e2e/wallet.mjs as the wallet:
//   build -> chipnet page -> connect (the QR is decoded and must equal the pairing URI) -> wallet joins
//   -> create pot A (deadline in 3 days) and pot B (deadline = the current block, so its refund is open)
//   -> a create the wallet rejects (the page must say nothing was sent) -> reload (the session resumes, no QR)
//   -> top up A -> award A to another address (sweeps both coins) -> refund B
//   -> the mainnet page refuses the same (testnet) wallet.
// `npm run e2e`. Writes e2e/out/result.json and screenshots. Starts and stops its own static server.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { decodeKeyExchangeURI } from '@wizardconnect/core';
import { childPub } from './wallet.mjs';
import { NETWORKS, FailoverProvider } from '../src/net.mjs';
import { p2pkhAddress } from '../src/pot.mjs';

const root = new URL('..', import.meta.url).pathname;
const out = new URL('./out/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const PORT = process.env.PORT || '8917';
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome-stable';
const say = (o) => console.log(JSON.stringify(o));
const result = { started: new Date().toISOString(), checks: {}, txs: {}, consoleProblems: [] };
const check = (name, ok, detail) => { result.checks[name] = ok ? 'ok' : `FAILED${detail ? `: ${detail}` : ''}`; say({ check: name, ok, ...(detail ? { detail } : {}) }); if (!ok) throw new Error(`check failed: ${name}${detail ? ` (${detail})` : ''}`); };

execFileSync('node', ['web/build.mjs'], { cwd: root, stdio: 'inherit' });
const server = spawn('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', 'web/dist'], { cwd: root, stdio: 'ignore' });
const wallets = [];
let browser = null;
const startWallet = (uri) => { const w = spawn('node', ['e2e/wallet.mjs', uri, '0'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] }); wallets.push(w); return w; };
const cleanup = async () => { for (const w of wallets) w.kill('SIGTERM'); await browser?.close().catch(() => {}); server.kill(); };
await new Promise((r) => setTimeout(r, 800));

const winner = p2pkhAddress(childPub(0, 5), 'bchtest'); // the wallet's receive/5: neither the poster's nor the judge's key
const chip = new FailoverProvider(NETWORKS.chipnet);

try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const watch = (page, tag) => {
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') result.consoleProblems.push(`${tag} ${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => result.consoleProblems.push(`${tag} PAGEERROR: ${e.message}`));
  };
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1100 } });
  const page = await ctx.newPage();
  watch(page, 'chipnet');
  const S = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__pot, (k, v) => (typeof v === 'bigint' ? String(v) : v))));
  const until = (fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 400 });
  const settled = () => until(() => !window.__pot.busy && window.__pot.view === 'pot' && window.__pot.pot?.loaded && !window.__pot.pot?.loading);

  // --- page loads on chipnet with the chipnet banner
  await page.goto(`${BASE}?net=chipnet`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await until(() => window.__pot?.height, null, 30000);
  check('chipnet banner', /CHIPNET/.test(await page.textContent('#netbanner')));

  // --- connect: the QR must decode to the pairing URI
  await page.click('#connect');
  await until(() => window.__pot.uri, null, 15000);
  let s = await S();
  const png = PNG.sync.read(await page.locator('#qr svg').screenshot());
  const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  check('QR decodes to the pairing URI', qr?.data === s.qrUri && JSON.stringify(decodeKeyExchangeURI(qr.data)) === JSON.stringify(decodeKeyExchangeURI(s.uri)));
  startWallet(s.uri);
  await until(() => (window.__pot.connected && window.__pot.balance !== null) || window.__pot.errors.length, null, 90000);
  s = await S();
  check('wallet connected', s.connected && !s.errors.length, s.errors[0]);
  say({ wallet: s.addr, balance: s.balance, height: s.height });
  check('wallet has chipnet coins', BigInt(s.balance) > 100000n, s.balance);

  // --- create pot A (deadline in 3 days, judge = me) and pot B (deadline = current block)
  const create = async (title, amount, height) => {
    await page.goto(`${BASE}?net=chipnet#/new`);
    await until(() => window.__pot.view === 'create' && window.__pot.connected, null, 60000);
    await page.fill('#f-title', title);
    await page.fill('#f-url', 'https://github.com/apeirs/pot');
    await page.fill('#f-amount', amount);
    if (height) { await page.click('#f-height-box summary'); await page.fill('#f-height', String(height)); }
    const n = (await S()).txs.length;
    await page.click('#create');
    await until((k) => window.__pot.errors.length || (window.__pot.txs.length > k && window.__pot.view === 'pot' && window.__pot.pot?.loaded && !window.__pot.busy), n);
    s = await S();
    if (s.errors.length) throw new Error(s.errors[0]);
    return { link: s.pot.link, address: s.pot.address, fundTxid: s.txs.at(-1).txid, sats: s.pot.sats, title: s.pot.meta?.title };
  };
  const stamp = new Date().toISOString().slice(0, 16);
  const A = await create(`e2e pot A ${stamp}`, '0.0002');
  check('pot A funded with its title on chain', A.sats === '20000' && A.title === `e2e pot A ${stamp}`, JSON.stringify(A));
  result.txs.createA = A.fundTxid;
  const tip = (await S()).height;
  const B = await create(`e2e pot B ${stamp}`, '0.0001', tip);
  check('pot B funded', B.sats === '10000', JSON.stringify(B));
  result.txs.createB = B.fundTxid;
  s = await S();
  check('pot B refund is open', /Deadline passed/.test(await page.textContent('#pot-deadline')) && !(await page.isDisabled('#refund-send')));

  // --- the wallet says no: the page says nothing was sent, and no tx is recorded
  await page.goto(`${BASE}?net=chipnet#/new`);
  await until(() => window.__pot.view === 'create');
  await page.fill('#f-title', 'e2e REJECTME');
  await page.fill('#f-amount', '0.0001');
  const before = (await S()).txs.length;
  await page.click('#create');
  await until(() => window.__pot.errors.length && !window.__pot.busy);
  s = await S();
  check('rejected signature shows "Nothing was sent"', /didn't sign\. Nothing was sent/.test(s.errors.at(-1)) && s.txs.length === before, s.errors.at(-1));
  await page.evaluate(() => { window.__pot.errors.length = 0; });

  // --- reload on pot A: the session resumes without a QR
  await page.goto(`${BASE}?net=chipnet#/p/${A.link}`);
  await page.reload();
  await until(() => window.__pot.connected || window.__pot.errors.length, null, 60000);
  s = await S();
  check('session resumed after reload, no QR', s.resumed && s.connected && (await page.locator('#qr').count()) === 0, JSON.stringify({ resumed: s.resumed, connected: s.connected }));
  await settled();

  // --- top up A
  await page.fill('#t-amount', '0.00003');
  await page.click('#topup-send');
  await until(() => window.__pot.errors.length || (window.__pot.pot.topupTxid && !window.__pot.busy && window.__pot.pot.utxos?.length >= 2));
  s = await S();
  check('top-up landed (pot A has 2 coins, 23,000 sats)', !s.errors.length && s.pot.sats === '23000' && s.pot.utxos.length === 2, s.errors[0] ?? s.pot.sats);
  result.txs.topupA = s.pot.topupTxid;

  // --- award A: a winner that is the poster is refused in the form; then pay the receive/5 address
  await page.fill('#w-addr', s.addr);
  check('poster as winner is refused', /can't be the poster or the judge/.test(await page.textContent('#w-hint')));
  await page.fill('#w-addr', winner);
  await page.click('#award-send');
  await until(() => window.__pot.errors.length || (window.__pot.pot.awardTxid && !window.__pot.busy && window.__pot.pot.loaded && !window.__pot.pot.loading));
  s = await S();
  check('award swept both coins to the winner', !s.errors.length && s.pot.sats === '0', s.errors[0] ?? s.pot.sats);
  result.txs.awardA = s.pot.awardTxid;
  const paid = (await chip.getUtxos(winner)).find((u) => u.txid === s.pot.awardTxid);
  check('winner holds the award output', !!paid && paid.satoshis > 22000n, String(paid?.satoshis));
  result.awardPaid = String(paid.satoshis);
  check('history shows fund, top-up and award', ['fund', 'topup', 'award'].every((k) => s.pot.history.some((h) => h.kind === k)), s.pot.history.map((h) => h.kind).join(','));
  await page.screenshot({ path: `${out}pot-awarded.png`, fullPage: true });

  // --- refund B
  await page.goto(`${BASE}?net=chipnet#/p/${B.link}`);
  await settled();
  await page.click('#refund-send');
  await until(() => window.__pot.errors.length || (window.__pot.pot.refundTxid && !window.__pot.busy && window.__pot.pot.loaded && !window.__pot.pot.loading));
  s = await S();
  check('refund returned pot B to the poster', !s.errors.length && s.pot.sats === '0', s.errors[0] ?? s.pot.sats);
  result.txs.refundB = s.pot.refundTxid;
  await page.screenshot({ path: `${out}pot-refunded.png`, fullPage: true });

  // --- the mainnet page refuses this testnet wallet (nothing is signed or sent)
  const ctx2 = await browser.newContext({ viewport: { width: 820, height: 1100 } });
  const main = await ctx2.newPage();
  watch(main, 'mainnet');
  await main.goto(BASE);
  check('mainnet banner', /MAINNET/.test(await main.textContent('#netbanner')));
  await main.click('#connect');
  await main.waitForFunction(() => window.__pot.uri, null, { timeout: 15000 });
  startWallet(await main.evaluate(() => window.__pot.uri));
  await main.waitForFunction(() => window.__pot.refused || window.__pot.connected, null, { timeout: 90000, polling: 400 });
  const m = await main.evaluate(() => ({ refused: window.__pot.refused, connected: window.__pot.connected, msg: document.getElementById('msg').textContent }));
  check('mainnet page refuses a testnet wallet', !!m.refused && !m.connected && /test network/.test(m.msg), JSON.stringify(m));
  await main.screenshot({ path: `${out}mainnet-refuses-testnet-wallet.png` });

  // A reload or disconnect can close a relay socket that is still opening or already closing; the browser logs that.
  const teardown = /WebSocket is already in CLOSING or CLOSED state|WebSocket is closed before the connection is established/;
  const errors = result.consoleProblems.filter((l) => / (error|PAGEERROR): /.test(l) && !teardown.test(l));
  result.consoleWarnings = result.consoleProblems.filter((l) => !errors.includes(l));
  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  result.ok = true;
} catch (e) {
  result.ok = false;
  result.error = String(e?.message ?? e).slice(0, 600);
  say({ FAILED: result.error });
  process.exitCode = 1;
} finally {
  result.finished = new Date().toISOString();
  writeFileSync(`${out}result.json`, JSON.stringify(result, null, 2));
  say({ result: result.ok ? 'GREEN' : 'RED', txs: result.txs });
  await cleanup();
}
