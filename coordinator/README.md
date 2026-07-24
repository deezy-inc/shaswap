**English** · [简体中文](README.zh-CN.md)

# qbit-swap coordinator

A **keyless, non-custodial** service that orchestrates BTC↔QBT atomic swaps. It never holds keys,
funds, or the preimage (until it's public on-chain). It derives the two HTLC addresses, watches both
chains, gates the claim on reorg-safe confirmations (`getconfirmationtarget`), broadcasts
party-signed transactions, and surfaces the revealed preimage. Both the browser web app and a
headless market-maker **bot** drive it through the same HTTP API.

## Pieces
- `chain.js` — keyless chain adapter for both nodes (height, `getconfirmationtarget`, `scantxoutset`
  funding watch, confirmations, `testmempoolaccept`/`sendrawtransaction`). Dev transport shells to the
  regtest CLIs over ssh; a prod adapter swaps `rpc()` for direct JSON-RPC.
- `swap.js` — swap store + Tier-Nolan state machine
  (`CREATED→READY→BTC_FUNDED→QBT_FUNDED→MATURING→CLAIMABLE→CLAIMED→COMPLETE`, plus `REFUNDED`/`ABORTED`).
- `server.js` — HTTP/JSON API + a chain-watcher loop; auth via a per-party capability token.
- `admin.js` — **read-only monitoring dashboard** (see below).
- `demo.js` — two headless bots run a full swap through the API, signing client-side with `../js`.

## Admin dashboard (`admin.js`)
A separate in-process HTTP server (`startAdmin(port)`, default `8790`) that gives the operator a live
view of the store — overview counts, chain heights/backends, a filterable table of every swap (state,
amounts, funding, party presence, watchtower-armed status), the order book, and an SSE activity feed.
It reads the live in-memory store directly (no DB polling; global `subscribeAll` drives the feed),
exposes **no mutation endpoints**, and **redacts capability tokens**. Gated by `ADMIN_TOKEN`
(`?token=` or `X-Admin-Token`; a random one is generated + logged if unset). `serve.js`/`trial.js` start
it automatically unless `ADMIN=off`. It is meant to be reached over a private network (e.g. the tailnet),
never exposed publicly — bind with `ADMIN_BIND` and keep it off any public reverse proxy.
- `GET /` dashboard · `GET /api/overview` · `GET /api/swaps[?state=]` · `GET /api/swaps/:id` ·
  `GET /api/offers` · `GET /stream` (SSE)

## API (auth: `X-Swap-Token`, header or `?token=`)
- `POST /swaps` → `{ id, tokens: { alice, bob } }` (Alice shares Bob's token as his link)
- `POST /swaps/:id/party` — submit `{ qbitPub, btcPub, btcDest, qbitDest, H? }`
- `GET  /swaps/:id` — the party's view: both legs' HTLC addresses, funding (+`spent`), confs, chain
  `heights`, `state`, `refund` availability per leg, and `preimage` (only once public on-chain)
- `GET  /swaps/:id/events` — **Server-Sent Events**: the same view pushed on every state change (the
  web app and bots subscribe instead of polling)
- `POST /swaps/:id/broadcast` — submit `{ leg, kind, tx }` (`kind`: `claim` | `refund`) to broadcast
- `POST /swaps/:id/finish` — **watchtower**: submit a pre-signed `{ claim: { leg, needsPreimage, tiers:[{feerate,tx}] }, refund: { leg, tx } }` so the coordinator finishes the swap even if you go offline

The watcher surfaces `refund.{qbit,btc}.available` once a funded, still-unspent leg's timelock passes,
and flags a leg `spent` when its claim/refund lands (via the API or directly) — so a swap that
resolves out-of-band still reaches a terminal state.

## Watchtower (`swap.js` `driveWatchtower` + `fees.js`)
Once both legs are funded, each party pre-signs and uploads (`/finish`) a **fee-ladder claim** (several
feerate tiers) and a **refund**. The coordinator then drives the swap to completion or refund even if
both tabs close: it broadcasts the initiator's claim when the leg matures (revealing the preimage),
splices that preimage into the participant's pre-signed claim and broadcasts it, or broadcasts a party's
refund after its timelock on abort. It picks/escalates ladder tiers using cached mempool.space feerates
(`fees.js`, `FEES_TTL_MS`). **Non-custodial:** every stored tx pays only its owner's address and the
coordinator holds no keys — it can only help, never redirect. Full-RBF is the network default, so tiers
need no RBF signaling. Proven by `../webapp/test/watchtower.e2e.mjs` (both parties arm, close their
tabs, coordinator finishes).

## Order book API (optional — `offers.js`)
A maker/taker layer on top of the swap engine (the web app gates it behind a flag; see its README).
- `POST /offers` — maker posts one lot `{ giveCoin, giveSats, wantCoin, wantSats }` → `{ id, makerToken }`
- `GET  /offers` — public book: `{ asks, bids }` (QBT priced in BTC; ask = sell QBT for BTC), best price first
- `POST /offers/:id/take` — instantiate a swap from the offer (taker = initiator) → `{ swapId, takerToken, direction, terms }`
- `GET  /offers/:id?makerToken=…` — maker view incl. the take (its swap token) so it can fulfill
- `POST /offers/:id/cancel` (maker token) — withdraw an open offer

## RFQ API (optional — `rfq.js`, powers the web app's instant-swap widget)
Authorized market-maker BOTS stream two-sided quotes; retail takes the best live price in one click.
Unlike the order book (standing one-lot offers), an RFQ quote must be actively re-pinged: if a bot goes
silent its liquidity drops out after `RFQ_TTL_MS` (default 30 s), so the widget never quotes a price
nobody stands behind. Enabled only when `RFQ_MAKER_KEYS=name:key,name2:key2` is set. Prices are BTC per
QBT; sizes are `qbtSats`; `bid` = maker buys QBT (retail sells into it), `ask` = maker sells QBT.
- `POST /rfq/maker` (header `X-Maker-Key`) — the bot's whole control loop: (re)state `{ bid?, ask? }`
  (a present side replaces, an absent side carries forward — `{}` is a pure keep-alive), refresh the
  TTL, and receive `matches`: takes awaiting this maker, each with the maker's swap token + role.
  Matches re-deliver every ping until the maker joins the swap (no ack protocol), then it fulfills
  through the ordinary per-swap API like any party. The full reference bot lives in `../maker-bot/`
  (two-sided quoting, inventory-aware sizing, wallet adapter); `webapp/deploy/rfq-maker-trial.js` is a
  minimal regtest-lab variant.
- `GET  /rfq` — public depth: best price + total size per side (`enabled:false` when no makers configured)
- `GET  /rfq/quote?side=buy|sell&btcSats=|qbtSats=` — best single-maker fill for a size (rounding always
  favors the maker); `409` when live liquidity can't cover it
- `POST /rfq/take` `{ side, btcSats|qbtSats, price }` — limit semantics: fills at `price` or better,
  else `409` "price moved" with a fresh quote. Creates the swap → `{ swapId, token, role, terms }`
  (retail buy → taker = alice/initiator; retail sell → taker = bob, the maker initiates).
- `GET  /rfq/plan?side&btcSats|qbtSats` — **multi-maker** routing: fills a size no single maker covers by
  walking the book best-price-first. Returns the volume-weighted `price` + per-leg breakdown; a thin book
  yields a partial (`complete:false`). Sub-min remainders are dropped, not made into dust swaps.
- `POST /rfq/order` `{ side, btcSats|qbtSats, price }` — take a plan, gated on the aggregate (VWAP) limit.
  Opens one swap per leg under a shared `orderId` → `{ orderId, price, qbtSats, btcSats, legs:[{ swapId,
  token, role, terms }] }`. The legs are **independent** swaps (each completes or refunds on its own, so a
  partial fill is possible); the taker drives each leg like any `/rfq/take` swap.

Fees are **taker-pays** on RFQ (peer link swaps keep the buyer-pays gross-up): a buy already charges
the taker (they're the BTC sender, funding `terms + fee`); a sell quotes the taker's BTC proceeds NET
of the fee (`takerNetOfGross`), so the maker's all-in outlay equals exactly its quoted price × size.

**Reputation / fill-rate.** The coordinator can't lock a maker's funds, so it watches what each maker
actually does: of the matches where it was *cleared to fund*, how often it funded its leg. Attribution
is fault-aware — a taker who never funds their own first leg is not charged against the maker (on a buy
the maker legitimately can't fund until the taker's BTC buries). A maker with `RFQ_REP_SUSPEND` no-shows
inside `RFQ_REP_WINDOW_MS` is auto-suspended (its quotes stop being served) until the bad marks age out.
Per-maker stats (`fillRate`, `noShow`, `suspended`, …) surface in the admin overview's `rfq` section.
Knobs: `RFQ_REP_GRACE_MS` (15m — how long a cleared-but-unfunded match waits before it's a no-show),
`RFQ_REP_WINDOW_MS` (1h), `RFQ_REP_SUSPEND` (3; 0 disables).

## Backends (env, per chain — see `chain.js`)
Each chain picks a backend via `<CHAIN>_BACKEND` (falls back to `COORD_CHAIN`, then `dev`):
- **`dev`** — shells to a node CLI. Set `<CHAIN>_CLI` and, to run remotely, `<CHAIN>_SSH_HOST`
  (empty = local). This is the regtest-lab transport; `findOutput` uses `scantxoutset` (fine only on a
  tiny regtest UTXO set).
- **`rpc`** — JSON-RPC over HTTP; set `<CHAIN>_RPC_URL` (e.g. `http://user:pass@host:port`). Funding
  watch method is per-chain via `<CHAIN>_WATCH` (default: BTC `wallet`, QBT `scan`):
  - `wallet` (Bitcoin default) — a **forward-only watch-only wallet** (`importdescriptors timestamp:"now"`
    + `listunspent`), never `scantxoutset`, so it works against a **pruned** Bitcoin node (`getTx` reads
    via the wallet, no `txindex`).
  - `scan` (Qbit default) — `scantxoutset`, which is cheap on a small UTXO set (Qbit's young chain) and
    avoids depending on wallet tracking of `p2mr` (witness-v2) descriptors. A full (unpruned) qbitd is
    cheap anyway since the whole chain is small.
  The wallet path runs a background job that rotates the wallet to drop settled swaps' descriptors so it
  can't balloon
  — **count-driven, not time-driven**: it only rotates once `WATCH_PRUNE_THRESHOLD` (default 500) stale
  descriptors have amortized (a few hundred is harmless), checked every `WATCH_CLEANUP_MS` (default 6h).
  A descriptor is kept while its swap is non-terminal (the **whole recovery/refund window**, which may be
  long) plus a `WATCH_SETTLE_GRACE_MS` grace after settling (default 24h), so it's never dropped while a
  counterparty might still be refunding. (Even if one were, funds are never at risk — the wallet is only
  for funding *detection*; parties refund with their own keys.) `WATCH_WALLET` sets the wallet name.
- **`esplora`** — mempool.space / self-hosted electrs REST for the **BTC leg** (no Bitcoin node needed);
  set `ESPLORA_URL` (default `https://mempool.space/api`). Indexed scripthash lookups + built-in
  rate-limit handling (`ESPLORA_MIN_INTERVAL_MS`, `ESPLORA_MAX_RETRIES`). This backend is BTC-only, so the
  QBT leg uses `dev`/`rpc` against your own `qbitd` (its data source — unrelated to how broadcastable QBT is).

Other knobs: `COORD_DB=/path/state.db` (**sqlite** persistence via `node:sqlite` — one row per swap,
UPSERTed per change so `touch()` is O(1), not a full-file rewrite; the swap is a JSON column, queryable
with JSON1: `SELECT id FROM swaps WHERE json_extract(data,'$.state')='COMPLETE'`. A `.json` path uses the
legacy atomic-snapshot backend instead; a fresh `.db` next to an existing `.json` imports it on first
boot. Default: in-memory, no persistence. `persistence` in `/api/overview` shows the active backend.) ·
`RATE_MAX=120`
(per-IP writes/min) · `DEV_CONFS_CAP` (cap the reorg-safe conf gate on hashrate-less regtest).

### HTLC addresses + timelocks (set these for the deploy network)
- `BTC_HRP` / `QBIT_HRP` — hrp for the HTLC **deposit addresses** the coordinator hands out. Must match
  the network: `bcrt`/`qbrt` (regtest, default), `tb`/`tqb` (testnet), `bc`/`qb` (mainnet). Wrong hrp =
  an address the user's wallet can't pay.
- **Timelocks are wall-clock**, not raw blocks. `HTLC_FROM_SECS` (initiator's leg, longer; default 24h)
  and `HTLC_TO_SECS` (participant's leg, shorter; default 12h) are each converted to a block count on
  their own chain via `BTC_BLOCK_SECS` (600) / `QBIT_BLOCK_SECS` (60). This keeps the Tier-Nolan
  ordering (initiator's leg outlasts the participant's, in real time) correct in **both** directions
  despite BTC's ~10 min vs QBT's ~60 s blocks. `HTLC_FROM_SECS` must exceed `HTLC_TO_SECS` (enforced).
  For a fast regtest lab, set the block times to `1` and the windows to `20`/`40` (see `deploy/lab.env`).

### Coordinator fee (optional — `feeaddr.js`)
Off by default. When on, the fee is charged **on top** of the buyer's BTC deposit (the seller nets the
full swap amount) and paid to a **fresh watch-only taproot address per swap** — the coordinator never
holds the fee key.
- `FEE_BPS` — platform fee in basis points (`200` = 2%). `0` (default) = fee off.
- `FEE_XPUB` — watch-only xpub the fee addresses derive from (BIP86 taproot, path `/0/<index>`, a fresh
  index per swap). `FEE_DESCRIPTOR` (a `tr(...)` descriptor) is accepted instead.
- `FEE_VERIFY_ADDRESS` + `FEE_VERIFY_ADDRESS_PATH` — optional startup assertion: derive the address at
  that path from `FEE_XPUB` and **refuse to start** unless it matches (guards a wrong/typo'd xpub).
  Default path `0/0`.
- `FEE_MIN_SATS` — skip the fee entirely if the total would fall below this (default `1000`).
- `FEE_NET_BUFFER` — the quote also reserves an estimated on-chain claim fee = `208 vB × live fastest-fee
  × FEE_NET_BUFFER` (default `3`), so a claim can outbid a fee spike between quote and claim. The claim
  **caps** the fee it takes at this reserve, so it can never reduce the seller's amount; the platform
  keeps the unused remainder. Tune up for more spike headroom (bigger quote), down when fees are
  structurally high (the multiplier already grows the absolute reserve). Not a safety knob — the cap
  protects the seller at any value.

### Minimum swap value
- `MIN_BTC_SATS` / `MIN_QBT_SATS` — reject swaps below these (default `50000` / `200000`), kept above the
  largest claim/refund fee + dust. The web app reads them (injected) to validate up front.

## Run the demos
Needs the two regtest nodes up (see `../wasm`/`../js`). Then:
```sh
DEV_CONFS_CAP=2 node demo.js         # happy path: full swap -> COMPLETE
DEV_CONFS_CAP=2 node refund_demo.js  # abort path: both parties refund -> REFUNDED, no preimage
```
`demo.js` creates a swap, both bots join, funds both HTLCs, matures the QBT leg, Alice claims QBT
(WASM SLH-DSA, revealing the preimage), Bob reads it and claims BTC. `refund_demo.js` funds both legs
then stalls; once the timelocks pass, Bob refunds his QBT and Alice refunds her BTC — proving the
non-custodial abort guarantee (nobody is left short).

## Not yet (next)
- The browser web app on top of `../js` (file backup + passkey-PRF/password-encrypted IndexedDB key
  management); reorg-aware height tracking already feeds the watcher.
