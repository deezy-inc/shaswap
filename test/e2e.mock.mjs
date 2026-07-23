// End-to-end: the REAL coordinator + the REAL MakerBot, over the REAL HTTP API, with an in-memory chain
// (test/mockchain.mjs) standing in for regtest nodes. Drives both terminal outcomes the bot must handle:
//   1) COMPLETE — taker funds BTC, bot funds QBT, taker claims QBT (revealing the preimage), bot claims BTC.
//   2) REFUNDED — taker funds BTC, bot funds QBT, taker walks; QBT timelock passes; bot refunds its QBT.
// Requires the qbit-otc checkout beside this repo (imports the coordinator + client from ../../qbit-otc).
//   Run:  node test/e2e.mock.mjs
import { randomBytes } from "node:crypto";
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { slhDsaKeygen, slhDsaSign, compressedPub, p2mrSighash, serializeTx, P2MR_CONTROL_SINGLE_LEAF, addressToScriptPubKey } from "../../qbit-otc/client/index.js";
import { MakerBot } from "../maker-bot.js";
import { installMocks } from "./mockchain.mjs";

// Regtest-shaped knobs BEFORE importing the coordinator (they're read at module load). Fees ON (2% +
// reserve) so the bot's coordinator-fee splitting is exercised, and one RFQ maker key so serveRfq works.
process.env.COORD_CHAIN = "dev";
process.env.BTC_BLOCK_SECS = "1"; process.env.QBIT_BLOCK_SECS = "1";
process.env.HTLC_TO_SECS = "60"; process.env.HTLC_FROM_SECS = "120";
process.env.DEV_CONFS_CAP = "2"; process.env.FUNDING_WINDOW_MS = "600000";
process.env.FEE_BPS = "200";
process.env.FEE_XPUB = "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ";
process.env.RFQ_MAKER_KEYS = "mm-test:makerkey123";
const { startServer } = await import("../../qbit-otc/coordinator/server.js");
const { qbit, btc } = await import("../../qbit-otc/coordinator/chain.js");
const mock = installMocks(qbit, btc);

const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, { token, method = "GET", body } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { "x-swap-token": token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`); return j;
};
const until = async (fn, ms = 400, tries = 200) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(ms); } throw new Error("until: timeout"); };
let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };

// A wallet adapter for the bot backed by the mock QBT chain (funds by address; dest spks are throwaway).
const wallet = {
  qbitHeight: async () => mock.qbit.height,
  newQbit: async () => ({ address: `qdest-${hex(randomBytes(4))}`, spk: randomBytes(22) }),
  newBtc: async () => ({ address: `bdest-${hex(randomBytes(4))}`, spk: randomBytes(22) }),
  fundQbit: async (address, sats) => mock.qbit.fundAddr(address, sats),
};
const policy = { minRate: 0.1, maxQbtSats: 10_000_000_000 };   // floor 0.1 BTC/QBT; cap 100 QBT

// Alice = the retail taker. She creates the swap, funds BTC, and (in the happy path) claims QBT.
async function makeAlice() {
  const kp = await slhDsaKeygen(randomBytes(128)), btcPriv = randomBytes(32), secret = randomBytes(32);
  return { kp, btcPriv, btcPub: compressedPub(btcPriv), secret, H: sha256(secret), qbitDestSpk: randomBytes(22) };
}
async function setupSwap(btcSats, qbtSats) {
  const alice = await makeAlice();
  const { id, tokens } = await api("/swaps", { method: "POST", body: { btcSats, qbtSats, securityLevel: "high" } });
  await api(`/swaps/${id}/party`, { token: tokens.alice, method: "POST", body: { qbitPub: hex(alice.kp.pk), btcPub: hex(alice.btcPub), btcDest: "bc1alice", qbitDest: "qbt1alice", H: hex(alice.H) } });
  return { id, tokens, alice };
}
// Register HTLC spks with the mock so funding-by-address/spk resolves, then let Alice fund BTC.
async function fundBtcAndRegister(id, tokens) {
  const v = await until(async () => { const s = await api(`/swaps/${id}`, { token: tokens.alice }); return s.htlc ? s : null; });
  mock.btc.register(v.htlc.btc.address, v.htlc.btc.spk);
  mock.qbit.register(v.htlc.qbit.address, v.htlc.qbit.spk);
  mock.btc.fundSpk(v.htlc.btc.spk, v.terms.btcSats + (v.fee?.sats || 0)); mock.btc.mine(2);
  return v;
}
async function aliceClaimQbt(id, tokens, alice) {
  const v = await until(async () => { const s = await api(`/swaps/${id}`, { token: tokens.alice }); return s.state === "CLAIMABLE" ? s : null; });
  const f = v.funding.qbit, leaf = bin(v.htlc.qbit.leaf), spk = bin(v.htlc.qbit.spk);
  const prevoutLE = bin(f.txid).reverse(), outVal = f.amountSats - 100000;
  const sh = p2mrSighash({ version: 2, locktime: 0, vin: [{ txidLE: prevoutLE, vout: f.vout, sequence: 0xffffffff }], spentOutputs: [{ amount: f.amountSats, spk }], vout: [{ value: outVal, spk: alice.qbitDestSpk }], inputIndex: 0, leafScript: leaf });
  const sig = await slhDsaSign(alice.kp.sk, sh);
  const tx = serializeTx({ version: 2, vin: [[prevoutLE, f.vout, new Uint8Array(0), 0xffffffff]], vout: [[BigInt(outVal), alice.qbitDestSpk]], wit: [[sig, alice.secret, Uint8Array.of(0x01), leaf, P2MR_CONTROL_SINGLE_LEAF]], locktime: 0 });
  await api(`/swaps/${id}/broadcast`, { token: tokens.alice, method: "POST", body: { leg: "qbit", kind: "claim", tx: hex(tx) } });
  mock.qbit.mine(1);
}

async function main() {
  await startServer(PORT);
  const bot = new MakerBot({ coordinatorUrl: BASE, wallet, policy, pollMs: 200, makerKey: "makerkey123", log: (m) => console.log("   " + m) });

  // ── 1) happy path → COMPLETE ────────────────────────────────────────────────
  console.log("\n=== scenario 1: taker buys QBT, bot fulfills → COMPLETE ===");
  {
    const { id, tokens, alice } = await setupSwap(20_000_000, 100_000_000);   // 0.2 BTC ⇄ 1 QBT (rate 0.2 ≥ floor)
    const outcome = bot.consider({ swapId: id, token: tokens.bob });          // bot runs the maker side concurrently
    await fundBtcAndRegister(id, tokens);                                     // Alice funds BTC; bot then funds QBT
    await until(async () => (await api(`/swaps/${id}`, { token: tokens.alice })).funding?.qbit ? true : null);
    mock.qbit.mine(2);
    await aliceClaimQbt(id, tokens, alice);                                   // reveal the preimage
    const res = await outcome;
    const final = await api(`/swaps/${id}`, { token: tokens.alice });
    ck(res.accepted && res.outcome === "completed", `bot reports completed (${res.outcome})`);
    ck(final.state === "COMPLETE", `coordinator state COMPLETE (${final.state})`);
    ck(!!final.broadcasts["btc:claim"], "bot's BTC claim was broadcast (it collected the BTC)");
    // Fee-awareness: the bot split the coordinator fee to fee.address instead of pocketing it.
    ck(final.fee?.sats > 0, `swap carried a coordinator fee (${final.fee?.sats} sats)`);
    const feeOut = await mock.btc.findOutput(hex(addressToScriptPubKey(final.fee.address)));
    ck(feeOut && feeOut.amountSats === final.fee.sats - Math.min(5000, final.fee.sats), `claim paid the fee output to fee.address (${feeOut?.amountSats} sats), bot netted terms only`);
  }

  // ── 2) taker walks after the bot funds → the bot REFUNDS its QBT ────────────
  console.log("\n=== scenario 2: taker abandons after bot funds QBT → REFUNDED ===");
  {
    const { id, tokens } = await setupSwap(20_000_000, 100_000_000);
    const outcome = bot.consider({ swapId: id, token: tokens.bob });
    await fundBtcAndRegister(id, tokens);
    const v = await until(async () => { const s = await api(`/swaps/${id}`, { token: tokens.alice }); return s.funding?.qbit ? s : null; });
    mock.qbit.mine((v.locktimes.qbit - mock.qbit.height) + 1);                // advance past the QBT timelock; taker never claims
    const res = await outcome;
    const final = await api(`/swaps/${id}`, { token: tokens.alice });
    ck(res.accepted && res.outcome === "refunded", `bot reports refunded (${res.outcome})`);
    ck(final.state === "REFUNDED", `coordinator state REFUNDED (${final.state})`);
  }

  // ── 3) pricing: a swap below the bot's rate floor is rejected without joining ─
  console.log("\n=== scenario 3: underpriced swap is rejected by policy ===");
  {
    const { id, tokens } = await setupSwap(6_000_000, 100_000_000);           // 0.06 BTC/QBT < floor 0.1
    const res = await bot.consider({ swapId: id, token: tokens.bob });
    const final = await api(`/swaps/${id}`, { token: tokens.bob });
    ck(!res.accepted && /floor/.test(res.reason), `bot rejected on price (${res.reason})`);
    ck(!final.self, "bot never joined the underpriced swap (its own party slot is empty)");
  }

  // ── 4) RFQ ask side: bot streams a quote, retail takes it via /rfq, swap → COMPLETE ────────
  console.log("\n=== scenario 4: RFQ maker quote → retail one-click buy → COMPLETE ===");
  {
    const ASK = 0.2;
    bot.serveRfq({ quote: { ask: { price: ASK, qbtSats: 5_000_000_000 } }, pingMs: 200 }).catch((e) => console.log("serveRfq:", e.message));
    // wait for the maker's first ping to register the quote, then retail takes the best price in one click
    await until(async () => { const d = await api("/rfq"); return d.buy?.qbtSats > 0 ? d : null; });
    const take = await api("/rfq/take", { method: "POST", body: { side: "buy", qbtSats: 100_000_000, price: ASK } });   // { swapId, token(alice), role }
    ck(take.role === "alice" && take.swapId, `retail took an RFQ buy quote (role ${take.role})`);
    // retail (alice) joins with H; the bot's next ping delivers the match and it fulfills as bob
    const alice = await makeAlice();
    const tokens = { alice: take.token };
    await api(`/swaps/${take.swapId}/party`, { token: take.token, method: "POST", body: { qbitPub: hex(alice.kp.pk), btcPub: hex(alice.btcPub), btcDest: "bc1alice", qbitDest: "qbt1alice", H: hex(alice.H) } });
    await fundBtcAndRegister(take.swapId, tokens);
    await until(async () => (await api(`/swaps/${take.swapId}`, { token: take.token })).funding?.qbit ? true : null);
    mock.qbit.mine(2);
    await aliceClaimQbt(take.swapId, tokens, alice);
    const final = await until(async () => { const s = await api(`/swaps/${take.swapId}`, { token: take.token }); return s.state === "COMPLETE" ? s : null; });
    ck(final.state === "COMPLETE", `RFQ-sourced swap settled COMPLETE (${final.state})`);
  }

  console.log(ok ? "\nPASS — MakerBot drives complete + refund + reject + RFQ against the live coordinator API" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.stack || e.message); process.exit(1); });
