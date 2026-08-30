**English** · [简体中文](README.zh-CN.md)

# shaswap

[![CI](https://github.com/deezy-inc/shaswap/actions/workflows/ci.yml/badge.svg)](https://github.com/deezy-inc/shaswap/actions/workflows/ci.yml)

**Trustless atomic swaps between Bitcoin forks** — and, more generally, between Bitcoin and any UTXO
chain that speaks Bitcoin-Core-compatible RPC. When a chain splits, holders on both sides need a way to
trade one side for the other **without an exchange, without custody, and without trusting the
counterparty**. shaswap is that venue: hash-timelock (Tier-Nolan) atomic swaps driven by a **keyless
coordinator** — all keys are ephemeral and generated in the user's browser, all signing happens
client-side, and the coordinator only watches the chains and relays party-signed transactions. It holds
no keys and can't move funds on its own; a stalled swap always refunds. (One trust assumption remains —
it's relied on to relay each party's pubkey honestly; see `webapp/README.md` › Trust assumptions.)

The chain pair is **one config value** (`CHAIN2`, see `coordinator/chains.js`):

- **`CHAIN2=bip110`** — **BTC-SHA256 ⇄ BTC-Blake2b**: real Bitcoin against the BIP-110 fork (Bitcoin
  Knots v29.4.x lineage — RDTS active, Blake2b proof of work). Standard Bitcoin script on both legs
  (P2WSH + ECDSA), with **fork replay protection built in and enforced**: every BTC-side sweep carries
  an OP_RETURN payload larger than the 83-byte datacarrier limit, which BIP-110 policy itself refuses
  to relay or mine — so a sweep settles on exactly one side of the split. The coordinator rejects
  marker-less sweeps; clients build the marker automatically.
- **`CHAIN2=qbit`** *(default)* — **BTC ⇄ QBT**: Qbit, a post-quantum Bitcoin fork (SLH-DSA
  signatures, `p2mr` witness-v2 addresses). Since Qbit can't share a Schnorr construction, both presets
  use the same classic HTLC design: one preimage links both legs.

Everything about a leg is per-slot config: script family (`p2wsh-ecdsa` | `p2mr-slhdsa`), bech32 hrp,
block time, minimum size, confirmation floor, reorg-cost model (BTC subsidy-priced, node-RPC-priced, or
fixed depth), an optional **trust-unconfirmed** mode (sweep at 0-conf between trusted parties), and the
replay-protection flag. Adding another fork is a preset, not a rewrite.

## Repository layout

| Path | What it is |
|---|---|
| `client/` | **Client library** (`@qbit-swap/client`) — HTLC construction + sighash + signing for both script families (ECDSA and WASM SLH-DSA), replay-marker builder; browser + Node. |
| `coordinator/` | **Keyless coordinator** — Tier-Nolan state machine, per-leg chain config (`chains.js`), value-scaled reorg gating, replay-marker enforcement, watchtower, RFQ maker API, sqlite persistence, admin dashboard. |
| `webapp/` | **Web app** — wallet-agnostic, one-decision-per-screen wizard (EN / 简体中文); pair-aware labels (e.g. BTC-SHA256 ⇄ BTC-Blake2b); instant-swap widget backed by maker liquidity. |
| `maker-bot/` | **Market-maker bot** — reference maker for the RFQ API: two-sided quotes, USD pegs, inventory-aware sizing, crash-safe key store, Telegram ops bot, node-less light mode. |
| `reference/*.py` | Python reference implementation + regtest validation scripts. |

## How a swap works

1. Either side opens the web app and picks a direction. The **initiator** holds a secret `s` with
   `H = SHA256(s)`.
2. Both legs are funded to HTLC addresses derived from `H` and the two parties' pubkeys — in forced
   sequence (initiator first, participant only after that deposit is irreversibly buried). The
   initiator's leg carries the longer timelock.
3. The initiator claims the leg it receives, revealing `s` on-chain. The participant reads `s` and
   claims the other leg. If either side stalls past the timelocks, each refunds its own deposit. On a
   replay-protected leg, every one of these sweeps carries the >83-byte OP_RETURN marker.

The coordinator gates the reveal on **reorg-safe confirmations** — value-scaled per the leg's
configured cost model — and surfaces the preimage + refundability over an SSE feed.

The default experience is **peer-to-peer** (share a private link with a counterparty). For retail,
an **instant-swap widget** (feature flag `QBIT_RFQ`) quotes live market-maker liquidity through the
coordinator's RFQ API — one click routes into the same non-custodial flow, including multi-maker fills
funded by a single deposit. An optional maker/taker **order book** exists behind `QBIT_ORDERBOOK`.

## Watchtower — finishing swaps when a party goes offline

An atomic swap has a hard requirement: once the initiator reveals `s`, the participant **must** claim
before their timelock, or the initiator could refund and take both sides. So a party who closes their
tab at the wrong moment could lose out. The watchtower removes that risk **without any custody**.

**The key insight:** a signature over a claim/refund transaction does **not** cover the preimage — the
preimage is a separate witness element the script checks at spend time. So the transactions can be
*pre-signed* and handed to a watchtower that can only ever complete them **to the party's own address**.

Once both legs are funded, each browser automatically pre-signs and uploads (`POST /swaps/:id/finish`):

- a **fee-ladder claim** of the leg it receives — several tiers at increasing feerates (the participant
  signs it *preimage-less*, with an empty slot the coordinator fills once `s` is public); and
- a **refund** of the leg it funded.

The coordinator (`swap.js` `driveWatchtower` + `fees.js`) broadcasts the right pre-signed transaction
as soon as its chain condition is met, escalating ladder tiers with live feerates. On a
replay-protected leg, bundles are rejected at upload unless every tier carries the marker.

**Non-custodial:** every stored transaction is already signed to pay only its owner's address, and the
coordinator holds no keys — the worst it can do is fail to help, never redirect funds. With both parties
armed, a swap runs to completion or refund with **nobody's tab open**. Proven end to end in
`webapp/test/watchtower.e2e.mjs`.

## Backends (what infrastructure you need)

The coordinator only does chain **reads + broadcast** (it's keyless). Each leg picks a backend via env
(`coordinator/chain.js`): `rpc` against your own node (pruned works — funding detection uses a
forward-only **watch-only wallet**, never `scantxoutset`), or `esplora` against any Esplora REST
endpoint (rate-limit handling included) for the BTC side. For a fork pair, run one node per side —
e.g. a pruned Bitcoin Core and a pruned Knots/BIP-110 node; both are cheap. Keep node boxes **private**,
separate from the public coordinator (which is the attack surface).

## Running it

Each component has its own README:
- `client/README.md` — client library + browser/Node signer, tests.
- `coordinator/README.md` — API, state machine, chain-pair config, backends, demos.
- `webapp/README.md` — build the app, run the wizard e2e, feature flags.
- `maker-bot/README.md` — run a market maker (one command; USD-pegged quotes; light mode).

The full protocol is covered by mock-chain e2e suites (`webapp/test/forkpair.e2e.mjs` drives a complete
BTC-SHA256 ⇄ BTC-Blake2b swap, replay enforcement included) plus a regtest lab for on-chain validation.

## License

MIT — see [LICENSE](LICENSE).
