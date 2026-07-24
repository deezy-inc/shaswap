// Reference runner: connect your BTC + QBT wallets and stream a two-sided RFQ quote to the coordinator.
// Configure via env, then `node run.js`. This is the whole "how do I run a maker" — the wallet adapter
// (wallets.js) is the only place your nodes are touched; the bot signs everything else with throwaway keys.
//
//   COORDINATOR_URL   the coordinator base URL (e.g. https://qbitswap.com/coord)
//   MAKER_KEY         your RFQ key — must match one entry in the coordinator's RFQ_MAKER_KEYS
//   BTC_RPC_URL       http://user:pass@btc-node:8332     (+ BTC_WALLET,  default "maker")
//   QBIT_RPC_URL      http://user:pass@qbit-node:PORT    (+ QBIT_WALLET, default "maker")
//   MID / SPREAD / SIZE_QBT   quote: bid=MID·(1−SPREAD), ask=MID·(1+SPREAD), SIZE_QBT per side (in QBT)
//   MIN_RATE / MAX_QBT        policy floor + per-swap size cap (used by the order-book/link paths)
import { MakerBot } from "./maker-bot.js";
import { rpcWallet, walletAdapter } from "./wallets.js";

const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };
const num = (k, d) => (process.env[k] != null ? Number(process.env[k]) : d);

const wallet = walletAdapter({
  btc:  rpcWallet(need("BTC_RPC_URL"),  process.env.BTC_WALLET  || "maker"),
  qbit: rpcWallet(need("QBIT_RPC_URL"), process.env.QBIT_WALLET || "maker"),
});

const bot = new MakerBot({
  coordinatorUrl: need("COORDINATOR_URL"),
  makerKey: need("MAKER_KEY"),
  wallet,
  policy: { minRate: num("MIN_RATE", 0.15), maxQbtSats: Math.round(num("MAX_QBT", 100) * 1e8) },
});

// Sanity-check the wallet connection up front (fail fast if a node/RPC is misconfigured).
const [bh, qh] = await Promise.all([wallet.btcHeight(), wallet.qbitHeight()]);
console.log(`[run] connected — BTC h${bh}, QBT h${qh}`);

const MID = num("MID", 0.20), SPREAD = num("SPREAD", 0.05), SIZE = Math.round(num("SIZE_QBT", 50) * 1e8);
await bot.serveRfq({
  quote: {
    bid: { price: MID * (1 - SPREAD), qbtSats: SIZE },   // it BUYS QBT (retail sells) — funds BTC up front
    ask: { price: MID * (1 + SPREAD), qbtSats: SIZE },   // it SELLS QBT (retail buys)
  },
  pingMs: num("PING_MS", 10000),   // well inside the 30s quote TTL; lower it if you re-price faster
});
