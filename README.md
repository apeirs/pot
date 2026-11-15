# Pot: pre-hackathon prep (chipnet spike, 2026-11-06..13)

Pot is a no-backend BCH bounty pot: a CashScript contract that holds a prize, takes top-ups from anyone, and pays the
winner chosen by a named judge key, or refunds the poster after a deadline. This gist is the work done **before**
BCH BLAZE 2026 started, so judges can see what was built during the hackathon and what wasn't.

What existed before 2026-11-14 (all on chipnet):
- Contract v1 (`BountyEscrow.cash`): lock → award → timeout refund. Fund f0db463c…, award 21bde501…, refund ccf79c4f….
- Contract v2 (`Pot.cash`): judge key, top-ups, an award that sweeps several coins at once. 3-input sweep b483fd17….
- WizardConnect end to end: a dapp ↔ relay ↔ wallet; fund 88b6a5e8…, award of a contract input 16440a48….
- Real wallet: Cashonize web connected to the test page and signed a fund (1283c2dd…) and an award (99544104…).
- A static test page at apeir.dk/online/pot-chipnet/ (create / top-up / award / refund, session resume, QR).
- `nostr-bch-bind` draft: a reference implementation plus test vectors binding a BCH address to a Nostr key
  (signmessage formats of Cashonize, Electron Cash and Paytaca checked).
- Found while testing: Paytaca's extension sign page encoded the message length wrongly for messages of 253+ bytes
  (paytaca/paytaca-app#831, fixed by the Paytaca team in #832 on 2026-11-07).

What is new during the hackathon (11-14..21): the mainnet deployment, the judged repo and UI (four views with copy,
error text and loading states), the Bind view and the npub resolver for the Paytaca identity bounty, salted pot
addresses, a 5,000-sat fee cap, the self-audit section, the deck and the demo video.

## Files
- `Pot.cash`, `Pot.json`: contract v2 and its compiled artifact (cashc 0.14.0).
- `BountyEscrow.cash`, `BountyEscrow.json`: contract v1 and its artifact.
- `pot-test.mjs` (17 cases), `mock-test.mjs` (8), `sweep-test.mjs` (26) with `sweep.mjs`: mock-network tests, no funds.
- `bind.mjs`, `bindverify.mjs`, `bind-vectors.json`: nostr-bch-bind reference, verifier and 10 vectors
  (throwaway keys derived from a fixed label; never funded).

Chipnet scripts that sign with a funded key are left out on purpose.

## Run
```
npm init -y && npm pkg set type=module
npm i cashscript@0.14.0 @bitauth/libauth@3.1.0-next.8 nostr-tools@2.25.5
node pot-test.mjs && node mock-test.mjs && node sweep-test.mjs && node bind.mjs
```
(`bind.mjs` rewrites `bind-vectors.json` with fresh signatures from the same fixed test keys.)

## Full tx ids (chipnet, for the list above)
- v1 fund f0db463c104a35a02c4856e57f75b0afc46940d7598b3fa1266d75b3cf0fc7e5
- v1 award 21bde501e7fc1780962a97e8763ce4abb9a367d0e63571fcb41f82cefab61250
- v1 refund ccf79c4f4d5eacf413c1c064cf2ed6e7be445a9d10a60f55b935c715c146f7db
- v2 sweep b483fd17600cdfaa3863a8dedece62d56703665a1c27c5c7bd6031b6397ed66c
- WC fund 88b6a5e8d23892f44e30d942c3b2e407651adb9d35ef58f924c6658bc40582c0
- WC award 16440a482e7fd7e7f54d32bc2fa38c9b409efe1a99c639cf7080be19d867ca77
- page award 852aa968ef9f5fdcaf926186ce54b7b3e2b83f082a3a0e8652d90b216ec553c9, refund bae1ac9640924c72ec3c5be32b308e3cec1adfbac4795db382645326c813abcb
- Cashonize fund 1283c2ddf44246783ba10521c7980c4e768df8cad17f43c3e1041f095d4c2e38, award 99544104b01c1dd9ce0bf93f35ec90804e95d8bd9dc5854a311b26e23cc1e023
