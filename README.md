**English** · [简体中文](README.zh-CN.md)

# qbit-swap

[![CI](https://github.com/deezy-inc/qbit-swap/actions/workflows/ci.yml/badge.svg)](https://github.com/deezy-inc/qbit-swap/actions/workflows/ci.yml)

Non-custodial atomic swaps between **Bitcoin (BTC)** and **Qbit (QBT)** — a post-quantum Bitcoin fork
(SLH-DSA signatures, `p2mr` witness-v2 addresses). Users trade peer-to-peer through a **keyless
coordinator**: all keys are ephemeral and generated in the user's browser, all signing happens
client-side, and the coordinator only watches the chains and relays party-signed transactions. It holds
no keys and can't move funds on its own; a stalled swap always refunds. (One trust assumption remains —
it's relied on to relay each party's pubkey honestly; see `webapp/README.md` › Trust
assumptions.)

> Bitcoin ↔ Qbit can't use a shared-Schnorr construction (Qbit signs with SLH-DSA, not Schnorr), so
> this uses a classic hash-timelock (Tier-Nolan) atomic swap: one preimage links both legs.

## Repository layout

| Path | What it is | Public |
|---|---|---|
| `client/` | **Client library** (`@qbit-swap/client`) — HTLC construction + sighash + signing for both legs; browser + Node. WASM SLH-DSA signer bundled. | ✅ |
| `coordinator/` | **Keyless coordinator** — Tier-Nolan state machine, reorg-safe confirmation gating, refund side-paths, SSE live feed, presence, pluggable chain backends. | ✅ |
| `webapp/` | **Web app** — a wallet-agnostic, one-decision-per-screen wizard (EN / 简体中文). Ephemeral keys, in-page signing, plaintext backup file. | ✅ |
| `maker-bot/` | **Market-maker bot** — reference maker for the RFQ instant-swap API: streams two-sided quotes, fulfills matches in either role, inventory-aware sizing, pluggable wallet adapter. | ✅ |
| `reference/*.py` | Python reference implementation + regtest validation scripts. | ✅ |

## How a swap works

1. Either side opens the web app and picks a direction (BTC→QBT or QBT→BTC). The **initiator** holds a
   secret `s` with `H = SHA256(s)`.
2. Both legs are funded to HTLC addresses derived from `H` and the two parties' pubkeys. The
   initiator funds the leg it sends (longer timelock); the participant funds the other (shorter).
3. The initiator claims the leg it receives, revealing `s` on-chain. The participant reads `s` and
   claims the other leg. If either side stalls past the timelocks, each refunds its own deposit.

The coordinator gates the initiator's claim on **reorg-safe confirmations** via Qbit's
`getconfirmationtarget` RPC, and surfaces the preimage + refundability over an SSE feed.

The default experience is **peer-to-peer** (share a private link with a counterparty). An optional
maker/taker **order book** — makers post offers, takers click to buy/sell — exists behind a web-app
feature flag (`window.QBIT_ORDERBOOK`, default off) with coordinator support in `offers.js`.

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

The coordinator (`swap.js` `driveWatchtower` + `fees.js`) then acts **only for a party that has actually
gone offline** (presence, ~15 s grace, so it never races a live client): it broadcasts the initiator's
claim when the leg matures (revealing `s`), splices `s` into the participant's pre-signed claim and
broadcasts it, or broadcasts a refund after the timelock on abort. It picks/escalates ladder tiers using
cached **mempool.space** feerates (full-RBF is the network default, so no RBF signaling is needed).

**Non-custodial:** every stored transaction is already signed to pay only its owner's address, and the
coordinator holds no keys — the worst it can do is fail to help, never redirect funds. With both parties
armed, a swap runs to completion or refund with **nobody's tab open**. The web app requires this
pre-signing before it tells you it's safe to close (`webapp/README.md`); proven end to end in
`webapp/test/watchtower.e2e.mjs`.

## Backends (what infrastructure you need)

The coordinator only does chain **reads + broadcast** (it's keyless). Each chain picks a backend via
env — see `coordinator/chain.js`:

- **Qbit — required: your own `qbitd`.** The coordinator ships no Esplora-style QBT data client, and the
  reorg-safe conf gate is a `qbitd` RPC, so point it at your own node: `QBIT_BACKEND=rpc` +
  `QBIT_RPC_URL=...`. (This is only the coordinator's data source — QBT txs are as broadcastable as BTC.)
- **Bitcoin — three options:**

  | `BTC_BACKEND` | Node | Disk | Rough $/mo (AWS) | Notes |
  |---|---|---|---|---|
  | `rpc` (watch-only wallet) | **pruned** Bitcoin Core | ~30–50 GB | **~$110–180** | cheapest; forward-only address watching; never uses `scantxoutset` |
  | `esplora` → `mempool.space` | none | 0 | **$0** | fastest to start; rate-limited + leaks watched addresses |
  | `esplora` → self-hosted electrs | **full** Core + electrs | ~2 TB | ~$265–450 | richest; heaviest (esplora REST index is large) |

  The `esplora` backend includes rate-limit handling (min-interval throttle + 429/5xx backoff) and
  works against any Esplora REST endpoint (`ESPLORA_URL`). The `rpc` backend uses a **watch-only
  wallet** (import each HTLC address forward-only) — never `scantxoutset`, which rescans the whole
  UTXO set and is unusable on mainnet.

  **Recommended:** start on `mempool.space` (free), move to a **pruned node + `rpc`** for cost, or
  self-host electrs if you want the REST API with no third party. Keep the node box **private**,
  separate from the public coordinator (which is the attack surface).

## Running it (regtest)

Each component has its own README:
- `client/README.md` — client library + browser/Node signer, tests.
- `coordinator/README.md` — API, state machine, backends, demos (`demo.js`, `refund_demo.js`).
- `webapp/README.md` — build the app, run the wizard e2e, the trial deployment.

A local regtest lab drives the transport via env (`<CHAIN>_CLI`, optional `<CHAIN>_SSH_HOST`); no
hostnames are baked into the code.

## License

MIT — see [LICENSE](LICENSE).
