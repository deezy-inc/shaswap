// Light mode: one seed → both chains (hardened/domain-separated), seed sealed at rest, and a node-less
// wallet against a MOCK esplora — balances with own-chain depth limits, real signed P2WPKH + p2mr
// funding txs (BTC sig verified by deterministic re-sign), and ancestor-aware package pricing at build
// time.  Run:  node test/light.test.mjs
import http from "node:http";
import { rmSync } from "node:fs";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { parseTx, bip143Sighash, ecdsaSign, addressToScriptPubKey, leafHash } from "@qbit-swap/client";
import { newMnemonic, checkMnemonic, mnemonicToSeed, btcKey, qbitKey } from "../light/hd.js";
import { sealSeed, openSeed } from "../light/seedstore.js";
import { lightWallet } from "../light/lightwallet.js";

let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };

// ── hd.js: determinism + branch separation ───────────────────────────────────────────────────────
const mnemonic = newMnemonic();
ck(mnemonic.split(" ").length === 12 && checkMnemonic(mnemonic), "generated a valid 12-word mnemonic");
const seed = mnemonicToSeed(mnemonic);
const b0 = btcKey(seed, 0, "bcrt"), b0again = btcKey(seed, 0, "bcrt"), b1 = btcKey(seed, 1, "bcrt");
ck(hex(b0.priv) === hex(b0again.priv) && b0.address === b0again.address, "BTC derivation is deterministic from the phrase");
ck(hex(b0.priv) !== hex(b1.priv), "distinct BTC indices → distinct keys");
ck(b0.address.startsWith("bcrt1q") && hex(addressToScriptPubKey(b0.address)) === hex(b0.spk), "BIP84 P2WPKH address round-trips to its spk");
const q0 = await qbitKey(seed, 0, "qbrt"), q0again = await qbitKey(seed, 0, "qbrt");
ck(hex(q0.sk) === hex(q0again.sk) && q0.address === q0again.address, "QBT SLH-DSA derivation is deterministic from the same phrase");
ck(q0.address.startsWith("qbrt1") && hex(q0.spk) === hex(new Uint8Array([0x52, 0x20, ...leafHash(q0.leaf)])), "p2mr pk-leaf address/spk consistent");
ck(hex(b0.priv).length === 64 && hex(q0.sk) !== hex(b0.priv), "branches are domain-separated (no shared key material)");

// ── seedstore: seal / open / wrong password ──────────────────────────────────────────────────────
const SF = new URL("./_seed_test.enc", import.meta.url).pathname;
rmSync(SF, { force: true });
sealSeed(SF, mnemonic, "correct horse battery");
ck(openSeed(SF, "correct horse battery") === mnemonic, "sealed seed opens with the right password");
let bad; try { openSeed(SF, "wrong password!"); } catch (e) { bad = e; }
ck(/wrong password/.test(bad?.message), "wrong password fails loudly (GCM auth), never yields garbage keys");
let short; try { sealSeed(SF, mnemonic, "short"); } catch (e) { short = e; }
ck(/at least 8/.test(short?.message), "weak password rejected");
rmSync(SF, { force: true });

// ── mock esplora (both chains served by one server, split by path prefix) ────────────────────────
const state = { btcUtxos: [], qbtUtxos: [], txs: [], fees: { fastestFee: 10 } };
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const p = req.url;
    if (p.endsWith("/blocks/tip/height")) return res.end("100");
    if (p.includes("/v1/fees/recommended")) return res.end(JSON.stringify(state.fees));
    if (p.includes("/address/") && p.endsWith("/utxo")) return res.end(JSON.stringify(p.includes("/btc/") ? state.btcUtxos : state.qbtUtxos));
    if (p.endsWith("/tx") && req.method === "POST") { state.txs.push(b); return res.end("dd" + state.txs.length.toString(16).padStart(62, "0")); }
    res.statusCode = 404; res.end("nf");
  });
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}`;
const w = await lightWallet({ seed, btcApi: `${base}/btc`, qbitApi: `${base}/qbt`, btcHrp: "bcrt", qbitHrp: "qbrt", log: () => {} });

// balances: confirmed + fresh unconfirmed count; foreign unconfirmed = depth 1
state.btcUtxos = [
  { txid: "aa".repeat(32), vout: 0, value: 50_000_000, status: { confirmed: true } },
  { txid: "bb".repeat(32), vout: 1, value: 10_000_000, status: { confirmed: false } },
];
ck((await w.balances()).btcSats === 60_000_000, "balances: confirmed + shallow unconfirmed both spendable");

// fundBtc: builds a real signed P2WPKH tx — outputs, change to our own address, RBF sequence, valid sig
const dest = btcKey(seed, 7, "bcrt").address;   // any valid bech32 target
const txid1 = await w.fundBtc(dest, 30_000_000);
ck(/^dd[0-9a-f]{62}$/.test(txid1), "fundBtc broadcast and returned the txid");
const t1 = parseTx(state.txs[0]);
ck(hex(t1.vout[0][1]) === hex(addressToScriptPubKey(dest)) && Number(t1.vout[0][0]) === 30_000_000, "output 0 pays the HTLC address the exact amount");
ck(hex(t1.vout[1][1]) === hex(btcKey(seed, 0, "bcrt").spk), "change returns to the wallet's own address");
ck(t1.vin.every((v) => v[3] === 0xfffffffd), "inputs signal RBF");
{ // deterministic re-sign must reproduce the witness signature (proves a correct BIP143 P2WPKH spend)
  const k = btcKey(seed, 0, "bcrt");
  const vinMeta = t1.vin.map((v) => ({ txidLE: v[0], vout: v[1], sequence: v[3] }));
  const voutMeta = t1.vout.map(([value, spk]) => ({ value, spk }));
  const amount = BigInt(50_000_000);              // selected the (largest) confirmed input first
  const sig = ecdsaSign(k.priv, bip143Sighash({ version: 2, vin: vinMeta, vout: voutMeta, inputIndex: 0, scriptCode: k.scriptCode, amount, locktime: 0 }));
  ck(hex(t1.wit[0][0]) === hex(sig) && hex(t1.wit[0][1]) === hex(k.pub), "witness [sig, pub] verifies (deterministic re-sign matches)");
}

// own-chain depth: the change from tx1 is depth 1; spending it makes a depth-2 tx; at the cap it stops
state.btcUtxos = [{ txid: txid1, vout: 1, value: Number(t1.vout[1][0]), status: { confirmed: false } }];
ck(w._debug.depthOf(txid1) === 1, "own broadcast tracked at depth 1");
const txid2 = await w.fundBtc(dest, 1_000_000);
ck(w._debug.depthOf(txid2) === 2, "child of our unconfirmed change tracked at depth 2");
const deep = (d) => "de".repeat(2) + d.toString(16).padStart(60, "e");   // valid-hex synthetic txids
w._debug.pending.set(deep(3), { fee: 1000, vsize: 100, parents: [txid2] });
for (let d = 4; d <= 20; d++) w._debug.pending.set(deep(d), { fee: 1000, vsize: 100, parents: [deep(d - 1)] });
state.btcUtxos = [{ txid: deep(20), vout: 0, value: 5_000_000, status: { confirmed: false } }];
ck((await w.balances()).btcSats === 0, "a UTXO at the chain-depth cap stops being spendable (too-long-mempool-chain guard)");

// package pricing: a cheap unconfirmed ancestor's deficit lands in the child's fee at build time
w._debug.pending.clear();
const cheap = "c".repeat(64);
w._debug.pending.set(cheap, { fee: 100, vsize: 1000, parents: [] });   // 0.1 sat/vB vs 10 target → 9900 deficit
state.btcUtxos = [{ txid: cheap, vout: 0, value: 40_000_000, status: { confirmed: false } }];
const before = state.txs.length;
await w.fundBtc(dest, 10_000_000);
const t3 = parseTx(state.txs[before]);
const paid = 40_000_000 - Number(t3.vout[0][0]) - Number(t3.vout[1][0] ?? 0n);
const childOnly = 10 * (11 + 68 + 31 * t3.vout.length);
ck(paid >= childOnly + 9900 && paid < childOnly + 9900 + 200, `child fee covers its own vsize AND the ancestor's deficit (paid ${paid}, child-only ${childOnly} + deficit 9900)`);

// fundQbit: p2mr pk-leaf spend with the SLH-DSA witness shape [sig, leaf, 0xc1]
state.qbtUtxos = [{ txid: "cc".repeat(32), vout: 0, value: 900_000_000, status: { confirmed: true } }];
const qdest = (await qbitKey(seed, 3, "qbrt")).address;
await w.fundQbit(qdest, 500_000_000);
const qt = parseTx(state.txs[state.txs.length - 1]);
ck(hex(qt.vout[0][1]) === hex(addressToScriptPubKey(qdest)) && Number(qt.vout[0][0]) === 500_000_000, "QBT output pays the target p2mr address exactly");
ck(qt.wit[0].length === 3 && qt.wit[0][0].length > 3000 && hex(qt.wit[0][1]) === hex(q0.leaf) && qt.wit[0][2][0] === 0xc1, "witness is [SLH-DSA sig, pk-leaf, 0xc1] — the single-key p2mr spend");

srv.close();
console.log(ok ? "\nPASS — light mode: one-seed dual-chain HD, sealed seed, node-less signed funding with chain-depth + package-fee smarts" : "\nFAIL");
process.exit(ok ? 0 : 1);
