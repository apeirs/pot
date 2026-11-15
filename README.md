# Pot: bounties you can trust, on Bitcoin Cash

> **BCH BLAZE 2026 entry (Mainnet track)** · Deck: TODO (deck PDF link) · Repo: https://github.com/apeirs/pot
> (pre-hackathon prep: https://gist.github.com/apeirs/aff6b63931c57e1a0729a72770abb325, tag `prehack-2026-11-14`;
> pre-hackathon demo: https://apeir.dk/online/pot-chipnet/) · EMBER2026 CashTokens address:
> `bitcoincash:zrk8th0g30cn28um7apj85un4l9vvd37lyf6j3l26f`

**Lock a bounty on chain. Only the judge can award it; only after the deadline can the poster take it back.**

Live: **https://apeir.dk/online/pot/** (mainnet) · https://apeir.dk/online/pot/?net=chipnet (free test coins)

## Try it in 2 minutes
1. Open **TODO (link to the live mainnet pot)**: a mainnet bounty we funded, its locked balance, its deadline (date and
   block) and its history.
2. **Add to it** with 0.00002 BCH or more: scan the QR under "Or pay from any BCH wallet" with any BCH wallet, or connect
   Cashonize or Paytaca with WizardConnect (Connect wallet, top right) and press "Send from my wallet". The pot updates
   within seconds.
3. Optional: **create** your own pot (Create a pot). Put the deadline 1-2 hours out, and after it you can take the pot
   back yourself with "Take the pot back".
4. On chipnet the same page runs with free test coins: https://apeir.dk/online/pot/?net=chipnet
5. Mainnet proof, one transaction for each path: create TODO, top-up TODO, award TODO, refund TODO.

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
npm test        # contract, sweep, app and network tests on a mock network (82 cases)
npm run dev     # builds the page into web/dist and serves it on http://127.0.0.1:8917
npm run e2e     # chipnet end to end in headless Chrome (needs Chrome and the test wallet's chipnet coins)
```
The end-to-end wallet (`e2e/wallet.mjs`) uses keys derived from a fixed public label: it is for chipnet test coins only.

## Built before the hackathon
A design and a chipnet spike were done before 2026-11-14 and published unchanged as the gist above (tag
`prehack-2026-11-14` marks the same files in this repo). Everything after that tag was written during the hackathon.

## License
MIT
