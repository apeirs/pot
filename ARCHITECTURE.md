# Architecture

Pot is three things: a CashScript contract, a static web page, and the user's wallet. There is no backend, no
database and no indexer.

```
  browser (web/app.js)                         BCH network
  ├─ pot link → contract + address  ─────────► Electrum servers (read coins and history, broadcast)
  ├─ builds transactions (cashscript)
  └─ WizardConnect (dapp) ◄── relay ──► user's wallet (Cashonize, Paytaca, Selene): signs
```

## The contract (`contracts/Pot.cash`)
`Pot(bytes20 posterPkh, pubkey judgePk, int deadline, int maxFee, bytes8 salt)`, compiled with cashc 0.14 to a P2SH32
address. The five constructor values are the pot's whole state; they never change.

Three ways money moves:
1. **Top-up** (no contract function): anyone pays the contract address. The first funding transaction also carries an
   OP_RETURN `POT1 <title> <url>` (at most 223 bytes). The page takes the title from the earliest pay-in that comes
   from the poster (an input signed by the poster's key, else change paid to the poster's address, which is how an HD
   wallet funds from other addresses); a stranger's top-up with its own POT1 is ignored.
2. **Award** `award(judgeSig)`: signed by the judge key. Exactly one output, which is not the poster's or the judge's
   P2PKH. Every input must be this same contract, and the output must carry at least the sum of the inputs minus
   `maxFee`. So the judge can choose the winner, but can't skim, split, or pay themselves.
3. **Refund** `refund(posterPk, posterSig)`: signed by the poster, valid once `tx.time >= deadline` (a block height, so
   the transaction's locktime must be at least the deadline). One output, to the poster's P2PKH, with the same
   all-inputs and fee-cap rules.

`salt` is 8 random bytes chosen when a pot is created, so two pots with the same poster, judge, deadline and fee cap
still get different addresses.

## The page (`web/`, logic in `src/`)
- `src/net.mjs`: the two networks (mainnet by default, chipnet with `?net=chipnet`), their Electrum servers with
  failover, explorer links, and address checks that name the wrong network.
- `src/pot.mjs`: pot links (`1.<posterPkh>.<judgePk>.<deadline>.<maxFee>.<salt>`), deadline ↔ date, and the four
  transactions. Create and top-up pick wallet coins and pay the pot; award and refund use `src/sweep.mjs` to pick pot
  coins so the fee stays under the cap. Fees are exact: transactions are built with the wallet's placeholder
  signature and key, which have the size of the real ones.
- `src/potread.mjs`: reads a pot's coins, balance and history from an Electrum server, classifies each transaction
  (fund, top-up, award, refund) and reads the POT1 title.
- `web/app.js`: the views (home, create, pot), the wallet panel and the error texts. Pots you create or open are
  remembered in this browser's localStorage, per network.

## The wallet flow (WizardConnect, hdwalletv1)
1. The page opens a relay session (`wss://relay.riften.net`) and shows a QR and a link.
2. The wallet scans it and answers with its xpubs. The page derives `receive/0` (the user's address and judge key) and
   reads the coins of the first 10 receive and change addresses.
3. WizardConnect carries no network field, so the page checks: a testnet key (tpub) is refused on mainnet, and a
   wallet with no coins on this network but coins on the other one is refused with a link to the right page.
4. For each action the page sends a sign request (the unsigned transaction, its source outputs with contract details,
   the input paths, and a one-line prompt such as "Award the pot: 0.0002 BCH to bitcoincash:q…"). The wallet signs
   and returns the transaction; the page broadcasts it. A rejection shows "The wallet didn't sign. Nothing was sent."
5. The session is kept in localStorage (per network), so a reload resumes it without a new QR.

## Tests
- `npm test`: the contract's rules (every rejected case names its Pot.cash line), the sweep planner, the app's
  transactions, and the network layer, all on CashScript's mock network.
- `npm run e2e`: the built page in headless Chrome against chipnet, with a test wallet over a real relay: pairing QR,
  create, a rejected request, resume after reload, top-up, award (two coins), refund, and the mainnet page refusing a
  testnet wallet.
