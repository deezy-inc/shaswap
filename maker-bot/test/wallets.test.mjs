// Unconfirmed-aware spendable balance: confirmed UTXOs always count; an unconfirmed one counts iff its
// mempool ancestor chain leaves headroom (ancestorcount < 20, ancestorsize < 80 kvB by default) so the
// next chained spend can't hit Core's "too-long-mempool-chain" (25 / 101 kvB policy). Also checks the
// RPC wiring (auth, /wallet/ path) via a fake Core server.  Run:  node test/wallets.test.mjs
import http from "node:http";
import { rpcWallet, walletAdapter } from "../wallets.js";

let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };

// Fake Core: one wallet, a mix of UTXOs, per-txid mempool entries.
const UTXOS = [
  { txid: "conf1", vout: 0, amount: 1.0, confirmations: 3, spendable: true },     // confirmed → counts
  { txid: "chg1", vout: 1, amount: 0.5, confirmations: 0, spendable: true },      // unconfirmed change, shallow chain → counts
  { txid: "deep1", vout: 0, amount: 0.25, confirmations: 0, spendable: true },    // ancestor chain at the cap → NOT counted
  { txid: "big1", vout: 0, amount: 0.2, confirmations: 0, spendable: true },      // ancestor SIZE too large → NOT counted
  { txid: "watch", vout: 0, amount: 9.9, confirmations: 5, spendable: false },    // watch-only → never
  { txid: "gone1", vout: 0, amount: 0.1, confirmations: 0, spendable: true },     // no mempool entry → not counted
];
const ENTRIES = {
  chg1: { ancestorcount: 2, ancestorsize: 700 },
  deep1: { ancestorcount: 20, ancestorsize: 9000 },     // == MAX_ANC → no headroom
  big1: { ancestorcount: 3, ancestorsize: 85_000 },     // 85 kvB ≥ 80 kvB guard
};
let mempoolCalls = 0;
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const { method, params } = JSON.parse(b);
    const R = (result) => res.end(JSON.stringify({ result, error: null }));
    if (method === "listunspent") return R(UTXOS);
    if (method === "getmempoolentry") { mempoolCalls++; const e = ENTRIES[params[0]]; return e ? R(e) : res.end(JSON.stringify({ error: { message: "Transaction not in mempool" } })); }
    if (method === "getblockcount") return R(100);
    res.end(JSON.stringify({ error: { message: "unknown " + method } }));
  });
});
await new Promise((r) => srv.listen(0, r));
const call = rpcWallet(`http://u:p@127.0.0.1:${srv.address().port}`, "maker");
const w = walletAdapter({ btc: call, qbit: call });

const { btcSats } = await w.balances();
// counted: conf1 (1.0) + chg1 (0.5) = 1.5 BTC; deep1/big1/watch/gone1 excluded.
ck(btcSats === 150_000_000, `spendable = confirmed + safe-chain unconfirmed only (${btcSats / 1e8} BTC, expected 1.5)`);
ck(mempoolCalls >= 4, "each unconfirmed txid's mempool entry was checked");

// A maker funded with ONE big UTXO that just funded a swap: only unconfirmed change remains, chain depth
// 1 → the bot can keep quoting (this is the case the naive confirmed-only read gets wrong).
UTXOS.length = 0; UTXOS.push({ txid: "chg1", vout: 0, amount: 4.2, confirmations: 0, spendable: true });
ENTRIES.chg1 = { ancestorcount: 1, ancestorsize: 300 };
ck((await w.balances()).btcSats === 420_000_000, "single unconfirmed change output still fully quotable (the big-UTXO-just-spent case)");

// After 20 chained spends the chain is at the margin → balance drops to 0 until a block confirms.
ENTRIES.chg1 = { ancestorcount: 20, ancestorsize: 30_000 };
ck((await w.balances()).btcSats === 0, "at the ancestor-count margin the UTXO stops counting (avoids too-long-mempool-chain)");

srv.close();
console.log(ok ? "\nPASS — spendable balance chains unconfirmed change safely up to the mempool limits" : "\nFAIL");
process.exit(ok ? 0 : 1);
