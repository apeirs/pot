# Pot: bounties you can trust, on Bitcoin Cash

> **BCH BLAZE 2026 entry (Mainnet track)** · Deck: https://apeir.dk/online/pot/deck.pdf · Video (104 s): https://apeir.dk/online/pot/pot-demo.mp4 · Repo: https://github.com/apeirs/pot
> (pre-hackathon prep: https://gist.github.com/apeirs/aff6b63931c57e1a0729a72770abb325, tag `prehack-2026-11-14`;
> pre-hackathon demo: https://apeir.dk/online/pot-chipnet/) · EMBER2026 CashTokens address:
> `bitcoincash:zrk8th0g30cn28um7apj85un4l9vvd37lyf6j3l26f`

**Lock a bounty on chain. Only the judge can award it; only after the deadline can the poster take it back.**

Live: **https://apeir.dk/online/pot/** (mainnet) · https://apeir.dk/online/pot/?net=chipnet (free test coins)

## Try it in 2 minutes
1. Open **[the BLAZE 2026 demo pot](https://apeir.dk/online/pot/#/p/1.a4bec748b68981eff89f7f37f855237b17d3f909.02259a322083854c4f76b91595c6f7630bcdcdb6407b66d3b09d0f9e3ef2683095.979645.5000.2ab2c2e8333f7708)** (first under Featured on the home page): 0.0005 BCH locked on mainnet
   until block 979,645 (about 11-30). Its balance, deadline and history are read live from the chain.
2. **Add to it**: scan the QR under "Or pay from any BCH wallet" with any BCH wallet, or connect Paytaca
   (Connect wallet, top right) and press "Send from my wallet". The pot updates within seconds.
3. **Identity**: click the ✓ npub badge next to the judge. The [#/bind](https://apeir.dk/online/pot/#/bind?q=npub1dw38lu4qufjs85t6m6hwgk0v5we8puwlyzed9yj3rjjav6skjvnqjuhuns)
   view fetches the judge's Nostr binding from the relays and verifies both signatures in the page.
   No wallet? [`#/bind?try`](https://apeir.dk/online/pot/#/bind?try) binds throwaway keys, logs in with them and shows
   forged proofs being refused.
4. See the other two paths done: [pot A](https://apeir.dk/online/pot/#/p/1.a4bec748b68981eff89f7f37f855237b17d3f909.02259a322083854c4f76b91595c6f7630bcdcdb6407b66d3b09d0f9e3ef2683095.977865.5000.08788b65839dcd5d) was awarded (both coins to one winner in one transaction), pot B was
   refunded after its deadline (links in the table below).
5. **Create** your own pot: Connect wallet (top right) with Paytaca or Selene over WizardConnect, then Create a pot
   (0.0001 BCH at least). Put the deadline 1-2 hours out.
   After the deadline you take it back with "Take the pot back"; before it, as the judge, you award it to another
   address.
6. On chipnet the same page runs with free test coins: https://apeir.dk/online/pot/?net=chipnet

**Mainnet proof**, one transaction per path, signed by the Paytaca browser extension over WizardConnect:

| Path | Transaction | What it shows |
|---|---|---|
| create (pot A) | [`8457e87d…`](https://blockchair.com/bitcoin-cash/transaction/8457e87d85d1c3af53418b6a7268ef45c46f3235d9f176bdb48a0961d9fd7075) | 0.0002 BCH into the contract, title in a POT1 OP_RETURN |
| top-up (pot A) | [`48dcebb3…`](https://blockchair.com/bitcoin-cash/transaction/48dcebb38f1c5f33026c287b0850df52aa9349e2f0b26f0c5b736118d9da1c73) | 0.00002 BCH more, a second coin |
| award (pot A) | [`d7f47d5e…`](https://blockchair.com/bitcoin-cash/transaction/d7f47d5e88c30338fb0c59937bc202016859ed93efb5f9b92b760cc40bebecba) | the judge's wallet signs two contract inputs; 0.000213 BCH to the winner, fee 700 sats |
| create (pot B) | [`9d17abd3…`](https://blockchair.com/bitcoin-cash/transaction/9d17abd3b01ad7432bba83558a05bed2941bfeef4854df7d8082a940cf04e5f8) | 0.0001 BCH, deadline block 977,443 ([pot B](https://apeir.dk/online/pot/#/p/1.a4bec748b68981eff89f7f37f855237b17d3f909.02259a322083854c4f76b91595c6f7630bcdcdb6407b66d3b09d0f9e3ef2683095.977443.5000.805a23cfd99dae88)) |
| refund (pot B) | [`50afa3db…`](https://blockchair.com/bitcoin-cash/transaction/50afa3dbeaa3cb88381e728b247818cd9eb2543e2f7710526a5c4f0ae9438057) | the poster's wallet signs the contract input after the deadline; 0.00009594 BCH back |
| create (pot C, open) | [`8223691c…`](https://blockchair.com/bitcoin-cash/transaction/8223691c776b2e6a39d1fd4f6e5c7a6f8c83d058fe4c0b3f622044763a00e32b) | 0.0005 BCH locked until block 979,645, [open for top-ups](https://apeir.dk/online/pot/#/p/1.a4bec748b68981eff89f7f37f855237b17d3f909.02259a322083854c4f76b91595c6f7630bcdcdb6407b66d3b09d0f9e3ef2683095.979645.5000.2ab2c2e8333f7708) |

WizardConnect shares your wallet's public keys (xpub) with the page, as every WizardConnect dapp does. Use a fresh
wallet if that matters to you.

## Why
Bounty hunters do the work first and trust the poster to pay. Pot puts the money in a contract before anyone starts:
the hunter sees it locked, the poster can't pull it back early, and the rules are code anyone can read.

## How it works
- Contract [`contracts/Pot.cash`](contracts/Pot.cash): `Pot(posterPkh, judgePk, deadline, maxFee, salt)`
  - `award(judgeSig)`: the judge pays every pot coin in the transaction to one output, minus at most `maxFee`; not to
    the poster, not to the judge.
  - `refund(posterPk, posterSig)`: from block `deadline` on, the poster takes it all back, to their own address only.
  - Top-ups are plain payments to the contract address; an award or refund sweeps them too.
- The pot's terms travel in its link (`#/p/1.<poster>.<judge key>.<deadline>.<fee cap>.<salt>`); the page rebuilds the
  contract and its address from them. The title and link sit in an OP_RETURN of the funding transaction. No backend,
  no account, no indexer: the page reads the chain over Electrum.
- Wallets sign over WizardConnect. Award and refund spend a contract input: the page builds the transaction with
  CashScript placeholders and the judge's or poster's wallet fills in its signature.

More in [ARCHITECTURE.md](ARCHITECTURE.md).

## Nostr identity (Paytaca DID)
A poster or judge can bind their BCH address to a Nostr key, so a pot shows who stands behind it and a pot can be
judged by, or awarded to, an npub instead of a raw address.

**Paytaca Decentralized Identity: requirement → where to see it** (no wallet needed for any link below)

| Requirement | Where to see it |
|---|---|
| 1. Identity creation and management | [`#/bind`](https://apeir.dk/online/pot/#/bind): your BCH wallet (Paytaca over WizardConnect, or any wallet with Sign Message) and your Nostr key (NIP-07 extension, a key made in the page, or a pasted nsec). Keys stay in the wallet or the page; no server, no account. |
| 2. Cryptographic binding | [`#/bind?try`](https://apeir.dk/online/pot/#/bind?try): throwaway BCH and Nostr keys (two different keys) both sign one message, and the page verifies both signatures. Its three "try to cheat" buttons show a copied proof, a borrowed address and an edited event refused, each with the reason. Live: the demo judge's mainnet binding, signed with Paytaca (`test/mainnet-binding.json`). |
| 3. Decentralized discovery | Three public Nostr relays, by npub or by address: [`#/bind?q=<npub>`](https://apeir.dk/online/pot/#/bind?q=npub1dw38lu4qufjs85t6m6hwgk0v5we8puwlyzed9yj3rjjav6skjvnqjuhuns), [`#/bind?q=<address>`](https://apeir.dk/online/pot/#/bind?q=bitcoincash:qzjta36gk6ycrmlcnaln07z4yda305lepy7tp7cnvp), and the ✓ npub badge on [demo pot C](https://apeir.dk/online/pot/#/p/1.a4bec748b68981eff89f7f37f855237b17d3f909.02259a322083854c4f76b91595c6f7630bcdcdb6407b66d3b09d0f9e3ef2683095.979645.5000.2ab2c2e8333f7708). |
| 4. Verification and authentication | Every event is verified in the browser (`src/bindverify.mjs`, `src/nostrbind.mjs`). Challenge-response login: [`#/bind?try`](https://apeir.dk/online/pot/#/bind?try) logs in with the throwaway identity and refuses a replay; [`#/bind?login=<npub>`](https://apeir.dk/online/pot/#/bind?login=npub1dw38lu4qufjs85t6m6hwgk0v5we8puwlyzed9yj3rjjav6skjvnqjuhuns) issues a real challenge to the demo judge's bound address. Reusable: `src/login.mjs`. Tests: `test/login-test.mjs`, `test/identity-test.mjs`. |
| 5. Working demo and documentation | This site, this README, [ARCHITECTURE.md](ARCHITECTURE.md) (identity section), `npm test`. |
| Stretch: pay by identity | [`#/new`](https://apeir.dk/online/pot/#/new): pick "Someone else" as judge and enter an npub; the page resolves its binding and shows the bound address and the judge key it recovered. A judge's award form takes the winner as an npub too, and resolves it again when the award is made. |
| Stretch: interoperability | Reads and verifies NIP-39 `bch:` claims (kind 10011) and pennyops `bch-nostr-bind.v1` as well as its own format (see "Compatible with" below). |

- **Bind** ([`#/bind`](https://apeir.dk/online/pot/#/bind)): connect Paytaca over WizardConnect (the same session as the
  pot), pick a Nostr key (a NIP-07 extension if you have one, else a fresh key made in the page or a pasted nsec; the
  secret never leaves the page and is never stored), then sign one short message with both keys. The BCH side is
  either a wallet `signmessage` signature (pasted) or a WizardConnect-signed transaction that commits to the message
  and can never be mined (locktime 4102444800, non-final). The page checks both signatures offline, then publishes the
  event to `nos.lol`, `relay.primal.net` and `relay.snort.social`.
- **On a pot page** the poster's and judge's addresses get a verified npub badge when a valid binding exists. The badge
  opens `#/bind?q=<npub>`, which fetches the binding from the relays and shows every check it passed.
- **Pay by identity**: the create form's judge field and the award form's winner field accept an npub. The page finds
  the npub's binding on the relays, verifies both signatures, and uses the bound address (or its key, for a judge). It
  re-resolves at award time and puts the npub in the wallet prompt.
- **Try it without a wallet** ([`#/bind?try`](https://apeir.dk/online/pot/#/bind?try)): the page makes a throwaway BCH key and
  a throwaway Nostr key at runtime (never stored, shown or published; the address is never funded), binds them, verifies
  the binding, logs in with it, then lets you try three forgeries and shows why each is refused. Code: `src/tryit.mjs`.
- **Log in with it** ([`#/bind?login=<npub>`](https://apeir.dk/online/pot/#/bind)): the challenge-response check of the
  Paytaca spec. The page finds the npub's binding on the relays and issues a challenge naming this site, the npub, a random
  16-byte nonce and the time. The bound address signs it (a pasted `signmessage`, or the same never-mined WizardConnect
  proof), and the page shows `✓ Logged in as <npub> / <address>` when the nonce is its own, unused and under 5 minutes
  old, the binding verifies and the signature is by the bound address. Each nonce logs in once. Any app can reuse
  `src/login.mjs` (no server needed).
- **Format** `nostr-bch-bind v1`: a kind 30078 event, `d` = `bch-bind:<address>`, tags `i` = `bch:<address>` and
  `proof` = [`signmessage` | `wc-tx`, value]; content `nostr-bch-bind:v1 / npub:<hex> / bch:<address> / created:<ts>`.
  A binding is valid when the Nostr event signature, the BCH proof over the same message, and the address/key fields
  all agree. Logic in `src/bindverify.mjs` and `src/nostrbind.mjs`, page in `web/bind.js`.
- **Live binding**: the BLAZE demo wallet `bitcoincash:qzjta36gk6ycrmlcnaln07z4yda305lepy7tp7cnvp` (judge of pot C) is bound to
  `npub1dw38lu4qufjs85t6m6hwgk0v5we8puwlyzed9yj3rjjav6skjvnqjuhuns` with a Paytaca `signmessage` signature, event
  `adf8a87d…fa1c100f` (also `test/mainnet-binding.json`, checked by `npm test`).

**Compatible with:** NIP-39 (kind 10011 identity list): a `["i", "bch:<cashaddr>", "<signmessage>"]` claim whose BCH
signature is over NIP-39's own text `Verifying that I control the following Nostr public key: <npub>` is read and fully
verified (found by npub and by address; the newest list replaces older ones), and shown as format "NIP-39". It was
checked against a live NIP-39 `bch:` binding published by another BLAZE project (tenxagent/blaze-bch). pennyops `bch-nostr-bind.v1` (kind 30078, `d` = `bch-nostr-bind`, written for Cashonize #405, the
prior art for paying an npub) is read and fully verified, signature from its `i` tag. alberdioni `bch-identity-bridge`
(kind 31234) carries no BCH proof on the relay, so it is shown greyed out as unverifiable, never as verified.

## Wallets
| Wallet | Network | Create | Top-up | Award (contract input) | Refund (contract input) | Identity proof (wc-tx) |
|---|---|---|---|---|---|---|
| Paytaca browser extension 0.27.5 | mainnet | yes | yes | yes | yes | yes |
| Selene web app v2026.10.02 (app.selene.cash) | mainnet | yes | not tried | yes | not tried | not tried |
| `@wizardconnect/wallet` test wallet (`e2e/wallet.mjs`) | chipnet | yes | yes | yes | yes | yes |
| Cashonize | | not tried yet | | | | |

- **Selene** signs the CashScript contract input: a pot it created ([`5e14240d…`](https://blockchair.com/bitcoin-cash/transaction/5e14240dfea4618e65c6689fb9940e64ab887a6846bc6814945f781559c97c7f))
  was awarded by Selene as judge to another Selene address ([`335210ab…`](https://blockchair.com/bitcoin-cash/transaction/335210abaec46fe803e800c998f54cbe0cb27d16c27424b56ce944959de846ea)).
  Its signature prompt names the action and marks the winner output as its own. Selene's first `wallet_ready` carries
  no keys and the next one does; the page now waits for a `wallet_ready` with a receive key (before this fix, pairing
  Selene ended in "The wallet did not share an address").
- **Paytaca identity proof**: on mainnet the wallet signed the binding transaction (prompt "Signature only, never sent"),
  the page verified it, and a broadcast attempt was refused by the network: `bad-txns-nonfinal (code 64)`.


## Self-audit
Each rule of the contract, the attack it stops, and the test that tries it (`npm test`, mock network):

| Rule (Pot.cash line) | Attack it stops | Test (test/pot-test.mjs) |
|---|---|---|
| judge signature (13) | the poster or a stranger awarding | `award signed by the poster`, `award signed by a stranger` |
| one output (14) | change siphoned to a second output | `award with a second output` |
| output ≠ poster (15) / ≠ judge (16) | self-award | `award to the poster`, `award to the judge` |
| every input is this contract (20, 37) | mixing in foreign or other-pot inputs | `foreign P2PKH input`, `inputs of two different pots` |
| output ≥ inputs − maxFee (24, 41) | skimming, incl. leaving a top-up out of the payout | `award skimming above the fee cap`, `sweep of 3 UTXOs paying out only 2`, `refund skimming` |
| poster key (29, 30) + `tx.time ≥ deadline` (31) | early or third-party refund | `refund before the deadline`, `refund by the judge` |
| refund output = poster (33) | refund to someone else | `refund after the deadline to someone else` |
| 8-byte salt (10, 12, 28) | two pots with the same terms sharing one address, so one award sweeps both | `same terms, different salt`, `inputs of two pots with the same terms but different salts` |

**Limits, plainly:**
1. The judge is trusted. A judge who colludes with the poster can award to the poster's second address. Pot stops the
   poster acting alone, not a corrupt judge. If the judge is the poster, hunters get only "locked until the deadline".
2. Top-ups are gifts to the pot: if nobody wins, they go back to the poster, not to whoever added them.
3. The contract can't see coins left out of a transaction, so a judge may award fewer than all; the rest waits for a
   later award or refund. The page always sweeps all it can.
4. CashTokens sent to a pot are burned by an award or refund. The page never sends tokens and warns token holders.
5. After the deadline, award and refund race: the first confirmed transaction wins. That's intended, so a judge can
   still pay late.
6. One award sweeps at most 15 coins at the 5,000-sat fee cap (13 for a refund; about 330-360 bytes each). The page
   takes the largest coins and says what it left for a later sweep; top-ups start at 2,000 sats.
7. Anyone can spam a pot with dust top-ups. Its page still loads: it reads the first 5 and the newest transactions
   (60 at most) and shows "N of M".
8. A deadline is a block height. The date the page shows assumes 10-minute blocks, so it is approximate.

## Run it
```
npm ci
npm test        # contract, sweep, app and network tests on a mock network (126 cases)
npm run dev     # builds the page into web/dist and serves it on http://127.0.0.1:8917
npm run e2e     # chipnet end to end in headless Chrome (needs Chrome and the test wallet's chipnet coins)
```
The end-to-end wallet (`e2e/wallet.mjs`) uses keys derived from a fixed public label: it is for chipnet test coins only.

## Built before the hackathon
A design and a chipnet spike were done before 2026-11-14 and published unchanged as the gist above (tag
`prehack-2026-11-14` marks the same files in this repo). Everything after that tag was written during the hackathon.

## License
MIT
