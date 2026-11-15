// Offline tests of the network layer: address checks per network, server failover, POT1 meta, and the readable
// error when no server answers.
import { NETWORKS, checkAddress, networkOfAddress, FailoverProvider, SERVER_ERROR } from '../src/net.mjs';
import { encodePotMeta, parsePotMeta, readPot } from '../src/potread.mjs';
import { secp256k1, hash160, encodeCashAddress, sha256, utf8ToBin } from '@bitauth/libauth';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok  ', name); }
  catch (e) { fail++; console.log('FAIL', name, '-', String(e?.message ?? e).split('\n')[0].slice(0, 300)); }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const pkh = hash160(secp256k1.derivePublicKeyCompressed(sha256.hash(utf8ToBin('pot net-test key'))));
const main = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: pkh }).address;
const chip = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address;
const p2sh = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2sh', payload: pkh }).address;

await t('chipnet servers never include the forked chipnet.bch.ninja', () => {
  eq(NETWORKS.chipnet.servers.some((s) => s.includes('bch.ninja')), false);
  eq(NETWORKS.chipnet.servers[0], 'wss://chipnet.imaginary.cash:50004');
  eq(NETWORKS.mainnet.servers[0], 'wss://fulcrum.greyh.at:50004');
});
await t('networkOfAddress', () => { eq(networkOfAddress(main), 'mainnet'); eq(networkOfAddress(chip), 'chipnet'); eq(networkOfAddress('nope'), null); });
await t('checkAddress: right network passes, wrong network is named', () => {
  eq(checkAddress(main, NETWORKS.mainnet), '');
  eq(checkAddress(main.slice('bitcoincash:'.length), NETWORKS.mainnet), '', 'no prefix');
  eq(checkAddress(chip, NETWORKS.mainnet), 'That is a chipnet address; this page is on mainnet.');
  eq(checkAddress(main, NETWORKS.chipnet), 'That is a mainnet address; this page is on chipnet.');
  eq(checkAddress('', NETWORKS.mainnet), 'Enter a BCH address.');
  eq(checkAddress('bitcoincash:qqqq', NETWORKS.mainnet), 'That is not a valid BCH address.');
  eq(checkAddress(p2sh, NETWORKS.mainnet), 'Pay out to a normal wallet address (it starts with q).');
});
await t('failover: a connection error moves to the next server; a node answer does not', async () => {
  const fp = new FailoverProvider(NETWORKS.mainnet);
  let calls = [];
  fp.providers = [
    { getBlockHeight: async () => { calls.push(0); throw new Error('Connection lost'); }, sendRawTransaction: async () => { calls.push(0); throw new Error('min relay fee not met (code 66)'); } },
    { getBlockHeight: async () => { calls.push(1); return 977000; } },
  ];
  eq(await fp.getBlockHeight(), 977000); eq(calls.join(), '0,1'); eq(fp.server, NETWORKS.mainnet.servers[1]);
  fp.index = 0; calls = [];
  let msg = '';
  try { await fp.sendRawTransaction('00'); } catch (e) { msg = e.message; }
  eq(msg, 'min relay fee not met (code 66)'); eq(calls.join(), '0');
});
await t('failover: every server down -> the readable server error', async () => {
  const fp = new FailoverProvider(NETWORKS.chipnet, { timeoutMs: 50 });
  fp.providers = [{ getUtxos: () => new Promise(() => {}) }];
  let msg = ''; try { await fp.getUtxos(chip); } catch (e) { msg = e.message; }
  eq(msg, SERVER_ERROR);
});
await t('POT1 meta round-trips, keeps a 0x… title as text, refuses oversize', () => {
  const m = parsePotMeta(encodePotMeta('0xdead bug', 'https://example.org/i/1'));
  eq(m.title, '0xdead bug'); eq(m.url, 'https://example.org/i/1');
  let err = ''; try { encodePotMeta('x'.repeat(61), ''); } catch (e) { err = e.message; } eq(err, 'Title is longer than 60 characters');
  err = ''; try { encodePotMeta('t', 'https://e.org/' + 'a'.repeat(220)); } catch (e) { err = e.message; } if (!/limit is 223/.test(err)) throw new Error(err);
});
await t('readPot with no reachable server -> the readable server error', async () => {
  let msg = ''; try { await readPot(chip, { servers: ['ws://127.0.0.1:9'], timeoutMs: 1500 }); } catch (e) { msg = e.message; }
  eq(msg, SERVER_ERROR);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
