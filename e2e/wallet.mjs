// A WizardConnect test wallet for the end-to-end run: `node e2e/wallet.mjs '<wizardconnect uri>' [maxSigns, 0 = until killed]`.
// Its keys come from a fixed public label, so they are throwaway by design: chipnet test coins only, never fund them
// on mainnet. It signs P2PKH inputs and CashScript contract inputs (it fills the 65-byte signature and 33-byte pubkey
// placeholders, as Cashonize does), Schnorr with ALL|UTXOS|FORKID. It hands out a testnet xpub (tpub), like a
// wallet set to a test network.
import { generateKeyExchangeCredentials, hexToBin, toBigInt } from '@wizardconnect/core';
import { WalletConnectionManager } from '@wizardconnect/wallet';
import {
  sha256, utf8ToBin, secp256k1, binToHex, decodeTransaction, encodeTransaction, deriveHdPath, deriveHdPrivateNodeChild,
  deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeHdPublicKey, generateSigningSerializationBch,
  SigningSerializationFlag, hash256,
} from '@bitauth/libauth';
import { appendFileSync, mkdirSync } from 'node:fs';

export const LABEL = 'pot e2e: throwaway chipnet test wallet, never fund on mainnet';
const seed = sha256.hash(utf8ToBin(LABEL));
const master = deriveHdPrivateNodeFromSeed(seed);
const chains = { 0: deriveHdPath(master, "m/44'/145'/0'/0"), 1: deriveHdPath(master, "m/44'/145'/0'/1"), 7: deriveHdPath(master, "m/44'/145'/0'/7") };
export const childPriv = (chain, i) => deriveHdPrivateNodeChild(chains[chain], i).privateKey;
export const childPub = (chain, i) => secp256k1.derivePublicKeyCompressed(childPriv(chain, i));

const URI = process.argv[2];
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (!URI) { console.error('usage: node e2e/wallet.mjs <wizardconnect uri> [maxSigns]'); process.exit(2); }
  const MAX_SIGNS = Number(process.argv[3] ?? 0);
  const TIMEOUT_MS = Number(process.env.WALLET_TIMEOUT_MS || 900000);
  const outDir = new URL('./out/', import.meta.url);
  mkdirSync(outDir, { recursive: true });
  const LOG = new URL('wallet.jsonl', outDir);
  const log = (o) => { console.log('[wallet]', JSON.stringify(o)); appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); };

  const nameToChild = { receive: 0, change: 1 };
  const relayKey = hexToBin(generateKeyExchangeCredentials().privateKey);
  const u8 = (v) => (v instanceof Uint8Array ? v : hexToBin(String(v ?? '').replace(/^<Uint8Array: 0x/, '').replace(/>$/, '')));
  const push = (b) => Uint8Array.from([b.length, ...b]);
  const HASH_TYPE = SigningSerializationFlag.allOutputs | SigningSerializationFlag.utxos | SigningSerializationFlag.forkId;
  // replace one byte-aligned placeholder push (0x41 + 65 zero bytes, or 0x21 + 33 zero bytes) in an unlocking script
  const replacePush = (hex, ph, val) => {
    for (let at = hex.indexOf(ph); at !== -1; at = hex.indexOf(ph, at + 1)) if (at % 2 === 0) return hex.slice(0, at) + val + hex.slice(at + ph.length);
    return null;
  };
  const adapter = {
    walletName: 'Pot test wallet', walletIcon: '',
    getRelayPrivateKey: () => relayKey,
    getPublicKey: (path, index) => childPub(Number(path), Number(index)),
    getXpub: (path) => encodeHdPublicKey({ node: deriveHdPublicNode(chains[Number(path)]), network: 'testnet' }).hdPublicKey,
    async signTransaction(request) {
      const t = request.transaction;
      const raw = typeof t.transaction === 'string' ? decodeTransaction(hexToBin(t.transaction)) : t.transaction;
      if (typeof raw === 'string') throw new Error(raw);
      const sos = t.sourceOutputs.map((so) => ({ ...so, outpointTransactionHash: u8(so.outpointTransactionHash), unlockingBytecode: u8(so.unlockingBytecode),
        lockingBytecode: u8(so.lockingBytecode), valueSatoshis: toBigInt(so.valueSatoshis) }));
      const sign = (i, covered, priv) => {
        const pre = generateSigningSerializationBch({ inputIndex: i, sourceOutputs: sos, transaction: raw },
          { coveredBytecode: covered, signingSerializationType: new Uint8Array([HASH_TYPE]) });
        return Uint8Array.from([...secp256k1.signMessageHashSchnorr(priv, hash256(pre)), HASH_TYPE]);
      };
      let contractInputs = 0;
      raw.inputs.forEach((inp, i) => {
        const p = request.inputPaths.find((x) => x[0] === i);
        if (!p) return;
        if (!(p[1] in nameToChild)) throw new Error(`unknown path ${p[1]}`);
        const priv = childPriv(nameToChild[p[1]], Number(p[2]));
        const pub = secp256k1.derivePublicKeyCompressed(priv);
        const so = t.sourceOutputs[i];
        if (so.contract?.artifact?.contractName) {
          contractInputs++;
          let hex = binToHex(sos[i].unlockingBytecode);
          const withSig = replacePush(hex, '41' + '00'.repeat(65), '41' + binToHex(sign(i, u8(so.contract.redeemScript), priv)));
          if (withSig === null) throw new Error(`input ${i}: contract input without a signature placeholder`);
          hex = replacePush(withSig, '21' + '00'.repeat(33), '21' + binToHex(pub)) ?? withSig;
          inp.unlockingBytecode = hexToBin(hex);
        } else {
          inp.unlockingBytecode = Uint8Array.from([...push(sign(i, sos[i].lockingBytecode, priv)), ...push(pub)]);
        }
      });
      log({ step: 'signed', prompt: t.userPrompt, inputs: raw.inputs.length, contractInputs, locktime: raw.locktime });
      return binToHex(encodeTransaction(raw));
    },
  };
  const wallet = new WalletConnectionManager(adapter);
  let signs = 0, readies = 0;
  wallet.on('pendingSignRequest', async (req) => {
    // the test's "user says no": reject any request whose prompt carries the marker
    if (String(req.request?.transaction?.userPrompt ?? '').includes('REJECTME')) { log({ step: 'rejected-by-test' }); await wallet.sendSignError(req.connectionId, req.request.sequence, 'User rejected'); return; }
    try {
      await wallet.sendSignResponse(req.connectionId, req.request.sequence, await adapter.signTransaction(req.request));
      signs++;
      if (MAX_SIGNS && signs >= MAX_SIGNS) setTimeout(() => { wallet.disconnectAll(); process.exit(0); }, 4000);
    } catch (e) {
      log({ step: 'sign-error', error: String(e.message) });
      await wallet.sendSignError(req.connectionId, req.request.sequence, String(e.message));
    }
  });
  const orig = wallet.handleDappReady?.bind(wallet); // wrapped only to count dapp_ready messages (resume proof)
  if (orig) wallet.handleDappReady = (conn, m) => { log({ step: 'dapp-ready', n: ++readies }); return orig(conn, m); };
  wallet.on('remoteDisconnect', (id, reason) => log({ step: 'remote-disconnect', reason }));
  wallet.connect(URI);
  log({ step: 'connected', address0: binToHex(childPub(0, 0)) });
  setTimeout(() => { log({ step: 'timeout', signs }); process.exit(1); }, TIMEOUT_MS);
  process.on('SIGTERM', () => { log({ step: 'stop', signs }); wallet.disconnectAll(); process.exit(0); });
}
