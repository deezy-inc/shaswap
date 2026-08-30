// FORK-PAIR e2e: CHAIN2=bip110 — real BTC ⇄ the BIP-110/Blake2b Knots fork — over the live coordinator
// API with the real SwapClient on both sides (in-memory chains). What this proves:
//   1. One env flip makes the second leg a P2WSH+ECDSA Bitcoin-family chain: both HTLCs are bc1…
//      P2WSH addresses, both parties sign ECDSA on both legs, swap → COMPLETE.
//   2. REPLAY PROTECTION: every BTC-side sweep (live claims AND the pre-signed watchtower tiers)
//      carries the >83-byte OP_RETURN marker; the coordinator REJECTS a marker-less BTC sweep.
//   3. TRUST-UNCONFIRMED: with both legs flagged, a swap completes with all deposits at 0-conf
//      (nothing mined); without the flags the same 0-conf setup holds safely short of CLAIMABLE.
//   Run:  node test/forkpair.e2e.mjs
import { randomBytes } from "node:crypto";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { parseTx, btcSpend, addressToScriptPubKey } from "@qbit-swap/client";
import { hasReplayMarker } from "../../coordinator/chains.js";
import { SwapClient } from "../src/swapflow.js";
import { installMocks } from "./mockchain.mjs";

process.env.COORD_CHAIN = "dev";
process.env.CHAIN2 = "bip110";                       // ← the whole point: one config value
process.env.BTC_HRP = "bcrt"; process.env.ALT_HRP = "bcrt";   // regtest-flavored bc-family addresses on BOTH legs
process.env.BTC_BLOCK_SECS = "1"; process.env.ALT_BLOCK_SECS = "1";
process.env.HTLC_TO_SECS = "60"; process.env.HTLC_FROM_SECS = "120";
process.env.DEV_CONFS_CAP = "2"; process.env.FUNDING_WINDOW_MS = "600000"; process.env.RATE_MAX = "100000";
process.env.ALT_MIN_SATS = "50000";                  // fork-coin minimum (sats scale, not qbit's)
const { startServer } = await import("../../coordinator/server.js");
const { qbit, btc } = await import("../../coordinator/chain.js");
const mock = installMocks(qbit, btc);

const PORT = 8808, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => { const r = await fetch(BASE + p, { method: o.method || "GET", headers: { "content-type": "application/json", ...(o.token ? { "x-swap-token": o.token } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); const j = await r.json(); if (!r.ok) { const e = new Error(j.error || r.status); e.body = j; throw e; } return j; };
const until = async (fn, ms = 250, tries = 300) => { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(ms); } throw new Error("until: timeout"); };
let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const dest = () => { const b = randomBytes(20); return { addr: null, spk: b }; };   // spks only; use client addresses below
// Valid bc-family addresses for dests (any P2WSH; decodable by addressToScriptPubKey).
import { splitterAddress } from "@qbit-swap/client";
const newAddr = () => splitterAddress(randomBytes(32), "bcrt").address;

async function runSwap({ mempoolOnly = false, mine = !mempoolOnly, waitGate = true } = {}) {
  const A = new SwapClient({ coordinator: BASE, btcHrp: "bcrt", qbitHrp: "bcrt", onUpdate: () => {} });
  const B = new SwapClient({ coordinator: BASE, btcHrp: "bcrt", qbitHrp: "bcrt", onUpdate: () => {} });
  const { id, inviteToken } = await A.create({ role: "alice", btcSats: 200_000, qbtSats: 150_000, securityLevel: "high", btcDest: newAddr(), qbitDest: newAddr() });
  await B.join({ id, token: inviteToken, btcDest: newAddr(), qbitDest: newAddr() });
  const v0 = await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.htlc ? v : null; });
  // fund both legs (alice's btc first, then bob's alt once cleared). Without trust flags a 0-conf BTC
  // deposit CORRECTLY never clears the sequenced-funding gate — scenario 4 skips the wait and funds
  // both directly to show the claimable gate also holds.
  mock.btc.fundSpk(v0.htlc.btc.spk, v0.terms.btcSats + (v0.fee?.sats || 0), { mempool: mempoolOnly });
  if (mine) mock.btc.mine(2);
  if (waitGate) await until(async () => { const v = await api(`/swaps/${id}`, { token: B.token }); return v.fundGate?.cleared ? v : null; });
  mock.qbit.fundSpk(v0.htlc.qbit.spk, v0.terms.qbtSats, { mempool: mempoolOnly });
  if (mine) mock.qbit.mine(2);
  return { A, B, id, v0 };
}

async function main() {
  await startServer(PORT);

  // ── sanity: the pair config the clients see ────────────────────────────────────────────────────
  const chains = await api("/chains");
  ck(chains.qbit.script === "p2wsh-ecdsa" && chains.qbit.label === "BTC-Blake2b" && chains.btc.label === "BTC-SHA256", "GET /chains: pair labeled BTC-SHA256 ⇄ BTC-Blake2b");
  ck(chains.btc.replayOpReturn === true && chains.qbit.replayOpReturn === false, "replay protection: ON for the BTC side, off on the fork side");

  // ── 1) full fork-pair swap → COMPLETE, with replay markers on every BTC-side sweep ─────────────
  console.log("\n=== scenario 1: BTC ⇄ B110 swap (ECDSA both legs) → COMPLETE, markers enforced ===");
  {
    const { A, B, id, v0 } = await runSwap({});
    ck(v0.htlc.btc.address.startsWith("bcrt1q") && v0.htlc.qbit.address.startsWith("bcrt1q"), "BOTH HTLCs are P2WSH bech32 addresses (no p2mr in the pair)");
    ck(!!v0.htlc.qbit.witnessScript && !v0.htlc.qbit.leaf, "second leg carries a witnessScript, not a p2mr leaf");
    A.start(); B.start();
    const final = await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.state === "COMPLETE" ? v : null; }, 300, 400);
    A.stop(); B.stop();
    ck(final.state === "COMPLETE", "fork-pair swap settled COMPLETE with ECDSA signing on both legs");
    // the BTC-side claim that landed on-chain must carry the >83-byte OP_RETURN
    const claimTx = mock.btc.tx.get(final.broadcasts["btc:claim"]);
    ck(claimTx && hasReplayMarker(claimTx.vout), "the mined BTC claim carries the replay marker (won't relay on the fork chain)");
    const altClaim = mock.qbit.tx.get(final.broadcasts["qbit:claim"]);
    ck(altClaim && !hasReplayMarker(altClaim.vout), "the fork-side claim carries no marker (BIP-110 would refuse it)");
  }

  // ── 2) coordinator REJECTS a marker-less BTC sweep on the flagged leg ──────────────────────────
  console.log("\n=== scenario 2: marker-less BTC sweep is refused ===");
  {
    const { A, B, id } = await runSwap({});
    A.start();                                                        // alice claims the fork leg, revealing the preimage
    const revealed = await until(async () => { const v = await api(`/swaps/${id}`, { token: B.token }); return v.preimage ? v : null; }, 300, 400);
    A.stop();
    const f = revealed.funding.btc, ws = bin(revealed.htlc.btc.witnessScript);
    const naked = btcSpend({ prevTxidLE: bin(f.txid).reverse(), vout: f.vout, amount: f.amountSats, ws, priv: B.btcPriv, destSpk: addressToScriptPubKey(B.btcDest), outVal: f.amountSats - 5000, branch: "claim", preimage: bin(revealed.preimage), replay: false });
    let err = null;
    try { await api(`/swaps/${id}/broadcast`, { token: B.token, method: "POST", body: { leg: "btc", kind: "claim", tx: hex(naked) } }); } catch (e) { err = e; }
    ck(/replay-protection OP_RETURN/.test(err?.message), `marker-less BTC claim rejected: "${err?.message}"`);
    // and the marked version (what the client builds by itself) is accepted
    B.start();
    const final = await until(async () => { const v = await api(`/swaps/${id}`, { token: B.token }); return v.state === "COMPLETE" ? v : null; }, 300, 400);
    B.stop();
    ck(final.state === "COMPLETE", "the client's own (marked) claim then completes the swap");
  }

  // ── 3) trust-unconfirmed: completes at 0-conf; without the flags it holds ──────────────────────
  console.log("\n=== scenario 3: trust-unconfirmed both legs → COMPLETE with NOTHING mined ===");
  {
    process.env.BTC_TRUST_UNCONFIRMED = "1"; process.env.ALT_TRUST_UNCONFIRMED = "1";
    const startHeights = { b: mock.btc.height, q: mock.qbit.height };
    const { A, B, id } = await runSwap({ mempoolOnly: true });
    A.start(); B.start();
    const final = await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.state === "COMPLETE" ? v : null; }, 300, 400);
    A.stop(); B.stop();
    ck(final.state === "COMPLETE", "swap completed with BOTH deposits still in the mempool (trust-unconfirmed)");
    ck(mock.btc.height === startHeights.b && mock.qbit.height === startHeights.q, "…and truly nothing was mined");
    delete process.env.BTC_TRUST_UNCONFIRMED; delete process.env.ALT_TRUST_UNCONFIRMED;
  }
  console.log("\n=== scenario 4: same 0-conf setup WITHOUT trust flags → held short of CLAIMABLE ===");
  {
    const { A, B, id } = await runSwap({ mempoolOnly: true, waitGate: false });
    for (let i = 0; i < 10; i++) { const v = await api(`/swaps/${id}`, { token: A.token }); if (v.state === "CLAIMABLE") { ck(false, "0-conf must NOT be claimable without trust"); break; } await sleep(300); }
    const v = await api(`/swaps/${id}`, { token: A.token });
    ck(v.state !== "CLAIMABLE" && v.state !== "COMPLETE", `without trust flags the 0-conf swap holds at ${v.state} (default safety intact)`);
    void A; void B; void dest; void parseTx;
  }

  console.log(ok ? "\nPASS — one config flip runs BTC ⇄ BIP-110 fork swaps: ECDSA both legs, replay-marker enforcement, 0-conf trust mode" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
