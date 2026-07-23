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
  constructor({ coordinatorUrl, wallet, policy, pollMs = 2000, feeSats = { qbit: 100000, btc: 5000 }, makerKey = null, log = console.log }) {
    this.base = coordinatorUrl.replace(/\/$/, "");
    this.wallet = wallet;
    this.policy = policy;
    this.pollMs = pollMs;
    this.feeSats = feeSats;                       // network fee the bot pays for its own claim/refund tx, per leg
    this.makerKey = makerKey;                     // RFQ X-Maker-Key (serveRfq); null for order-book / link modes
    this.log = log;
    this.offers = new Map();   // offerId -> { makerToken, lot, handling }
    this.handling = new Set(); // swapIds already being fulfilled (RFQ matches re-deliver until we join)
  }

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
  // quote: { ask?: {price, qbtSats}, bid?: {price, qbtSats} } — price is BTC per QBT. Ask-only recommended.
  async serveRfq({ quote, pingMs = 3000 }) {
    if (!this.makerKey) throw new Error("serveRfq needs a makerKey (the coordinator's RFQ_MAKER_KEYS value)");
    this.log(`[maker] RFQ market up: ${JSON.stringify(quote)} (ping ${pingMs}ms)`);
    for (;;) {
      try {
        const { matches = [] } = await this.#rfqPing(quote);
        for (const m of matches) {
          if (this.handling.has(m.swapId)) continue;
          const run = m.role === "alice" ? this.fulfillAsAlice({ id: m.swapId, token: m.token }) : this.fulfill({ id: m.swapId, token: m.token });
          this.handling.add(m.swapId);
          this.log(`[maker] RFQ match ${m.swapId.slice(0, 8)} (${m.side} ${m.qbtSats / 1e8} QBT @ ${m.price}) — fulfilling as ${m.role}`);
          run.then((r) => this.log(`[maker] RFQ ${m.swapId.slice(0, 8)} -> ${r.outcome}`))
             .catch((e) => { this.log(`[maker] RFQ fulfill error: ${e.message}`); this.handling.delete(m.swapId); });
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

  async fulfill({ id, token }) {
    // 1) ephemeral, per-swap keys — nothing persists past this swap.
    const qbit = await slhDsaKeygen(cryptoRandom(128));
    const btcPriv = cryptoRandom(32);
    const btcPub = compressedPub(btcPriv);
    const qbitDest = await this.wallet.newQbit();     // QBT refund sink (if taker aborts)
    const btcDest = await this.wallet.newBtc();       // where we receive BTC

    // 2) join as Bob (no H — the taker owns the secret).
    await this.#api(`/swaps/${id}/party`, {
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

    // 4) fund our QBT leg.
    const fundTxid = await this.wallet.fundQbit(ready.htlc.qbit.address, ready.terms.qbtSats);
    this.log(`[maker] funded QBT HTLC ${ready.terms.qbtSats} sats (${fundTxid.slice(0, 12)})`);

    // 5) race: either the taker claims QBT (revealing the preimage -> we claim BTC), or the QBT
    //    timelock expires with no claim (-> we refund our QBT). Whichever comes first.
    while (true) {
      const v = await this.#api(`/swaps/${id}`, { token });
      if (v.preimage) return this.#claimBtc({ id, token, v, btcPriv, destSpk: btcDest.spk });
      const h = await this.wallet.qbitHeight();
      if (v.funding?.qbit && h >= v.locktimes.qbit) return this.#refundQbit({ id, token, v, qbit, destSpk: qbitDest.spk });
      await sleep(this.pollMs);
    }
  }

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
  async fulfillAsAlice({ id, token }) {
    // 1) ephemeral, per-swap keys — INCLUDING the secret we (the initiator) commit to.
    const qbit = await slhDsaKeygen(cryptoRandom(128));
    const btcPriv = cryptoRandom(32), btcPub = compressedPub(btcPriv);
    const secret = cryptoRandom(32), H = sha256(secret);
    const qbitDest = await this.wallet.newQbit();     // where we receive the QBT we're buying
    const btcDest = await this.wallet.newBtc();       // BTC refund sink (if the taker never funds)

    // 2) join as Alice WITH H (only the initiator commits the hash).
    await this.#api(`/swaps/${id}/party`, {
      token, method: "POST",
      body: { qbitPub: hex(qbit.pk), btcPub: hex(btcPub), btcDest: btcDest.address, qbitDest: qbitDest.address, H: hex(H) },
    });
    const ready = await this.#poll(`/swaps/${id}`, token, (v) => v.state !== "CREATED" && v.htlc);
    this.log(`[maker] joined swap ${id.slice(0, 12)} as Alice -> ${ready.state}; BTC HTLC ${ready.htlc.btc.address}`);

    // 3) fund our BTC leg FIRST (the initiator funds unconditionally; it stays refundable until we reveal).
    //    The buyer funds the coordinator fee on top of terms.btcSats — so does the bot as buyer.
    const btcAmt = ready.terms.btcSats + (ready.fee?.sats || 0);
    const fundTxid = await this.wallet.fundBtc(ready.htlc.btc.address, btcAmt);
    this.log(`[maker] funded BTC HTLC ${btcAmt} sats (${fundTxid.slice(0, 12)}); awaiting the taker's QBT`);

    // 4) race: the taker funds QBT and it matures -> we claim QBT (revealing the preimage); or the taker
    //    never funds and our BTC timelock passes -> we refund the BTC. We only ever reveal at CLAIMABLE,
    //    which the coordinator sets only once BOTH legs are buried and it's still safe (never too late).
    while (true) {
      const v = await this.#api(`/swaps/${id}`, { token });
      if (v.state === "CLAIMABLE" && v.funding?.qbit) return this.#claimQbit({ id, token, v, qbit, secret, destSpk: qbitDest.spk });
      const h = await this.wallet.btcHeight();
      if (v.funding?.btc && !v.funding.btc.spent && !v.preimage && h >= v.locktimes.btc) return this.#refundBtc({ id, token, v, btcPriv, destSpk: btcDest.spk });
      await sleep(this.pollMs);
    }
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
