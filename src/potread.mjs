// potread.mjs: read a Pot from the chain for the bounty view: UTXOs, balance, classified
// history and the title/link the funding tx carries. Browser-safe: no node APIs (the WebSocket comes from
// @electrum-cash/network's isomorphic-ws, which uses the native one in a browser).
//
// No new dependency: @electrum-cash/network is the client cashscript's ElectrumNetworkProvider already uses,
// @bitauth/libauth is already in the app bundle.
//
// Funding meta format (POT1), one OP_RETURN output in the funding tx:
//   OP_RETURN <"POT1"> <title, UTF-8, <= 60 characters> <url, UTF-8>
// Whole output script <= 223 bytes (BCH standardness). Only the FIRST pay-in tx's POT1 output counts:
// anyone can top up and attach their own OP_RETURN, so later ones are ignored. Pass `posterPkh` to
// readPot to also learn whether the funding tx was signed by the poster (meta.byPoster).
import { ElectrumClient } from '@electrum-cash/network';
import {
  binToHex, hexToBin, utf8ToBin, binToUtf8, sha256, hash160, hash256, decodeTransaction, encodeDataPush,
  decodeAuthenticationInstructions, cashAddressToLockingBytecode, lockingBytecodeToCashAddress, vmNumberToBigInt,
} from '@bitauth/libauth';

import { NETWORKS, SERVER_ERROR } from './net.mjs';

export { SERVER_ERROR }; // UX.md, Empty and loading states
export const CHIPNET_SERVERS = NETWORKS.chipnet.servers;
export const MAINNET_SERVERS = NETWORKS.mainnet.servers;

// Pot.json ABI order: index 0 = award(judgeSig), index 1 = refund(posterPk, posterSig).
// CashScript pushes this index as the last argument before the redeem script when a contract has > 1 function.
export const POT_FUNCTIONS = ['award', 'refund'];

const PROTOCOL = '1.5.0'; // same as cashscript 0.14 (include_tokens on listunspent)
const MAGIC = utf8ToBin('POT1');
const OP_RETURN = 0x6a;
const MAX_TITLE_CHARS = 60;
const MAX_OP_RETURN = 223;
const HEAD = 5; // first txs always fetched (the fund and its POT1 meta)

// ---------- POT1 meta
export function encodePotMeta(title, url) {
  title = String(title ?? '').trim(); url = String(url ?? '').trim();
  if ([...title].length > MAX_TITLE_CHARS) throw new Error(`Title is longer than ${MAX_TITLE_CHARS} characters`);
  const script = Uint8Array.from([OP_RETURN, ...encodeDataPush(MAGIC), ...encodeDataPush(utf8ToBin(title)),
    ...encodeDataPush(utf8ToBin(url))]);
  if (script.length > MAX_OP_RETURN) throw new Error(`Title + link take ${script.length} bytes; the limit is ${MAX_OP_RETURN}. Shorten the link.`);
  return script; // use as { to: script, amount: 0n } in a cashscript TransactionBuilder (not addOpReturnOutput:
  // it reads any chunk starting with "0x" as hex, which would mangle a title like "0x… bug")
}

export function parsePotMeta(lockingBytecode) {
  if (!lockingBytecode?.length || lockingBytecode[0] !== OP_RETURN) return null;
  const ins = decodeAuthenticationInstructions(lockingBytecode.slice(1));
  if (ins.length < 3 || ins.some((i) => 'malformed' in i || i.data === undefined)) return null;
  if (binToHex(ins[0].data) !== binToHex(MAGIC)) return null;
  try {
    return { title: binToUtf8(ins[1].data).slice(0, 200), url: binToUtf8(ins[2].data).slice(0, 500) };
  } catch { return null; }
}

// ---------- helpers
export const electrumScriptHash = (lockingBytecode) => binToHex(sha256.hash(lockingBytecode).slice().reverse());

const txidOf = (raw) => binToHex(hash256(raw).slice().reverse());

function parseServer(s) {
  const m = /^(wss?:\/\/)?([^:/]+)(?::(\d+))?\/?$/.exec(String(s).trim());
  if (!m) throw new Error(`Bad server: ${s}`);
  return { url: `${m[1] ?? 'wss://'}${m[2]}:${m[3] ?? 50004}`, host: m[2], port: Number(m[3] ?? 50004), encrypted: m[1] !== 'ws://' };
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: timeout after ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(t));
}

async function rpc(client, ms, method, ...params) {
  const r = await withTimeout(client.request(method, ...params), ms, method);
  if (r instanceof Error) throw r; // the client resolves (not rejects) with an Error on an RPC error
  return r;
}

// index of the CashScript function in a p2sh unlock: <args…> <selector> <redeemScript>
function functionOf(unlockingBytecode, functions) {
  const ins = decodeAuthenticationInstructions(unlockingBytecode);
  if (ins.length < 2 || ins.some((i) => 'malformed' in i)) return null;
  if (functions.length === 1) return functions[0];
  const sel = ins[ins.length - 2];
  let n = null;
  if (sel.opcode === 0x00) n = 0;
  else if (sel.opcode >= 0x51 && sel.opcode <= 0x60) n = sel.opcode - 0x50;
  else if (sel.data?.length) { const v = vmNumberToBigInt(sel.data); if (typeof v === 'bigint') n = Number(v); }
  return n !== null && n < functions.length ? functions[n] : null;
}

// does this input's redeem script hash to the contract's p2sh payload? (fallback to the outpoint check)
function redeemMatches(unlockingBytecode, contract) {
  if (contract.type !== 'p2sh32' && contract.type !== 'p2sh20') return false;
  const ins = decodeAuthenticationInstructions(unlockingBytecode);
  const last = ins[ins.length - 1];
  if (!last?.data) return false;
  const h = contract.type === 'p2sh32' ? hash256(last.data) : hash160(last.data);
  return binToHex(h) === binToHex(contract.payload);
}

// pubkey of a P2PKH unlock (<sig> <pubkey>), or null
function p2pkhPubkey(unlockingBytecode) {
  const ins = decodeAuthenticationInstructions(unlockingBytecode);
  const pk = ins.length === 2 ? ins[1].data : null;
  return pk && (pk.length === 33 || pk.length === 65) ? pk : null;
}

// Same-block txs come in txid order (CTOR), and a fund and a top-up of the same block need not spend each
// other directly (fund -> other tx -> top-up). Walk up to 4 generations of parents (<= 24 extra tx fetches)
// of each tx that shares its height with another, and record which history txs are its ancestors.
async function linkSameBlock(client, left, txs) {
  const byHeight = new Map();
  for (const t of txs) byHeight.set(t.height > 0 ? t.height : 0, [...(byHeight.get(t.height > 0 ? t.height : 0) ?? []), t]);
  const known = new Map(txs.map((t) => [t.txid, t.tx]));
  let budget = 24;
  const parents = (tx) => [...new Set(tx.inputs.map((i) => binToHex(i.outpointTransactionHash)))];
  for (const group of byHeight.values()) {
    if (group.length < 2) continue;
    const ids = new Set(group.map((t) => t.txid));
    for (const t of group) {
      t.ancestors = new Set();
      let frontier = parents(t.tx);
      for (let depth = 0; depth < 4 && frontier.length; depth++) {
        const next = [];
        const missing = frontier.filter((id) => !known.has(id)).slice(0, Math.max(0, budget));
        budget -= missing.length;
        const raws = await withTimeout(Promise.all(missing.map((id) => client.request('blockchain.transaction.get', id, false))), left(), 'ancestry');
        missing.forEach((id, k) => { if (!(raws[k] instanceof Error)) { const tx = decodeTransaction(hexToBin(raws[k])); if (typeof tx !== 'string') known.set(id, tx); } });
        for (const id of frontier) {
          if (ids.has(id)) t.ancestors.add(id);
          if (known.has(id)) next.push(...parents(known.get(id)));
        }
        frontier = [...new Set(next)];
      }
    }
  }
}

// ---------- one server
async function readFrom(server, contract, opts) {
  const { host, port, encrypted } = parseServer(server);
  const ms = opts.timeoutMs, deadline = Date.now() + ms;
  const left = () => Math.max(1, deadline - Date.now()); // one budget per server, not per request
  const client = new ElectrumClient('Pot', PROTOCOL, host, { port, encrypted, timeoutInMilliSeconds: ms });
  try {
    await withTimeout(client.connect(), left(), `connect ${host}`);
    let [hist, unspent] = await Promise.all([
      rpc(client, left(), 'blockchain.scripthash.get_history', contract.scripthash),
      rpc(client, left(), 'blockchain.scripthash.listunspent', contract.scripthash, 'include_tokens'),
    ]);
    // Cap the tx fetches: anyone can spam a pot with dust top-ups, and fetching thousands of txs times out on every
    // server (seen on mainnet 11-06: busy P2SH addresses failed all 4 servers). Keep the first HEAD (fund + its meta)
    // and the newest; the page says "showing N of M". get_history is cheap, so the total is always exact.
    const total = hist.length, cap = Math.max(opts.maxTxs, HEAD + 1);
    if (hist.length > cap) hist = [...hist.slice(0, HEAD), ...hist.slice(hist.length - (cap - HEAD))];
    const raws = await withTimeout(Promise.all(hist.map((h) => client.request('blockchain.transaction.get', h.tx_hash, false))), left(),
      'blockchain.transaction.get');
    const txs = hist.map((h, i) => {
      if (raws[i] instanceof Error) throw raws[i];
      const raw = hexToBin(raws[i]);
      if (txidOf(raw) !== h.tx_hash) throw new Error(`${host} sent a tx that does not hash to ${h.tx_hash}`);
      const tx = decodeTransaction(raw);
      if (typeof tx === 'string') throw new Error(`decode ${h.tx_hash}: ${tx}`);
      return { txid: h.tx_hash, height: h.height, tx };
    });
    try { await linkSameBlock(client, left, txs); } catch { /* order falls back to the tie-break; never fatal */ }
    return { hist: txs, unspent, total };
  } finally {
    client.disconnect(true).catch(() => {}); // also stops the client's automatic reconnect timer
  }
}

function classify(txs, contract, opts) {
  const lockHex = binToHex(contract.lockingBytecode);
  txs = chronological(txs);
  const contractOuts = new Set();
  for (const { txid, tx } of txs) tx.outputs.forEach((o, n) => { if (binToHex(o.lockingBytecode) === lockHex) contractOuts.add(`${txid}:${n}`); });

  // meta: with posterPkh, the earliest POT1 in a pay-in signed by the poster (a stranger's top-up can carry a
  // POT1 too, even in the same block as the fund); without it, or if none is the poster's, the earliest POT1.
  const want = opts.posterPkh ? (typeof opts.posterPkh === 'string' ? opts.posterPkh : binToHex(opts.posterPkh)) : null;
  const metas = [];
  let funded = false;
  const history = txs.map(({ txid, height, tx }) => {
    const spends = tx.inputs.filter((inp) => contractOuts.has(`${binToHex(inp.outpointTransactionHash)}:${inp.outpointIndex}`)
      || redeemMatches(inp.unlockingBytecode, contract));
    const toContract = tx.outputs.filter((o) => binToHex(o.lockingBytecode) === lockHex);
    const sum = (os) => os.reduce((s, o) => s + o.valueSatoshis, 0n);
    if (spends.length) {
      const fns = new Set(spends.map((inp) => functionOf(inp.unlockingBytecode, opts.functions)));
      const kind = fns.size === 1 && (fns.has('award') || fns.has('refund')) ? [...fns][0] : 'other';
      const paid = tx.outputs.filter((o) => binToHex(o.lockingBytecode) !== lockHex && o.lockingBytecode[0] !== OP_RETURN);
      const to = paid.length === 1 ? addressOf(paid[0].lockingBytecode, contract.prefix) : undefined;
      return { txid, height, kind, sats: sum(paid), ...(to ? { to } : {}), inputs: spends.length };
    }
    if (toContract.length) {
      const kind = funded ? 'topup' : 'fund';
      funded = true;
      const op = tx.outputs.map((o) => parsePotMeta(o.lockingBytecode)).find(Boolean);
      if (op) metas.push({ ...op, txid, byPoster: want ? tx.inputs.some((inp) => { const pk = p2pkhPubkey(inp.unlockingBytecode); return pk && binToHex(hash160(pk)) === want; }) : undefined });
      return { txid, height, kind, sats: sum(toContract) };
    }
    return { txid, height, kind: 'other', sats: 0n };
  });
  let meta = (want && metas.find((m) => m.byPoster)) || metas[0] || null;
  if (meta && !want) { const { byPoster, ...m } = meta; meta = m; }
  return { history, meta };
}

// Order: by height, unconfirmed (height <= 0) last. Within one block BCH orders txs by txid (CTOR), not by
// time, and Electrum returns that order, so a top-up and an award mined with their fund came back as
// topup, award, fund. Fix: topological order on spends (a tx after every tx whose output it spends);
// among txs with no dependency on each other, one carrying a POT1 output first, then the server's order.
function chronological(txs) {
  const order = (h) => (h > 0 ? h : Number.MAX_SAFE_INTEGER);
  const ids = new Set(txs.map((t) => t.txid));
  const deps = new Map(txs.map((t) => [t.txid, new Set([...t.tx.inputs.map((i) => binToHex(i.outpointTransactionHash)), ...(t.ancestors ?? [])]
    .filter((d) => ids.has(d) && d !== t.txid))]));
  const hasMeta = (t) => t.tx.outputs.some((o) => parsePotMeta(o.lockingBytecode));
  const rank = (a, b) => order(a.height) - order(b.height) || hasMeta(b) - hasMeta(a) || a.i - b.i;
  let left = txs.map((t, i) => ({ ...t, i }));
  const out = [], done = new Set();
  while (left.length) {
    const ready = left.filter((t) => [...deps.get(t.txid)].every((d) => done.has(d)));
    const next = (ready.length ? ready : left).sort(rank)[0]; // no ready tx = a cycle (impossible on chain): fall back
    out.push(next); done.add(next.txid);
    left = left.filter((t) => t !== next);
  }
  return out;
}

function addressOf(lockingBytecode, prefix) {
  const r = lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix });
  return typeof r === 'string' ? `script:${binToHex(lockingBytecode)}` : r.address;
}

// ---------- public API
/**
 * Read a pot. Tries each server in order (timeoutMs each) and returns the first full answer.
 * @param {string} contractAddress  cashaddr of the pot (bchtest:… or bitcoincash:…)
 * @param {{servers?: string[], timeoutMs?: number, maxTxs?: number, functions?: string[], posterPkh?: string|Uint8Array,
 *          onAttempt?: (server: string, error?: Error) => void}} [opts]
 * @returns {Promise<{utxos, balanceSats: bigint, history, historyTotal: number, meta: {title,url,txid,byPoster?}|null, server: string, failed: {server,error}[]}>}
 */
export async function readPot(contractAddress, opts = {}) {
  const decoded = cashAddressToLockingBytecode(contractAddress);
  if (typeof decoded === 'string') throw new Error(`Not a BCH address: ${contractAddress}`);
  const prefix = decoded.prefix;
  const { payload, type } = lockingInfo(decoded.bytecode);
  const contract = { lockingBytecode: decoded.bytecode, scripthash: electrumScriptHash(decoded.bytecode), prefix, payload, type };
  const o = {
    servers: opts.servers ?? (prefix === 'bitcoincash' ? MAINNET_SERVERS : CHIPNET_SERVERS),
    timeoutMs: opts.timeoutMs ?? 8000, maxTxs: opts.maxTxs ?? 60, functions: opts.functions ?? POT_FUNCTIONS, posterPkh: opts.posterPkh,
  };
  const failed = [];
  for (const server of o.servers) {
    try {
      const { hist, unspent, total } = await readFrom(server, contract, o);
      const { history, meta } = classify(hist, contract, o);
      const utxos = unspent.map((u) => ({
        txid: u.tx_hash, vout: u.tx_pos, satoshis: BigInt(u.value), height: u.height, lockingBytecode: binToHex(contract.lockingBytecode),
        token: u.token_data ? { ...u.token_data, amount: BigInt(u.token_data.amount ?? 0) } : undefined,
      }));
      opts.onAttempt?.(server);
      return { utxos, balanceSats: utxos.reduce((s, u) => s + u.satoshis, 0n), history, historyTotal: total, meta, server: parseServer(server).url, failed };
    } catch (error) {
      failed.push({ server, error: String(error?.message ?? error) });
      opts.onAttempt?.(server, error);
    }
  }
  const err = new Error(SERVER_ERROR);
  err.failed = failed;
  throw err;
}

function lockingInfo(bytecode) {
  // P2SH32: OP_HASH256 <32> OP_EQUAL; P2SH20: OP_HASH160 <20> OP_EQUAL
  if (bytecode.length === 35 && bytecode[0] === 0xaa && bytecode[1] === 0x20 && bytecode[34] === 0x87) return { type: 'p2sh32', payload: bytecode.slice(2, 34) };
  if (bytecode.length === 23 && bytecode[0] === 0xa9 && bytecode[1] === 0x14 && bytecode[22] === 0x87) return { type: 'p2sh20', payload: bytecode.slice(2, 22) };
  return { type: 'other', payload: new Uint8Array() };
}
