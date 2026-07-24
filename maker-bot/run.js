// One-command maker runner: connect your BTC + QBT wallets and stream a fixed two-sided quote.
//
//   node run.js --bid 0.19 --ask 0.21 --size 50
//
// Prices are BTC per QBT (fixed until you change them — via flags, or live from the Telegram bot);
// --size is QBT per side (a ceiling: each ping re-sizes down to live spendable inventory, including
// safely-chainable unconfirmed change). Quote one side or both (--ask only → sell-only, --bid only →
// buy-only). Connection/config via flags or env:
//
//   --coordinator URL   (COORDINATOR_URL)   the coordinator base URL, e.g. https://qbitswap.com/coord
//   --key KEY           (MAKER_KEY)         your RFQ maker key (matches the coordinator's RFQ_MAKER_KEYS)
//   --btc-rpc URL       (BTC_RPC_URL)       http://user:pass@btc-node:8332    [+ BTC_WALLET, "maker"]
//   --qbit-rpc URL      (QBIT_RPC_URL)      http://user:pass@qbit-node:PORT   [+ QBIT_WALLET, "maker"]
//   --bid P / --ask P   (BID / ASK)         fixed prices, BTC per QBT
//   --size N            (SIZE_QBT, 50)      QBT quoted per side (ceiling)
//   --ping MS           (PING_MS, 10000)    quote refresh; must stay under the coordinator's 30s TTL
//   --reserve-btc N / --reserve-qbt N       keep-back never quoted (whole coins; default 0)
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   optional: control/monitor Telegram bot (telegram.js)
import { MakerBot } from "./maker-bot.js";
import { rpcWallet, walletAdapter } from "./wallets.js";
import { startTelegram } from "./telegram.js";
import { fileKeystore } from "./keystore.js";

// ── tiny arg parser: --a-b v → args["a-b"]=v; bare --flag → true ─────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const k = a.slice(2);
  args[k] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true;
}
const opt = (flag, env, dflt) => args[flag] ?? process.env[env] ?? dflt;
const num = (flag, env, dflt) => { const v = opt(flag, env, dflt); return v == null ? null : Number(v); };
const die = (msg) => { console.error(`\n${msg}\n\nUsage:  node run.js --bid 0.19 --ask 0.21 --size 50\n        (see the header of run.js for all flags / env vars)\n`); process.exit(1); };

if (args.help || args.h) die("Fixed-price RFQ maker.");

// ── LIGHT MODE: no nodes — one seed phrase (encrypted at rest), public esplora APIs ──────────────
//   node run.js --light --init                    first run: makes + seals the seed, prints it ONCE
//   node run.js --light --bid 0.19 --ask 0.21     runs the maker from the sealed seed
// Env: LIGHT_SEED_FILE (./maker-seed.enc) · LIGHT_PASSWORD (headless) · BTC_ESPLORA / QBIT_ESPLORA
const LIGHT = !!args.light;
const SEED_FILE = opt("seed-file", "LIGHT_SEED_FILE", "./maker-seed.enc");
if (LIGHT && args.init) {
  const { newMnemonic } = await import("./light/hd.js");
  const { sealSeed, promptPassword } = await import("./light/seedstore.js");
  const mnemonic = newMnemonic();
  console.log("\nYour seed phrase (write it down NOW — it is shown exactly once, and it IS the funds):\n");
  console.log(`    ${mnemonic}\n`);
  const p1 = await promptPassword("choose a wallet password (min 8 chars): ");
  const p2 = await promptPassword("repeat it: ");
  if (p1 !== p2) die("passwords don't match — nothing written; run --init again");
  sealSeed(SEED_FILE, mnemonic, p1);
  console.log(`sealed → ${SEED_FILE} (AES-256-GCM, scrypt). Fund the addresses shown on next start.`);
  process.exit(0);
}

const coordinatorUrl = opt("coordinator", "COORDINATOR_URL") || die("missing --coordinator (or COORDINATOR_URL)");
const makerKey = opt("key", "MAKER_KEY") || die("missing --key (or MAKER_KEY)");
const bid = num("bid", "BID", null), ask = num("ask", "ASK", null);
if (bid == null && ask == null) die("set a fixed --bid and/or --ask (BTC per QBT)");
if (bid != null && ask != null && bid >= ask) die(`--bid (${bid}) must be below --ask (${ask})`);
const sizeQbt = num("size", "SIZE_QBT", 50);

let wallet;
if (LIGHT) {
  const { checkMnemonic, mnemonicToSeed } = await import("./light/hd.js");
  const { openSeed, promptPassword } = await import("./light/seedstore.js");
  const { lightWallet } = await import("./light/lightwallet.js");
  const mnemonic = openSeed(SEED_FILE, await promptPassword());
  if (!checkMnemonic(mnemonic)) die("sealed seed is not a valid mnemonic");
  wallet = await lightWallet({
    seed: mnemonicToSeed(mnemonic),
    btcApi: opt("btc-esplora", "BTC_ESPLORA", "https://mempool.space/api"),
    qbitApi: opt("qbit-esplora", "QBIT_ESPLORA", "https://qbitmempool.robertclarke.com/api"),
    btcHrp: process.env.BTC_HRP || "bc", qbitHrp: process.env.QBIT_HRP || "qb",
  });
} else {
  const btcRpc = opt("btc-rpc", "BTC_RPC_URL") || die("missing --btc-rpc (or BTC_RPC_URL) — or use --light");
  const qbitRpc = opt("qbit-rpc", "QBIT_RPC_URL") || die("missing --qbit-rpc (or QBIT_RPC_URL)");
  wallet = walletAdapter({
    btc:  rpcWallet(btcRpc, process.env.BTC_WALLET || "maker"),
    qbit: rpcWallet(qbitRpc, process.env.QBIT_WALLET || "maker"),
  });
}
const keystore = fileKeystore();   // durable per-swap keys (MAKER_KEY_DIR, default ./maker-keys) — crash-safe
const bot = new MakerBot({
  coordinatorUrl, makerKey, wallet, keystore,
  policy: { minRate: num("min-rate", "MIN_RATE", 0.0000001), maxQbtSats: Math.round(num("max-qbt", "MAX_QBT", sizeQbt) * 1e8) },
});

// Sanity-check wallets up front (fail fast on a bad RPC URL / wallet name).
const [bh, qh, bal] = await Promise.all([wallet.btcHeight(), wallet.qbitHeight(), wallet.balances()]);
console.log(`[run] connected — BTC h${bh} (${(bal.btcSats / 1e8).toFixed(8)} spendable), QBT h${qh} (${(bal.qbtSats / 1e8).toFixed(8)} spendable)`);

// The LIVE quote object: serveRfq re-reads it every ping, so mutating it (Telegram /bid /ask /size,
// /pause) takes effect on the next ping. Sides are ceilings; inventory sizing trims them per ping.
const quote = {
  bid: bid != null ? { price: bid, qbtSats: Math.round(sizeQbt * 1e8) } : null,
  ask: ask != null ? { price: ask, qbtSats: Math.round(sizeQbt * 1e8) } : null,
};
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
  startTelegram({ bot, wallet, quote, token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID });

const resumed = await bot.resumePending();   // pick up any swaps a previous run left mid-flight
if (resumed) console.log(`[run] resumed ${resumed} in-flight swap(s) from ${keystore.dir}`);

console.log(`[run] quoting ${quote.bid ? `bid ${quote.bid.price}` : "(no bid)"} / ${quote.ask ? `ask ${quote.ask.price}` : "(no ask)"} BTC/QBT · ${sizeQbt} QBT per side`);
await bot.serveRfq({
  quote,
  pingMs: num("ping", "PING_MS", 10000),
  reserveBtcSats: Math.round(num("reserve-btc", "RESERVE_BTC", 0) * 1e8),
  reserveQbtSats: Math.round(num("reserve-qbt", "RESERVE_QBT", 0) * 1e8),
});
