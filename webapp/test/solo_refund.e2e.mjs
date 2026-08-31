// SOLO-FUNDED REFUND e2e: the first leg funds, the counterparty never sends theirs, and the funder's
// tab CLOSES. The client must have armed a refund-only watchtower bundle the moment its own deposit
// existed (not only when both legs fund), so the coordinator refunds the deposit after the timelock
// with nobody online. Also proves the solo arm upgrades to the full claim+refund bundle when the
// second leg lands (swap still completes).  Run:  node test/solo_refund.e2e.mjs
import { randomBytes } from "node:crypto";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { addressToScriptPubKey, splitterAddress } from "@qbit-swap/client";
import { hasReplayMarker } from "../../coordinator/chains.js";
import { SwapClient } from "../src/swapflow.js";
import { installMocks } from "./mockchain.mjs";

process.env.COORD_CHAIN = "dev";
process.env.CHAIN2 = "bip110";
process.env.BTC_HRP = "bcrt"; process.env.ALT_HRP = "bcrt";
process.env.BTC_BLOCK_SECS = "1"; process.env.ALT_BLOCK_SECS = "1";
process.env.HTLC_TO_SECS = "60"; process.env.HTLC_FROM_SECS = "120";
process.env.DEV_CONFS_CAP = "2"; process.env.FUNDING_WINDOW_MS = "600000"; process.env.RATE_MAX = "100000";
process.env.ALT_MIN_SATS = "50000";
const { startServer } = await import("../../coordinator/server.js");
const { qbit, btc } = await import("../../coordinator/chain.js");
const mock = installMocks(qbit, btc);

const PORT = 8810, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => { const r = await fetch(BASE + p, { method: o.method || "GET", headers: { "content-type": "application/json", ...(o.token ? { "x-swap-token": o.token } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); const j = await r.json(); if (!r.ok) { const e = new Error(j.error || r.status); e.body = j; throw e; } return j; };
const until = async (fn, ms = 250, tries = 300) => { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(ms); } throw new Error("until: timeout"); };
let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const newAddr = () => splitterAddress(randomBytes(32), "bcrt").address;

async function setup() {
  const A = new SwapClient({ coordinator: BASE, btcHrp: "bcrt", qbitHrp: "bcrt", onUpdate: () => {} });
  const B = new SwapClient({ coordinator: BASE, btcHrp: "bcrt", qbitHrp: "bcrt", onUpdate: () => {} });
  const { id, inviteToken } = await A.create({ role: "alice", btcSats: 200_000, qbtSats: 150_000, securityLevel: "high", btcDest: newAddr(), qbitDest: newAddr() });
  await B.join({ id, token: inviteToken, btcDest: newAddr(), qbitDest: newAddr() });
  const v0 = await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.htlc ? v : null; });
  const btcTxid = mock.btc.fundSpk(v0.htlc.btc.spk, v0.terms.btcSats + (v0.fee?.sats || 0));
  mock.btc.mine(2);
  return { A, B, id, v0, btcTxid };
}

async function main() {
  await startServer(PORT);

  // ── 1) counterparty never funds → tab closes → WATCHTOWER refunds after the timelock ───────────
  console.log("\n=== scenario 1: solo-funded leg, tab closed → watchtower auto-refund ===");
  {
    const { A, id, v0, btcTxid } = await setup();
    A.start();
    // the client must arm a refund-only bundle from its own deposit ALONE (second leg never funds)
    const armed = await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.safetyNet?.self ? v : null; });
    ck(!!armed, "refund-only safety net armed with ONLY the first leg funded");
    A.stop();   // tab closed — recovery must not depend on this client anymore
    mock.btc.mine(125);   // pass the fromLeg CLTV (120 blocks at 1s/block)
    const final = await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.state === "REFUNDED" ? v : null; }, 300, 400);
    ck(final.state === "REFUNDED", "watchtower refunded the solo deposit with the tab closed");
    const sweepTxid = mock.btc.spentBy.get(`${btcTxid}:0`);
    const sweep = mock.btc.tx.get(sweepTxid);
    ck(!!sweep && hex(sweep.vout[0][1]) === hex(addressToScriptPubKey(A.btcDest)), "…to the funder's own refund address");
    ck(!hasReplayMarker(sweep.vout), "the refund carries NO replay marker (it pays its own funder — a replay is harmless)");
  }

  // ── 2) solo arm must not break the happy path: second leg lands → full bundle → COMPLETE ───────
  console.log("\n=== scenario 2: solo arm upgrades to claim+refund when the second leg funds ===");
  {
    const { A, B, id, v0 } = await setup();
    A.start();
    await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.safetyNet?.self ? v : null; });
    await until(async () => { const v = await api(`/swaps/${id}`, { token: B.token }); return v.fundGate?.cleared ? v : null; });
    mock.qbit.fundSpk(v0.htlc.qbit.spk, v0.terms.qbtSats);
    mock.qbit.mine(2);
    B.start();
    const final = await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.state === "COMPLETE" ? v : null; }, 300, 400);
    A.stop(); B.stop();
    ck(final.state === "COMPLETE", "swap still completes normally after an early solo arm");
  }

  console.log(ok ? "\nPASS — a solo-funded deposit is watchtower-recoverable even with every tab closed" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
