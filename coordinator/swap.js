// Keyless swap model + Tier-Nolan state machine. The coordinator never holds keys, preimages (until
// public), or funds. It derives the two HTLC addresses, watches both chains, gates the initiator's
// claim on reorg-safe confirmations, surfaces refundability once timelocks pass, broadcasts
// party-signed txs, and surfaces the revealed preimage. Optional JSON persistence + a change pub/sub
// feed the API/SSE.
//
// Roles are FIXED so the QBT BUYER is always the initiator (alice, holds the secret), no matter who
// created the swap link. Every swap is btc2qbt under the hood: the initiator funds fromLeg=BTC (longer
// timelock) and claims toLeg=QBT (shorter timelock, revealing the preimage); the participant (bob, the
// QBT seller) funds QBT and claims BTC with the now-public preimage. This is the only reorg-safe
// assignment — the buyer's BTC funding stays refundable until they reveal, so BOTH parties can fund
// immediately and the value-scaled gate sits on the buyer's QBT claim. Who sells QBT is decided purely
// by which token (alice/bob) each party holds; the vulnerable "initiator sells QBT" arrangement is no
// longer constructible. `direction` is retained as "btc2qbt" on every swap for view/compat.
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import {
  htlcWitnessScript, p2wshSpk, p2wshAddr,          // BTC leg
  htlcLeafQbit, p2mrSpk, p2mrAddress,               // QBT leg
  parseTx, serializeTx,                             // for splicing the preimage into a pre-signed claim
} from "../client/index.js";
import { qbit, btc } from "./chain.js";
import { btcFeerates, cachedBtcFeerates, cachedQbitFeerates } from "./fees.js";
import { feeAddress, validateFeeKey } from "./feeaddr.js";
import { makeStore } from "./store.js";
import { chainCfg, publicChains, hasReplayMarker, forkTwinPair } from "./chains.js";

export const States = ["CREATED", "READY", "FROM_FUNDED", "TO_FUNDED", "MATURING", "CLAIMABLE", "CLAIMED", "COMPLETE", "REFUNDED", "ABORTED"];
const TERMINAL = ["COMPLETE", "REFUNDED", "ABORTED"];
const legsFor = (direction) => (direction === "qbt2btc" ? { fromLeg: "qbit", toLeg: "btc" } : { fromLeg: "btc", toLeg: "qbit" });
const chainOf = (leg) => (leg === "btc" ? btc : qbit);

const swaps = new Map();
const token = () => randomBytes(16).toString("hex");

// ── active-swap cap ───────────────────────────────────────────────────────────────────────────────
// The in-memory working set is polled against both nodes every tick; an unbounded set is a DoS vector.
// Cancel-able (CREATED) swaps and terminal ones are excluded from the count.
const MAX_ACTIVE_SWAPS = Number(process.env.MAX_ACTIVE_SWAPS || 2000);

// ── persistence (optional; COORD_DB → .db/.sqlite = per-row sqlite, else JSON snapshot) ──────────────
// The store checkpoints in-memory state so a restart resumes in-flight swaps. touch() writes just the
// changed swap (O(1) on the sqlite backend), so this scales past the JSON snapshot's full-file rewrite.
const store = makeStore(process.env.COORD_DB || null, () => [...swaps.values()]);
export const storeBackend = () => store.backend;
export const storeQuery = (sql, ...params) => (store.query ? store.query(sql, ...params) : null);   // sqlite only; null otherwise
export const _store = store;   // internal/test seam
for (const s of store.load()) swaps.set(s.id, s);

// ── memory bounding: evict long-settled swaps, load-on-demand from the store ─────────────────────────
// The in-memory Map is the WORKING SET (active swaps + recently-settled). A settled swap needs no more
// engine action (poll() and driveWatchtower() both no-op on TERMINAL), so once it's been terminal past
// SWAP_EVICT_MS we drop it from memory — it lives on in the store and is re-loaded on demand by getSwap.
// This bounds RAM to active + ~a day of history instead of growing forever. Only with a store that can
// reload (sqlite): with the JSON/memory backend there's no per-id read, so we never evict.
const EVICT_MS = Number(process.env.SWAP_EVICT_MS || 86400000);   // 24h — matches the watch-descriptor settle grace
export function evictSettled() {
  if (!store.get) return 0;                                        // no load-on-demand → keep everything in memory
  const cutoff = Date.now() - EVICT_MS;
  let n = 0;
  for (const s of swaps.values())
    if (TERMINAL.includes(s.state) && s.settledAt > 0 && s.settledAt < cutoff && !twinPending(s)) { swaps.delete(s.id); n++; }   // a detected-but-unswept replay twin pins the swap in memory (driveTwinSweep needs it)
  return n;
}
// Store-backed aggregates over ALL swaps (incl. evicted) — null when the backend can't provide them
// (JSON/memory), so callers fall back to the in-memory working set.
export const persistedCounts = () => (store.counts ? store.counts() : null);
export const persistedVolume = () => (store.volume ? store.volume() : null);
export const recentComplete = (limit) => (store.recent ? store.recent(limit) : null);
// Working set + persisted history, merged (the LIVE in-memory object wins for any id in both — it's
// fresher). This is what LIST-style readers (the admin dashboard's swaps table, watchtower panel) must
// use: allSwaps() alone silently loses long-settled swaps once they evict. Read-only — do not mutate
// the store-loaded (terminal) entries. `limit` bounds the store read, newest-updated first.
export function swapsIncludingSettled(limit = 1000) {
  if (!store.query) return allSwaps();          // JSON/memory backend never evicts — the Map IS the history
  const out = new Map(swaps);
  for (const r of store.query("SELECT data FROM swaps ORDER BY updated_at DESC LIMIT ?", limit)) {
    try { const s = JSON.parse(r.data); if (!out.has(s.id)) out.set(s.id, s); } catch { /* torn row */ }
  }
  return [...out.values()];
}

// ── change pub/sub (drives SSE) ───────────────────────────────────────────────
const subs = new Map();
export function subscribe(id, cb) {
  if (!subs.has(id)) subs.set(id, new Set());
  subs.get(id).add(cb);
  return () => subs.get(id)?.delete(cb);
}
// Global subscription: fires on ANY swap's change. Drives the admin dashboard's live feed.
const allSubs = new Set();
export function subscribeAll(cb) { allSubs.add(cb); return () => allSubs.delete(cb); }
// The signature must cover EVERY field a restart can't recompute from chain state — party data and H
// arrive once from clients and exist nowhere else. (A join used to leave the sig unchanged, so a
// coordinator restart before the SECOND party joined silently dropped the first joiner's keys and
// wedged the swap in CREATED with no way forward.)
const sigOf = (s) => JSON.stringify({ st: s.state, f: s.funding, r: s.refund, p: s.preimage, b: s.broadcasts, fn: [!!s.finish?.alice, !!s.finish?.bob], tw: s.twin, pa: s.party?.alice?.btcPub, pb: s.party?.bob?.btcPub, H: s.H, sf: s.shortFunded, wt: s.wt });
function emit(s) {
  for (const cb of subs.get(s.id) || []) { try { cb(s); } catch { /* dead listener */ } }
  for (const cb of allSubs) { try { cb(s); } catch { /* dead listener */ } }
}
function touch(s) {
  const g = sigOf(s);
  if (g === s._sig) return s;
  s._sig = g; store.put(s);   // persist just this swap (O(1) on sqlite; JSON backend rewrites the snapshot)
  emit(s);
  return s;
}

// ── presence (drives "counterparty online") ──────────────────────────────────
// A role is online if it has hit the API recently — the SSE connect, the client's ~6s heartbeat, or a
// polling bot's requests all refresh `seen`. We deliberately do NOT treat an open SSE socket as proof of
// life: through the Cloudflare tunnel a closed browser tab's socket can linger at the origin (the `close`
// event never fires), so a socket-count signal reads "online" forever and used to freeze the watchtower.
// Recency of an actual client-originated request can't be faked by a dead connection. (Presence is now a
// UI signal only — the watchtower acts on chain state regardless.)
const ONLINE_MS = 20000;   // > 3× the client heartbeat, so one dropped beat doesn't flap the indicator
const nowMs = () => Date.now();
const presenceOf = (s) => (s.presence ||= { alice: { sse: 0, seen: 0 }, bob: { sse: 0, seen: 0 } });
export const isOnline = (s, role) => nowMs() - presenceOf(s)[role].seen < ONLINE_MS;
function onPresenceChange(s, role, mutate) { const before = isOnline(s, role); mutate(presenceOf(s)[role]); if (isOnline(s, role) !== before) emit(s); }
export function markSeen(id, role) { const s = swaps.get(id); if (s) onPresenceChange(s, role, (p) => { p.seen = nowMs(); }); }
export function addConnection(id, role) { const s = swaps.get(id); if (s) onPresenceChange(s, role, (p) => { p.sse++; p.seen = nowMs(); }); }
export function dropConnection(id, role) { const s = swaps.get(id); if (s) onPresenceChange(s, role, (p) => { p.sse = Math.max(0, p.sse - 1); }); }
// Periodic sweep so a client going silent (last-seen expiry) flips the counterparty to offline.
export function sweepPresence() {
  for (const s of swaps.values()) {
    const o = { alice: isOnline(s, "alice"), bob: isOnline(s, "bob") };
    if (!s._online || s._online.alice !== o.alice || s._online.bob !== o.bob) { s._online = o; emit(s); }
  }
}

// Per-leg chain identity (label, hrp, block time, min sats/confs, script family, reorg model, trust +
// replay flags) lives in chains.js — the "qbit" slot is configurable to any Core-RPC UTXO chain
// (CHAIN2=qbit|bip110). These are thin accessors so a config change needs no edits here.
export const MIN_SATS = { get btc() { return chainCfg("btc").minSats; }, get qbit() { return chainCfg("qbit").minSats; } };   // above the largest claim/refund fee + dust; the web app reads these (injected) so its up-front check matches this authority
const HRP = { get btc() { return chainCfg("btc").hrp; }, get qbit() { return chainCfg("qbit").hrp; } };   // MUST match the deploy network or users get an unspendable address

// ── coordinator fee (optional, default OFF) ────────────────────────────────────────────────────
// A fee charged ON TOP of the buyer's BTC deposit and paid to a FRESH watch-only taproot address per
// swap, derived from an xpub / tr(...) descriptor the admin supplies (feeaddr.js). The coordinator
// holds no key — it can watch fees arrive but never spend them. Enabled only when BOTH a positive rate
// and a valid key are configured; otherwise every swap is fee-free and behaves exactly as before.
const FEE_BPS = Number(process.env.FEE_BPS || 0);                                    // basis points, e.g. 250 = 2.5%
const FEE_KEY = process.env.FEE_DESCRIPTOR || process.env.FEE_XPUB || "";            // taproot descriptor or xpub
const FEE_MIN_SATS = Number(process.env.FEE_MIN_SATS || 1000);                       // below this the PLATFORM cut (bps) is skipped (would be a dust output); the network reserve is still charged
const FEE_NETWORK = { bc: "mainnet", tb: "testnet", sb: "signet", bcrt: "regtest" }[HRP.btc] || "regtest";
const FEE_ON = FEE_BPS > 0 && !!FEE_KEY;
// The buyer's fee also PRE-PAYS the seller's BTC-claim network fee (sized from current conditions), so the
// seller nets the full amount and the platform's bps isn't silently eaten when fees are high. The bps
// portion is an extra cushion: the seller only loses if the actual claim fee overshoots estimate + bps.
// Aggressive by design: the buyer reserves a generous network-fee headroom so the claim can outbid a fee
// spike between quote and claim. It costs the buyer little and the CLAIM caps the fee it actually takes at
// this reserve (see btcClaimSplit), so it can never eat into the seller's amount — worst case the unused
// reserve just stays with the platform.
const FEE_NET_BUFFER = Number(process.env.FEE_NET_BUFFER || 3);
const BTC_CLAIM_VBYTES = 208;                                                        // BTC HTLC claim + the coordinator-fee output
export const feeNetSats = (fastestFee) => Math.ceil(BTC_CLAIM_VBYTES * Math.max(1, fastestFee || 1) * FEE_NET_BUFFER);   // dynamic: scales with the live fastest-fee rate
const estBtcClaimFee = () => feeNetSats(cachedBtcFeerates().fastestFee);
// Compose the swap's fee. The network-fee reserve is ALWAYS charged (it's what keeps the seller whole at
// any swap size); FEE_MIN_SATS gates only the platform's bps cut — below it we simply drop that cut (it
// would otherwise be a dust fee output). So "below the floor" means "the platform earns nothing on this
// one", NEVER "the seller absorbs the network fee".
export const composeFee = (platformRaw, netFee, feeMin) => {
  const platform = platformRaw >= feeMin ? platformRaw : 0;
  return { platform, netFee, sats: platform + netFee };
};
// Next BIP32 receive index to hand out — resumed past anything already used by persisted swaps (load()
// has already populated `swaps`), so a restart never reissues a fee address. A fresh one per swap; gaps ok.
let feeNextIndex = 1 + [...swaps.values()].reduce((m, s) => Math.max(m, s.fee?.index ?? -1), -1);
if (FEE_ON) {
  try {
    const a0 = validateFeeKey(FEE_KEY, FEE_NETWORK);   // parses the xpub/descriptor and derives index 0
    // Optional startup assertion: if the operator pins an address they KNOW their wallet owns at a known
    // path, refuse to start unless the configured xpub reproduces it — so a wrong or typo'd xpub can
    // never route real fees to a wallet nobody controls. Path is "branch/index" (default 0/0).
    if (process.env.FEE_VERIFY_ADDRESS) {
      const want = process.env.FEE_VERIFY_ADDRESS.trim();
      const seg = (process.env.FEE_VERIFY_ADDRESS_PATH || "0/0").split("/").filter(Boolean).map(Number);
      const index = seg.length ? seg[seg.length - 1] : 0, branch = seg.length >= 2 ? seg[seg.length - 2] : 0;
      const got = feeAddress(FEE_KEY, index, FEE_NETWORK, branch);
      if (got !== want) throw new Error(`FEE_XPUB does not derive FEE_VERIFY_ADDRESS at ${branch}/${index} — got ${got}, expected ${want}. Check the xpub/path.`);
      console.log(`[fee] ${FEE_BPS} bps · xpub VERIFIED against ${want} at ${branch}/${index} ✓ (${FEE_NETWORK})`);
    } else {
      console.log(`[fee] ${FEE_BPS} bps · watch-only taproot (${FEE_NETWORK}); index 0 → ${a0}  (tip: set FEE_VERIFY_ADDRESS to assert the xpub on startup)`);
    }
  } catch (e) { throw new Error(`fee config invalid: ${e.message}`); }
}
// ── taker-pays pricing helpers (used by rfq.js; the fee MECHANICS are unchanged) ──────────────
// Fee incidence policy: peer link swaps keep buyer-pays (the BTC sender grosses up by the fee). RFQ
// swaps are TAKER-pays — a retail BUY already is (the taker is the BTC sender), and for a retail SELL
// the rfq layer quotes the taker's BTC proceeds NET of the fee, so the maker's all-in outlay
// (terms.btcSats + fee) equals exactly its quoted price. These helpers do that arithmetic here, next
// to the knobs (FEE_BPS/FEE_MIN_SATS/reserve), so rfq.js can never drift from what deriveFee charges.
// The full fee that WOULD be charged on a swap of `btcSats` (0 when fees are off).
export const feeTotalOn = (btcSats) => (FEE_ON ? composeFee(Math.round((btcSats * FEE_BPS) / 10000), estBtcClaimFee(), FEE_MIN_SATS).sats : 0);
// The largest btcSats such that btcSats + fee(btcSats) ≤ gross — i.e. what a sell-side taker nets when
// the maker's total outlay is capped at `gross` (its quoted price × size). Handles the FEE_MIN_SATS
// step (below the floor only the network reserve is charged).
export function takerNetOfGross(gross) {
  if (!FEE_ON) return Math.max(0, gross);
  const net = estBtcClaimFee();
  const noPlat = gross - net;                                                     // candidate when the platform cut is floored away
  if (Math.round((noPlat * FEE_BPS) / 10000) < FEE_MIN_SATS) return Math.max(0, noPlat);
  let b = Math.floor(((gross - net) * 10000) / (10000 + FEE_BPS)) + 1;            // closed form, then settle the ±1-sat rounding
  while (b > 0 && b + feeTotalOn(b) > gross) b--;
  return b;
}

// A swap's coordinator fee (or null when off / below the floor): a fresh address + the sats charged.
function deriveFee(btcSats) {
  if (!FEE_ON) return null;
  const { platform, netFee, sats } = composeFee(Math.round((btcSats * FEE_BPS) / 10000), estBtcClaimFee(), FEE_MIN_SATS);
  const index = feeNextIndex++;
  return { bps: FEE_BPS, sats, platform, netFee, index, address: feeAddress(FEE_KEY, index, FEE_NETWORK) };
}

// ── HTLC timelocks, in WALL-CLOCK time (not raw blocks) ───────────────────────────────────────
// Tier-Nolan safety: the initiator's leg (fromLeg) must stay refundable LONGER — in real time — than
// the participant's leg (toLeg), so the participant is forced to reveal the preimage (claiming their
// leg) before the initiator can refund, and the initiator still has time to claim after the reveal.
// BTC (~10 min) and QBT (~60 s) have very different block times, so a fixed BLOCK count would invert
// this ordering in one direction. We instead pick wall-clock windows and convert each to that chain's
// block count via its block time. For regtest the lab sets tiny values so tests stay fast.
const BLOCK_SECS = { get btc() { return chainCfg("btc").blockSecs; }, get qbit() { return chainCfg("qbit").blockSecs; } };
const locktimeBlocks = (leg, secs) => Math.max(1, Math.ceil(secs / BLOCK_SECS[leg]));

// ── Value-scaled reorg security + timelocks ──────────────────────────────────────────────────
// Both the reorg-safe confirmation gate AND the timelocks scale with the swap's value instead of a
// fixed target. Value is measured in BTC (its price is the liquid one). Qbit is SHA-256-mined like
// Bitcoin, so a qbit reorg is priced in BTC too: the cost to rewrite one qbit confirmation ≈
// `security_per_confirmation` (BTC-confs bought per qbit conf, from the node's chainwork model incl.
// AuxPoW) × the BTC block subsidy. We require the cost to reorg the claimed leg to exceed the swap's
// BTC value by REORG_MARGIN×. Timelocks are then derived from the resulting confirmation count, so a
// small swap settles + refunds fast while a large one gets deeper confirmations and longer windows.
const REORG_MARGIN = Number(process.env.REORG_MARGIN || 3);                 // cost-to-reorg ≥ this × swap value
const MIN_CONFS = { get btc() { return chainCfg("btc").minConfs; }, get qbit() { return chainCfg("qbit").minConfs; } };   // never 0-conf (unless trustUnconfirmed), but otherwise let the value-scaled math decide
const UNPRICED_CONFS = Number(process.env.UNPRICED_CONFS || 6);   // conservative fallback when the reorg cost can't be priced (node model unavailable)
// Funding deadline: once the HTLCs are derived (READY), both parties must fund within this window, or
// the swap is treated as expired — because the timelocks are fixed at READY time, funding much later
// would leave too little margin before the refund unlocks (and, past the timelock, is outright unsafe).
// Kept well under the shortest timelock. Regtest overrides it tiny for tests.
const FUNDING_WINDOW_MS = Number(process.env.FUNDING_WINDOW_MS || 3600000);  // 1h
const REVEAL_BUFFER = Number(process.env.REVEAL_BUFFER_BLOCKS || 6);         // QBT blocks (beyond confsTarget) the timelock must stay ahead before the buyer may reveal
const TO_MULT = Number(process.env.HTLC_TO_MULT || 2);                      // claim window ≈ maturity × this + base
const TO_BASE_SECS = Number(process.env.HTLC_TO_BASE_SECS || 10800);        // toLeg (QBT-seller refund) base window: 3h — funding/detection slack, plus a ~3 BTC flat work-cost floor against a rented-hashrate sprint compressing the height-based CLTV (censor the buyer's claim, refund early, take the BTC with the mempool-leaked preimage). Large swaps widen further via the confs term.
const FROM_GAP_SECS = Number(process.env.HTLC_FROM_GAP_SECS || 7200);       // extra BTC time the buyer's leg outlasts the seller's: 2h — absorbs long Bitcoin inter-block gaps (P(no block in 2h) ≈ e^-12) so the seller's BTC claim can't be refunded out from under it
const MIN_TO_SECS = Number(process.env.MIN_TO_SECS || 10800);              // floor on the toLeg window (3h)
const btcSubsidySats = (h) => Math.floor(5_000_000_000 / 2 ** Math.floor(h / 210_000));   // BTC block reward at height h

// Confirmations a leg must reach so that reorging it costs ≥ REORG_MARGIN × the swap's BTC value —
// priced per the leg's configured reorg model, floored at its MIN_CONFS:
//   "conftarget-rpc" — the node's own getconfirmationtarget chainwork model (qbit's AuxPoW-aware RPC),
//                      converted to BTC via security_per_confirmation × the BTC subsidy;
//   "btc-subsidy"    — SHA-256d BTC-family: reorging one block ≈ one BTC block subsidy of work;
//   "fixed"          — a flat, configured depth for chains whose reorg cost can't be priced (young or
//                      exotic hashrate markets — e.g. the Blake2b fork; value scaling doesn't apply).
async function reorgConfs(leg, btcSats, qbtSats, level, btcHeight) {
  const cfg = chainCfg(leg);
  if (cfg.reorgModel === "fixed") {
    // Value-scaled fixed depth: `fixedConfs` at the configured scale (fixedScaleBtc BTC), +1 conf per
    // value doubling, capped at fixedMaxConfs. Small swaps settle fast; big ones get a deep burial.
    const satsPerBtc = 1e8, scaleSats = (cfg.fixedScaleBtc || 0.01) * satsPerBtc;
    const extra = btcSats > scaleSats ? Math.ceil(Math.log2(btcSats / scaleSats)) : 0;
    const confs = Math.min(cfg.fixedMaxConfs || cfg.fixedConfs, Math.max(MIN_CONFS[leg], cfg.fixedConfs + extra));
    return { confs, source: "fixed", level, valueBtcSats: btcSats };
  }
  const btcSub = btcSubsidySats(btcHeight);
  let costPerConf, extra = {};                                             // BTC sats to reorg one confirmation of this leg
  if (cfg.reorgModel === "conftarget-rpc") {
    const t = await chainOf(leg).confTarget(qbtSats, level);
    const spc = t.model?.security_per_confirmation || (t.confs ? (t.equivalentBtcConfs || 6) / t.confs : 0);
    costPerConf = spc * btcSub;
    extra = { securityPerConf: spc, hashrate: t.model?.total_observed_hashrate };
  } else {
    costPerConf = btcSub;                                                   // "btc-subsidy": one block ≈ one BTC subsidy of work
  }
  const need = costPerConf > 0 ? Math.max(MIN_CONFS[leg], Math.ceil((REORG_MARGIN * btcSats) / costPerConf)) : UNPRICED_CONFS;
  // Cap the value-scaled depth at the leg's configured ceiling (BTC_MAX_CONFS / ALT_MAX_CONFS): beyond
  // it the marginal work-cost per conf stops being a meaningful security increase and only stretches the
  // timelock window. A leg with no cap (maxConfs unset) scales unbounded as before.
  const capped = cfg.maxConfs > 0 ? Math.min(need, cfg.maxConfs) : need;
  return { confs: capped, source: cfg.reorgModel === "conftarget-rpc" ? "reorg-cost" : "btc-depth", level, valueBtcSats: btcSats, costPerConfSats: Math.round(costPerConf), ...extra };
}

// Wall-clock timelock windows derived from the gate's maturity (or forced fixed via env, for regtest).
// The claim window covers maturity plus slack; the funding leg outlasts it so the participant can claim
// after the preimage is revealed.
function htlcWindows(toLeg, confs) {
  if (process.env.HTLC_TO_SECS && process.env.HTLC_FROM_SECS)
    return { toSecs: Number(process.env.HTLC_TO_SECS), fromSecs: Number(process.env.HTLC_FROM_SECS) };
  const toSecs = Math.max(MIN_TO_SECS, Math.round(confs * BLOCK_SECS[toLeg] * TO_MULT + TO_BASE_SECS));
  return { toSecs, fromSecs: toSecs + FROM_GAP_SECS };
}
export function createSwap({ btcSats, qbtSats, securityLevel = "high" }) {
  // Reject when the active (non-terminal) working set is full, so memory can't grow unboundedly; a
  // created-but-never-funded swap is reclaimable by its creator. CANCELED and terminal states don't count.
  if (MAX_ACTIVE_SWAPS > 0) {
    let active = 0;
    for (const s of swaps.values()) if (![...TERMINAL, "CANCELED"].includes(s.state)) active++;
    if (active >= MAX_ACTIVE_SWAPS) throw new Error(`active swap cap (${MAX_ACTIVE_SWAPS}) reached — try again shortly`);
  }
  // The QBT buyer is ALWAYS the initiator (alice): every swap is btc2qbt (initiator sends BTC, receives
  // QBT). Who sells QBT is chosen purely by which token each party keeps — there is no way to construct
  // a swap where the initiator sells QBT (the reorg-unsafe arrangement).
  const direction = "btc2qbt";
  // Reject dust-level swaps: the amount must comfortably exceed claim/refund fees (incl. the top
  // watchtower fee tier) or the spend would produce a dust/negative output.
  const minAmt = (n) => (n / 1e8).toFixed(8).replace(/\.?0+$/, "");   // sats → BTC/QBT decimal, no trailing zeros
  if (!(btcSats >= MIN_SATS.btc) || !(qbtSats >= MIN_SATS.qbit)) throw new Error(`amount too small (minimum ${minAmt(MIN_SATS.btc)} ${chainCfg("btc").label} and ${minAmt(MIN_SATS.qbit)} ${chainCfg("qbit").label})`);
  const s = {
    id: token(), tokens: { alice: token(), bob: token() },
    terms: { btcSats, qbtSats, securityLevel, direction },
    fee: deriveFee(btcSats),               // optional coordinator fee (fresh watch-only address) — null when off
    roles: legsFor(direction),             // { fromLeg, toLeg } — initiator funds fromLeg, claims toLeg
    state: "CREATED", H: null,
    party: { alice: null, bob: null },
    locktimes: null, htlc: null,
    funding: { btc: null, qbit: null },
    heights: null, refund: null,
    confsTarget: null, preimage: null,
    finish: { alice: null, bob: null },    // watchtower: each party's pre-signed { claim(ladder), refund }
    wt: {},                                // watchtower broadcast tracking (role:kind -> {txid,tier,at})
    broadcasts: {}, createdAt: Date.now(),
  };
  swaps.set(s.id, s);
  touch(s);
  return s;
}
// Working set first; on a miss, load-on-demand from the store (an evicted, long-settled swap). The
// loaded object is transient (NOT re-added to the Map) so the working set stays bounded — safe because
// evicted swaps are TERMINAL and never mutate; they're only read (resume/view a completed swap).
export const getSwap = (id) => swaps.get(id) || (store.get ? store.get(id) : null) || undefined;
export const roleOf = (s, tok) => (tok === s.tokens.alice ? "alice" : tok === s.tokens.bob ? "bob" : null);
export const allSwaps = () => [...swaps.values()];

// Party submits pubkeys + destination addresses. The initiator (alice, the QBT buyer) also submits H —
// whether they created the swap or joined it via the invite link.
// Either party may cancel a swap that NOBODY has funded yet — this clears out stale, never-used swaps
// so the coordinator isn't left watching them. The record is kept (state CANCELED, sticky): the HTLC
// addresses stay valid, so if someone funds one anyway they can still refund after the timelock.
export function cancelSwap(s, role) {
  if (s.funding?.btc || s.funding?.qbit || s.shortFunded) throw new Error("a deposit already exists — cancel is only for unfunded swaps; an underfunded deposit is refundable after its timelock");
  if (s.state === "CANCELED" || TERMINAL.includes(s.state)) throw new Error("swap already finished");
  s.canceled = { by: role, at: Date.now() };
  s.state = "CANCELED";
  return touch(s);
}

// First-come lock for pubkeys AND H: once a slot is filled none of these fields may change, and the
// lock goes in BEFORE any HTLCs are derived. Without this, alice could change H after both parties
// joined — silently re-deriving both addresses and orphaning any manual/out-of-band funding made to the
// original address. The lock rejects the change outright.
// First-come lock for pubkeys AND H: once a slot is filled none of these may change, and the lock goes
// in BEFORE any HTLCs are derived. Without this, alice could change H after both parties joined —
// silently re-deriving both addresses and orphaning any manual/out-of-band funding made to the original.
export async function submitParty(s, role, data) {
  if (s.state === "CANCELED") throw new Error("this swap was canceled");
  if (s.state !== "CREATED" && s.state !== "READY") throw new Error("party data locked");
  const existing = s.party[role];
  // First-come lock: pubkeys AND H are immutable once a slot is filled; H may only be SET once (by
  // alice's first join). Without the H lock alice could mutate H after both parties joined, silently
  // re-deriving both HTLC addresses and orphaning manual/out-of-band funding made to the original.
  if (existing && (existing.btcPub !== data.btcPub || existing.qbitPub !== data.qbitPub)) throw new Error("this swap has already been joined by someone else");
  if (role === "alice" && s.H && !existing && data.H && data.H !== s.H) throw new Error("H is already locked");
  // Validate the inputs BEFORE writing party data (so a bad submission can't wedge the swap). Keys are
  // opaque blobs until derive runs; format-check them at derive-time to stay chain-agnostic.
  const isHex = (v) => typeof v === "string" && /^[0-9a-f]+$/i.test(v);
  if (role === "alice" && data.H && !isHex(data.H)) throw new Error("H must be hex");
  if (role === "alice" && data.H && !s.H) s.H = data.H;   // first-come lock: set-once
  if (!existing) s.party[role] = { qbitPub: data.qbitPub, btcPub: data.btcPub, btcDest: data.btcDest, qbitDest: data.qbitDest };
  if (s.party.alice && s.party.bob && s.H) {
    if (!isHex(s.party.alice.qbitPub) || !isHex(s.party.alice.btcPub)) throw new Error("alice's pubkey material is not hex");
    if (!isHex(s.party.bob.qbitPub) || !isHex(s.party.bob.btcPub)) throw new Error("bob's pubkey material is not hex");
    await deriveHtlcs(s);
  }
  return touch(s);
}

async function deriveHtlcs(s) {
  const H = bin(s.H);
  const [qh, bh] = [await qbit.height(), await btc.height()];
  const { fromLeg, toLeg } = s.roles;
  const A = s.party.alice, B = s.party.bob;   // A = initiator, B = participant
  // Reorg-safe gate on the leg the initiator claims (toLeg), scaled to the swap's BTC value.
  const ct = await reorgConfs(toLeg, s.terms.btcSats, s.terms.qbtSats, s.terms.securityLevel, bh);
  if (process.env.DEV_CONFS_CAP) ct.confs = Math.min(ct.confs, Number(process.env.DEV_CONFS_CAP));
  s.confsTarget = ct;
  // Reorg/RBF-safe gate on the FUNDING leg the initiator sends (fromLeg). The buyer must not reveal the
  // preimage (by claiming toLeg) until this deposit is buried, because once the secret is public the
  // seller claims fromLeg — so that funding tx must no longer be double-spendable (an unconfirmed deposit
  // is RBF-able; a shallow one is reorg-able). Same value-scaled math, on the fromLeg coin.
  const fct = await reorgConfs(fromLeg, s.terms.btcSats, s.terms.qbtSats, s.terms.securityLevel, bh);
  if (process.env.DEV_CONFS_CAP) fct.confs = Math.min(fct.confs, Number(process.env.DEV_CONFS_CAP));
  s.fromConfsTarget = fct;

  // Timelocks derived from the gate's maturity: fromLeg (initiator funds) gets the LONGER window,
  // toLeg (participant funds) the SHORTER one. Each wall-clock window → a block count on its OWN chain,
  // so the real-time ordering holds regardless of which coin is on which leg.
  const { toSecs, fromSecs } = htlcWindows(toLeg, ct.confs);
  const lock = { qbit: qh, btc: bh };
  lock[fromLeg] += locktimeBlocks(fromLeg, fromSecs);
  lock[toLeg] += locktimeBlocks(toLeg, toSecs);
  s.locktimes = lock;

  // Per leg: claim party + refund party. On fromLeg, participant claims (with public secret) &
  // initiator refunds. On toLeg, initiator claims (revealing secret) & participant refunds.
  // The SCRIPT FAMILY is per-leg config, not per-leg-name: a fork pair runs P2WSH+ECDSA on BOTH legs
  // (each party's qbitPub then carries a secp pubkey for the second chain, not an SLH-DSA key).
  const pub = (party, leg) => bin(leg === "qbit" ? s.party[party].qbitPub : s.party[party].btcPub);
  const build = (leg, claimParty, refundParty) => chainCfg(leg).script === "p2mr-slhdsa"
    ? htlcLeafQbit(H, pub(claimParty, leg), pub(refundParty, leg), lock[leg])
    : htlcWitnessScript(H, pub(claimParty, leg), pub(refundParty, leg), lock[leg]);
  const fromScript = build(fromLeg, "bob", "alice");    // fromLeg: participant claims, initiator refunds
  const toScript = build(toLeg, "alice", "bob");        // toLeg:   initiator claims, participant refunds
  const pack = (leg, script) => chainCfg(leg).script === "p2mr-slhdsa"
    ? { leaf: hex(script), spk: hex(p2mrSpk(script)), address: p2mrAddress(script, HRP[leg]) }
    : { witnessScript: hex(script), spk: hex(p2wshSpk(script)), address: p2wshAddr(script, HRP[leg]) };
  s.htlc = { [fromLeg]: pack(fromLeg, fromScript), [toLeg]: pack(toLeg, toScript) };
  s.state = "READY";
  s.readyAt ||= Date.now();   // starts the funding-window countdown
}

// Watcher tick: detect funding on both legs, gate the initiator's claim on reorg-safe confs, surface
// refundability once timelocks pass, notice terminal on-chain spends. Pure chain reads.
export async function poll(s) {
  if (["CREATED", ...TERMINAL].includes(s.state)) return;
  const [qh, bh] = [await qbit.height(), await btc.height()];
  s.heights = { qbit: qh, btc: bh };
  const H = { qbit: qh, btc: bh };
  const { fromLeg, toLeg } = s.roles;

  // Only count a leg as funded when the deposit meets the agreed amount — otherwise a counterparty
  // could underfund their HTLC and short the other side. An underfunded leg is surfaced (shortFunded)
  // but doesn't progress the swap, so it stalls and the underfunder can refund after the timelock.
  const need = { btc: s.terms.btcSats + (s.fee?.sats || 0), qbit: s.terms.qbtSats };   // buyer funds the coordinator fee on top of the BTC leg
  // Discover funding, or keep re-checking a still-unconfirmed (mempool) deposit until it confirms.
  // Re-deriving from findOutput while unconfirmed also tracks an RBF'd deposit to its new outpoint,
  // and clears it if the mempool tx is dropped without replacement.
  for (const leg of ["btc", "qbit"]) {
    const cur = s.funding[leg];
    if (!cur || cur.unconfirmed) {
      const o = await chainOf(leg).findOutput(s.htlc[leg].spk);
      if (o && o.amountSats >= need[leg]) s.funding[leg] = { txid: o.txid, vout: o.vout, amountSats: o.amountSats, height: o.height, unconfirmed: o.height == null, spent: false };
      else if (o) s.shortFunded = { ...(s.shortFunded || {}), [leg]: { got: o.amountSats, need: need[leg], txid: o.txid, vout: o.vout, amountSats: o.amountSats, height: o.height, unconfirmed: o.height == null, spent: false } };   // full outpoint: an underfunded deposit is a real HTLC UTXO, refundable by its funder after the timelock
      else if (cur && cur.unconfirmed) s.funding[leg] = null;   // unconfirmed deposit dropped out of the mempool
    }
  }
  // Spent-detection only for CONFIRMED funding (a claim/refund spending it). An unconfirmed deposit is
  // managed by the re-poll above, not treated as "spent" when gettxout can't see it yet.
  for (const leg of ["btc", "qbit"]) if (s.funding[leg] && !s.funding[leg].unconfirmed && !s.funding[leg].spent && !(await chainOf(leg).isUnspent(s.funding[leg].txid, s.funding[leg].vout))) s.funding[leg].spent = true;
  // Same spent-detection for an underfunded deposit, so its refund flips the swap to REFUNDED.
  for (const leg of ["btc", "qbit"]) { const sf = s.shortFunded?.[leg]; if (sf && !sf.unconfirmed && !sf.spent && !(await chainOf(leg).isUnspent(sf.txid, sf.vout))) sf.spent = true; }

  // Backfill the spending txid for a claim/refund that landed OUT OF BAND — a party's own node, or the
  // client's direct-broadcast fallback when we were unreachable. In those cases poll marks the deposit
  // spent but applyEffects never ran, so s.broadcasts (and thus the recorded claim txid) would be empty
  // on an otherwise-COMPLETE swap. Best-effort: find the spender and classify it by whether its witness
  // reveals the preimage (claim) or not (refund). Runs once per leg — skipped the moment a record exists.
  // Placed before the COMPLETE check below so an out-of-band QBT claim's preimage is captured in time.
  for (const leg of ["btc", "qbit"]) {
    const f = s.funding[leg];
    if (!f?.spent || s.broadcasts[`${leg}:claim`] || s.broadcasts[`${leg}:refund`]) continue;
    try {
      const txid = await chainOf(leg).spendingTxid(f.txid, f.vout);
      if (!txid) continue;
      const wit = (await chainOf(leg).getTx(txid)).vin?.[0]?.txinwitness || [];
      const pre = wit.find((x) => x.length === 64 && hex(sha256(bin(x))) === s.H);
      if (pre) { if (!s.preimage) s.preimage = pre; s.broadcasts[`${leg}:claim`] = txid; }
      else s.broadcasts[`${leg}:refund`] = txid;
    } catch { /* node transient — retry next tick */ }
  }

  const from = s.funding[fromLeg], to = s.funding[toLeg];
  // Confirmation depth of each deposit (0 while still in the mempool).
  if (from) from.confs = from.height != null ? H[fromLeg] - from.height + 1 : 0;
  if (to) to.confs = to.height != null ? H[toLeg] - to.height + 1 : 0;
  // Sequenced funding: the initiator's BTC deposit must be buried & irreversible before the participant
  // funds QBT. Otherwise the initiator could fund BTC low-fee, let QBT confirm, RBF-cancel the BTC, then
  // claim the QBT (revealing the preimage) — leaving the participant's BTC claim spending a UTXO that was
  // replaced away. Once BTC is buried it can't be RBF'd, so the claim always has a live UTXO. Record when
  // that clearance first held: it starts the participant's own funding countdown.
  // TRUST-UNCONFIRMED (per-leg config): a 0-conf deposit on a trusted leg counts as buried — the
  // sequenced-funding clearance, the claimable gate, and broadcast's hold-gate all pass at 0-conf.
  // This trades the RBF/double-spend safety analysis away for speed; chains.js documents when that's OK.
  const buriedNow = (leg, f, target) => !!f && (chainCfg(leg).trustUnconfirmed ? true : !f.unconfirmed && (f.confs || 0) >= target);
  const fromBuried = buriedNow(fromLeg, from, s.fromConfsTarget.confs);
  if (fromBuried) s.fromConfirmedAt ||= Date.now();
  // recompute the pre-claim state from ground truth (broadcast() owns CLAIMED/COMPLETE/REFUNDED)
  if (!["CLAIMED", "CANCELED", ...TERMINAL].includes(s.state)) {
    let st = "READY";
    if (from) st = "FROM_FUNDED";
    if (to && !to.spent) {
      // Reveal the preimage (become CLAIMABLE) only when BOTH deposits are buried to their reorg-safe
      // depth: toLeg protects the buyer against a reorg of the coin they claim; fromLeg protects the
      // seller, whose subsequent claim must spend a funding tx the buyer can no longer RBF/double-spend.
      const fromReady = fromBuried;
      const toReady = buriedNow(toLeg, to, s.confsTarget.confs);
      // AND the QBT timelock must still be far enough ahead for the buyer's claim to bury reorg-safe
      // BEFORE the seller's refund unlocks. A slow-confirming (low-fee) deposit can push maturity right up
      // against the timelock; if so we must NOT reveal — the seller could then race a refund and grab both.
      // Hold at MATURING instead, which routes both sides to a safe refund. This gate is on the STATE, so
      // the watchtower (which only reveals in CLAIMABLE) is bound by it too and can't exacerbate the race.
      const inTime = (s.locktimes[toLeg] - H[toLeg]) >= s.confsTarget.confs + REVEAL_BUFFER;
      s.tooLate = !!(from && fromReady && toReady && !inTime);   // matured but no longer safe to complete → will refund
      st = from ? (fromReady && toReady && inTime ? "CLAIMABLE" : "MATURING") : "TO_FUNDED";
    }
    s.state = st;
  }
  if (s.preimage && to?.spent && from?.spent && !TERMINAL.includes(s.state)) { s.state = "COMPLETE"; s.settledAt = Date.now(); }

  // Refundability: initiator reclaims fromLeg after its (longer) timelock; participant reclaims toLeg
  // after its (shorter) timelock — each while their own deposit is still unspent. An UNDERFUNDED deposit
  // is a real HTLC UTXO too: fall back to it here so its funder can reclaim it (it never enters s.funding,
  // so it can't progress the swap — this is purely the recovery path). `short` flags that case for the UI.
  const fromR = from || s.shortFunded?.[fromLeg], toR = to || s.shortFunded?.[toLeg];
  s.refund = {
    [fromLeg]: { party: "alice", at: s.locktimes[fromLeg], available: !!(fromR && !fromR.spent && !fromR.unconfirmed && H[fromLeg] >= s.locktimes[fromLeg]), short: !from && !!s.shortFunded?.[fromLeg] },
    [toLeg]: { party: "bob", at: s.locktimes[toLeg], available: !!(toR && !toR.spent && !s.preimage && !toR.unconfirmed && H[toLeg] >= s.locktimes[toLeg]), short: !to && !!s.shortFunded?.[toLeg] },
  };
  touch(s);
}

// Post-broadcast state effects, shared by party broadcasts and the watchtower. Any claim may carry the
// preimage in its witness — extract it so the counterparty can complete. The fromLeg claim (the
// participant taking the initiator's coin) is the final step -> COMPLETE.
async function applyEffects(s, leg, kind, txid) {
  s.broadcasts[`${leg}:${kind}`] = txid;
  if (kind === "claim") {
    const wit = (await chainOf(leg).getTx(txid)).vin[0].txinwitness || [];
    const pre = wit.find((x) => x.length === 64 && hex(sha256(bin(x))) === s.H);
    if (pre && !s.preimage) s.preimage = pre;
    if (s.funding[leg]) s.funding[leg].spent = true;
    if (leg === s.roles.fromLeg) { s.state = "COMPLETE"; s.settledAt = Date.now(); } else s.state = "CLAIMED";
  }
  if (kind === "refund") { if (s.funding[leg]) s.funding[leg].spent = true; if (s.shortFunded?.[leg]) s.shortFunded[leg].spent = true; s.state = "REFUNDED"; s.settledAt = Date.now(); }
}
// A party submits a signed tx; the coordinator broadcasts it (keyless). Validate the routing inputs:
// anything untrusted can only reach chainOf(leg) if it passes the shape check.
export async function broadcast(s, leg, kind, txHex) {
  if (!["btc", "qbit"].includes(leg) || !["claim", "refund"].includes(kind))
    throw new Error(`bad leg/kind ("${leg}"/"${kind}") — refusing to relay`);
  // Never relay the buyer's preimage-revealing claim (toLeg) until BOTH deposits are buried to their
  // reorg/RBF-safe depth:
  //   · fromLeg (BTC) — so the seller's subsequent claim spends a funding tx the buyer can no longer RBF;
  //   · toLeg  (QBT) — so once the secret is public the seller can't RBF-cancel their own (still-0-conf)
  //     deposit out from under the buyer's claim, keeping the QBT AND taking the BTC.
  // A confirmed tx can't be RBF'd, so requiring both mined closes the window in either confirmation order.
  // Treat every chain as an OPEN network: assume a determined party can relay a signed tx without us, so
  // this coordinator check is NOT a hard barrier — it's the honest-client policy plus a backstop for naive
  // users. The actual guarantees come from the protocol itself: sequenced funding (the seller only funds
  // once the buyer's BTC is irreversibly buried, see poll()) and each party's client waiting for the coin
  // it claims to bury before revealing — so a party who bypasses this check only ever risks its own funds.
  // The seller's fromLeg claim (secret already public) and either refund are never blocked.
  if (kind === "claim" && leg === s.roles.toLeg) {
    const buried = (f, tgt, l) => f && (chainCfg(l).trustUnconfirmed || (!f.unconfirmed && (f.confs || 0) >= (tgt?.confs || MIN_CONFS[l])));   // trust-unconfirmed: a 0-conf deposit passes the hold-gate
    if (!buried(s.funding[s.roles.fromLeg], s.fromConfsTarget, s.roles.fromLeg) || !buried(s.funding[leg], s.confsTarget, leg))
      throw new Error("both deposits must confirm to a safe depth before the swap can settle — try again shortly");
    // And refuse to reveal if the QBT timelock is now too close for this claim to bury before the seller's
    // refund unlocks (a slow deposit ran down the window) — revealing here would let the seller take both.
    if ((s.locktimes[leg] - (s.heights?.[leg] || 0)) < s.confsTarget.confs + REVEAL_BUFFER)
      throw new Error("too close to the timelock to reveal safely — this swap will refund instead");
  }
  // FORK REPLAY PROTECTION: on a replay-protected leg every sweep must carry the >83-byte OP_RETURN
  // marker (BIP-110 policy refuses to relay/mine it on the fork chain, so this sweep settles on exactly
  // one side of the pair). ENFORCED, not advisory — a marker-less sweep would replay across the fork
  // and can hand the counterparty both sides of history. Clients build it (btcSpend `replay: true`).
  // Refunds are exempt: a refund pays the funder's OWN address, so a cross-fork replay of it can only
  // return that same funder's twin coins — harmless (it's exactly what the twin sweep does). Claims
  // stay enforced: replayed, they'd hand the counterparty both sides of history.
  if (kind !== "refund" && chainCfg(leg).replayOpReturn && !hasReplayMarker(parseTx(bin(txHex)).vout))
    throw new Error(`this ${chainCfg(leg).label} ${kind} lacks the replay-protection OP_RETURN (>83 bytes) — rebuild the sweep with the replay marker`);
  const chain = chainOf(leg);
  const acc = await chain.testAccept(txHex);
  if (!acc.allowed) throw new Error(`rejected: ${acc.reason}`);
  const txid = await chain.broadcast(txHex);
  await applyEffects(s, leg, kind, txid);
  return { txid, state: touch(s).state };
}

// ── watchtower ────────────────────────────────────────────────────────────────
// Each party pre-signs a fee-ladder claim + a refund (`submitFinish`); the coordinator broadcasts them
// on their behalf so a swap completes/refunds even if both tabs close. Non-custodial: every stored tx
// pays only its owner's address, and the coordinator holds no keys — it can only help, never redirect.
export function submitFinish(s, role, bundle) {
  // A normal swap arms claim + refund; an underfunded deposit arms a refund ONLY (there is no completion
  // path). So require refund.tiers; claim.tiers is optional (and, when present, must be non-empty).
  if (!bundle?.refund?.tiers?.length) throw new Error("finish bundle needs refund.tiers[]");
  if (bundle.claim && !bundle.claim.tiers?.length) throw new Error("finish bundle claim.tiers[] must be non-empty when present");
  // Twin sweep (fork pairs only): a refund-path spend of this party's deposit outpoint, pre-signed for
  // the OTHER chain — used by driveTwinSweep if the deposit gets replayed across the fork. `leg` is the
  // chain it will be broadcast ON; `fundLeg` is the leg whose deposit it reclaims.
  if (bundle.twin) {
    if (!forkTwinPair()) throw new Error("twin sweep only applies to a fork pair");
    if (!bundle.twin.tiers?.length || !["btc", "qbit"].includes(bundle.twin.leg) || !["btc", "qbit"].includes(bundle.twin.fundLeg) || bundle.twin.leg === bundle.twin.fundLeg)
      throw new Error("twin bundle needs tiers[] and opposite leg/fundLeg");
  }
  // Replay protection covers the WATCHTOWER path too: these pre-signed txs are broadcast without going
  // through broadcast()'s check, so validate every tier on a replay-protected leg at upload time.
  // (For `twin`, b.leg is the broadcast chain, so the marker requirement lands exactly where it must:
  // a twin sweep broadcast on the marker leg carries the marker; one for the fork leg must not.)
  for (const kind of ["claim", "twin"]) {   // refund tiers are exempt (see broadcast(): a replayed refund only pays its own funder)
    const b = bundle[kind];
    if (!b?.tiers?.length || !["btc", "qbit"].includes(b.leg) || !chainCfg(b.leg).replayOpReturn) continue;
    for (const t of b.tiers) if (!hasReplayMarker(parseTx(bin(t.tx)).vout))
      throw new Error(`${kind} tier lacks the replay-protection OP_RETURN required on the ${chainCfg(b.leg).label} leg — rebuild the watchtower bundle with the replay marker`);
  }
  s.finish[role] = bundle;
  return touch(s);
}
const splicePreimage = (txHex, preimageHex) => { const tx = parseTx(bin(txHex)); tx.wit[0][1] = bin(preimageHex); return hex(serializeTx(tx)); };
// Pick the cheapest pre-signed tier whose feerate beats the current mempool fastest fee (BTC); qbit or
// no fee data -> the lowest tier. `minIndex` floors the choice so a re-send never downgrades below the
// tier already used. Exported for the fee-ladder unit test.
export async function pickTier(leg, tiers, minIndex = 0) {
  if (leg !== "btc") return minIndex;
  const target = (await btcFeerates()).fastestFee || 1;
  for (let i = minIndex; i < tiers.length; i++) if (tiers[i].feerate >= target) return i;
  return tiers.length - 1;
}
async function wtSend(s, role, leg, kind, txHex, tier) {
  const chain = chainOf(leg);
  const acc = await chain.testAccept(txHex);
  if (!acc.allowed) return false;                 // already spent, or this tier too low right now — retry next tick/tier
  const txid = await chain.broadcast(txHex);
  s.wt[`${role}:${kind}`] = { txid, tier, at: s.heights?.[leg] ?? 0, ts: Date.now() };
  await applyEffects(s, leg, kind, txid);
  return true;
}
// Broadcast a party's pre-signed claim OR refund at a specific ladder tier (both are fee-laddered now),
// splicing in the now-public preimage for the participant's claim. Caller chooses the tier from the
// live fastest-fee target.
async function wtBroadcast(s, role, leg, kind, tier) {
  const b = s.finish[role][kind];                 // { leg, needsPreimage?, tiers:[{feerate,tx}] }
  const raw = b.tiers[tier].tx;
  const txHex = (kind === "claim" && b.needsPreimage) ? splicePreimage(raw, s.preimage) : raw;
  return wtSend(s, role, leg, kind, txHex, tier);
}
// Called every watcher tick. The watchtower broadcasts each party's pre-signed tx AS SOON AS the chain
// condition for it is met — it does NOT care whether the party is online. A claim/refund sends the
// party's OWN coins to the party's OWN address, so if the client is also live and broadcasts, the two
// are the same spend: one confirms, the other is a harmless double-spend the network drops. Presence is
// a UI signal only; making the safety net depend on it (as it once did) let a stale "online" flag —
// e.g. an SSE socket that lingers at the Cloudflare origin after the tab closed — freeze the swap. The
// `s.wt[...]` guards keep the watchtower from re-sending its own broadcast; `unspent` stops once anyone's
// spend lands. It drives the swap to completion (or refund) from each party's bundle regardless.
export async function driveWatchtower(s) {
  if (!s.roles || !s.htlc || ["CREATED", "CANCELED", ...TERMINAL].includes(s.state)) return;
  const { fromLeg, toLeg } = s.roles, H = s.heights || {};
  const unspent = (leg) => { const f = s.funding[leg] || s.shortFunded?.[leg]; return !!f && !f.spent; };   // shortFunded → refund an underfunded deposit
  // NEVER claim (reveal/settle) while ANY leg is underfunded: the swap can't complete safely, and claiming
  // the counterparty's coin against an underfunded deposit would rob them. Underfunding only ever refunds.
  const canClaim = !s.shortFunded;

  // a) initiator's claim of toLeg once matured (CLAIMABLE) -> reveals the preimage on-chain
  if (canClaim && s.state === "CLAIMABLE" && s.finish.alice?.claim && unspent(toLeg) && !s.wt["alice:claim"]) await wtBroadcast(s, "alice", toLeg, "claim", await pickTier(toLeg, s.finish.alice.claim.tiers));
  // b) participant's claim of fromLeg once the preimage is public (spliced in)
  if (canClaim && s.preimage && s.finish.bob?.claim && unspent(fromLeg) && !s.wt["bob:claim"]) await wtBroadcast(s, "bob", fromLeg, "claim", await pickTier(fromLeg, s.finish.bob.claim.tiers));
  // c) abort refunds after each leg's timelock (only while no preimage — else the claim path applies),
  //    sized to the live fastest fee from the pre-signed refund ladder.
  if (!s.preimage && s.locktimes) {
    if (s.finish.alice?.refund && unspent(fromLeg) && (H[fromLeg] || 0) >= s.locktimes[fromLeg] && !s.wt["alice:refund"]) await wtBroadcast(s, "alice", fromLeg, "refund", await pickTier(fromLeg, s.finish.alice.refund.tiers));
    if (s.finish.bob?.refund && unspent(toLeg) && (H[toLeg] || 0) >= s.locktimes[toLeg] && !s.wt["bob:refund"]) await wtBroadcast(s, "bob", toLeg, "refund", await pickTier(toLeg, s.finish.bob.refund.tiers));
  }
  // d) Fee management for the watchtower's own claims. We (re)broadcast ONLY when the funding is
  //    genuinely unspent ON-CHAIN (mempool included) — i.e. no claim is in flight or mined, whether ours
  //    (dropped/evicted) or the party's OWN out-of-band tx (their backup file, their own node, or the
  //    client's direct-broadcast fallback on EITHER leg). We never RBF a claim already in the mempool: it may be the party's,
  //    and trampling it is worse than waiting out the (generous) timelock; a genuinely underpriced tx
  //    gets evicted under fee pressure → funding unspent → re-sent here. The re-send follows the LIVE
  //    fastest-fee recommendation, floored at the tier last used — so a drop for a non-fee reason
  //    re-sends the same tier, a fee spike steps it up. testAccept no-ops it if nothing needs changing.
  for (const [role, kind, leg] of [["alice", "claim", toLeg], ["bob", "claim", fromLeg], ["alice", "refund", fromLeg], ["bob", "refund", toLeg]]) {
    if (kind === "claim" && !canClaim) continue;                      // never (re)send a claim while any leg is underfunded
    const rec = s.wt[`${role}:${kind}`], b = s.finish[role]?.[kind], f = s.funding[leg] || s.shortFunded?.[leg];   // shortFunded → manage the underfunded refund
    if (!rec || !b || !f) continue;
    if (kind === "refund" && s.preimage) continue;                   // abort refunds are moot once the secret is out
    if (!(await chainOf(leg).isUnspent(f.txid, f.vout))) continue;   // a spend (ours or theirs) is in the mempool/chain → don't interfere
    const tier = Math.max(rec.tier, await pickTier(leg, b.tiers));   // live fastest-fee tier, never downgraded
    s.wt[`${role}:${kind}`] = null;
    if (!(await wtBroadcast(s, role, leg, kind, tier))) s.wt[`${role}:${kind}`] = rec;   // couldn't re-send (e.g. mined between ticks) → keep the record
  }
  touch(s);
}

// ── fork-pair twin sweep ──────────────────────────────────────────────────────
// If a sender skips replay protection, their deposit tx can be replayed onto the OTHER chain of the
// fork — an identical "twin" UTXO at the same outpoint, paying the same HTLC script. The refund path
// still belongs to the sender, so once the timelock allows, the watchtower returns the twin to the
// address they nominated ON THAT CHAIN, using the `twin` tiers the client pre-signed (see submitFinish).
//
// Broadcast ONLY after the real deposit's outpoint is spent on its home chain (the swap settled) plus
// a delay: the fork-leg twin sweep carries no marker (BIP-110 forbids large datacarriers there), so a
// third party COULD replay it back onto the home chain — where it is then a double-spend of an
// already-settled outpoint, i.e. harmless. The btc-leg twin sweep carries the marker and can't travel.
// Runs for TERMINAL swaps too (the twin chain may lag the CLTV height by weeks); eviction is held off
// while a detected twin is unresolved (see evictSettled). A twin that appears only after the swap
// evicted is out of scope here — the pre-signed sweep remains in the party's backup file.
const TWIN_CHECK_MS = () => Number(process.env.TWIN_CHECK_MS || 60000);       // per-swap probe throttle
const TWIN_SWEEP_DELAY_MS = () => Number(process.env.TWIN_SWEEP_DELAY_MS || 3600000);   // ≈6 BTC blocks past home settle
export const twinPending = (s) => !!s.twin && Object.values(s.twin).some((t) => !t.resolved);
export async function driveTwinSweep(s) {
  if (!forkTwinPair() || !s.htlc || !s.locktimes || ["CREATED", "CANCELED"].includes(s.state)) return;
  const now = Date.now();
  if (s._twinAt && now - s._twinAt < TWIN_CHECK_MS()) return;
  s._twinAt = now;
  for (const role of ["alice", "bob"]) {
    const tw = s.finish?.[role]?.twin;
    if (!tw?.tiers?.length) continue;
    const key = `${role}:twin`;
    if ((s.wt ||= {})[key]?.done) continue;
    const f = s.funding[tw.fundLeg] || s.shortFunded?.[tw.fundLeg];
    if (!f) continue;
    const twinChain = chainOf(tw.leg), home = chainOf(tw.fundLeg);
    let t = s.twin?.[tw.fundLeg];
    // 1) detect: the deposit's outpoint exists unspent on the OTHER chain → it was replayed.
    if (!t) {
      if (!(await twinChain.isUnspent(f.txid, f.vout))) continue;
      t = ((s.twin ||= {})[tw.fundLeg] = { detectedAt: now });
      console.log(`[twin] swap ${s.id}: ${chainCfg(tw.fundLeg).label} deposit ${f.txid.slice(0, 16)}… replayed onto ${chainCfg(tw.leg).label} — sweeping back after the timelock`);
      touch(s);
    }
    // Surface WHY the sweep hasn't fired yet (admin/UI reads it) — written only on reason CHANGES so
    // the store isn't churned every probe. lockHeight is the twin-chain height the sweep needs.
    t.lockHeight ??= s.locktimes[tw.fundLeg];
    const wait = (reason) => { if (t.waiting !== reason) { t.waiting = reason; touch(s); } };
    // 2) the REAL deposit must be spent on its home chain, settled past a reorg-safe delay.
    if (await home.isUnspent(f.txid, f.vout)) { wait("home-deposit-unspent"); continue; }
    if (!t.homeSpentAt) { t.homeSpentAt = now; touch(s); }
    if (now - t.homeSpentAt < TWIN_SWEEP_DELAY_MS()) { wait("reorg-delay"); continue; }
    // 3) the pre-signed sweep's nLockTime is the HTLC's CLTV height — final only once the TWIN chain
    //    reaches it (a lagging fork chain gets there later; the sweep just waits).
    if ((await twinChain.height()) < s.locktimes[tw.fundLeg]) { wait("twin-chain-below-lock-height"); continue; }
    // 4) still unswept? (the owner may have reclaimed it themselves out-of-band)
    if (!(await twinChain.isUnspent(f.txid, f.vout))) { s.wt[key] = { done: true, ts: now }; t.resolved = "external"; delete t.waiting; touch(s); continue; }
    // Walk UP the ladder on rejection. pickTier only price-checks the btc slot, so a sweep going out on
    // the second slot would otherwise retry tier 0 forever — exactly how a too-thin pre-signed tier
    // ("min relay fee not met") deadlocks. A higher tier is strictly more acceptable, so try each.
    let tier = await pickTier(tw.leg, tw.tiers, s.wt[key]?.tier || 0);
    let acc = await twinChain.testAccept(tw.tiers[tier].tx);
    while (!acc.allowed && tier + 1 < tw.tiers.length) { tier++; acc = await twinChain.testAccept(tw.tiers[tier].tx); }
    if (!acc.allowed) {
      wait(`mempool: ${acc.reason || "not accepted"}`);
      // Remember the escalation only when the blocker was economic; a transient/structural refusal
      // (e.g. still non-final) shouldn't permanently push future attempts to the priciest tier.
      if (/fee|dust|insufficient/i.test(acc.reason || "")) s.wt[key] = { ...(s.wt[key] || {}), tier };
      continue;
    }
    const txid = await twinChain.broadcast(tw.tiers[tier].tx);
    s.wt[key] = { txid, tier, ts: now, done: true };
    t.sweepTxid = txid; t.resolved = "swept"; delete t.waiting;
    console.log(`[twin] swap ${s.id}: replayed ${chainCfg(tw.fundLeg).label} deposit swept back to its sender on ${chainCfg(tw.leg).label} (${txid.slice(0, 16)}…)`);
    touch(s);
  }
}

// The view a party is allowed to see (both legs' public data; preimage only once on-chain).
export function view(s, role) {
  // Sequenced funding: the participant (bob) funds the toLeg (QBT) leg and may only do so once the
  // initiator's fromLeg (BTC) deposit is buried & irreversible; the initiator (alice) funds first,
  // unconditionally. `cleared` gates the participant's deposit prompt; the countdown starts from the
  // moment they're cleared, not from join, so a slow BTC confirmation doesn't eat their funding window.
  const toFunder = role === "bob";
  const fromF = s.funding[s.roles?.fromLeg];
  const fundGate = toFunder
    ? { cleared: !!s.fromConfirmedAt, funded: !!fromF, unconfirmed: !!(fromF && fromF.unconfirmed), confs: fromF?.confs || 0, need: s.fromConfsTarget?.confs || 1 }
    : { cleared: true };
  const fundStart = toFunder ? s.fromConfirmedAt : s.readyAt;
  return {
    // Per-leg chain identity (labels, script family, trust/replay flags) so clients pick the right
    // keys, signer, and sweep shape without hardcoding what each slot is.
    chains: publicChains(),
    id: s.id, role, state: s.state, terms: s.terms, direction: s.terms.direction, roles: s.roles,
    H: s.H, locktimes: s.locktimes, htlc: s.htlc, funding: s.funding, heights: s.heights,
    confsTarget: s.confsTarget, fromConfsTarget: s.fromConfsTarget, fee: s.fee || null,
    fundGate,
    fundBy: fundStart ? fundStart + FUNDING_WINDOW_MS : null, now: Date.now(),   // funding deadline + server clock (countdown is server-anchored)
    tooLate: !!s.tooLate,   // both matured but too close to the timelock to safely complete → will refund
    refund: s.refund, feerates: { btc: cachedBtcFeerates(), qbit: cachedQbitFeerates() },
    counterparty: s.party[role === "alice" ? "bob" : "alice"], self: s.party[role],
    counterpartyOnline: isOnline(s, role === "alice" ? "bob" : "alice"), selfOnline: isOnline(s, role),
    safetyNet: { self: !!s.finish?.[role], counterparty: !!s.finish?.[role === "alice" ? "bob" : "alice"] },
    shortFunded: s.shortFunded || null,
    twin: s.twin || null,   // fork-pair replay twins: { [fundLeg]: { detectedAt, homeSpentAt?, sweepTxid?, resolved? } }
    preimage: s.preimage, broadcasts: s.broadcasts,
    canceled: s.canceled ? { byYou: s.canceled.by === role, at: s.canceled.at } : null,
  };
}
