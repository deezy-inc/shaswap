# qbit-swap-mm (PRIVATE)

Automated market-maker bots that fulfill BTC↔QBT atomic swaps on our behalf. **Private** — kept
separate from the open-source stack.

It builds on the open-source pieces (which stay public):
- the **client library** (`@qbit-swap/client`, the `swaplib/js` package) — key gen, HTLC construction,
  P2MR/BIP143 sighash, WASM SLH-DSA + ECDSA signing;
- the **coordinator HTTP API** — the maker joins/fulfills swaps through the same endpoints anyone else
  would use.

A maker bot adds the *decision layer* on top: which swaps to take, pricing, inventory/liquidity
management, and running many swaps concurrently — signing everything client-side (non-custodial).

## Layout
- `maker-bot.js` — a single-party autonomous maker: given a swap it decides to take, it joins as the
  counterparty, funds its leg, watches the coordinator, and claims (or refunds on timeout) — the same
  mechanical flow the reference client uses, wrapped in an autonomous accept/price/execute loop.

## Dev
Depends on the public client library. For local dev it references it directly; in production it
consumes the published `@qbit-swap/client` package and points at a coordinator URL.
