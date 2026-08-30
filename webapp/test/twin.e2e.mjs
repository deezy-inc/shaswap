// FORK-PAIR TWIN-SWEEP e2e: a sender who skips replay protection gets their deposit REPLAYED onto the
// other chain of the fork — an identical UTXO at the same outpoint, paying the same HTLC script. The
// client pre-signs a refund-path sweep of that twin for the other chain (armSafetyNet `twin` tiers) and
// the coordinator's driveTwinSweep returns it to the sender's refund address once (a) the real deposit
// settled on its home chain and (b) the twin chain reaches the HTLC's CLTV height. What this proves:
//   1. btc-leg deposit replayed onto the fork chain → detected, held until the fork chain reaches the
//      CLTV height, then swept back — with NO marker (BIP-110 policy would refuse one there).
//   2. fork-leg deposit replayed onto the btc chain → swept back WITH the marker (so the sweep itself
//      cannot cross back over the fork).
//   3. no replay → no twin state, ever.
//   4. submitFinish rejects a marker-less twin tier destined for the marker (btc) leg.
//   Run:  node test/twin.e2e.mjs
import { randomBytes } from "node:crypto";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { btcSpend, addressToScriptPubKey, splitterAddress } from "@qbit-swap/client";
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
process.env.TWIN_CHECK_MS = "1";          // probe every tick (test speed)
process.env.TWIN_SWEEP_DELAY_MS = "0";    // no reorg-safety wait in tests — the locktime gate is what we exercise
const { startServer } = await import("../../coordinator/server.js");
const { qbit, btc } = await import("../../coordinator/chain.js");
const mock = installMocks(qbit, btc);

const PORT = 8809, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => { const r = await fetch(BASE + p, { method: o.method || "GET", headers: { "content-type": "application/json", ...(o.token ? { "x-swap-token": o.token } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); const j = await r.json(); if (!r.ok) { const e = new Error(j.error || r.status); e.body = j; throw e; } return j; };
const until = async (fn, ms = 250, tries = 300) => { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(ms); } throw new Error("until: timeout"); };
let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const newAddr = () => splitterAddress(randomBytes(32), "bcrt").address;

async function runSwap() {
  const A = new SwapClient({ coordinator: BASE, btcHrp: "bcrt", qbitHrp: "bcrt", onUpdate: () => {} });
  const B = new SwapClient({ coordinator: BASE, btcHrp: "bcrt", qbitHrp: "bcrt", onUpdate: () => {} });
  const { id, inviteToken } = await A.create({ role: "alice", btcSats: 200_000, qbtSats: 150_000, securityLevel: "high", btcDest: newAddr(), qbitDest: newAddr() });
  await B.join({ id, token: inviteToken, btcDest: newAddr(), qbitDest: newAddr() });
  const v0 = await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.htlc ? v : null; });
  const btcTxid = mock.btc.fundSpk(v0.htlc.btc.spk, v0.terms.btcSats + (v0.fee?.sats || 0));
  mock.btc.mine(2);
  await until(async () => { const v = await api(`/swaps/${id}`, { token: B.token }); return v.fundGate?.cleared ? v : null; });
  const qbtTxid = mock.qbit.fundSpk(v0.htlc.qbit.spk, v0.terms.qbtSats);
  mock.qbit.mine(2);
  return { A, B, id, v0, btcTxid, qbtTxid };
}
const complete = async (A, B, id) => {
  A.start(); B.start();
  const final = await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.state === "COMPLETE" ? v : null; }, 300, 400);
  A.stop(); B.stop();
  return final;
};

async function main() {
  await startServer(PORT);
  ck((await api("/chains")).btc.forkTwin === true, "GET /chains advertises forkTwin on the bip110 pair");

  // ── 1) btc deposit replayed onto the fork chain → marker-LESS sweep after its CLTV height ───────
  console.log("\n=== scenario 1: unprotected BTC-SHA256 deposit replayed onto the fork chain ===");
  {
    const { A, B, id, v0, btcTxid } = await runSwap();
    mock.qbit.mirrorFrom(mock.btc, btcTxid);                       // the replay (sender skipped the OP_RETURN)
    const final = await complete(A, B, id);
    ck(final.state === "COMPLETE", "swap still settles COMPLETE with the twin sitting on the fork chain");
    const det = await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.twin?.btc ? v : null; });
    ck(!!det.twin.btc.detectedAt, "coordinator detected the replayed twin");
    // held while the fork chain is short of the HTLC's CLTV height
    await sleep(800);
    const ftwin = `${btcTxid}:0`;
    ck(!mock.qbit.utxo.get(ftwin)?.spent, `twin NOT swept while fork height (${mock.qbit.height}) < CLTV (${v0.locktimes.btc})`);
    mock.qbit.mine(v0.locktimes.btc - mock.qbit.height + 1);
    const swept = await until(async () => { const v = await api(`/swaps/${id}`, { token: A.token }); return v.twin?.btc?.resolved === "swept" ? v : null; });
    ck(mock.qbit.utxo.get(ftwin)?.spent, "twin swept once the fork chain reached the CLTV height");
    const sweep = mock.qbit.tx.get(swept.twin.btc.sweepTxid);
    ck(sweep && !hasReplayMarker(sweep.vout), "the fork-chain sweep carries NO marker (BIP-110 would refuse it)");
    ck(hex(sweep.vout[0][1]) === hex(addressToScriptPubKey(A.btcDest)), "…and pays the SENDER's own refund address");
  }

  // ── 2) fork deposit replayed onto the btc chain → sweep WITH the marker ─────────────────────────
  console.log("\n=== scenario 2: unprotected BTC-Blake2b deposit replayed onto the btc chain ===");
  {
    const { A, B, id, v0, qbtTxid } = await runSwap();
    mock.btc.mirrorFrom(mock.qbit, qbtTxid);
    const final = await complete(A, B, id);
    ck(final.state === "COMPLETE", "swap settles COMPLETE with the twin on the btc chain");
    await until(async () => { const v = await api(`/swaps/${id}`, { token: B.token }); return v.twin?.qbit ? v : null; });
    mock.btc.mine(Math.max(0, v0.locktimes.qbit - mock.btc.height) + 1);
    const swept = await until(async () => { const v = await api(`/swaps/${id}`, { token: B.token }); return v.twin?.qbit?.resolved === "swept" ? v : null; });
    const sweep = mock.btc.tx.get(swept.twin.qbit.sweepTxid);
    ck(sweep && hasReplayMarker(sweep.vout), "the btc-chain sweep CARRIES the marker (cannot cross back over the fork)");
    ck(hex(sweep.vout[0][1]) === hex(addressToScriptPubKey(B.qbitDest)), "…and pays the fork-side sender's refund address");
  }

  // ── 3) no replay → no twin state ────────────────────────────────────────────────────────────────
  console.log("\n=== scenario 3: protected deposits (no replay) → no twin state ===");
  {
    const { A, B, id } = await runSwap();
    const final = await complete(A, B, id);
    await sleep(800);
    const v = await api(`/swaps/${id}`, { token: A.token });
    ck(final.state === "COMPLETE" && !v.twin, "no twin ever detected on a clean swap");
  }

  // ── 4) submitFinish rejects a marker-less twin tier for the marker leg ──────────────────────────
  console.log("\n=== scenario 4: marker-less twin tier for the btc leg is refused at upload ===");
  {
    const { A, B, id } = await runSwap();
    const v = await until(async () => { const w = await api(`/swaps/${id}`, { token: B.token }); return w.funding?.qbit ? w : null; });
    const f = v.funding.qbit, ws = bin(v.htlc.qbit.witnessScript);
    const naked = hex(btcSpend({ prevTxidLE: bin(f.txid).reverse(), vout: f.vout, amount: f.amountSats, ws, priv: B.btcPriv, destSpk: addressToScriptPubKey(B.qbitDest), outVal: f.amountSats - 5000, branch: "refund", preimage: new Uint8Array(0), locktime: v.locktimes.qbit, replay: false }));
    let err = null;
    try {
      await api(`/swaps/${id}/finish`, { token: B.token, method: "POST", body: { refund: { leg: "qbit", tiers: [{ feerate: 1, tx: naked }] }, twin: { leg: "btc", fundLeg: "qbit", tiers: [{ feerate: 1, tx: naked }] } } });
    } catch (e) { err = e; }
    ck(/twin tier lacks the replay-protection/.test(err?.message), `marker-less twin tier rejected: "${err?.message}"`);
    void A;
  }

  console.log(ok ? "\nPASS — replayed (unprotected) deposits are detected and swept back to their sender on the other chain, marker rules intact" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
