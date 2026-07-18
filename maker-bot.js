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
  p2mrSighash, serializeTx, P2MR_CONTROL_SINGLE_LEAF, btcSpend,
} from "@qbit-swap/client";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {Object} Wallet   maker's own funded nodes; the bot never hands keys to anyone.
 * @property {() => Promise<number>}                       qbitHeight   current QBT tip (refund gate)
 * @property {() => Promise<{address:string, spk:Uint8Array}>} newQbit   fresh QBT address (refund sink)
 * @property {() => Promise<{address:string, spk:Uint8Array}>} newBtc    fresh BTC address (receive sink)
 * @property {(address:string, sats:number) => Promise<string>} fundQbit  send sats to the QBT HTLC
 *
 * @typedef {Object} Policy
 * @property {number} minRate      floor on btcSats/qbtSats (BTC received per QBT given out)
 * @property {number} maxQbtSats   max QBT to expose on a single swap (inventory / blast radius)
 */

export class MakerBot {
  /** @param {{coordinatorUrl:string, wallet:Wallet, policy:Policy, pollMs?:number, feeSats?:{qbit:number,btc:number}, log?:Function}} cfg */
  constructor({ coordinatorUrl, wallet, policy, pollMs = 2000, feeSats = { qbit: 100000, btc: 5000 }, log = console.log }) {
    this.base = coordinatorUrl.replace(/\/$/, "");
    this.wallet = wallet;
    this.policy = policy;
    this.pollMs = pollMs;
    this.feeSats = feeSats;
    this.log = log;
    this.offers = new Map();   // offerId -> { makerToken, lot, handling }
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
  async #claimBtc({ id, token, v, btcPriv, destSpk }) {
    const f = v.funding.btc, ws = bin(v.htlc.btc.witnessScript);
    const tx = btcSpend({
      prevTxidLE: bin(f.txid).reverse(), vout: f.vout, amount: f.amountSats, ws, priv: btcPriv,
      destSpk, outVal: f.amountSats - this.feeSats.btc, branch: "claim", preimage: bin(v.preimage),
    });
    const r = await this.#api(`/swaps/${id}/broadcast`, { token, method: "POST", body: { leg: "btc", kind: "claim", tx: hex(tx) } });
    this.log(`[maker] claimed BTC ${r.txid.slice(0, 12)} -> ${r.state}`);
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
}

function cryptoRandom(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export { sha256 };   // re-export for adapters that need H-checks
