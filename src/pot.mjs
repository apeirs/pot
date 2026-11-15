// Pot app logic shared by the page and the tests: pot parameters and links, deadline <-> date, and the four
// transactions (create, top-up, award, refund) built for a WizardConnect wallet to sign. Browser-safe, no network
// calls of its own except through the provider passed in.
import {
  Contract, TransactionBuilder, placeholderP2PKHUnlocker, placeholderSignature, placeholderPublicKey,
} from 'cashscript';
import { sourceOutputToRelay } from '@wizardconnect/core/hdwalletv1-serialize';
import { binToHex, hexToBin, hash160, encodeCashAddress, encodeTransaction, sha256, utf8ToBin } from '@bitauth/libauth';
import artifact from '../contracts/Pot.json' with { type: 'json' };
import { planSweep, leftNote, DUST } from './sweep.mjs';

export { artifact, leftNote, DUST };
export const MAX_FEE = 5000n; // per award/refund: up to ~15 pot coins in one award at 1 sat/byte
export const MIN_TOPUP = 2000n; // each extra coin costs ~330 sats to sweep later; smaller top-ups mostly feed miners
export const MIN_POT = 10000n;
export const FEE_RATE = 1; // sat/byte
export const BLOCK_SECONDS = 600;
const P2PKH_UNLOCK_BYTES = 100; // <65-byte Schnorr sig> <33-byte pubkey>, with their push opcodes

const isHex = (s, bytes) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(s);

export function newSalt() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return binToHex(b);
}

/** Pot parameters: { posterPkh: hex20, judgePk: hex33, deadline: block height, maxFee: sats, salt: hex8 }. */
export function checkParams(p) {
  if (!isHex(p.posterPkh, 20)) throw new Error('Bad pot link: poster');
  if (!isHex(p.judgePk, 33) || !/^0[23]/.test(p.judgePk)) throw new Error('Bad pot link: judge key');
  if (!(Number.isInteger(p.deadline) && p.deadline > 0 && p.deadline < 500000000)) throw new Error('Bad pot link: deadline');
  if (!(Number.isInteger(p.maxFee) && p.maxFee > 0 && p.maxFee <= 100000)) throw new Error('Bad pot link: fee cap');
  if (!isHex(p.salt, 8)) throw new Error('Bad pot link: salt');
  return p;
}

/** The pot's terms as one URL-safe string; the page rebuilds the contract (and its address) from it. */
export const encodePotLink = (p) => ['1', p.posterPkh, p.judgePk, p.deadline, p.maxFee, p.salt].join('.');

export function decodePotLink(s) {
  const f = String(s ?? '').trim().toLowerCase().split('.');
  if (f.length !== 6 || f[0] !== '1') throw new Error('This is not a Pot link.');
  return checkParams({ posterPkh: f[1], judgePk: f[2], deadline: Number(f[3]), maxFee: Number(f[4]), salt: f[5] });
}

export const potContract = (p, provider) => new Contract(artifact,
  [hexToBin(p.posterPkh), hexToBin(p.judgePk), BigInt(p.deadline), BigInt(p.maxFee), hexToBin(p.salt)],
  { provider, addressType: 'p2sh32' });

export const p2pkhAddress = (pub, prefix) => encodeCashAddress({ prefix, type: 'p2pkh', payload: hash160(pub) }).address;
export const pkhAddress = (pkhHex, prefix) => encodeCashAddress({ prefix, type: 'p2pkh', payload: hexToBin(pkhHex) }).address;

// ---------- deadline: a block height, shown as a date. Blocks come every ~10 minutes, so the date is approximate.
/** First block height at or after the given time (rounded up, so the refund never opens early). */
export const heightForTime = (targetMs, tip, nowMs = Date.now()) =>
  tip + Math.max(1, Math.ceil((targetMs - nowMs) / (BLOCK_SECONDS * 1000)));
export const timeForHeight = (height, tip, nowMs = Date.now()) => nowMs + (height - tip) * BLOCK_SECONDS * 1000;

// ---------- WizardConnect request
/** cashscript's WC object -> the hdwalletv1 sign request (hex strings, contract info for contract inputs). */
export function wcRequest(wcObj, inputPaths) {
  return {
    transaction: {
      transaction: binToHex(encodeTransaction(wcObj.transaction)),
      sourceOutputs: wcObj.sourceOutputs.map((so) => ({
        ...sourceOutputToRelay({
          outpointTransactionHash: so.outpointTransactionHash, outpointIndex: so.outpointIndex,
          unlockingBytecode: so.unlockingBytecode ?? new Uint8Array(), sequenceNumber: so.sequenceNumber,
          valueSatoshis: so.valueSatoshis, lockingBytecode: so.lockingBytecode,
        }),
        ...(so.contract ? {
          contract: {
            abiFunction: so.contract.abiFunction,
            redeemScript: `<Uint8Array: 0x${binToHex(so.contract.redeemScript)}>`,
            artifact: { contractName: so.contract.artifact.contractName },
          },
        } : {}),
      })),
      broadcast: false,
      userPrompt: wcObj.userPrompt,
    },
    inputPaths,
  };
}

// ---------- create and top-up: plain payments from the wallet (P2PKH inputs)
/**
 * Picks wallet coins (largest first) and builds a payment of `amount` to `to`, with optional extra outputs
 * (the POT1 OP_RETURN), change back to `changeTo`, and a fee from the real signed size at 1 sat/byte.
 * @param coins [{ utxo, address, path: [name, index] }] the wallet's coins, without tokens
 * @returns { wcObj, inputPaths, fee, change }
 */
export function buildPayment({ provider, coins, to, amount, extraOutputs = [], changeTo, userPrompt }) {
  amount = BigInt(amount);
  const sorted = [...coins].filter((c) => !c.utxo.token).sort((a, b) => (b.utxo.satoshis > a.utxo.satoshis ? 1 : -1));
  const build = (ins, change) => {
    let tb = new TransactionBuilder({ provider });
    for (const c of ins) tb = tb.addInput(c.utxo, placeholderP2PKHUnlocker(c.address));
    tb = tb.addOutput({ to, amount });
    for (const o of extraOutputs) tb = tb.addOutput(o);
    if (change > 0n) tb = tb.addOutput({ to: changeTo, amount: change });
    return tb;
  };
  const feeFor = (ins, withChange) => {
    const bytes = encodeTransaction(build(ins, withChange ? DUST : 0n).buildLibauthTransaction(true)).length
      + ins.length * P2PKH_UNLOCK_BYTES;
    return BigInt(Math.ceil(bytes * FEE_RATE));
  };
  if (!sorted.length) throw new Error('This wallet has no spendable coins on this network.');
  const ins = [];
  let total = 0n;
  for (const c of sorted) {
    ins.push(c); total += c.utxo.satoshis;
    const fee = feeFor(ins, true);
    if (total >= amount + fee + DUST) {
      const change = total - amount - fee;
      return finish(build(ins, change), ins, fee, change);
    }
    const feeNoChange = feeFor(ins, false);
    if (total >= amount + feeNoChange) return finish(build(ins, 0n), ins, total - amount, 0n); // leftover < dust goes to fee
  }
  throw new Error(`Not enough coins in this wallet: it holds ${total} sats, this needs about ${amount + feeFor(sorted, true)} sats.`);

  function finish(tb, used, fee, change) {
    const wcObj = tb.generateWcTransactionObject({ broadcast: false, userPrompt });
    const inputPaths = used.map((c, i) => [i, c.path[0], c.path[1]]);
    return { wcObj, inputPaths, fee, change };
  }
}

// ---------- award and refund: spend the pot (contract inputs), one output, inputs chosen by planSweep
function sweepTx(C, provider, kind, inputs, to, amount, locktime) {
  let tb = new TransactionBuilder({ provider });
  for (const x of inputs) {
    tb = tb.addInput(x, kind === 'award'
      ? C.unlock.award(placeholderSignature())
      : C.unlock.refund(placeholderPublicKey(), placeholderSignature()));
  }
  tb = tb.addOutput({ to, amount });
  return kind === 'refund' ? tb.setLocktime(locktime) : tb;
}

/**
 * Builds an award (to the winner) or a refund (to the poster) of the pot's coins. The tx is built with the wallet's
 * placeholders (65-byte sig, 33-byte pubkey), so its size equals the signed size and the fee is exact.
 * @param signPath [name, index] of the judge's (award) or poster's (refund) key in the connected wallet
 */
export function buildSweep({ provider, params, kind, utxos, to, locktime = 0, signPath = ['receive', 0], userPrompt }) {
  const C = potContract(params, provider);
  const coins = utxos.filter((u) => !u.token);
  const bytesFn = (ins) => encodeTransaction(sweepTx(C, provider, kind, ins, to, 1000n, locktime).buildLibauthTransaction(true)).length;
  const plan = planSweep(coins, { maxFee: BigInt(params.maxFee), feeRatePerByte: FEE_RATE, bytesFn });
  const prompt = typeof userPrompt === 'function' ? userPrompt(plan) : userPrompt;
  const wcObj = sweepTx(C, provider, kind, plan.inputs, to, plan.amount, locktime)
    .generateWcTransactionObject({ broadcast: false, userPrompt: prompt });
  const inputPaths = plan.inputs.map((_, i) => [i, signPath[0], signPath[1]]);
  return { wcObj, inputPaths, plan, note: leftNote(plan) };
}

// ---------- identity: the wc-tx binding proof (BIND-SPEC.md, proof 2b), for wallets that only sign transactions
export const BIND_PROTO = 'nostr-bch-bind:v1';
export const BIND_LOCKTIME = 4102444800; // 2100-01-01: the proof tx can never be mined
export const BIND_FEE = 300n;
/**
 * A transaction that is never sent: one coin of the bound address back to the same address minus 300 sats, plus an
 * OP_RETURN "nostr-bch-bind:v1" <sha256(message)>, locktime 2100 with a non-final sequence. The wallet's signature on
 * it proves the address's key signed the binding message. A published proof can't be mined, and even if it were, the
 * coin would come back to the same address.
 * @param coin { utxo, address, path: [name, index] } one coin of the address being bound, without tokens
 */
export function buildBindProof({ provider, coin, message, userPrompt }) {
  if (coin.utxo.token) throw new Error('A token coin can not carry the proof.');
  if (coin.utxo.satoshis < BIND_FEE + DUST) throw new Error(`The proof needs a coin of at least ${BIND_FEE + DUST} sats on this address.`);
  const tb = new TransactionBuilder({ provider })
    .addInput(coin.utxo, placeholderP2PKHUnlocker(coin.address))
    .addOpReturnOutput([BIND_PROTO, '0x' + binToHex(sha256.hash(utf8ToBin(message)))])
    .addOutput({ to: coin.address, amount: coin.utxo.satoshis - BIND_FEE })
    .setLocktime(BIND_LOCKTIME);
  const wcObj = tb.generateWcTransactionObject({ broadcast: false, userPrompt });
  const lockingBytecode = binToHex(wcObj.sourceOutputs[0].lockingBytecode);
  return {
    wcObj, inputPaths: [[0, coin.path[0], coin.path[1]]],
    /** the signed tx hex -> the `proof` tag value */
    proof: (signedHex) => JSON.stringify({ tx: signedHex, source: { valueSatoshis: String(coin.utxo.satoshis), lockingBytecode } }),
  };
}

/** BIP21 payment URI for a top-up from any wallet. */
export function bip21(address, sats, label) {
  const q = [];
  if (sats) q.push(`amount=${(Number(sats) / 1e8).toFixed(8).replace(/\.?0+$/, '')}`);
  if (label) q.push(`label=${encodeURIComponent(label)}`);
  return address + (q.length ? `?${q.join('&')}` : '');
}
