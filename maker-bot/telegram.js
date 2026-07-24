// Telegram control/monitor bot for the maker. Long-polls getUpdates (no deps, no inbound ports) and:
//   · pushes NOTIFICATIONS for every swap the maker participates in (match → funded → completed/
//     refunded/error), via MakerBot's onEvent hook;
//   · answers COMMANDS from the operator: /balances, /quote, /bid, /ask, /size, /pause, /resume,
//     /status, /help. Price/size commands mutate the LIVE quote object run.js passed to serveRfq, so
//     they take effect on the next ping (≤ pingMs).
// SECURITY: only messages from TELEGRAM_CHAT_ID are honored — anyone else who finds the bot gets
// silence. The bot token grants quote control, so treat it like the maker key.
//   Env: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (run.js starts this automatically when both are set).
const fmt = (sats) => (sats / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");

export function startTelegram({ bot, wallet, quote, token, chatId, log = console.log, apiBase = "https://api.telegram.org" }) {
  const api = async (method, body) => {
    const r = await fetch(`${apiBase}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) log(`[tg] ${method} failed: ${j.description || r.status}`);
    return j;
  };
  const send = (text) => api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });

  // ── notifications: every swap the maker takes part in ──────────────────────────────────────────
  const sideWord = (m) => (m.side === "ask" ? "sold" : "bought");
  bot.onEvent = (type, d) => {
    const id = `<code>${(d.swapId || "").slice(0, 10)}</code>`;
    if (type === "match") send(`🤝 Matched ${id}: retail ${d.side === "ask" ? "buys" : "sells"} ${fmt(d.qbtSats)} QBT @ ${d.price} — fulfilling as ${d.role}`);
    else if (type === "funded") send(`💰 Funded ${d.leg.toUpperCase()} leg of ${id} (${fmt(d.sats)} ${d.leg === "btc" ? "BTC" : "QBT"})`);
    else if (type === "completed") send(`✅ Swap ${id} COMPLETE — ${sideWord(d)} ${fmt(d.qbtSats)} QBT @ ${d.price}`);
    else if (type === "refunded") send(`↩️ Swap ${id} refunded — taker walked; funds recovered`);
    else if (type === "error") send(`⚠️ Swap ${id} error: ${d.error}`);
  };

  // ── commands ───────────────────────────────────────────────────────────────────────────────────
  const sideLine = (s) => (s ? `${s.price} × ${fmt(s.qbtSats)} QBT` : "—");
  const quoteText = () => `Quote${quote.paused ? " (PAUSED)" : ""}:\n  bid ${sideLine(quote.bid)}\n  ask ${sideLine(quote.ask)}`;
  const setSide = (side, arg) => {
    const p = Number(arg);
    if (!(p > 0)) return `usage: /${side} &lt;price BTC/QBT&gt; (or /${side} off)`;
    const size = quote[side]?.qbtSats ?? quote[side === "bid" ? "ask" : "bid"]?.qbtSats ?? 50e8;
    quote[side] = { price: p, qbtSats: size };
    return `ok — ${side} → ${p}\n\n${quoteText()}`;
  };
  const handlers = {
    help: () => "Commands:\n/balances — spendable BTC + QBT\n/quote — current bid/ask/size\n/bid &lt;p&gt; · /ask &lt;p&gt; — set a price (or 'off' to drop the side)\n/size &lt;qbt&gt; — set per-side size\n/pause · /resume — stop/restart quoting\n/status — in-flight swaps",
    balances: async () => { const b = await wallet.balances(); return `Spendable (incl. safe unconfirmed):\n  ${fmt(b.btcSats)} BTC\n  ${fmt(b.qbtSats)} QBT`; },
    quote: () => quoteText(),
    bid: (arg) => (arg === "off" ? ((quote.bid = null), `ok — bid off\n\n${quoteText()}`) : setSide("bid", arg)),
    ask: (arg) => (arg === "off" ? ((quote.ask = null), `ok — ask off\n\n${quoteText()}`) : setSide("ask", arg)),
    size: (arg) => {
      const q = Number(arg);
      if (!(q > 0)) return "usage: /size &lt;QBT per side&gt;";
      for (const s of ["bid", "ask"]) if (quote[s]) quote[s].qbtSats = Math.round(q * 1e8);
      return `ok — size → ${q} QBT per side\n\n${quoteText()}`;
    },
    pause: () => { quote.paused = true; return "⏸ paused — quote will expire from the book within the TTL (~30s); in-flight swaps continue"; },
    resume: () => { quote.paused = false; return `▶️ resumed\n\n${quoteText()}`; },
    status: () => {
      const ids = [...bot.handling];
      return ids.length ? `In-flight (${ids.length}):\n` + ids.map((id) => `  <code>${id.slice(0, 10)}</code>`).join("\n") : "No swaps in flight.";
    },
  };
  async function onMessage(msg) {
    if (String(msg.chat?.id) !== String(chatId)) return;              // operator only — silence for anyone else
    const [cmd, ...rest] = (msg.text || "").trim().split(/\s+/);
    const h = handlers[cmd.replace(/^\//, "").replace(/@.*$/, "")];
    if (!h) return;
    try { await send(await h(rest.join(" "))); } catch (e) { await send(`⚠️ ${e.message}`); }
  }

  // ── long-poll loop ─────────────────────────────────────────────────────────────────────────────
  let stopped = false, offset = 0;
  (async () => {
    log("[tg] maker Telegram bot up");
    while (!stopped) {
      try {
        const r = await api("getUpdates", { timeout: 25, offset, allowed_updates: ["message"] });
        for (const u of r.result || []) { offset = u.update_id + 1; if (u.message) await onMessage(u.message); }
      } catch { await new Promise((s) => setTimeout(s, 3000)); }      // network blip — back off briefly
    }
  })();
  return { stop: () => { stopped = true; bot.onEvent = null; } };
}
