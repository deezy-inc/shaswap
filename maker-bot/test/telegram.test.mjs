// Telegram control bot: commands from the AUTHORIZED chat mutate the live quote (picked up by the next
// serveRfq ping), unauthorized chats are ignored, and MakerBot events become notifications. Runs against
// a fake Telegram API (getUpdates queue + sendMessage capture) via the apiBase hook — no network.
//   Run:  node test/telegram.test.mjs
import http from "node:http";
import { startTelegram } from "../telegram.js";

let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fake Telegram API ────────────────────────────────────────────────────────────────────────────
const inbox = [];          // updates waiting for getUpdates
const sent = [];           // texts the bot sent
let updateId = 1;
const push = (chatId, text) => inbox.push({ update_id: updateId++, message: { chat: { id: chatId }, text } });
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const body = JSON.parse(b || "{}");
    if (req.url.endsWith("/getUpdates")) { const out = inbox.filter((u) => u.update_id >= (body.offset || 0)); inbox.length = 0; return res.end(JSON.stringify({ ok: true, result: out })); }
    if (req.url.endsWith("/sendMessage")) { sent.push(body.text); return res.end(JSON.stringify({ ok: true, result: {} })); }
    res.end(JSON.stringify({ ok: true, result: [] }));
  });
});
await new Promise((r) => srv.listen(0, r));

// ── a stub bot + wallet + live quote (what run.js wires up) ──────────────────────────────────────
const bot = { handling: new Set(["swapAAAA1111", "swapBBBB2222"]), onEvent: null };
const wallet = { balances: async () => ({ btcSats: 123_450_000, qbtSats: 5_000_000_000 }) };
const quote = { bid: { price: 0.19, qbtSats: 50e8 }, ask: { price: 0.21, qbtSats: 50e8 } };
const tg = startTelegram({ bot, wallet, quote, token: "T", chatId: "777", apiBase: `http://127.0.0.1:${srv.address().port}`, log: () => {} });
const flush = async () => { for (let i = 0; i < 40 && inbox.length; i++) await sleep(50); await sleep(150); };
const lastSent = () => sent[sent.length - 1] || "";

// commands from the operator chat
push("777", "/balances"); await flush();
ck(/1\.2345 BTC/.test(lastSent()) && /50 QBT/.test(lastSent()), "/balances reports spendable BTC + QBT");

push("777", "/bid 0.185"); await flush();
ck(quote.bid.price === 0.185 && quote.bid.qbtSats === 50e8, "/bid mutates the LIVE quote (price changed, size kept)");

push("777", "/size 25"); await flush();
ck(quote.bid.qbtSats === 25e8 && quote.ask.qbtSats === 25e8, "/size resizes both sides");

push("777", "/ask off"); await flush();
ck(quote.ask === null, "/ask off drops the ask side");
push("777", "/ask 0.22"); await flush();
ck(quote.ask?.price === 0.22 && quote.ask.qbtSats === 25e8, "/ask restores the side (inheriting the bid's size)");

push("777", "/pause"); await flush();
ck(quote.paused === true, "/pause sets the flag serveRfq honors (quote expires from the book)");
push("777", "/resume"); await flush();
ck(quote.paused === false, "/resume clears it");

push("777", "/status"); await flush();
ck(/In-flight \(2\)/.test(lastSent()) && /swapAAAA11/.test(lastSent()), "/status lists in-flight swaps");

// an UNAUTHORIZED chat is silently ignored — no reply, no quote change
const sentBefore = sent.length;
push("666", "/bid 0.01"); await flush();
ck(quote.bid.price === 0.185 && sent.length === sentBefore, "commands from a non-operator chat are ignored (no reply, no mutation)");

// MakerBot events → notifications
bot.onEvent("match", { swapId: "swapCCCC3333", side: "ask", qbtSats: 1e8, price: 0.21, role: "bob" }); await sleep(150);
ck(/Matched/.test(lastSent()) && /retail buys/.test(lastSent()), "match event pushes a 🤝 notification");
bot.onEvent("completed", { swapId: "swapCCCC3333", side: "ask", qbtSats: 1e8, price: 0.21 }); await sleep(150);
ck(/COMPLETE/.test(lastSent()) && /sold 1 QBT/.test(lastSent()), "completed event pushes a ✅ notification");
bot.onEvent("error", { swapId: "swapDDDD4444", error: "fund error: boom" }); await sleep(150);
ck(/⚠️/.test(lastSent()) && /boom/.test(lastSent()), "error event pushes a ⚠️ notification");

tg.stop(); srv.close();
console.log(ok ? "\nPASS — Telegram bot: authorized control of the live quote + full swap notifications" : "\nFAIL");
process.exit(ok ? 0 : 1);
