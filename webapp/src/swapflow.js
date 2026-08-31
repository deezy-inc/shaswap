// Browser-side swap party. Generates ephemeral per-swap keys, creates/joins a swap through the
// coordinator's API, subscribes to its live feed, and signs its own claim/refund in-page (WASM SLH-DSA
// for the Qbit leg, ECDSA for the Bitcoin leg). The coordinator is keyless.
//
//   The QBT BUYER is the initiator (alice, holds the secret): funds fromLeg=BTC (longer timelock),
//   claims toLeg=QBT (revealing the preimage). The QBT SELLER is the participant (bob): funds QBT,
//   claims BTC with the now-public preimage. This holds no matter who created the link — the creator
//   simply keeps the alice (buyer) or bob (seller) token and shares the other. Every swap is btc2qbt.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import {
  slhDsaKeygen, slhDsaSign, compressedPub,
  p2mrSighash, serializeTx, P2MR_CONTROL_SINGLE_LEAF,
  btcSpend, addressToScriptPubKey,
  htlcLeafQbit, p2mrSpk, htlcWitnessScript, p2wshSpk,   // for independent HTLC verification
} from "@qbit-swap/client";

const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export class SwapClient {
  constructor({ coordinator, onUpdate = () => {}, feeSats = { qbit: 100000, btc: 5000 }, btcHrp = "bc", qbitHrp = "qb", chains = null }) {
    this.base = coordinator.replace(/\/$/, "");
    this.onUpdate = onUpdate;
    this.feeSats = feeSats;
    this.acted = new Set();
    this.createdAt = Date.now();   // when this swap was started here (restored on resume; used in the recover list)
    // Per-leg chain identity ({ btc, qbit } slots → label/script family/replay flags). The "qbit" slot
    // may be ANY Core-RPC UTXO chain (e.g. the BIP-110/Blake2b BTC fork → p2wsh-ecdsa on both legs);
    // injected (window.QBIT_CHAINS), fetched from GET /chains before keygen, and refreshed by the view.
    this.chains = chains || globalThis.QBIT_CHAINS || null;
    // Direct-broadcast fallback endpoints for the coordinator-down path (see #send), keyed by network.
    // BOTH chains are openly relayable — this browser can push a signed tx straight to a public node on
    // either leg — so we keep a fallback for each. QBT is no more "coordinator-only" than BTC; swap safety
    // never rests on relay being gated (it comes from the funding order + waiting for burial). Empty → none.
    this.btcBroadcast = BTC_BROADCAST[btcHrp] || [];
    this.qbitBroadcast = QBIT_BROADCAST[qbitHrp] || [];
  }
  // The leg's HTLC script family / replay-protection flag — from the freshest source available.
  famOf(leg) { return (this.view?.chains || this.chains)?.[leg]?.script || (leg === "qbit" ? "p2mr-slhdsa" : "p2wsh-ecdsa"); }
  replayOf(leg) { return !!(this.view?.chains || this.chains)?.[leg]?.replayOpReturn; }
  async #ensureChains() { if (!this.chains) this.chains = await this.#api("/chains").catch(() => null); }

  // Retries transient failures (network drop, coordinator restart/blip, 5xx/429) so an in-flight
  // create/join/submit isn't lost to a momentary outage. A definitive 4xx (business error) is thrown
  // immediately — it won't succeed on retry.
  async #api(path, { token, method = "GET", body } = {}) {
    const headers = { "content-type": "application/json", ...(token ? { "x-swap-token": token } : {}) };
    for (let attempt = 0; ; attempt++) {
      let r;
      try { r = await fetch(this.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
      catch (e) { if (attempt >= 4) throw e; await new Promise((s) => setTimeout(s, 500 * (attempt + 1))); continue; }
      if (r.status >= 500 || r.status === 429) { if (attempt >= 4) throw new Error(`coordinator ${r.status}`); await new Promise((s) => setTimeout(s, 500 * (attempt + 1))); continue; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.status);
      return j;
    }
  }

  // ── identity / persistence ───────────────────────────────────────────────────
  // The "qbit"-slot keypair matches its configured script family: SLH-DSA for p2mr, a secp256k1 pair
  // for a p2wsh-ecdsa second chain (fork pairs) — either way it travels as { pk, sk } under qbitPub.
  async #freshKeys(isInitiator) {
    await this.#ensureChains();
    if (this.famOf("qbit") === "p2mr-slhdsa") this.qbit = await slhDsaKeygen(rand(128));
    else { const sk = rand(32); this.qbit = { sk, pk: compressedPub(sk) }; }
    this.btcPriv = rand(32);
    if (isInitiator) { this.secret = rand(32); this.H = sha256(this.secret); }   // only the initiator (alice) holds the secret
  }
  secrets() {
    return {
      swapId: this.id, role: this.role, direction: this.direction, token: this.token, coordinator: this.base,
      btcDest: this.btcDest, qbitDest: this.qbitDest,
      qbitPk: hex(this.qbit.pk), qbitSk: hex(this.qbit.sk), btcPriv: hex(this.btcPriv),
      secret: this.secret ? hex(this.secret) : null, H: this.H ? hex(this.H) : null,
      btcSats: this.terms?.btcSats ?? null, qbtSats: this.terms?.qbtSats ?? null,
      createdAt: this.createdAt,
      recovery: this.recovery || null,   // pre-signed watchtower ladder (claim tiers + refund), for offline recovery
    };
  }
  restore(p) {
    this.id = p.swapId; this.role = p.role; this.direction = p.direction; this.token = p.token; this.base = p.coordinator.replace(/\/$/, "");
    if (p.createdAt) this.createdAt = p.createdAt;
    this.btcDest = p.btcDest; this.qbitDest = p.qbitDest;
    this.qbit = { pk: bin(p.qbitPk), sk: bin(p.qbitSk) }; this.btcPriv = bin(p.btcPriv);
    this.secret = p.secret ? bin(p.secret) : null; this.H = p.H ? bin(p.H) : null;
    this.terms = p.btcSats != null ? { btcSats: p.btcSats, qbtSats: p.qbtSats } : null;
    this.recovery = p.recovery || null;
    return this;
  }

  // ── create / join ────────────────────────────────────────────────────────────
  // `role` is the creator's OWN role: "alice" if the creator is BUYING QBT (initiator, sends BTC),
  // "bob" if SELLING QBT (participant, sends QBT). Only the initiator holds the secret; the invite link
  // hands the counterparty the other token. Every swap is btc2qbt under the hood.
  async create({ role = "alice", btcSats, qbtSats, securityLevel = "high", btcDest, qbitDest }) {
    this.role = role; this.direction = "btc2qbt"; this.btcDest = btcDest; this.qbitDest = qbitDest;
    this.terms = { btcSats, qbtSats };
    await this.#freshKeys(role === "alice");
    const { id, tokens } = await this.#api("/swaps", { method: "POST", body: { btcSats, qbtSats, securityLevel } });
    this.id = id; this.token = tokens[role];
    await this.#submit();
    const inviteToken = tokens[role === "alice" ? "bob" : "alice"];
    return { id, myToken: this.token, inviteToken, inviteLink: this.link(inviteToken) };
  }
  // Join from an invite link. We learn our role from the coordinator via our token — if we're the
  // initiator (alice, the QBT buyer) we must generate the secret + submit H; the participant must not.
  async join({ id, token, btcDest, qbitDest }) {
    this.id = id; this.token = token; this.btcDest = btcDest; this.qbitDest = qbitDest;
    const pre = await this.#api(`/swaps/${id}`, { token });
    this.role = pre.role; this.direction = pre.direction || "btc2qbt";
    if (pre.chains) this.chains = pre.chains;   // the swap view is authoritative for the pair's identity
    await this.#freshKeys(this.role === "alice");
    const v = await this.#submit();
    this.terms = { btcSats: v.terms?.btcSats, qbtSats: v.terms?.qbtSats };
    return { id, role: this.role, direction: this.direction };
  }
  // Enter an already-created swap (e.g. one instantiated by taking an order-book offer) in a given role.
  async enter({ id, token, direction, role, btcDest, qbitDest }) {
    this.role = role; this.direction = direction; this.id = id; this.token = token; this.btcDest = btcDest; this.qbitDest = qbitDest;
    await this.#freshKeys(role === "alice");
    const v = await this.#submit();
    this.terms = { btcSats: v.terms?.btcSats, qbtSats: v.terms?.qbtSats };
    return { id };
  }
  #submit() {
    const body = { qbitPub: hex(this.qbit.pk), btcPub: hex(compressedPub(this.btcPriv)), btcDest: this.btcDest, qbitDest: this.qbitDest };
    if (this.role === "alice") body.H = hex(this.H);
    return this.#api(`/swaps/${this.id}/party`, { token: this.token, method: "POST", body });
  }
  link(inviteToken) {
    const l = globalThis.location;
    const lang = l?.search ? new URLSearchParams(l.search).get("lang") : null;   // carry the sharer's language into the invite link
    const q = lang ? `?lang=${encodeURIComponent(lang)}` : "";
    return `${l?.origin || ""}${l?.pathname || ""}${q}#coord=${encodeURIComponent(this.base)}&id=${this.id}&token=${inviteToken}`;
  }

  // ── live drive ────────────────────────────────────────────────────────────────
  start() {
    const url = `${this.base}/swaps/${this.id}/events?token=${this.token}`;
    if (typeof EventSource !== "undefined") { this.es = new EventSource(url); this.es.onmessage = (e) => this.#onView(JSON.parse(e.data)); this.es.onerror = () => {}; }
    else this.timer = setInterval(async () => { try { this.#onView(await this.#api(`/swaps/${this.id}`, { token: this.token })); } catch {} }, 2000);
    // Presence heartbeat: an SSE connection alone no longer counts as "online" server-side (a tab closed
    // behind the Cloudflare tunnel can leave the socket lingering), so keep our last-seen fresh with a
    // tiny periodic hit. Cleared in stop() — and when the tab closes, the beats simply stop.
    this.beat = setInterval(() => { this.#api(`/swaps/${this.id}/beat`, { token: this.token }).catch(() => {}); }, 6000);
  }
  stop() { this.es?.close(); clearInterval(this.timer); clearInterval(this.beat); }
  // Cancel an unfunded swap (either party). The coordinator rejects it once a deposit exists.
  cancel() { return this.#api(`/swaps/${this.id}/cancel`, { token: this.token, method: "POST" }); }

  async #onView(v) {
    this.view = v;
    // Self-heal: if the coordinator shows OUR party slot empty even though we already joined (e.g. it
    // restarted before our submission persisted), re-submit — idempotent under the first-come lock
    // (same keys), and throttled so a slow view can't stampede it.
    if (!v.self && this.btcDest && this.qbit && this.btcPriv && !this.halted && !this._resub) {
      this._resub = setTimeout(() => { this._resub = null; }, 5000);
      this.#submit().catch(() => {});
    }
    // Independently re-derive the HTLC scripts from OUR keys + the counterparty pubkey + H + locktimes
    // and confirm they match the coordinator's. If not, a derivation bug or tampering produced a script
    // we don't control — HALT before any funds move.
    if (v.htlc && !this.verifyHtlc(v)) { this.halted = true; this.onUpdate({ ...v, securityError: true }); return; }
    this.onUpdate(v);
    if (this.halted) return;
    try { await this.#act(v); } catch (e) { this.onUpdate({ ...v, actionError: String(e.message || e) }); }
    if (v.state === "COMPLETE" || v.state === "REFUNDED" || v.state === "CANCELED") this.stop();
  }
  // Recompute both HTLC scriptPubKeys the way the coordinator must have, using our own real keys — a
  // mismatch means the address we'd fund isn't the script we can claim/refund. (This binds our keys, H,
  // and the locktimes into the scripts; it does not by itself authenticate the counterparty's pubkey.)
  verifyHtlc(v) {
    try {
      if (!v.roles || !v.locktimes || !v.counterparty?.qbitPub || !v.counterparty?.btcPub || !v.H) return true;   // not enough yet
      const H = bin(v.H), { fromLeg, toLeg } = v.roles;
      const self = { qbit: this.qbit.pk, btc: compressedPub(this.btcPriv) };
      const cp = { qbit: bin(v.counterparty.qbitPub), btc: bin(v.counterparty.btcPub) };
      const pk = (role, coin) => (role === this.role ? self[coin] : cp[coin]);
      const spk = (leg, claimRole, refundRole) => this.famOf(leg) === "p2mr-slhdsa"
        ? hex(p2mrSpk(htlcLeafQbit(H, pk(claimRole, leg), pk(refundRole, leg), v.locktimes[leg])))
        : hex(p2wshSpk(htlcWitnessScript(H, pk(claimRole, leg), pk(refundRole, leg), v.locktimes[leg])));
      // deriveHtlcs: fromLeg claim=participant(bob)/refund=initiator(alice); toLeg claim=alice/refund=bob
      return spk(fromLeg, "bob", "alice") === v.htlc[fromLeg].spk && spk(toLeg, "alice", "bob") === v.htlc[toLeg].spk;
    } catch { return false; }
  }

  // Which leg this party funds / claims / refunds, from the swap's role map.
  legs(v) {
    const { fromLeg, toLeg } = v.roles;
    return this.role === "alice"
      ? { fund: fromLeg, claim: toLeg, refund: fromLeg }     // initiator
      : { fund: toLeg, claim: fromLeg, refund: toLeg };      // participant
  }

  async #act(v) {
    if (!v.htlc) return;
    // Arm the coordinator watchtower once BOTH legs are funded: pre-sign a fee-ladder claim + a refund
    // so the swap completes/refunds even if this tab closes. Non-custodial — pays only our addresses.
    if (v.funding?.[this.legs(v).fund] || (v.funding?.btc && v.funding?.qbit) || v.shortFunded?.[this.legs(v).fund]) { try { await this.armSafetyNet(v); } catch { /* retry next tick */ } }

    const done = (k) => this.acted.has(k) || v.broadcasts?.[k];
    const { claim, refund } = this.legs(v);
    if (this.role === "alice") {
      if (v.state === "CLAIMABLE" && !done(`${claim}:claim`)) return this.#claim(v, claim, this.secret);
      if (v.refund?.[refund]?.available && v.state !== "COMPLETE" && !done(`${refund}:refund`)) return this.#refund(v, refund);
    } else {
      if (v.preimage && !done(`${claim}:claim`)) return this.#claim(v, claim, bin(v.preimage));
      if (v.refund?.[refund]?.available && !v.preimage && !done(`${refund}:refund`)) return this.#refund(v, refund);
    }
  }
  // Broadcast a signed claim/refund. Primary path is the coordinator (it relays to both chains' nodes
  // and updates its view). If the coordinator is unreachable, the tx can still be pushed straight to the
  // network via public broadcast APIs — for EITHER leg, since both BTC and QBT are openly relayable — so
  // a backend outage never traps your claim/refund while this tab is open.
  async #send(leg, kind, tx) {
    const key = `${leg}:${kind}`, txHex = hex(tx);
    this.acted.add(key);   // guard against a duplicate fire on the next tick while this send is in flight
    try {
      return await this.#api(`/swaps/${this.id}/broadcast`, { token: this.token, method: "POST", body: { leg, kind, tx: txHex } });
    } catch (e) {
      // Benign: the spend already landed — the watchtower (or our own earlier broadcast) got there first,
      // so the node rejects this as a duplicate / already-spent input. That's SUCCESS, not an error: leave
      // `key` marked done and swallow it, so no spurious message flashes as the swap settles.
      if (alreadySpent(e)) return { alreadyDone: true };
      const endpoints = leg === "btc" ? this.btcBroadcast : this.qbitBroadcast;
      if (endpoints.length) {
        try {
          const txid = await postRawTx(endpoints, txHex);
          this.onUpdate({ ...this.view, broadcastFallback: { leg, kind, txid } });   // surface that we bypassed the coordinator
          return { fallback: true, txid };
        } catch (fe) {
          // The QBT public-mempool fallback is best-effort — NEVER surface its errors (the coordinator +
          // watchtower are the authority on completion, and a duplicate/already-spent 400 is expected once
          // the claim has landed). BTC still surfaces a genuine, non-already-spent failure.
          if (leg === "qbit" || alreadySpent(fe)) return { alreadyDone: true };
          this.acted.delete(key); throw fe;
        }
      }
      this.acted.delete(key);   // total failure — let #act retry this leg on the next update
      throw e;
    }
  }

  // ── watchtower safety net: pre-sign and upload a fee-ladder claim + a refund ──
  async armSafetyNet(v) {
    if (!v.htlc) return;
    const { fund, claim, refund } = this.legs(v);
    const bothFunded = v.funding?.btc && v.funding?.qbit;
    // Refund-only arming: OUR deposit is a real HTLC UTXO even while the swap can't complete —
    // underfunded, or the counterparty never funds theirs (an expired first leg). Pre-sign its refund
    // the moment it exists, so the watchtower reclaims it after the timelock even if this tab never
    // comes back. Without this, a solo-funded-then-abandoned swap had NO watchtower coverage and
    // recovery depended entirely on the sender's backup file.
    const mine = !bothFunded ? (v.funding?.[fund] || v.shortFunded?.[fund]) : null;
    if (!bothFunded && !mine) return;
    // Arm as soon as the deposit(s) exist — even at 0-conf: the outpoints are known, so the recovery txs
    // can be pre-signed now. Re-key on the live outpoints so a replaced/solo/underfunded deposit re-arms
    // (and a solo arm upgrades to the full claim+refund bundle when the second leg lands).
    const key = bothFunded
      ? `${v.funding.btc.txid}:${v.funding.btc.vout}|${v.funding.qbit.txid}:${v.funding.qbit.vout}`
      : `solo:${mine.txid}:${mine.vout}`;
    if (this.armedKey === key) return;
    // Build a fee-ladder of pre-signed txs for a leg/kind: skip any tier whose fee would leave a dust or
    // negative output (defensive; createSwap already floors amounts), always keeping at least the lowest.
    const ladderOf = async (leg, kind, pre, xvb) => {
      const amt = (v.funding?.[leg] || v.shortFunded?.[leg]).amountSats;   // shortFunded → underfunded refund
      const aff = LADDER[leg].map((fr) => ({ fr, fee: feeFor(leg, kind, fr, v.feerates, xvb) })).filter(({ fee }) => amt - fee > DUST);
      const use = aff.length ? aff : [{ fr: LADDER[leg][0], fee: feeFor(leg, kind, LADDER[leg][0], v.feerates, xvb) }];
      return Promise.all(use.map(async ({ fr, fee }) => ({ feerate: fr, tx: hex(await this.#build(v, leg, kind, pre, fee)) })));
    };
    // participant signs the claim preimage-LESS (the coordinator splices the preimage in on reveal).
    const claimPreimage = this.role === "alice" ? this.secret : new Uint8Array(0);
    const bundle = bothFunded
      ? {
          claim: { leg: claim, needsPreimage: this.role !== "alice", tiers: await ladderOf(claim, "claim", claimPreimage, feeVbytes(v, claim, "claim")) },
          refund: { leg: refund, tiers: await ladderOf(refund, "refund", new Uint8Array(0), 0) },   // no coordinator-fee output on a refund
        }
      : { refund: { leg: refund, tiers: await ladderOf(refund, "refund", new Uint8Array(0), 0) } };   // underfunded → refund only (no claim path)
    // Fork pairs: pre-sign a TWIN sweep — the same refund-path spend of our deposit outpoint, but
    // built for the OTHER chain. If our deposit gets replayed across the fork (sender skipped the
    // replay protection), the watchtower uses this to return the duplicated coins to our refund
    // address once the timelock allows. The replay marker rides it only when the chain it will be
    // broadcast ON requires one (btc leg: marker keeps THIS sweep from crossing back; fork leg:
    // BIP-110 would refuse to relay a marker-ed tx at all).
    const twinLeg = fund === "btc" ? "qbit" : "btc";
    if ((v.chains || this.view?.chains || this.chains)?.[fund]?.forkTwin && this.famOf(fund) === "p2wsh-ecdsa") {
      const amt = (v.funding?.[fund] || v.shortFunded?.[fund]).amountSats;
      const xvb = this.replayOf(twinLeg) ? REPLAY_VB : 0;
      const aff = LADDER[twinLeg].map((fr) => ({ fr, fee: feeFor(fund, "refund", fr, v.feerates, xvb) })).filter(({ fee }) => amt - fee > DUST);
      const use = aff.length ? aff : [{ fr: LADDER[twinLeg][0], fee: feeFor(fund, "refund", LADDER[twinLeg][0], v.feerates, xvb) }];
      bundle.twin = { leg: twinLeg, fundLeg: fund, tiers: await Promise.all(use.map(async ({ fr, fee }) => ({ feerate: fr, tx: hex(await this.#buildTwin(v, fund, twinLeg, fee)) }))) };
    }
    // Keep our own copy of the pre-signed recovery ladder BEFORE the POST — the file alone (keys + these
    // txs) is enough to recover even if the coordinator is gone, AND the coordinator emits the "armed"
    // view update the instant it receives the bundle (over SSE, before this POST's own response
    // resolves); that update re-renders, so recovery must already be set or the "download recovery
    // backup" button is missed until the next update. Safe if the POST fails: `armed` stays false, so the
    // button stays hidden until a successful retry.
    this.recovery = bundle;
    await this.#api(`/swaps/${this.id}/finish`, { token: this.token, method: "POST", body: bundle });
    this.armedKey = key;
    this.armed = true;   // the coordinator now reflects safetyNet.self=true in the view
  }

  // ── signing (leg-generic; build a tx at a given fee, then optionally broadcast) ──
  // Dispatch on the leg's SCRIPT FAMILY, not its slot name — a fork pair signs P2WSH+ECDSA on BOTH legs.
  #build(v, leg, kind, preimage, feeSats) { return this.famOf(leg) === "p2mr-slhdsa" ? this.#buildP2mr(v, leg, kind, preimage, feeSats) : this.#buildP2wsh(v, leg, kind, preimage, feeSats); }
  // Slot-shaped accessors: which of our dests/keys serves a given leg (the qbit-slot key is SLH-DSA or
  // secp depending on the slot's family; both live in this.qbit).
  #destOf(leg) { return leg === "btc" ? this.btcDest : this.qbitDest; }
  #privOf(leg) { return leg === "btc" ? this.btcPriv : this.qbit.sk; }
  // Live claim/refund the party signs itself: size the BTC fee at mempool's High-priority tier
  // (v.feerates.fastestFee) so it confirms promptly — the pre-signed fee ladder is only the fallback
  // the watchtower uses when this party is OFFLINE. Never let the fee eat the output below dust.
  #liveFee(v, leg, kind) { const amt = (v.funding?.[leg] || v.shortFunded?.[leg])?.amountSats || 0; return Math.min(dynFee(leg, kind, v.feerates, feeVbytes(v, leg, kind)), amt - DUST); }
  async #claim(v, leg, preimage) { return this.#send(leg, "claim", await this.#build(v, leg, "claim", preimage, this.#liveFee(v, leg, "claim"))); }
  async #refund(v, leg) { return this.#send(leg, "refund", await this.#build(v, leg, "refund", new Uint8Array(0), this.#liveFee(v, leg, "refund"))); }

  // Build (but do NOT broadcast) this party's claim or refund sweep at the current view — the same tx
  // #claim/#refund would send. Exposed for tests/tooling (e.g. checking timelock maturity). A refund's
  // nLockTime is the leg's CLTV height, so it is consensus-invalid ("non-final") until the chain reaches
  // it; a claim carries no timelock. Returns { leg, hex }.
  async buildSweep(v, kind) {
    const { claim, refund } = this.legs(v);
    const leg = kind === "refund" ? refund : claim;
    const preimage = kind === "refund" ? new Uint8Array(0) : (this.role === "alice" ? this.secret : bin(v.preimage));
    return { leg, hex: hex(await this.#build(v, leg, kind, preimage, this.#liveFee(v, leg, kind))) };
  }

  // Twin sweep: refund-branch spend of our FUND-leg deposit outpoint, destined for the OTHER chain of
  // a fork pair (same script rules, so the same ECDSA signing applies — only the marker differs).
  async #buildTwin(v, fundLeg, twinLeg, feeSats) {
    const f = v.funding[fundLeg] || v.shortFunded?.[fundLeg], ws = bin(v.htlc[fundLeg].witnessScript), destSpk = addressToScriptPubKey(this.#destOf(fundLeg));
    return btcSpend({ prevTxidLE: bin(f.txid).reverse(), vout: f.vout, amount: f.amountSats, ws, priv: this.#privOf(fundLeg), destSpk, outVal: f.amountSats - feeSats, branch: "refund", preimage: new Uint8Array(0), locktime: v.locktimes[fundLeg], extraOut: null, replay: this.replayOf(twinLeg) });
  }

  async #buildP2mr(v, leg, kind, preimage, feeSats) {
    const f = v.funding[leg] || v.shortFunded?.[leg], leaf = bin(v.htlc[leg].leaf), spk = bin(v.htlc[leg].spk);   // shortFunded → refund an underfunded deposit
    const destSpk = addressToScriptPubKey(this.#destOf(leg)), prevoutLE = bin(f.txid).reverse(), outVal = f.amountSats - feeSats;
    const refund = kind === "refund", lock = refund ? v.locktimes[leg] : 0, seq = refund ? 0xfffffffe : 0xffffffff;
    const sh = p2mrSighash({ version: 2, locktime: lock, vin: [{ txidLE: prevoutLE, vout: f.vout, sequence: seq }], spentOutputs: [{ amount: f.amountSats, spk }], vout: [{ value: outVal, spk: destSpk }], inputIndex: 0, leafScript: leaf });
    const sig = await slhDsaSign(this.qbit.sk, sh);
    const witIf = refund ? new Uint8Array(0) : preimage;           // ELSE(refund)=empty ; IF(claim)=preimage (empty placeholder when pre-signing preimage-less)
    const wit = refund ? [sig, witIf, leaf, P2MR_CONTROL_SINGLE_LEAF] : [sig, witIf, Uint8Array.of(0x01), leaf, P2MR_CONTROL_SINGLE_LEAF];
    return serializeTx({ version: 2, vin: [[prevoutLE, f.vout, new Uint8Array(0), seq]], vout: [[BigInt(outVal), destSpk]], wit: [wit], locktime: lock });
  }
  async #buildP2wsh(v, leg, kind, preimage, feeSats) {
    const f = v.funding[leg] || v.shortFunded?.[leg], ws = bin(v.htlc[leg].witnessScript), destSpk = addressToScriptPubKey(this.#destOf(leg));   // shortFunded → refund an underfunded deposit
    const branch = kind === "refund" ? "refund" : "claim";
    // Coordinator fee: on a successful BTC-SLOT claim, add a second output paying the coordinator's fee
    // address (the fee always rides the btc slot). The buyer funded it on top of the swap amount, so the
    // seller still nets the full swap amount; the claim's own network fee (feeSats) is taken out of the
    // fee output. No fee on refunds; dropped if it would be dust.
    let extraOut = null, outVal = f.amountSats - feeSats;   // no coordinator fee → the claimer pays the network fee from its own amount
    if (leg === "btc" && branch === "claim" && v.fee?.sats > 0 && v.fee.address) {
      const split = btcClaimSplit(f.amountSats, feeSats, v.fee.sats);   // seller stays whole; network fee capped at the reserve
      outVal = split.outVal;
      if (split.feeOut != null) extraOut = { spk: addressToScriptPubKey(v.fee.address), value: split.feeOut };
    }
    // Fork replay protection: on a flagged leg every sweep carries the >83-byte OP_RETURN marker (the
    // coordinator refuses marker-less sweeps there; BIP-110 policy keeps the tx off the fork chain).
    return btcSpend({ prevTxidLE: bin(f.txid).reverse(), vout: f.vout, amount: f.amountSats, ws, priv: this.#privOf(leg), destSpk, outVal, branch, preimage, locktime: branch === "refund" ? v.locktimes[leg] : 0, extraOut, replay: this.replayOf(leg) && branch !== "refund" });   // refunds pay our own address — a replayed refund is harmless (and returns our twin), so no marker
  }
}

// Fixed fee ladders (sat/vB) the client pre-signs for the WATCHTOWER fallback; the coordinator
// picks/escalates tiers using live feerates when it must act for an offline party. BTC spans
// economy→extreme; Qbit is uncongested so a low pair suffices.
const DUST = 546;
// BTC claim outputs when the buyer pre-paid a fee (funding = swap amount + fee reserve). The seller ALWAYS
// nets the full swap amount (funding − feeTotal); the network fee we actually take is CAPPED at feeTotal,
// so however high fees have risen it can never eat into the seller's amount. The platform keeps whatever
// the (capped) network fee didn't consume — dropped if that remainder would be dust (then the leftover, at
// most feeTotal, simply becomes the network fee, still leaving the seller whole).
export function btcClaimSplit(funding, netFee, feeTotal) {
  const outVal = funding - feeTotal;                                       // seller's agreed amount, always
  const feeOut = feeTotal - Math.min(Math.max(0, netFee), feeTotal);       // platform remainder after the capped network fee
  return { outVal, feeOut: feeOut > DUST ? feeOut : null };
}
// Public broadcast endpoints for the coordinator-down fallback (#send), keyed by network hrp. Both chains
// are openly relayable, so we ship a fallback for EITHER leg: each endpoint accepts a raw tx hex as the
// POST body and returns the txid (Esplora-style). Regtest ("bcrt"/"qbrt") has no public endpoint → empty.
// QBT endpoints can be injected per-deploy via window.QBIT_BROADCAST_URLS = { qb: [...], tqb: [...] } so
// they aren't pinned in-source; a hardcoded default can be added here once stable.
export const BTC_BROADCAST = {
  bc: ["https://mempool.space/api/tx", "https://blockstream.info/api/tx"],
  tb: ["https://mempool.space/testnet4/api/tx", "https://blockstream.info/testnet/api/tx"],
};
export const QBIT_BROADCAST = {
  qb: (globalThis.QBIT_BROADCAST_URLS?.qb) || [],
  tqb: (globalThis.QBIT_BROADCAST_URLS?.tqb) || [],
};
// A broadcast rejection that actually means "the spend already landed" — the input is gone (already
// spent) or the tx is already known/in the mempool. Not a failure: the claim/refund is done. Covers
// Bitcoin Core / Esplora reasons and RPC codes (-25 missing inputs, -26 already-in-chain, -27 already-known).
const alreadySpent = (e) => /already|in[- ]?mempool|txn-already|missing[- ]?inputs|missingorspent|bad-txns-inputs|-2[567]\b/i.test(String(e?.message || e || ""));
// POST a raw tx hex to each endpoint in turn; return the first accepted txid, or throw if none accept.
// Injectable fetch for testing. Used by the coordinator-down BTC broadcast fallback.
export async function postRawTx(endpoints, txHex, fetchImpl = fetch) {
  let lastErr;
  for (const url of endpoints) {
    try {
      const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "text/plain" }, body: txHex });
      const body = (await r.text()).trim();
      if (r.ok) return body;                                   // the txid
      lastErr = new Error(`${url} -> ${r.status} ${body.slice(0, 100)}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("no reachable broadcast endpoint");
}
const LADDER = { btc: [2, 8, 25, 75, 200], qbit: [1, 5] };
// vsize per sweep, by SCRIPT FAMILY (measured on regtest). IMPORTANT: SLH-DSA witnesses get NO segwit
// discount (vsize == weight ≈ 3.9k vB), so those must be the real sizes — a low estimate underpays the
// feerate and the tx can stall. A p2wsh-ecdsa second leg (fork pair) sizes like Bitcoin.
const FAMILY_VBYTES = { "p2wsh-ecdsa": { claim: 165, refund: 140 }, "p2mr-slhdsa": { claim: 4200, refund: 4200 } };
const legFam = (leg) => globalThis.QBIT_CHAINS?.[leg]?.script || (leg === "qbit" ? "p2mr-slhdsa" : "p2wsh-ecdsa");
const VBYTES = { get btc() { return FAMILY_VBYTES[legFam("btc")]; }, get qbit() { return FAMILY_VBYTES[legFam("qbit")]; } };
// Marginal vsize of the coordinator-fee output (a P2TR output ≈ 43 vB), added to a BTC claim that
// carries one; and of the replay-protection OP_RETURN (103-byte spk ≈ 112 vB) on a flagged leg — both
// so the network fee is sized for the real transaction.
const FEE_OUT_VB = 43, REPLAY_VB = 112;
const feeVbytes = (v, leg, kind) => (leg === "btc" && kind === "claim" && v.fee?.sats > 0 ? FEE_OUT_VB : 0)
  + (kind === "claim" && (v.chains?.[leg]?.replayOpReturn || globalThis.QBIT_CHAINS?.[leg]?.replayOpReturn) ? REPLAY_VB : 0);   // refunds carry no marker
// Absolute fee floor (sats): never pay below the node's own min-relay feerate for this tx's size
// (`feerates.<leg>.minimumFee` — BTC from mempool.space, Qbit from getmempoolinfo). No hardcoded floor.
const relayFloor = (leg, kind, feerates, extraVb = 0) => Math.ceil(Math.max(1, feerates?.[leg]?.minimumFee || 1) * (VBYTES[leg][kind] + extraVb));
const feeFor = (leg, kind, feerate, feerates, extraVb = 0) => Math.max(relayFloor(leg, kind, feerates, extraVb), Math.round(feerate * (VBYTES[leg][kind] + extraVb)));
// The fee (sats) for a live-signed claim/refund, sized from the coordinator's per-chain recommendation
// (`view.feerates = { btc, qbit }`): High priority (fastestFee) for the urgent claim, Medium
// (halfHourFee) for the timelock-gated refund. BTC comes from mempool.space; Qbit from the node's own
// estimatesmartfee. This is the NORMAL path; the pre-signed ladder is only for extreme situations (a
// party offline during a fee spike).
export function dynFee(leg, kind, feerates, extraVb = 0) {
  const tier = kind === "claim" ? "fastestFee" : "halfHourFee";
  const fr = Math.max(1, feerates?.[leg]?.[tier] || 0);
  return Math.max(relayFloor(leg, kind, feerates, extraVb), Math.round(fr * (VBYTES[leg][kind] + extraVb)));
}
