# Pot: bounties you can trust, on Bitcoin Cash

> **BCH BLAZE 2026 entry (Mainnet track)** · Deck: TODO (deck PDF link) · Repo: https://github.com/apeirs/pot
> (pre-hackathon prep: https://gist.github.com/apeirs/aff6b63931c57e1a0729a72770abb325, tag `prehack-2026-11-14`;
> pre-hackathon demo: https://apeir.dk/online/pot-chipnet/) · EMBER2026 CashTokens address:
> `bitcoincash:zrk8th0g30cn28um7apj85un4l9vvd37lyf6j3l26f`

**Lock a bounty on chain. Only the judge can award it; only after the deadline can the poster take it back.**

Live: **https://apeir.dk/online/pot/** (mainnet) · https://apeir.dk/online/pot/?net=chipnet (free test coins)

## Try it in 2 minutes
1. Open **[the mainnet demo pot](https://apeir.dk/online/pot/#/p/1.a4bec748b68981eff89f7f37f855237b17d3f909.02259a322083854c4f76b91595c6f7630bcdcdb6407b66d3b09d0f9e3ef2683095.977865.5000.08788b65839dcd5d)** (also under Featured on the home page): funded, topped up and awarded on
   mainnet. Its history links every transaction; the award paid both of its coins to one winner in one transaction.
2. **Create** your own pot: Connect wallet (top right) with Paytaca or Cashonize over WizardConnect, then Create a pot
   (0.0001 BCH at least). Put the deadline 1-2 hours out.
3. **Add to it**: scan the QR under "Or pay from any BCH wallet" with any BCH wallet, or press "Send from my wallet".
   The pot updates within seconds.
4. After the deadline, take it back with "Take the pot back"; before it, as the judge, award it to another address.
5. On chipnet the same page runs with free test coins: https://apeir.dk/online/pot/?net=chipnet

**Mainnet proof**, one transaction per path, signed by the Paytaca browser extension over WizardConnect:

| Path | Transaction | What it shows |
|---|---|---|
| create (pot A) | [`8457e87d…`](https://blockchair.com/bitcoin-cash/transaction/8457e87d85d1c3af53418b6a7268ef45c46f3235d9f176bdb48a0961d9fd7075) | 0.0002 BCH into the contract, title in a POT1 OP_RETURN |
| top-up (pot A) | [`48dcebb3…`](https://blockchair.com/bitcoin-cash/transaction/48dcebb38f1c5f33026c287b0850df52aa9349e2f0b26f0c5b736118d9da1c73) | 0.00002 BCH more, a second coin |
| award (pot A) | [`d7f47d5e…`](https://blockchair.com/bitcoin-cash/transaction/d7f47d5e88c30338fb0c59937bc202016859ed93efb5f9b92b760cc40bebecba) | the judge's wallet signs two contract inputs; 0.000213 BCH to the winner, fee 700 sats |
| create (pot B) | [`9d17abd3…`](https://blockchair.com/bitcoin-cash/transaction/9d17abd3b01ad7432bba83558a05bed2941bfeef4854df7d8082a940cf04e5f8) | 0.0001 BCH, deadline block 977,443 ([pot B](https://apeir.dk/online/pot/#/p/1.a4bec748b68981eff89f7f37f855237b17d3f909.02259a322083854c4f76b91595c6f7630bcdcdb6407b66d3b09d0f9e3ef2683095.977443.5000.805a23cfd99dae88)) |
| refund (pot B) | TODO (after block 977,443) | the poster takes it back after the deadline |

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

## Wallets
| Wallet | Network | Create | Top-up | Award (contract input) | Refund (contract input) |
|---|---|---|---|---|---|
| Paytaca browser extension 0.27.5 | mainnet | yes | yes | yes | TODO |
| `@wizardconnect/wallet` test wallet (`e2e/wallet.mjs`) | chipnet | yes | yes | yes | yes |
| Cashonize, Selene | | not tried yet | | | |


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
npm test        # contract, sweep, app and network tests on a mock network (83 cases)
npm run dev     # builds the page into web/dist and serves it on http://127.0.0.1:8917
npm run e2e     # chipnet end to end in headless Chrome (needs Chrome and the test wallet's chipnet coins)
```
The end-to-end wallet (`e2e/wallet.mjs`) uses keys derived from a fixed public label: it is for chipnet test coins only.

## Built before the hackathon
A design and a chipnet spike were done before 2026-11-14 and published unchanged as the gist above (tag
`prehack-2026-11-14` marks the same files in this repo). Everything after that tag was written during the hackathon.

## License
MIT
