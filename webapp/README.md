**English** · [简体中文](README.zh-CN.md)

# qbit-swap web app

A **wallet-agnostic, non-custodial** browser app for BTC⇄QBT atomic swaps. The browser generates
ephemeral per-swap keys, signs its own claim/refund entirely in-page (WASM SLH-DSA for the Qbit leg,
ECDSA for the Bitcoin leg), and talks to a **keyless coordinator** that only relays and broadcasts.
The app never asks which wallet you use — you paste a receiving address of any type and send funds
from wherever you like.

## How it works
- The UI is a **one-decision-per-screen wizard**. The first screen is the only real choice — *which
  way do you want to swap?* — so **either side can initiate** (`btc2qbt` or `qbt2btc`).
- The creator is the **initiator** (holds the secret): funds the leg they send (longer timelock),
  claims the leg they receive (revealing the preimage). The joiner is the **participant**: funds the
  leg they send, claims the other with the now-public preimage.
- Each side enters only the addresses it needs (a receive address, and a refund address used only on
  cancel); the app decodes them to scriptPubKeys client-side (`addressToScriptPubKey` handles
  P2WPKH/P2WSH, P2TR, qbit P2MR, and legacy P2PKH/P2SH).
- The app drives the swap on the coordinator's live feed (SSE) and **auto-signs** claim/refund. If the
  swap stalls past the timelocks, each side auto-refunds its own deposit.
- **Watchtower safety net (default):** once both legs are funded, the app pre-signs a fee-ladder claim
  + a refund and uploads them, so the coordinator finishes (or refunds) the swap even if you close the
  tab. Until it's armed, the app warns you not to leave (`beforeunload`) — pays only to your addresses,
  non-custodial. Proven by `test/watchtower.e2e.mjs`.
- A **live presence indicator** shows whether your counterparty is online (from their SSE/API activity).
- UI is bilingual (**English / 简体中文**) via `src/i18n.js` — a header switcher, choice persisted.

## Order book (feature-flagged, default OFF)
There's an optional maker/taker **order book**: makers post offers, the landing shows the relevant side
for your chosen direction, and you click one to buy/sell (it takes the offer and runs the taker wizard).
It's gated behind `window.QBIT_ORDERBOOK` (default off) — with it off, choosing a direction goes
straight to the peer-to-peer flow, which is the primary experience. See `deploy/maker-trial.js` for a
regtest maker that posts asks + fulfills takes.

## Instant swap widget (feature-flagged, default OFF)
A Uniswap-style **one-click swap card** on the landing hero, priced from live market-maker bot
liquidity (the coordinator's `/rfq` API): pick a direction, type an amount on either side, the best
live price fills the other side, and one click routes into the normal non-custodial flow (addresses →
backup → live swap) with the winning maker as counterparty. Quotes are limit-protected — if the price
moves against you between quote and confirm, you're shown the fresh price and asked to accept it,
never filled worse. Gated behind `window.QBIT_RFQ` (default off); the widget also hides itself when
the coordinator has no makers configured. The reference maker bot lives in `../maker-bot/`
(`deploy/rfq-maker-trial.js` is a minimal regtest-lab variant).
Fees are taker-pays: on a buy the fee is added on top of the BTC you send; on a sell your quoted BTC
proceeds are already net of it (the widget says so under the receive panel).

## Key protection (`src/keystore.js`)
For now (product decision) the ephemeral secrets are kept in the **clear**: a plaintext backup file
the user downloads, plus a plaintext IndexedDB copy so a reload can resume. One file protects one
short-lived swap; losing it can only lose that single swap (ephemeral keys, no shared seed), and a
stalled swap still refunds. Drop the file back into the app to finish or refund; the record is purged
on settle. *(An encrypted-envelope version — passphrase + WebAuthn-PRF passkey, `src/passkey.js` — is
preserved in git history and can be re-enabled for at-rest protection.)*

## Build & serve
```sh
npm install          # pulls @qbit-swap/client (file:../js)
npm run build        # -> dist/app.js (single self-contained module; WASM embedded, no external fetch)
python3 -m http.server 8080    # or any static server; open http://localhost:8080
```
The bundle targets the browser, so esbuild swaps the Node WASM signer for `signer.web.js` automatically.
Set the coordinator URL in the create form (or `window.QBIT_COORDINATOR`).

## Tests
- `npm test` — headless key-store round-trip (plaintext backup + vault save/list/purge).
- `DEV_CONFS_CAP=2 node test/bidir.e2e.mjs` (needs the regtest lab) — drives the real `SwapClient`
  through a full swap **in both directions** to COMPLETE against the live coordinator and chains.
- `TRIAL_URL=https://<host> node test/browser.e2e.mjs` (needs a running trial) — Playwright drives the
  actual wizard UI (creator + participant, both directions) through the faucet to COMPLETE.
- `DEV_CONFS_CAP=2 node test/premature.e2e.mjs` (needs the regtest lab) — each party tries to broadcast
  a sweep **before maturity**: the CLTV-locked refunds are rejected as `non-final` (by the node and the
  coordinator) until the chain reaches the timelock, while a claim (no timelock) is accepted immediately.

## Security notes
- Keys never leave the browser; the coordinator is keyless and sees only public data (and the preimage
  only once it's on-chain).
- **HTLC verification:** before showing a deposit address, the client independently re-derives both
  HTLC scriptPubKeys from its own keys + the counterparty pubkey + `H` + locktimes and checks they match
  the coordinator's — a derivation bug (or tampering) that produced a script it can't claim/refund halts
  the swap before any funds move (`SwapClient.verifyHtlc`).
- **Address validation:** receive/refund addresses are checked to be a valid address *on the right chain*
  (`addressCoin`) **and the right network** (`addressOnNetwork` — a deploy sets `window.QBIT_HRPS`, e.g.
  `{btc:"bc",qbit:"qb"}` for mainnet). So a BTC address can't be entered where a QBT one is needed, **and**
  a testnet/regtest address pasted into a mainnet swap is rejected — either would otherwise send funds to
  an output the swap can't spend.
- **Underfunding:** the coordinator only counts a leg as funded once the deposit meets the agreed amount,
  so a counterparty can't underfund their HTLC and short the other side.
- **Single-use link:** the first party to join a trade link claims the participant slot; a second person
  opening the same link is rejected rather than racing to replace them.
- One backup file protects one swap; losing it before settling can only ever lose that single swap
  (ephemeral keys, no shared seed) — and a stalled swap refunds. Backups are plaintext for now.

### Trust assumptions
- **The coordinator is trusted to relay the counterparty's pubkey honestly.** The client verifies each
  HTLC is built from its *own* keys, but it takes the *counterparty's* pubkey as reported by the
  coordinator. A malicious operator could therefore MITM the pubkey exchange and steal after the preimage
  is revealed. This is out of scope for the current model (honest-but-keyless coordinator); it does **not**
  apply to a coordinator bug — those are caught by the HTLC self-verification above. Closing it fully
  would need an out-of-band SAS/fingerprint the two parties compare before funding (à la Signal safety
  numbers). Not implemented.
- **Fee economics are pinned at agreement time.** The coordinator-supplied fee (`fee.sats`/`fee.address`)
  is captured once at create/join and never re-read from the live view, so a compromised coordinator can't
  inflate it at claim time to drain a claim output. The network fee for live claims/refunds is additionally
  hard-capped (≤5% of the funded amount, ≥10k sats) as a defense-in-depth bound.
- **Timelocks** are currently `+20/+40` blocks; before mainnet they must be tuned in wall-clock per chain
  (BTC ~10 min vs QBT ~60 s blocks) so the claim window survives a fee spike + a few RBF rounds.
