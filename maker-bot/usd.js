// USD-pegged quoting. With QBT trading around cents, BTC/QBT prices are ~1e-6 — unreadable, and the
// number people naturally think in is USD per QBT. So the operator can quote in USD (--bid-usd 0.11
// --ask-usd 0.13, or "/bid $0.11" in Telegram) and the bot converts to BTC/QBT via the live BTCUSD rate
// (price_btcqbt = usd_per_qbt / usd_per_btc), re-pricing on an interval so the quote FOLLOWS BTC: a
// USD peg holds your dollar price steady while the BTC-denominated quote drifts with the market.
// BTCUSD comes from CoinGecko (same public source the webapp uses), cached ~2 min; a stale-feed guard
// stops repricing (keeping the last good price and eventually letting the quote expire) rather than
// quoting off a dead rate.
const COINGECKO = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
const CACHE_MS = 120_000, STALE_MS = Number(process.env.USD_FEED_STALE_MS || 900_000);   // refuse pegs on a >15 min-old rate

let cache = { rate: 0, at: 0 };
export async function btcUsd(fetchImpl = fetch, url = process.env.BTCUSD_URL || COINGECKO) {
  if (cache.rate > 0 && Date.now() - cache.at < CACHE_MS) return cache.rate;
  try {
    const j = await (await fetchImpl(url)).json();
    const rate = j?.bitcoin?.usd ?? j?.USD ?? j?.usd;                       // CoinGecko shape, or a simple {usd: N} override feed
    if (rate > 0) cache = { rate, at: Date.now() };
  } catch { /* keep last cached rate */ }
  if (!(cache.rate > 0)) throw new Error("no BTCUSD rate available (feed unreachable and no cache)");
  if (Date.now() - cache.at > STALE_MS) throw new Error("BTCUSD rate is stale — refusing to (re)price USD pegs");
  return cache.rate;
}
export const usdToBtcQbt = (usdPerQbt, btcUsdRate) => usdPerQbt / btcUsdRate;

// Keep USD-pegged sides tracking BTCUSD. `pegs` = { bid?: usd, ask?: usd } (mutable — Telegram edits
// it); each tick recomputes any pegged side's BTC price in place (serveRfq re-reads the quote every
// ping). On a stale/unavailable feed the prices are left as-is and the error is surfaced once.
export function startUsdRepricer({ quote, pegs, intervalMs = Number(process.env.REPRICE_MS || 120_000), log = console.log, fetchImpl = fetch }) {
  let lastErr = "";
  const MAX_DEVIATION = Number(process.env.USDPCT_MAX_DEVIATION || 30);   // %: refuse steps bigger than this off the previous quote
  const tick = async () => {
    if (pegs.bid == null && pegs.ask == null) return;
    try {
      const rate = await btcUsd(fetchImpl);
      for (const side of ["bid", "ask"]) {
        if (pegs[side] == null) continue;
        const price = usdToBtcQbt(pegs[side], rate);
        const size = quote[side]?.qbtSats ?? quote[side === "bid" ? "ask" : "bid"]?.qbtSats ?? 50e8;
        const prev = quote[side]?.price;
        // Bounded step: never move more than MAX_DEVIATION% in one tick, so a bad/ compromised feed
        // can't swing the book in a single bound (the previous price persists until the next tick).
        if (prev > 0) {
          const dev = Math.abs(price - prev) / prev * 100;
          if (dev > MAX_DEVIATION) {
            if (lastErr !== "dev") { log(`[usd] ${side} move ${dev.toFixed(0)}% > cap ${MAX_DEVIATION}% — holding ${prev}`); lastErr = "dev"; }
            continue;
          }
        }
        if (quote[side]?.price !== price) quote[side] = { price, qbtSats: size };
        lastErr = "";
      }
    } catch (e) { if (e.message !== lastErr) { lastErr = e.message; log(`[usd] ${e.message} — holding last prices`); } }
  };
  const timer = setInterval(tick, intervalMs);
  return { tick, stop: () => clearInterval(timer) };
}
