// Price guardrails + USD quoting. With QBT ≈ $0.12 (~1e-6 BTC/QBT), the classic fat-finger is a USD
// number typed into the BTC/QBT field — 0.12 "dollars" quotes ~$14,000/QBT. Covers: reference-price
// sourcing (settled-swaps median → book mid → none), the deviation guard, the absolute ceiling (catches
// USD-magnitude typos with NO reference), USD→BTC/QBT conversion + pegs following BTCUSD, and the
// Telegram $/force flows.  Run:  node test/sanity.test.mjs
import http from "node:http";
import { referencePrice, quoteIssues } from "../maker-bot.js";
import { btcUsd, usdToBtcQbt, startUsdRepricer } from "../usd.js";
import { startTelegram } from "../telegram.js";

let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REF = 0.00000104;   // ≈ $0.12/QBT at $115k BTC

// ── mock coordinator ─────────────────────────────────────────────────────────────────────────────
const co = { trades: [], rfq: { enabled: true, buy: { price: null }, sell: { price: null } } };
const srv = http.createServer((req, res) => {
  if (req.url.startsWith("/trades")) { if (!co.trades.length) { res.statusCode = 404; return res.end("{}"); } return res.end(JSON.stringify(co.trades)); }
  if (req.url.startsWith("/rfq")) return res.end(JSON.stringify(co.rfq));
  res.statusCode = 404; res.end("{}");
});
await new Promise((r) => srv.listen(0, r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

// reference sourcing: settled-swaps median beats the book; book mid is the fallback; none → null
co.trades = [0.9 * REF, REF, 1.1 * REF, REF, 40 * REF].map((price) => ({ price }));   // one outlier — median shrugs it off
let ref = await referencePrice(BASE);
ck(Math.abs(ref.price - REF) < 1e-12 && /settled swaps/.test(ref.source), `reference = median of settled swaps (${ref.price})`);
co.trades = [];
co.rfq.buy.price = 1.1 * REF; co.rfq.sell.price = 0.9 * REF;
ref = await referencePrice(BASE);
ck(Math.abs(ref.price - REF) < 1e-12 && /book/.test(ref.source), "no trades feed → falls back to the live book's mid");
co.rfq.buy.price = null; co.rfq.sell.price = null;
ck((await referencePrice(BASE)) === null, "fresh market (no trades, empty book) → no reference");

// deviation guard: sane spread passes; the $0.12-as-BTC fat-finger is caught and marked losing
const q = (b, a) => ({ bid: b != null ? { price: b } : null, ask: a != null ? { price: a } : null });
ck(quoteIssues(q(0.95 * REF, 1.05 * REF), { ref: REF, devPct: 30, maxPrice: 0.001 }).length === 0, "a ±5% spread around the reference passes");
let iss = quoteIssues(q(0.12, null), { ref: REF, devPct: 30, maxPrice: 0.001 });
ck(iss.length === 1 && iss[0].reason === "ceiling" && iss[0].losing, "bid 0.12 (a USD number in the BTC field, ~100,000× off) → ceiling violation, flagged losing");
iss = quoteIssues(q(null, REF * 0.5), { ref: REF, devPct: 30, maxPrice: 0.001 });
ck(iss.length === 1 && iss[0].reason === "deviation" && iss[0].losing, "ask at half the reference → deviation, losing (selling cheap)");
ck(quoteIssues(q(0.12, null), { ref: null, devPct: 30, maxPrice: 0.001 })[0]?.reason === "ceiling", "the ceiling catches USD-magnitude typos even with NO reference price");
ck(quoteIssues(q(REF * 2, null), { ref: null, devPct: 30, maxPrice: 0.001 }).length === 0, "without a reference, a plausible-magnitude price is allowed (nothing to compare against)");

// ── USD conversion + pegs following BTCUSD ───────────────────────────────────────────────────────
let rate = 115000;
const fakeFetch = async () => ({ json: async () => ({ bitcoin: { usd: rate } }) });
process.env.BTCUSD_URL = "http://x/";   // never actually hit (fakeFetch)
ck(Math.abs(usdToBtcQbt(0.12, 115000) - REF) < 2e-8, "usd→BTC/QBT conversion ($0.12 @ $115k ≈ 1.04e-6)");
const quote = { bid: { price: usdToBtcQbt(0.11, rate), qbtSats: 50e8 }, ask: { price: usdToBtcQbt(0.13, rate), qbtSats: 50e8 } };
const pegs = { bid: 0.11, ask: 0.13 };
const rep = startUsdRepricer({ quote, pegs, intervalMs: 3600_000, log: () => {}, fetchImpl: fakeFetch });
rate = 130000;                                   // BTC pumps ~13% before the first tick fetches the rate
await rep.tick();
ck(Math.abs(quote.bid.price - usdToBtcQbt(0.11, 130000)) < 1e-15 && Math.abs(quote.ask.price - usdToBtcQbt(0.13, 130000)) < 1e-15,
  "pegs FOLLOW BTCUSD: after BTC moves, both sides reprice so the dollar prices hold ($0.11/$0.13)");
rep.stop();

// ── Telegram: $ sets a peg, sanity blocks a bad price, force overrides ───────────────────────────
const inbox = []; const sent = []; let uid = 1;
const push = (t) => inbox.push({ update_id: uid++, message: { chat: { id: 999 }, text: t } });
const tgSrv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
  if (req.url.endsWith("/getUpdates")) { const body = JSON.parse(b || "{}"); const out = inbox.filter((u) => u.update_id >= (body.offset || 0)); inbox.length = 0; return res.end(JSON.stringify({ ok: true, result: out })); }
  if (req.url.endsWith("/sendMessage")) { sent.push(JSON.parse(b).text); return res.end(JSON.stringify({ ok: true, result: {} })); }
  res.end(JSON.stringify({ ok: true, result: [] }));
}); });
await new Promise((r) => tgSrv.listen(0, r));
const tq = { bid: { price: REF, qbtSats: 50e8 }, ask: null, paused: false };
const tpegs = {};
const sanity = async (side, price) => {
  const issues = quoteIssues({ [side]: { price } }, { ref: REF, devPct: 30, maxPrice: 0.001 });
  return issues.length ? { ok: false, msg: `way off (${issues[0].reason})` } : { ok: true };
};
const usd = { toBtc: async (u) => usdToBtcQbt(u, 115000), peg: (side, u) => { if (u == null) delete tpegs[side]; else tpegs[side] = u; } };
const tg = startTelegram({ bot: { handling: new Set(), onEvent: null }, wallet: { balances: async () => ({ btcSats: 0, qbtSats: 0 }) }, quote: tq, sanity, usd, token: "T", chatId: "999", apiBase: `http://127.0.0.1:${tgSrv.address().port}`, log: () => {} });
const flush = async () => { for (let i = 0; i < 40 && inbox.length; i++) await sleep(50); await sleep(150); };
const last = () => sent[sent.length - 1] || "";

push("/ask $0.13"); await flush();
ck(tpegs.ask === 0.13 && Math.abs(tq.ask.price - usdToBtcQbt(0.13, 115000)) < 1e-15, "'/ask $0.13' sets a USD peg and installs the converted BTC/QBT price");
ck(/peg/.test(last()), "confirmation shows it's a peg");
push("/bid 0.12"); await flush();
ck(/🚫/.test(last()) && tq.bid.price === REF, "'/bid 0.12' (USD-magnitude typo) is BLOCKED by the guardrail — quote untouched");
push("/bid 0.12 force"); await flush();
ck(tq.bid.price === 0.12, "'... force' overrides (explicit operator intent)");
push("/bid off"); await flush();
ck(tq.bid === null && !("bid" in tpegs), "'/bid off' drops the side and clears its peg");

tg.stop(); srv.close(); tgSrv.close();
console.log(ok ? "\nPASS — guardrails catch USD-in-BTC-field typos (with or without a reference); USD pegs quote & follow BTCUSD" : "\nFAIL");
process.exit(ok ? 0 : 1);
