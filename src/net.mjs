// Networks and a failover Electrum provider. Browser-safe (no node: imports).
//
// Server choice (checked 2026-11-13, one request each):
// - mainnet: fulcrum.greyh.at first, bch.imaginary.cash as the fallback.
// - chipnet: chipnet.imaginary.cash only. cashscript's default chipnet host (chipnet.bch.ninja) followed a minority
//   fork from 2026-11-12, so it is never used here.
import { ElectrumNetworkProvider } from 'cashscript';
import { decodeCashAddress } from '@bitauth/libauth';

export const NETWORKS = {
  mainnet: {
    name: 'mainnet',
    cashscript: 'mainnet',
    prefix: 'bitcoincash',
    servers: ['wss://fulcrum.greyh.at:50004', 'wss://bch.imaginary.cash:50004'],
    txUrl: (txid) => `https://blockchair.com/bitcoin-cash/transaction/${txid}`,
    addressUrl: (addr) => `https://blockchair.com/bitcoin-cash/address/${addr.replace(/^bitcoincash:/, '')}`,
  },
  chipnet: {
    name: 'chipnet',
    cashscript: 'chipnet',
    prefix: 'bchtest',
    servers: ['wss://chipnet.imaginary.cash:50004'],
    txUrl: (txid) => `https://chipnet.imaginary.cash/tx/${txid}`,
    addressUrl: (addr) => `https://chipnet.imaginary.cash/address/${addr}`,
  },
};

export const SERVER_ERROR = "Couldn't reach a BCH server. Retry";

export const hostOf = (server) => {
  const m = /^(?:wss?:\/\/)?([^:/]+)(?::(\d+))?\/?$/.exec(String(server).trim());
  if (!m) throw new Error(`Bad server: ${server}`);
  return m[1];
};

/** Which network an address belongs to ('mainnet' | 'chipnet'), or null if it is not a valid cashaddr. */
export function networkOfAddress(address) {
  const d = decodeCashAddress(String(address ?? '').trim());
  if (typeof d === 'string') return null;
  return Object.values(NETWORKS).find((n) => n.prefix === d.prefix)?.name ?? null;
}

/**
 * Checks a payout address for this network. Returns '' when it is fine, else a sentence for the user.
 * Wallets often show addresses without the prefix; those are read with this network's prefix.
 */
export function checkAddress(address, net) {
  let a = String(address ?? '').trim();
  if (!a) return 'Enter a BCH address.';
  if (!a.includes(':')) a = `${net.prefix}:${a}`;
  const d = decodeCashAddress(a);
  if (typeof d === 'string') return 'That is not a valid BCH address.';
  if (d.prefix !== net.prefix) {
    const other = Object.values(NETWORKS).find((n) => n.prefix === d.prefix);
    return other ? `That is a ${other.name} address; this page is on ${net.name}.` : 'That is not a BCH address.';
  }
  if (d.type !== 'p2pkh' && d.type !== 'p2pkhWithTokens') return 'Pay out to a normal wallet address (it starts with q).';
  return '';
}

export const normalizeAddress = (address, net) => {
  const a = String(address ?? '').trim();
  return a.includes(':') ? a : `${net.prefix}:${a}`;
};

const CONNECTION_ERROR = /timeout|timed out|connect|connection|closed|socket|ECONN|ENOTFOUND|network|lost|unreachable/i;
// A node's answer, never a connection problem: Fulcrum words every rejection "...rejected by network rules ... (code N)",
// which the word "network" above would otherwise send round every server and turn into SERVER_ERROR.
const NODE_ANSWER = /rejected by network rules|\(code -?\d+\)|bad-txns|non-final|mandatory-script|missing ?inputs|txn-/i;
const isConnectionError = (e) => { const m = String(e?.message ?? e); return CONNECTION_ERROR.test(m) && !NODE_ANSWER.test(m); };

/**
 * A cashscript NetworkProvider that tries the network's servers in order. A connection problem moves it to the next
 * server and retries once there; an answer from a node (such as a rejected transaction) is passed through as is.
 */
export class FailoverProvider {
  constructor(net, { timeoutMs = 10000 } = {}) {
    this.net = net;
    this.network = net.cashscript;
    this.timeoutMs = timeoutMs;
    this.index = 0;
    this.providers = net.servers.map((s) => new ElectrumNetworkProvider(net.cashscript, { hostname: hostOf(s) }));
  }

  get server() { return this.net.servers[this.index]; }

  async call(method, ...args) {
    let lastError;
    for (let tries = 0; tries < this.providers.length; tries++) {
      const p = this.providers[this.index];
      let timer;
      try {
        return await Promise.race([
          p[method](...args),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method}: timeout`)), this.timeoutMs); }),
        ]);
      } catch (e) {
        lastError = e;
        if (!isConnectionError(e)) throw e;
        this.index = (this.index + 1) % this.providers.length;
      } finally {
        clearTimeout(timer);
      }
    }
    const err = new Error(SERVER_ERROR);
    err.cause = lastError;
    throw err;
  }

  getUtxos(address) { return this.call('getUtxos', address); }
  getBlockHeight() { return this.call('getBlockHeight'); }
  getRawTransaction(txid) { return this.call('getRawTransaction', txid); }
  sendRawTransaction(hex) { return this.call('sendRawTransaction', hex); }
}
