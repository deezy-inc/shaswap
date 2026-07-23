# qbit-swap-mm (PRIVATE)

Automated market-maker bots that fulfill BTC↔QBT atomic swaps on our behalf. **Private** — kept
separate from the open-source stack.

It builds on the open-source pieces (which stay public):
- the **client library** (`@qbit-swap/client`, the `qbit-otc/client` package) — key gen, HTLC
  construction, P2MR/BIP143 sighash, WASM SLH-DSA + ECDSA signing;
- the **coordinator HTTP API** — the maker joins/fulfills swaps through the same endpoints anyone else
  would use.

A maker bot adds the *decision layer* on top: which swaps to take, pricing, inventory/liquidity
management, and running many swaps concurrently — signing everything client-side (non-custodial). It
never hands keys to anyone, and it can only ever recover its own funds.

## Layout
- `maker-bot.js` — a single-party autonomous maker. Given a swap it decides to take, it joins as the
  counterparty (Bob: holds QBT, wants BTC), funds its leg only after the taker's BTC is on-chain, and
  claims the BTC on reveal (or refunds its QBT on timeout).
- `test/e2e.mock.mjs` + `test/mockchain.mjs` — end-to-end tests: the **real coordinator + real bot over
  the real HTTP API**, with an in-memory chain standing in for regtest nodes.

## Dev / running the tests
Depends on the public client library and, for the e2e, the coordinator — both from a `qbit-otc`
checkout **beside this repo** (`../qbit-otc`). Then:

```
npm install
npm test          # runs test/e2e.mock.mjs
```

The e2e covers all four paths the bot must handle: a completed swap (with **coordinator-fee splitting**),
a refund when the taker walks, a policy reject on an underpriced swap, and an **RFQ one-click buy**. It
uses a mock chain, so it proves the bot↔coordinator *protocol* end to end; on-chain tx *validity* is
covered by the client library's own regtest e2e (run that against a live regtest node when available).

## Three ways to source swaps

### 1. RFQ — powers the web app's one-click "instant swap" widget  *(recommended)*
`MakerBot.serveRfq({ quote })` streams a live two-sided quote to the coordinator's `/rfq` layer and
fulfills matches it hands back. The coordinator expires a quote if the bot stops pinging, so the loop
**must keep running** — the ping *is* the liveness signal.

```js
const bot = new MakerBot({ coordinatorUrl, wallet, policy, makerKey: "<RFQ_MAKER_KEYS value>" });
await bot.serveRfq({ quote: { ask: { price: 0.20, qbtSats: 5_000_000_000 } }, pingMs: 3000 });
```

Prices are BTC per QBT; sizes are `qbtSats`. Retail sees the best live price in the widget and takes it
in one click; the bot's next ping delivers the match and it fulfills as Bob.

> **Ask-side only for now.** This bot makes the **ask** (it holds QBT, sells for BTC → it is Bob). A
> retail *buy* hits the ask and is fulfilled. A retail *sell* hits a **bid** (maker = Alice, the
> initiator who funds BTC, holds the secret, and claims QBT) — that role isn't implemented yet, so quote
> `ask` only. Two-sided quoting is the main open follow-up (see below).

### 2. Order book (`makeMarket`)
Posts a batch of QBT-for-BTC **asks** to the public order book and fulfills takes, replenishing each lot.
Feature-flagged in the web app (`QBIT_ORDERBOOK`); RFQ is the primary retail path now.

```js
await bot.makeMarket({ lots: [ { qbtSats: 100_000_000, btcSats: 20_000_000 }, /* … */ ] });
```

### 3. Direct link (`consider`)
`bot.consider({ swapId, token })` prices a single swap link received out-of-band and, if it clears
policy, fulfills it. The core execution path all three modes share.

## Fee awareness
When the coordinator charges a platform fee, the buyer funds the BTC HTLC with `terms + fee`, and the
claim must pay the fee out to `fee.address` (it's honor-system — the coordinator is keyless and doesn't
validate claim outputs). The bot splits it exactly like the reference client: it nets `terms.btcSats`,
the claim's network fee comes out of the reserve, and the platform remainder goes to `fee.address`. With
no fee configured it just pays its own network fee from the amount.

## Open follow-ups
- **Two-sided quoting** — an Alice-role fulfill (fund BTC, hold the secret, claim QBT on reveal) so the
  bot can also make the **bid** side (retail selling QBT to it). Until then, quote ask-only.
- **Dynamic claim/refund fees** — `feeSats` is a fixed per-leg network fee; the reference client sizes
  BTC claims at the live mempool rate. Under fee pressure a fixed fee can underpay and stall a claim.
- **Concurrency/inventory caps** — `policy.maxQbtSats` bounds a single swap, but there's no global
  cap on simultaneous in-flight QBT exposure.
