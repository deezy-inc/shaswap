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
// Spendable balance in sats — Core's getbalances().mine.trusted (confirmed + own unconfirmed change),
// which is what's actually available to fund a swap right now.
const spendable = async (call) => Math.round(((await call("getbalances"))?.mine?.trusted || 0) * 1e8);

// Assemble the six-method adapter the bot expects from two node clients.
export function walletAdapter({ btc, qbit, btcAddrType = "bech32" }) {
  return {
    btcHeight:  () => btc("getblockcount"),
    qbitHeight: () => qbit("getblockcount"),
    newBtc:     () => fresh(btc, btcAddrType),   // segwit v0 receive/refund sink
    newQbit:    () => fresh(qbit, null),          // qbitd's default (post-quantum) address type
    fundBtc:  (address, sats) => btc("sendtoaddress", address, toAmount(sats)),
    fundQbit: (address, sats) => qbit("sendtoaddress", address, toAmount(sats)),
    // Live spendable inventory — serveRfq sizes each quote to this (minus in-flight + your keep-back).
    balances: async () => { const [btcSats, qbtSats] = await Promise.all([spendable(btc), spendable(qbit)]); return { btcSats, qbtSats }; },
  };
}
