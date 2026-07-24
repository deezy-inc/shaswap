// Wallet adapter: the ONLY connection between the bot and your coins. The bot never holds a private key
// or a seed — it asks this adapter for fresh addresses, chain heights, and "send N sats to this HTLC
// address", nothing more. Every HTLC claim/refund is signed IN THE BOT with throwaway per-swap keys it
// generates itself; your wallet's keys never leave your node. So "connecting a wallet" = pointing this
// adapter at a bitcoind + a qbitd whose wallets hold your BTC and QBT inventory.
//
// Backed here by standard Bitcoin-Core-style JSON-RPC (qbitd speaks the same wallet RPC). It only ever
// calls: getblockcount, getnewaddress, getaddressinfo, sendtoaddress — a deliberately tiny surface. Point
// it at YOUR OWN nodes (they need only be on the same network as the coordinator's — they don't have to
// be the same nodes). Run each node with a funded wallet and restrict RPC to the bot's host.
//
//   import { rpcWallet, walletAdapter } from "./wallets.js";
//   const wallet = walletAdapter({
//     btc:  rpcWallet(process.env.BTC_RPC_URL,  process.env.BTC_WALLET  || "maker"),   // http://user:pass@host:8332
//     qbit: rpcWallet(process.env.QBIT_RPC_URL, process.env.QBIT_WALLET || "maker"),   // http://user:pass@host:PORT
//   });
//   new MakerBot({ coordinatorUrl, wallet, policy, makerKey });
import { hexToBytes as bin } from "@noble/hashes/utils.js";

// A JSON-RPC client bound to one node's wallet. `rpcUrl` carries user:pass (http://user:pass@host:port);
// `walletName` is the loaded wallet the funds live in (Core serves it at /wallet/<name>).
export function rpcWallet(rpcUrl, walletName) {
  if (!rpcUrl) throw new Error("rpcWallet: an RPC URL is required (http://user:pass@host:port)");
  const u = new URL(rpcUrl);
  const auth = u.username ? "Basic " + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64") : undefined;
  const endpoint = `${u.protocol}//${u.host}${walletName ? `/wallet/${walletName}` : "/"}`;
  return async function call(method, ...params) {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: "1.0", id: "mm", method, params }),
    });
    const j = await r.json().catch(() => ({ error: { message: `${r.status} ${r.statusText}` } }));
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
}

// A fresh address + its scriptPubKey (the bot needs the spk to build the claim/refund output that pays
// back into this wallet). getaddressinfo works for any address type the wallet produces (incl. qbit p2mr).
async function fresh(call, kind) {
  const address = kind ? await call("getnewaddress", "", kind) : await call("getnewaddress");
  const info = await call("getaddressinfo", address);
  return { address, spk: bin(info.scriptPubKey) };
}
// sats → a Core amount string with 8 dp (avoids float drift). sendtoaddress deposits EXACTLY this into
// the HTLC; the wallet pays the network fee on top from its balance.
const toAmount = (sats) => (sats / 1e8).toFixed(8);

// Spendable balance in sats, UNCONFIRMED-AWARE. The naive read (confirmed only) cripples a maker funded
// with one big UTXO: the first swap spends it and leaves a large unconfirmed CHANGE output, which is
// perfectly spendable — Core relays chained unconfirmed txs up to its mempool-chain policy (default 25
// ancestors / 101 kvB ancestor size; exceeding it = "too-long-mempool-chain"). So we count an
// unconfirmed UTXO as available iff its mempool ancestor chain leaves headroom for one more link,
// with a safety margin under the policy caps (MAKER_MAX_ANCESTORS, default 20; ~80 kvB size guard).
// Confirmed UTXOs always count. A wallet that can't answer getmempoolentry just skips that UTXO.
const MAX_ANC = Number(process.env.MAKER_MAX_ANCESTORS || 20);        // < Core's 25-ancestor default
const MAX_ANC_KVB = Number(process.env.MAKER_MAX_ANCESTOR_KVB || 80); // < Core's 101 kvB default
async function spendable(call) {
  const utxos = await call("listunspent", 0, 9999999);
  let sats = 0;
  const seen = new Map();   // txid -> mempool entry (many change outputs share a funding tx)
  for (const u of utxos) {
    if (u.spendable === false) continue;                              // watch-only / unsolvable
    const v = Math.round(u.amount * 1e8);
    if (u.confirmations > 0) { sats += v; continue; }
    try {
      const e = seen.get(u.txid) || (seen.set(u.txid, await call("getmempoolentry", u.txid)), seen.get(u.txid));
      const sizeKvb = ((e.ancestorsize ?? e["ancestorsize"] ?? 0) / 1000);
      if (e.ancestorcount < MAX_ANC && sizeKvb < MAX_ANC_KVB) sats += v;   // room for one more chained spend
    } catch { /* evicted/foreign-unindexed — don't count what we can't verify */ }
  }
  return sats;
}

// ── ancestor-aware (package) fee selection ───────────────────────────────────────────────────────
// When a funding tx spends unconfirmed change, miners judge it by the whole ancestor PACKAGE's feerate,
// not the child's own — so a child paying "next-block" on its own vsize still stalls if low-fee
// ancestors drag the package under the target (and in a rising market, old ancestors always do). After
// sending, read the chain's real economics from getmempoolentry (fees.ancestor / ancestorsize INCLUDE
// the child) and, if the package rate is short of next-block, RBF-bump the child so its fee covers the
// whole chain's deficit:  childFee' = ceil(target × ancestorSize) − (ancestorFees − childFee).
// Capped at MAKER_MAX_FEERATE (default 500 sat/vB) so a weird mempool can't drain the wallet; any
// failure (no mempool entry — confirmed parents; bumpfee unavailable) keeps the original tx. An RBF'd
// funding gets a new txid, which is fine: the coordinator re-derives an unconfirmed deposit from
// findOutput each poll, tracking replacements.
const MAX_FEERATE = Number(process.env.MAKER_MAX_FEERATE || 500);   // sat/vB cap on the bumped child
async function nextBlockRate(call) {
  try {
    const r = await call("estimatesmartfee", 2, "CONSERVATIVE");     // BTC/kvB → sat/vB
    if (r?.feerate > 0) return Math.max(1, Math.ceil(r.feerate * 1e5));
  } catch { /* estimator cold */ }
  return 1;                                                          // uncongested / regtest floor
}
async function fundPackageAware(call, address, sats) {
  const txid = await call("sendtoaddress", address, toAmount(sats));
  try {
    const e = await call("getmempoolentry", txid);                   // throws if it confirmed instantly / all-confirmed parents edge
    if (!(e?.ancestorcount > 1)) return txid;                        // no unconfirmed ancestors → child-only economics are correct
    const target = await nextBlockRate(call);
    const S = e.ancestorsize, F = Math.round(e.fees.ancestor * 1e8); // whole-chain vsize + fees (child included)
    if (F >= target * S) return txid;                                // package already clears next-block
    const childFee = Math.round(e.fees.base * 1e8);
    const neededChild = Math.ceil(target * S) - (F - childFee);      // child absorbs the ancestors' deficit
    const rate = Math.min(MAX_FEERATE, Math.max(1, Math.ceil(neededChild / e.vsize)));
    const b = await call("bumpfee", txid, { fee_rate: rate });
    return b?.txid || txid;
  } catch { return txid; }                                           // best-effort: never fail the funding over the bump
}

// Assemble the six-method adapter the bot expects from two node clients.
export function walletAdapter({ btc, qbit, btcAddrType = "bech32" }) {
  return {
    btcHeight:  () => btc("getblockcount"),
    qbitHeight: () => qbit("getblockcount"),
    newBtc:     () => fresh(btc, btcAddrType),   // segwit v0 receive/refund sink
    newQbit:    () => fresh(qbit, null),          // qbitd's default (post-quantum) address type
    fundBtc:  (address, sats) => fundPackageAware(btc, address, sats),
    fundQbit: (address, sats) => fundPackageAware(qbit, address, sats),
    // Live spendable inventory — serveRfq sizes each quote to this (minus in-flight + your keep-back).
    balances: async () => { const [btcSats, qbtSats] = await Promise.all([spendable(btc), spendable(qbit)]); return { btcSats, qbtSats }; },
  };
}
