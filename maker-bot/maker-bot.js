// MakerBot — autonomous single-party market maker for BTC<->QBT atomic swaps.  PRIVATE.
//
// It plays "Bob": holds QBT inventory, wants BTC. Given a swap link (Bob's capability token) it
// received out-of-band, it prices the terms against policy + inventory and, if profitable, executes
// the maker side of the swap end to end — safely, in Tier-Nolan order — including recovering its own
// funds by refund if the taker walks away.
//
// It depends only on the PUBLIC pieces: the @qbit-swap/client library (crypto + tx construction) and
// the coordinator's HTTP API. All the private edge lives here: which swaps to take, at what price,
// and how much inventory to expose. Chain access (funding QBT, reading height) is injected as a
// `wallet` adapter so this file stays node/runtime-agnostic — in production that's the maker's own
// qbitd/bitcoind RPC.
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  slhDsaKeygen, slhDsaSign, compressedPub,
  p2mrSighash, serializeTx, P2MR_CONTROL_SINGLE_LEAF, btcSpend, addressToScriptPubKey,
} from "@qbit-swap/client";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DUST = 546;

/**
 * @typedef {Object} Wallet   maker's own funded nodes; the bot never hands keys to anyone.
 * @property {() => Promise<number>}                       qbitHeight   current QBT tip (refund/claim gate)
 * @property {() => Promise<number>}                       btcHeight    current BTC tip (Alice-side refund gate)
 * @property {() => Promise<{address:string, spk:Uint8Array}>} newQbit   fresh QBT address (recv/refund sink)
 * @property {() => Promise<{address:string, spk:Uint8Array}>} newBtc    fresh BTC address (recv/refund sink)
 * @property {(address:string, sats:number) => Promise<string>} fundQbit  send sats to the QBT HTLC (Bob side)
 * @property {(address:string, sats:number) => Promise<string>} fundBtc   send sats to the BTC HTLC (Alice side)
 *
 * @typedef {Object} Policy
 * @property {number} minRate      floor on btcSats/qbtSats (BTC paid per QBT — bid ceiling / ask floor)
 * @property {number} maxQbtSats   max QBT to expose on a single swap (inventory / blast radius)
 */

export class MakerBot {
  /** @param {{coordinatorUrl:string, wallet:Wallet, policy:Policy, pollMs?:number, feeSats?:{qbit:number,btc:number}, log?:Function}} cfg */
  constructor({ coordinatorUrl, wallet, policy, pollMs = 2000, feeSats = { qbit: 100000, btc: 5000 }, makerKey = null, keystore = null, log = console.log }) {
    this.base = coordinatorUrl.replace(/\/$/, "");
    this.wallet = wallet;
    this.policy = policy;
    this.pollMs = pollMs;
    this.feeSats = feeSats;                       // network fee the bot pays for its own claim/refund tx, per leg
    this.makerKey = makerKey;                     // RFQ X-Maker-Key (serveRfq); null for order-book / link modes
    this.log = log;
    this.offers = new Map();   // offerId -> { makerToken, lot, handling }
    this.handling = new Set(); // swapIds already being fulfilled (RFQ matches re-deliver until we join)
    this.inflight = new Map(); // swapId -> { btcSats?|qbtSats? } committed but not yet funded (inventory reserve)
    this.onEvent = null;       // optional hook: (type, data) — match | funded | completed | refunded | error (drives the Telegram bot)
    this.keystore = keystore;  // optional durable per-swap key store (keystore.js) — crash-safe claims/refunds + resumePending()
  }
  #ev(type, data) { try { this.onEvent?.(type, data); } catch { /* observer must never break the bot */ } }

  async #api(path, { token, method = "GET", body } = {}) {
    const r = await fetch(this.base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { "x-swap-token": token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
    return j;
  }
  #poll(path, token, pred, tries = 300) {
    return (async () => {
      for (let i = 0; i < tries; i++) {
        const v = await this.#api(path, { token });
        const done = pred(v);
        if (done) return v;
        await sleep(this.pollMs);
      }
      throw new Error(`poll timeout on ${path}`);
    })();
  }

  // Pure pricing decision — the private edge. Maker gives qbtSats, receives btcSats.
  evaluate(terms) {
    const rate = terms.btcSats / terms.qbtSats;                 // BTC per QBT
    if (terms.qbtSats > this.policy.maxQbtSats) return { accept: false, rate, reason: `qbt ${terms.qbtSats} > cap ${this.policy.maxQbtSats}` };
    if (rate < this.policy.minRate) return { accept: false, rate, reason: `rate ${rate.toFixed(6)} < floor ${this.policy.minRate}` };
    return { accept: true, rate, reason: "within policy" };
  }

  // ── RFQ: stream a live two-sided quote and fulfill matches the coordinator hands back ──
  // The coordinator's /rfq layer is the backend for the web app's one-click "instant swap" widget:
  // retail takes the best live maker price. A maker must KEEP PINGING — its quote expires (RFQ_TTL_MS)
  // if it goes silent — and the same ping response delivers any matches (a retail take), each with the
  // maker's per-swap token + role. This loop pings on `pingMs` and fulfills every match it can.
  //
  // Two-sided: a retail BUY hits the ask (maker = Bob → fulfill()); a retail SELL hits the bid
  // (maker = Alice → fulfillAsAlice(): the bot is the initiator — it funds BTC up front, holds the
  // secret, and claims QBT on reveal, or refunds its BTC if the taker never funds). Quote either or both.
  async #rfqPing(body) {
    const r = await fetch(`${this.base}/rfq/maker`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-maker-key": this.makerKey || "" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`/rfq/maker: ${j.error || r.status}`);
    return j;   // { ok, ttlMs, quote, matches:[{swapId, token, role, side, price, btcSats, qbtSats}] }
  }
  // Inventory-aware sizing: how much can each side ACTUALLY be covered right now? Available = the wallet's
  // spendable balance, minus a keep-back reserve you never quote, minus what's already committed to
  // in-flight swaps the bot picked up but hasn't funded yet (`this.inflight` — released the moment the
  // node balance itself reflects the spend, i.e. right after funding, so we never double-count). The ask
  // (we SELL QBT) is capped by QBT on hand; the bid (we BUY QBT, paying BTC) by BTC / bid price. A side
  // that can't cover the coordinator minimum is dropped (quoted as null) until inventory returns.
  //   Requires wallet.balances() -> { btcSats, qbtSats }; without it, sizes stay static (back-compat).
  async #sizeQuote(quote, keepBtc, keepQbt) {
    if (!this.wallet.balances) return quote;                       // no balance source → quote the static sizes
    let bal;
    try { bal = await this.wallet.balances(); } catch (e) { this.log(`[maker] balance check failed: ${e.message} — skipping this ping`); return null; }
    let btc = bal.btcSats, qbt = bal.qbtSats;
    for (const r of this.inflight.values()) { btc -= r.btcSats || 0; qbt -= r.qbtSats || 0; }   // subtract un-funded commitments
    const btcAvail = Math.max(0, btc - (keepBtc || 0)), qbtAvail = Math.max(0, qbt - (keepQbt || 0));
    const cap = (size, avail) => (size > 0 ? { size } : null) && Math.min(size, Math.max(0, Math.floor(avail)));
    const out = {};
    if ("ask" in quote && quote.ask) { const s = cap(quote.ask.qbtSats, qbtAvail); out.ask = s > 0 ? { price: quote.ask.price, qbtSats: s } : null; }
    if ("bid" in quote && quote.bid) { const s = cap(quote.bid.qbtSats, btcAvail / quote.bid.price); out.bid = s > 0 ? { price: quote.bid.price, qbtSats: s } : null; }
    return out;
  }
  // quote: { ask?: {price, qbtSats}, bid?: {price, qbtSats} } — price is BTC per QBT. These are the MAX
  // sizes; each ping re-sizes them down to live inventory (see #sizeQuote). reserveBtcSats/reserveQbtSats
  // is a keep-back you never quote (gas/float). pingMs: the ping only has to land inside the coordinator's
  // quote TTL (RFQ_TTL_MS, default 30s), so ~10s keeps the quote live with a dropped-ping cushion. It ALSO
  // bounds how stale your quoted price can be (a taker fills at your last-pinged price), so ping as often
  // as you re-price — every few seconds tracking the market, 10–15s if steady. (200ms is just test speed.)
  async serveRfq({ quote, pingMs = 10000, reserveBtcSats = 0, reserveQbtSats = 0 }) {
    if (!this.makerKey) throw new Error("serveRfq needs a makerKey (the coordinator's RFQ_MAKER_KEYS value)");
    this.log(`[maker] RFQ market up: ${JSON.stringify(quote)} (ping ${pingMs}ms${this.wallet.balances ? ", inventory-sized" : ""})`);
    for (;;) {
      try {
        // Paused (e.g. Telegram /pause): stop pinging so the standing quote expires within the TTL and
        // liquidity drops from the widget. In-flight fulfillments keep running to completion.
        if (quote.paused) { await sleep(pingMs); continue; }
        const sized = await this.#sizeQuote(quote, reserveBtcSats, reserveQbtSats);
        if (sized === null) { await sleep(pingMs); continue; }       // balance unreadable → don't quote blind
        const { matches = [] } = await this.#rfqPing(sized);
        for (const m of matches) {
          if (this.handling.has(m.swapId)) continue;
          this.handling.add(m.swapId);
          this.inflight.set(m.swapId, m.role === "alice" ? { btcSats: m.btcSats } : { qbtSats: m.qbtSats });   // reserve the leg we'll fund until it's funded
          const run = m.role === "alice" ? this.fulfillAsAlice({ id: m.swapId, token: m.token }) : this.fulfill({ id: m.swapId, token: m.token });
          this.log(`[maker] RFQ match ${m.swapId.slice(0, 8)} (${m.side} ${m.qbtSats / 1e8} QBT @ ${m.price}) — fulfilling as ${m.role}`);
          this.#ev("match", m);
          run.then((r) => { this.log(`[maker] RFQ ${m.swapId.slice(0, 8)} -> ${r.outcome}`); this.#ev(r.outcome === "completed" ? "completed" : "refunded", { ...m, txid: r.txid }); })
             .catch((e) => { this.log(`[maker] RFQ fulfill error: ${e.message}`); this.#ev("error", { ...m, error: e.message }); })
             .finally(() => { this.handling.delete(m.swapId); this.inflight.delete(m.swapId); });
        }
      } catch (e) { this.log(`[maker] RFQ ping error: ${e.message}`); }
      await sleep(pingMs);
    }
  }

  // ── order book: post asks at several lot sizes and fulfill any that get taken ──
  async postAsk({ qbtSats, btcSats }) {
    const o = await this.#api("/offers", { method: "POST", body: { giveCoin: "QBT", giveSats: qbtSats, wantCoin: "BTC", wantSats: btcSats } });
    this.offers.set(o.id, { makerToken: o.makerToken, lot: { qbtSats, btcSats }, handling: false });
    this.log(`[maker] posted ask ${o.id.slice(0, 8)}: ${qbtSats / 1e8} QBT @ ${(btcSats / qbtSats).toFixed(4)} BTC/QBT`);
    return o.id;
  }
  async #offerView(id, makerToken) {
    const r = await fetch(`${this.base}/offers/${id}?makerToken=${makerToken}`);
    const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
  }
  // Post `lots` [{qbtSats, btcSats}] as asks and keep the book replenished; fulfill takes as they come.
  async makeMarket({ lots }) {
    for (const lot of lots) await this.postAsk(lot);
    this.log(`[maker] market up: ${lots.length} asks`);
    for (;;) {
      for (const [id, o] of [...this.offers]) {
        try {
          const mv = await this.#offerView(id, o.makerToken);
          if (mv.status === "taken" && mv.take && !o.handling) {
            o.handling = true;
            this.log(`[maker] ask ${id.slice(0, 8)} taken -> fulfilling swap ${mv.take.swapId.slice(0, 8)}`);
            this.fulfill({ id: mv.take.swapId, token: mv.take.makerSwapToken }).catch((e) => this.log(`[maker] fulfill error: ${e.message}`));
            this.offers.delete(id);
            await this.postAsk(o.lot);   // replenish the book with a fresh ask of the same lot
          }
        } catch { /* transient */ }
      }
      await sleep(this.pollMs);
    }
  }

  // Consider one swap link { swapId, token }. Prices it, and if profitable runs the maker side to
  // a terminal state. Returns a structured outcome; never throws for a normal reject.
  async consider({ swapId, token }) {
    const id = swapId, view0 = await this.#api(`/swaps/${id}`, { token });
    const decision = this.evaluate(view0.terms);
    this.log(`[maker] swap ${id.slice(0, 12)} rate=${decision.rate.toFixed(6)} -> ${decision.accept ? "ACCEPT" : "REJECT"} (${decision.reason})`);
    if (!decision.accept) return { accepted: false, ...decision };
    return this.fulfill({ id, token });
  }

  // `saved` = a keystore record from a previous run (crash recovery): reuse its keys instead of fresh
  // ones. Every step is idempotent under resume — re-joining with the SAME keys is allowed by the
  // coordinator, and funding is skipped when the leg is already funded on-chain.
  async fulfill({ id, token, saved = null }) {
    // 1) ephemeral, per-swap keys — persisted to the keystore BEFORE any action, so a crash never
    //    strands our ability to claim the BTC or refund the QBT we lock below.
    const qbit = saved ? { pk: saved.qbitPk, sk: saved.qbitSk } : await slhDsaKeygen(cryptoRandom(128));
    const btcPriv = saved ? saved.btcPriv : cryptoRandom(32);
    const btcPub = compressedPub(btcPriv);
    const qbitDest = saved ? saved.qbitDest : await this.wallet.newQbit();     // QBT refund sink (if taker aborts)
    const btcDest = saved ? saved.btcDest : await this.wallet.newBtc();        // where we receive BTC
    if (!saved) this.keystore?.save({ swapId: id, token, role: "bob", qbitPk: qbit.pk, qbitSk: qbit.sk, btcPriv, btcDest, qbitDest, at: Date.now() });

    // 2) join as Bob (no H — the taker owns the secret). On resume, the join may already be on record —
    // and once a deposit exists the coordinator locks party data — so only submit when our slot is
    // empty, and hard-stop if the slot holds keys that aren't ours (a mismatched keystore record could
    // otherwise watch a swap it can't actually sign for).
    const pre = saved ? await this.#api(`/swaps/${id}`, { token }) : null;
    if (pre?.self && pre.self.qbitPub !== hex(qbit.pk)) throw new Error("keystore keys don't match this swap's joined party — refusing to resume");
    if (!pre?.self) await this.#api(`/swaps/${id}/party`, {
      token, method: "POST",
      body: { qbitPub: hex(qbit.pk), btcPub: hex(btcPub), btcDest: btcDest.address, qbitDest: qbitDest.address },
    });
    const ready = await this.#poll(`/swaps/${id}`, token, (v) => v.state !== "CREATED" && v.htlc);
    this.log(`[maker] joined swap ${id.slice(0, 12)} -> ${ready.state}; QBT HTLC ${ready.htlc.qbit.address}`);

    // 3) SAFETY: never lock QBT until the taker's BTC HTLC is on-chain. This is the Tier-Nolan
    //    ordering that makes the swap non-custodial for us — if the taker never funds BTC, we simply
    //    never fund QBT and walk away with zero exposure.
    const funded = await this.#poll(`/swaps/${id}`, token, (v) => v.funding?.btc);
    this.log(`[maker] taker's BTC HTLC funded (${funded.funding.btc.txid.slice(0, 12)}); locking QBT`);

    // 4) fund our QBT leg — unless a previous run already did (resume-idempotency).
    if (!funded.funding?.qbit) {
      const fundTxid = await this.wallet.fundQbit(ready.htlc.qbit.address, ready.terms.qbtSats);
      this.log(`[maker] funded QBT HTLC ${ready.terms.qbtSats} sats (${fundTxid.slice(0, 12)})`);
      this.#ev("funded", { swapId: id, leg: "qbit", sats: ready.terms.qbtSats, txid: fundTxid });
    } else this.log(`[maker] QBT leg already funded (resume) — watching for the reveal`);
    this.inflight.delete(id);   // funded — the node balance now reflects this spend, so drop the reserve (no double-count)

    // 5) race: either the taker claims QBT (revealing the preimage -> we claim BTC), or the QBT
    //    timelock expires with no claim (-> we refund our QBT). Whichever comes first.
    while (true) {
      const v = await this.#api(`/swaps/${id}`, { token });
      if (v.preimage) return this.#done(id, await this.#claimBtc({ id, token, v, btcPriv, destSpk: btcDest.spk }));
      const h = await this.wallet.qbitHeight();
      if (v.funding?.qbit && h >= v.locktimes.qbit) return this.#done(id, await this.#refundQbit({ id, token, v, qbit, destSpk: qbitDest.spk }));
      if (["COMPLETE", "REFUNDED", "ABORTED", "CANCELED"].includes(v.state)) return this.#done(id, { accepted: true, outcome: v.state.toLowerCase() });   // settled out from under us (e.g. resumed after our claim landed)
      await sleep(this.pollMs);
    }
  }
  #done(id, result) { this.keystore?.markDone(id); return result; }

  // Taker revealed the preimage on the QBT chain; sweep the BTC HTLC to our sink.
  //
  // Coordinator-fee awareness: when the coordinator charges a platform fee, the buyer funds the BTC HTLC
  // with terms.btcSats + fee.sats, and the fee is a SEPARATE output the claim must pay to fee.address —
  // it's honor-system (the coordinator is keyless and doesn't validate claim outputs), so a fee-blind
  // claim would silently pocket the platform's cut AND overpay us. We split it exactly like the reference
  // client: we net terms.btcSats (funding − fee.sats), the network fee for this tx comes out of the fee
  // reserve, and the platform remainder goes to fee.address. With no fee configured, we just pay our own
  // network fee out of the amount, as before.
  async #claimBtc({ id, token, v, btcPriv, destSpk }) {
    const f = v.funding.btc, ws = bin(v.htlc.btc.witnessScript);
    let outVal = f.amountSats - this.feeSats.btc, extraOut = null;
    if (v.fee?.sats > 0 && v.fee.address) {
      outVal = f.amountSats - v.fee.sats;                                        // we net exactly the agreed amount
      const feeOut = v.fee.sats - Math.min(Math.max(0, this.feeSats.btc), v.fee.sats);   // platform remainder after the capped network fee
      if (feeOut > DUST) extraOut = { spk: addressToScriptPubKey(v.fee.address), value: feeOut };
    }
    const tx = btcSpend({
      prevTxidLE: bin(f.txid).reverse(), vout: f.vout, amount: f.amountSats, ws, priv: btcPriv,
      destSpk, outVal, branch: "claim", preimage: bin(v.preimage), extraOut,
    });
    const r = await this.#api(`/swaps/${id}/broadcast`, { token, method: "POST", body: { leg: "btc", kind: "claim", tx: hex(tx) } });
    this.log(`[maker] claimed BTC ${r.txid.slice(0, 12)} -> ${r.state}${extraOut ? ` (fee ${extraOut.value} → coordinator)` : ""}`);
    return { accepted: true, outcome: "completed", txid: r.txid };
  }

  // Taker walked after we funded; the QBT timelock has passed — refund our QBT to ourselves.
  async #refundQbit({ id, token, v, qbit, destSpk }) {
    const f = v.funding.qbit, leaf = bin(v.htlc.qbit.leaf), spk = bin(v.htlc.qbit.spk);
    const prevoutLE = bin(f.txid).reverse(), outVal = f.amountSats - this.feeSats.qbit, lock = v.locktimes.qbit;
    const sh = p2mrSighash({
      version: 2, locktime: lock,
      vin: [{ txidLE: prevoutLE, vout: f.vout, sequence: 0xfffffffe }],   // <0xffffffff enables CLTV
      spentOutputs: [{ amount: f.amountSats, spk }],
      vout: [{ value: outVal, spk: destSpk }], inputIndex: 0, leafScript: leaf,
    });
    const sig = await slhDsaSign(qbit.sk, sh);
    // ELSE branch: false selector (empty) picks refund; sig verifies against the fund key.
    const tx = serializeTx({
      version: 2, vin: [[prevoutLE, f.vout, new Uint8Array(0), 0xfffffffe]],
      vout: [[BigInt(outVal), destSpk]],
      wit: [[sig, new Uint8Array(0), leaf, P2MR_CONTROL_SINGLE_LEAF]], locktime: lock,
    });
    const r = await this.#api(`/swaps/${id}/broadcast`, { token, method: "POST", body: { leg: "qbit", kind: "refund", tx: hex(tx) } });
    this.log(`[maker] refunded QBT ${r.txid.slice(0, 12)} -> ${r.state}`);
    return { accepted: true, outcome: "refunded", txid: r.txid };
  }

  // ── Alice side (bid): the bot IS the initiator ──────────────────────────────────────────────────
  // Used when the bot makes the BID (retail sells QBT to it): it holds the secret, funds BTC (the longer,
  // refundable leg) up front, waits for the taker's QBT, then claims the QBT — revealing the preimage —
  // once the coordinator says it's safe (CLAIMABLE). If the taker never funds, its BTC stays refundable
  // and it reclaims it after the timelock. Funding BTC before the taker commits is inherent to being the
  // buyer; the exposure is bounded and always recoverable (never lost), which is the Tier-Nolan guarantee.
  async fulfillAsAlice({ id, token, saved = null }) {
    // 1) ephemeral, per-swap keys — INCLUDING the secret we (the initiator) commit to. All persisted to
    //    the keystore BEFORE any action: losing the secret would make our locked BTC refund-only; losing
    //    the keys would strand it entirely.
    const qbit = saved ? { pk: saved.qbitPk, sk: saved.qbitSk } : await slhDsaKeygen(cryptoRandom(128));
    const btcPriv = saved ? saved.btcPriv : cryptoRandom(32), btcPub = compressedPub(btcPriv);
    const secret = saved ? saved.secret : cryptoRandom(32), H = sha256(secret);
    const qbitDest = saved ? saved.qbitDest : await this.wallet.newQbit();     // where we receive the QBT we're buying
    const btcDest = saved ? saved.btcDest : await this.wallet.newBtc();        // BTC refund sink (if the taker never funds)
    if (!saved) this.keystore?.save({ swapId: id, token, role: "alice", qbitPk: qbit.pk, qbitSk: qbit.sk, btcPriv, secret, btcDest, qbitDest, at: Date.now() });

    // 2) join as Alice WITH H (only the initiator commits the hash). On resume, only submit if our slot
    // is empty (party data locks once a deposit exists), and never proceed on a key mismatch.
    const pre = saved ? await this.#api(`/swaps/${id}`, { token }) : null;
    if (pre?.self && pre.self.qbitPub !== hex(qbit.pk)) throw new Error("keystore keys don't match this swap's joined party — refusing to resume");
    if (!pre?.self) await this.#api(`/swaps/${id}/party`, {
      token, method: "POST",
      body: { qbitPub: hex(qbit.pk), btcPub: hex(btcPub), btcDest: btcDest.address, qbitDest: qbitDest.address, H: hex(H) },
    });
    const ready = await this.#poll(`/swaps/${id}`, token, (v) => v.state !== "CREATED" && v.htlc);
    this.log(`[maker] joined swap ${id.slice(0, 12)} as Alice -> ${ready.state}; BTC HTLC ${ready.htlc.btc.address}`);

    // 3) fund our BTC leg FIRST (the initiator funds unconditionally; it stays refundable until we
    //    reveal) — unless a previous run already did (resume-idempotency). The buyer funds the
    //    coordinator fee on top of terms.btcSats — so does the bot as buyer.
    if (!ready.funding?.btc) {
      const btcAmt = ready.terms.btcSats + (ready.fee?.sats || 0);
      const fundTxid = await this.wallet.fundBtc(ready.htlc.btc.address, btcAmt);
      this.log(`[maker] funded BTC HTLC ${btcAmt} sats (${fundTxid.slice(0, 12)}); awaiting the taker's QBT`);
      this.#ev("funded", { swapId: id, leg: "btc", sats: btcAmt, txid: fundTxid });
    } else this.log(`[maker] BTC leg already funded (resume) — awaiting the taker's QBT`);
    this.inflight.delete(id);   // funded — the node balance now reflects this spend, so drop the reserve

    // 4) race: the taker funds QBT and it matures -> we claim QBT (revealing the preimage); or the taker
    //    never funds and our BTC timelock passes -> we refund the BTC. We only ever reveal at CLAIMABLE,
    //    which the coordinator sets only once BOTH legs are buried and it's still safe (never too late).
    while (true) {
      const v = await this.#api(`/swaps/${id}`, { token });
      if (v.state === "CLAIMABLE" && v.funding?.qbit) return this.#done(id, await this.#claimQbit({ id, token, v, qbit, secret, destSpk: qbitDest.spk }));
      const h = await this.wallet.btcHeight();
      if (v.funding?.btc && !v.funding.btc.spent && !v.preimage && h >= v.locktimes.btc) return this.#done(id, await this.#refundBtc({ id, token, v, btcPriv, destSpk: btcDest.spk }));
      if (["COMPLETE", "REFUNDED", "ABORTED", "CANCELED"].includes(v.state)) return this.#done(id, { accepted: true, outcome: v.state.toLowerCase() });
      await sleep(this.pollMs);
    }
  }

  // Resume swaps left OPEN in the keystore by a previous run (crash recovery). Idempotent end to end:
  // re-join with the saved keys, skip already-funded legs, and pick up the watch loop where it left off.
  async resumePending() {
    const open = this.keystore?.list() || [];
    for (const r of open) {
      if (this.handling.has(r.swapId)) continue;
      this.handling.add(r.swapId);
      this.log(`[maker] resuming ${r.role} swap ${r.swapId.slice(0, 12)} from the keystore`);
      const run = r.role === "alice" ? this.fulfillAsAlice({ id: r.swapId, token: r.token, saved: r }) : this.fulfill({ id: r.swapId, token: r.token, saved: r });
      run.then((res) => { this.log(`[maker] resumed ${r.swapId.slice(0, 8)} -> ${res.outcome}`); this.#ev(res.outcome === "completed" ? "completed" : "refunded", { swapId: r.swapId, ...res }); })
         .catch((e) => { this.log(`[maker] resume error ${r.swapId.slice(0, 8)}: ${e.message}`); this.#ev("error", { swapId: r.swapId, error: e.message }); })
         .finally(() => this.handling.delete(r.swapId));
    }
    return open.length;
  }

  // Both legs are buried & safe: claim the taker's QBT to our sink, revealing the preimage in the witness
  // (this is what lets the taker then claim our BTC). No coordinator-fee output here — the fee rides the
  // BTC leg, which the taker claims.
  async #claimQbit({ id, token, v, qbit, secret, destSpk }) {
    const f = v.funding.qbit, leaf = bin(v.htlc.qbit.leaf), spk = bin(v.htlc.qbit.spk);
    const prevoutLE = bin(f.txid).reverse(), outVal = f.amountSats - this.feeSats.qbit;
    const sh = p2mrSighash({
      version: 2, locktime: 0,
      vin: [{ txidLE: prevoutLE, vout: f.vout, sequence: 0xffffffff }],
      spentOutputs: [{ amount: f.amountSats, spk }],
      vout: [{ value: outVal, spk: destSpk }], inputIndex: 0, leafScript: leaf,
    });
    const sig = await slhDsaSign(qbit.sk, sh);
    // CLAIM branch: the 0x01 selector picks IF; `secret` is revealed here.
    const tx = serializeTx({
      version: 2, vin: [[prevoutLE, f.vout, new Uint8Array(0), 0xffffffff]],
      vout: [[BigInt(outVal), destSpk]],
      wit: [[sig, secret, Uint8Array.of(0x01), leaf, P2MR_CONTROL_SINGLE_LEAF]], locktime: 0,
    });
    const r = await this.#api(`/swaps/${id}/broadcast`, { token, method: "POST", body: { leg: "qbit", kind: "claim", tx: hex(tx) } });
    this.log(`[maker] claimed QBT ${r.txid.slice(0, 12)} -> ${r.state} (revealed preimage; taker can now claim BTC)`);
    return { accepted: true, outcome: "completed", txid: r.txid };
  }

  // The taker never funded QBT; our BTC timelock has passed — reclaim our BTC to ourselves.
  async #refundBtc({ id, token, v, btcPriv, destSpk }) {
    const f = v.funding.btc, ws = bin(v.htlc.btc.witnessScript);
    const tx = btcSpend({
      prevTxidLE: bin(f.txid).reverse(), vout: f.vout, amount: f.amountSats, ws, priv: btcPriv,
      destSpk, outVal: f.amountSats - this.feeSats.btc, branch: "refund", locktime: v.locktimes.btc,
    });
    const r = await this.#api(`/swaps/${id}/broadcast`, { token, method: "POST", body: { leg: "btc", kind: "refund", tx: hex(tx) } });
    this.log(`[maker] refunded BTC ${r.txid.slice(0, 12)} -> ${r.state}`);
    return { accepted: true, outcome: "refunded", txid: r.txid };
  }
}

function cryptoRandom(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export { sha256 };   // re-export for adapters that need H-checks
