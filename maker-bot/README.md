# maker-bot

An autonomous market-maker bot that fulfills BTC↔QBT atomic swaps — the reference implementation of
the maker side of this stack, and a starting point for running your own.

It builds on the sibling packages in this repo:
- the **client library** (`@qbit-swap/client`, `../client`) — key gen, HTLC construction, P2MR/BIP143
  sighash, WASM SLH-DSA + ECDSA signing;
- the **coordinator HTTP API** — the maker joins/fulfills swaps through the same endpoints anyone else
  would use (nothing here is privileged beyond the RFQ maker key).

A maker bot adds the *decision layer* on top: which swaps to take, pricing, inventory/liquidity
management, and running many swaps concurrently — signing everything client-side (non-custodial). It
never hands keys to anyone, and it can only ever recover its own funds.

## Layout
- `maker-bot.js` — the autonomous maker: prices swaps, joins as the right role, funds its leg, and
  claims (or refunds) — signing every HTLC tx in-process with throwaway per-swap keys.
- `wallets.js` — the **wallet adapter**: the only thing that touches your coins (see below).
- `run.js` — reference runner: connect wallets + stream a two-sided quote. `node run.js`.
- `test/e2e.mock.mjs` + `test/mockchain.mjs` — end-to-end tests: the **real coordinator + real bot over
  the real HTTP API**, with an in-memory chain standing in for regtest nodes.

## Connecting your wallets
The bot is wallet-agnostic and **never holds a key or a seed**. It reaches your coins only through an
injected `wallet` adapter — six methods — and signs every HTLC claim/refund itself with ephemeral,
per-swap keys. So your wallet's job is small: hand out fresh addresses, report chain height, and send to
an HTLC address. Claimed funds land back at addresses your wallet owns.

```js
// The interface the bot expects:
//   btcHeight() / qbitHeight()  -> Promise<number>            current tip (funding/refund gates)
//   newBtc()    / newQbit()     -> Promise<{address, spk}>    fresh receive/refund address + its scriptPubKey
//   fundBtc(address, sats) / fundQbit(address, sats) -> Promise<txid>   send exactly `sats` to an HTLC
```

`wallets.js` implements this against standard Bitcoin-Core-style JSON-RPC (qbitd speaks the same wallet
RPC), calling only `getblockcount`, `getnewaddress`, `getaddressinfo`, `sendtoaddress`:

```js
import { MakerBot } from "./maker-bot.js";
import { rpcWallet, walletAdapter } from "./wallets.js";

const wallet = walletAdapter({
  btc:  rpcWallet("http://user:pass@btc-node:8332",  "maker"),   // your bitcoind + a funded wallet named "maker"
  qbit: rpcWallet("http://user:pass@qbit-node:PORT", "maker"),   // your qbitd + a funded wallet
});
new MakerBot({ coordinatorUrl, wallet, policy, makerKey }).serveRfq({ quote });
```

Point it at **your own** bitcoind + qbitd — they only need to be on the same network as the coordinator's
nodes, not the same machines. Run each with a funded wallet, keep the RPC private to the bot's host, and
use a dedicated RPC user. Nothing else is needed: the bot exports no keys and the wallet signs no HTLCs.
`run.js` wires all of this from env (`BTC_RPC_URL`, `QBIT_RPC_URL`, `MAKER_KEY`, `COORDINATOR_URL`, …).

Any wallet works, not just Core — implement the same six methods against a different backend (an HD
signer + Esplora, a custody API, hardware) and pass that object as `wallet`.

**Package-aware funding fees.** When a funding tx spends unconfirmed ancestors, miners judge the whole
ancestor *package's* feerate — a child paying "next-block" on its own vsize still stalls behind low-fee
ancestors, especially in a rising market. After each send the Core adapter reads the chain's real
economics (`getmempoolentry`: ancestor fees/size include the child) and, if the package is short of the
next-block target, RBF-bumps the child to absorb the whole deficit
(`childFee' = target×ancestorSize − otherAncestorFees`), capped at `MAKER_MAX_FEERATE` (500 sat/vB).
The coordinator tracks an RBF'd unconfirmed deposit automatically.

**Light-mode fee cap:** the node-less wallet's funding feerate is additionally hard-capped at
`LIGHT_MAX_FEERATE` (default 500 sat/vB) so a compromised/garbage public fee oracle can't drain the
wallet into miner fees.

**Coordinator-trust hardening.** Before the bot locks any funds it independently re-derives both HTLC
scriptPubKeys from its own keys + the counterparty pubkey + `H` + locktimes and checks they match the
coordinator's (`#verifyHtlc` — same check the webapp does); a mismatch halts the swap before funding.
The coordinator-fee on a BTC claim is **pinned at join time** (never re-read from the live view, capped
at ≤5% of the swap, ≥10k sats), and the counterparty's revealed preimage is validated against `H` before
the bot signs the claim. Fulfillments retry transient fetch/wallet errors in-process (5 attempts) so a
blip never strands a funded swap, and the keystore keeps everything resumable across restarts.

## Swap-key safety (crash recovery)
The bot signs with ephemeral per-swap keys. Held only in memory they'd die with the process — stranding
the QBT it locked (no refund key), the BTC it's owed (no claim key), and on the Alice side the preimage
secret itself. So every swap's material (keys, secret, dests, swap token) is written to a durable
keystore **before the bot takes any action**: one JSON file per swap under `MAKER_KEY_DIR` (default
`./maker-keys`), `0600` in a `0700` dir, atomic writes. On startup `run.js` calls `resumePending()`,
which re-enters every open swap idempotently (skips the join if already joined — verifying the stored
keys match the joined party — skips already-funded legs, and picks up the claim/refund watch where it
left off). Settled swaps retire to `.done.json`. The keystore sits on the same trust boundary as the
wallet RPC credentials in env: protect the machine; back up the directory if you back up anything.

## Dev / running the tests
Uses the sibling `client/` and `coordinator/` packages in this repo:

```
npm install
npm test          # runs test/e2e.mock.mjs
```

The e2e covers all seven paths the bot must handle: a completed swap (with **coordinator-fee splitting**),
a refund when the taker walks, a policy reject on an underpriced swap, an **RFQ one-click buy** (bot as
Bob), an **RFQ one-click sell** (bot as Alice — it funds BTC and claims QBT on reveal), the bot
**refunding its own BTC** when a sell-side taker walks, and **inventory-aware quote sizing** (quotes
track live balance). It uses a mock chain, so it proves the bot↔coordinator *protocol* end to end;
on-chain tx *validity* is covered by the client library's own regtest e2e (run against a live node).

## Inventory-aware quoting
`serveRfq` re-sizes the quote on every ping to what the wallet can actually cover: **available =
spendable balance − a keep-back reserve − in-flight commitments** (swaps picked up but not yet funded).
The ask (it sells QBT) is capped by QBT on hand; the bid (it buys QBT with BTC) by BTC ÷ bid price. A
side that can't cover the coordinator minimum is quoted as `null` (dropped) until inventory returns. So
the sizes you pass to `serveRfq` are *ceilings*, and the bot never quotes depth it can't fund. This
needs `wallet.balances() -> { btcSats, qbtSats }`; without it, sizes stay static. Tune the keep-back
with `serveRfq({ …, reserveBtcSats, reserveQbtSats })`.

**Unconfirmed change counts.** A maker funded with one big UTXO would look broke to a naive
confirmed-only balance the moment its first swap leaves a large unconfirmed change output — but that
change is spendable (Core happily chains unconfirmed spends up to its mempool policy: 25 ancestors /
101 kvB). The Core adapter's `balances()` therefore counts an unconfirmed UTXO iff its mempool ancestor
chain leaves headroom for one more spend, with a safety margin under the caps (`MAKER_MAX_ANCESTORS`,
default 20; ~80 kvB size guard) — so the bot keeps quoting through long unconfirmed chains and stops
*just before* it would hit `too-long-mempool-chain`, resuming automatically once a block confirms.

## Quickstart — run a fixed-price maker with one command

```
COORDINATOR_URL=https://qbitswap.com/coord MAKER_KEY=... \
BTC_RPC_URL=http://user:pass@btc-node:8332 QBIT_RPC_URL=http://user:pass@qbit-node:8332 \
node run.js --bid-usd 0.11 --ask-usd 0.13 --size 50
```

`--bid-usd/--ask-usd` quote in **USD per QBT** — the unit people actually think in — converted via the
live BTCUSD rate and **re-priced on an interval so your dollar price follows BTC**. Each repricing step
is bounded (`USDPCT_MAX_DEVIATION`, default 30% from the previous quote) so a wrong-but-up feed can't
swing the book in one tick. Prefer raw
`--bid/--ask` only if you really mean BTC per QBT (mind the magnitude: QBT ≈ $0.12 is ≈ 0.0000010
BTC/QBT). `--size` is QBT per side (a ceiling — inventory sizing trims it live). Quote one side only by
passing just one. All flags have env twins (see `run.js`'s header).

### Price sanity guardrail
A fat-fingered price — above all, a USD number typed into the BTC/QBT field (`--bid 0.12` ≈ **$14,000
per QBT**) — is free money for the first arbitrageur. Before any quote goes live (startup AND Telegram
changes), it's checked two ways:
- **deviation**: more than `PRICE_DEV_PCT` (30%) off the market reference — the median of recent
  settled swaps (`/trades`), else the live maker book's mid (`/rfq`);
- **ceiling**: above `PRICE_MAX` (0.001 BTC/QBT ≈ $100+/QBT) outright — catches USD-magnitude typos
  even on a fresh market with no reference at all.

A violation refuses to start (or rejects the Telegram command) with the reference price shown. If the
price is genuinely intentional, override explicitly: `--force-price` / `FORCE_PRICE=1` on the CLI, or
append `force` to the Telegram command (`/bid 0.5 force`).

## Light mode — no nodes, one seed phrase

Run a maker without bitcoind or qbitd: one BIP39 seed phrase backs BOTH chains, encrypted at rest, with
balances and broadcasts through public esplora APIs (mempool.space for BTC; a mempool.space-style
instance for QBT):

```
node run.js --light --init                     # once: makes + seals the seed (shown exactly once)
node run.js --light --bid 0.19 --ask 0.21      # runs the maker from the sealed seed
```

- **One seed, both chains, quantum-safely** (`light/hd.js`): BTC keys via hardened BIP84 (portable to
  any standard wallet); QBT SLH-DSA keys via HKDF under a versioned domain label. The master seed is
  symmetric material — never used as an EC key — so even a quantum adversary who recovers every BTC key
  from its on-chain pubkeys (Shor) faces hash preimages toward the master, leaving the QBT branch its
  full post-quantum security. The QBT derivation is self-consistent to this bot (no PQ HD standard
  exists yet), so the phrase restores this wallet exactly but qbitd wouldn't derive the same addresses.
- **Sealed at rest** (`light/seedstore.js`): AES-256-GCM under an scrypt-stretched password, fresh
  salt/nonce, 0600; wrong password fails loudly (authenticated encryption). Password prompted on the
  tty (no echo) or `LIGHT_PASSWORD` for headless runs.
- **Self-signing wallet** (`light/lightwallet.js`): builds and signs its own funding txs (P2WPKH via
  BIP143; QBT single-key p2mr leaves via SLH-DSA), change back to itself, RBF-signaling. It tracks its
  own unconfirmed spend graph exactly — chain depth capped under Core's 25-ancestor policy, and funding
  fees are **package-priced at build time** (the child's fee absorbs every unconfirmed ancestor's
  shortfall from the next-block rate — no bumpfee needed, priced right the first time).
- **Trade-offs**: liveness rides on the public APIs (rate limits, uptime) and your addresses/balances
  are visible to them. Right for small makers; run your own nodes at size. Endpoints override via
  `BTC_ESPLORA` / `QBIT_ESPLORA` (defaults: mempool.space, qbitmempool.robertclarke.com).

## Telegram control & monitoring

Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` and `run.js` starts a dedicated operator bot
(`telegram.js`, zero deps, long-polling — no inbound ports). It pushes a notification for every swap the
maker touches (🤝 matched → 💰 funded → ✅ complete / ↩️ refunded / ⚠️ error), and answers:

```
/balances          spendable BTC + QBT (incl. safe unconfirmed)
/quote             current bid/ask/size
/bid $0.11         set the bid as a USD PEG (follows BTCUSD)      /bid off drops the side
/ask $0.13         set the ask as a USD peg                       /ask 0.0000011 = fixed BTC/QBT
/size 25           QBT per side
/pause  /resume    stop quoting (quote expires from the widget in ~30s) / restart
/status            in-flight swaps
```

Price changes run through the same sanity guardrail as startup — a way-off price is rejected with the
market reference shown; append `force` to override (`/bid 0.5 force`).

Price/size changes mutate the live quote and take effect on the next ping (≤ `--ping`, default 10s).
Only messages from `TELEGRAM_CHAT_ID` are honored — any other chat gets silence.

## Three ways to source swaps

### 1. RFQ — powers the web app's one-click "instant swap" widget  *(recommended)*
`MakerBot.serveRfq({ quote })` streams a live **two-sided** quote to the coordinator's `/rfq` layer and
fulfills matches it hands back. The coordinator expires a quote if the bot stops pinging, so the loop
**must keep running** — the ping *is* the liveness signal.

```js
const bot = new MakerBot({ coordinatorUrl, wallet, policy, makerKey: "<RFQ_MAKER_KEYS value>" });
await bot.serveRfq({ quote: {
  ask: { price: 0.21, qbtSats: 5_000_000_000 },   // it SELLS QBT for BTC (retail buys)
  bid: { price: 0.19, qbtSats: 5_000_000_000 },   // it BUYS QBT with BTC (retail sells)
}, pingMs: 3000 });
```

Prices are BTC per QBT; sizes are `qbtSats`. Retail sees the best live price in the widget and takes it
in one click; the bot's next ping delivers the match and it fulfills the right role automatically:
- a retail **buy** hits the **ask** → the bot is **Bob** (funds QBT once the BTC is on-chain, claims BTC);
- a retail **sell** hits the **bid** → the bot is **Alice**, the initiator (funds BTC up front, holds the
  secret, claims the QBT on reveal — or refunds its BTC if the taker never funds).

> Quote one side or both. Making the **bid** means funding BTC before the taker commits QBT — inherent to
> being the buyer; the exposure is bounded and always recoverable (the bot refunds after the timelock,
> never loses funds), but size the `bid` to the inventory/capital you want exposed.

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
- **Dynamic claim/refund fees** — `feeSats` is a fixed per-leg network fee; the reference client sizes
  BTC claims at the live mempool rate. Under fee pressure a fixed fee can underpay and stall a claim.
- **Concurrency/inventory caps** — `policy.maxQbtSats` bounds a single swap, but there's no global
  cap on simultaneous in-flight QBT exposure.
