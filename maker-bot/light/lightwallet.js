// Node-less wallet: the same 6-method adapter wallets.js provides, but backed by public esplora APIs
// (mempool.space for BTC; a mempool.space-style instance for QBT) instead of Core RPC. The bot's coins
// live at ONE derived address per chain (BIP84 P2WPKH / SLH-DSA p2mr pk-leaf, both from the single seed
// phrase — see hd.js); this wallet builds, signs, and broadcasts its own funding transactions.
//
// Unconfirmed-chain smarts, without a node: esplora exposes no ancestorcount, but this wallet BUILDS
// every one of its own unconfirmed txs, so it tracks its own spend graph exactly: each pending tx
// records {fee, vsize, parents}. A UTXO is spendable while its chain depth stays under LIGHT_MAX_CHAIN
// (default 20 < Core's 25); and funding fees are ancestor-aware AT BUILD TIME — the child's fee covers
// its own vsize at the next-block rate PLUS every unconfirmed ancestor's shortfall from that rate, so
// the whole package clears next-block even in a rising market (no bumpfee needed: we price it right
// the first time, from a graph we know exactly).
//
// Trade-offs vs the Core adapter (documented for operators): liveness depends on the public APIs, and
// the wallet's addresses/balances are visible to them. Right for small makers; run nodes at size.
import { bytesToHex as hex, hexToBytes as bin } from "@noble/hashes/utils.js";
import { encoding, bip143Sighash, ecdsaSign, serializeSegwit, p2mrSighash, slhDsaSign, serializeTx, P2MR_CONTROL_SINGLE_LEAF, addressToScriptPubKey } from "@qbit-swap/client";
import { btcKey, qbitKey } from "./hd.js";
const { concatBytes } = encoding;

const MAX_CHAIN = Number(process.env.LIGHT_MAX_CHAIN || 20);
// Hard cap on the feerate (sat/vB) used for funding, so a compromised/garbage fee oracle can't drain
// the wallet into miner fees. Mirrors wallets.js's MAKER_MAX_FEERATE on the Core-RPC path.
const LIGHT_MAX_FEERATE = Number(process.env.LIGHT_MAX_FEERATE || 500);
// vsize models: P2WPKH ~68 vB/input, 31/output, 11 overhead. Qbit p2mr pk-spends carry a ~3.6 kB
// SLH-DSA signature with NO witness discount — measured ≈3.9-4.2 kvB per input; be generous.
const BTC_VB = { in: 68, out: 31, base: 11 };
const QBT_VB = { in: 4200, out: 45, base: 12 };

// Minimal esplora client with a politeness throttle + 429/5xx backoff (public APIs rate-limit).
function esplora(base, minIntervalMs = Number(process.env.LIGHT_API_INTERVAL_MS || 250)) {
  let last = 0, chain = Promise.resolve();
  const call = async (path, opts) => {
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, last + minIntervalMs - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const r = await fetch(base + path, opts);
      if (r.ok) return r;
      if ((r.status === 429 || r.status >= 500) && attempt < 4) { await new Promise((s) => setTimeout(s, 1000 * 2 ** attempt)); continue; }
      throw new Error(`${base}${path} → ${r.status} ${await r.text().catch(() => "")}`.trim());
    }
  };
  return (path, opts) => (chain = chain.then(() => call(path, opts)));   // serialize requests per host
}

export async function lightWallet({ seed, btcApi = "https://mempool.space/api", qbitApi = "https://qbitmempool.robertclarke.com/api", btcHrp = "bc", qbitHrp = "qb", log = console.log }) {
  const B = esplora(btcApi), Q = esplora(qbitApi);
  const btc = btcKey(seed, 0, btcHrp);
  const qbit = await qbitKey(seed, 0, qbitHrp);   // one-time WASM keygen
  log(`[light] BTC  ${btc.address}`);
  log(`[light] QBT  ${qbit.address}`);

  // Own unconfirmed-spend graph: txid -> { fee, vsize, parents: [txid...] } (only OUR broadcasts).
  const pending = new Map();
  const spentOutpoints = new Set();               // outpoints consumed by our pending txs (esplora may lag)
  const chainOf = (txid, seen = new Set()) => {   // full own-ancestor set of a pending tx
    if (seen.has(txid) || !pending.has(txid)) return seen;
    seen.add(txid);
    for (const p of pending.get(txid).parents) chainOf(p, seen);
    return seen;
  };
  const depthOf = (txid) => (pending.has(txid) ? chainOf(txid).size : 1);   // foreign unconfirmed = fresh (depth 1)
  // A confirmed input clears its subtree's bookkeeping lazily: on each utxo scan we drop pending entries
  // the API now reports as confirmed.
  const noteConfirmed = (txid) => { if (pending.delete(txid)) for (const k of [...spentOutpoints]) if (k.startsWith(txid + ":")) spentOutpoints.delete(k); };

  async function utxos(api, address) {
    const r = await (await api(`/address/${address}/utxo`)).json();
    for (const u of r) if (u.status?.confirmed) noteConfirmed(u.txid);
    return r.filter((u) => !spentOutpoints.has(`${u.txid}:${u.vout}`))
      .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed, depth: u.status?.confirmed ? 0 : depthOf(u.txid) }));
  }
  const spendableSet = (us) => us.filter((u) => u.confirmed || u.depth < MAX_CHAIN);

  async function btcRate() { try { const f = await (await B("/v1/fees/recommended")).json(); return Math.min(LIGHT_MAX_FEERATE, Math.max(1, Math.ceil(f.fastestFee || 1))); } catch { return Number(process.env.LIGHT_BTC_FEERATE || 2); } }
  async function qbtRate() { try { const f = await (await Q("/v1/fees/recommended")).json(); return Math.min(LIGHT_MAX_FEERATE, Math.max(1, Math.ceil(f.fastestFee || 1))); } catch { return Number(process.env.LIGHT_QBIT_FEERATE || 1); } }

  // Ancestor deficit for a candidate input set at `rate`: every unconfirmed ancestor's shortfall from
  // the target rate (per-tx floor at 0 — a rich ancestor doesn't subsidize a poor one; ≥ package-exact,
  // never under). This is what makes the whole chain next-block even when old links priced a calmer market.
  function ancestorDeficit(inputs, rate) {
    const anc = new Set();
    for (const u of inputs) if (!u.confirmed) chainOf(u.txid, anc);
    let d = 0;
    for (const t of anc) { const p = pending.get(t); if (p) d += Math.max(0, rate * p.vsize - p.fee); }
    return Math.ceil(d);
  }
  // Largest-first coin selection to cover `need` (amount + fee at the running input count).
  function select(us, amountSats, rate, vb) {
    const sorted = [...us].sort((a, b) => b.value - a.value);
    const picked = [];
    let inVal = 0;
    for (const u of sorted) {
      picked.push(u); inVal += u.value;
      const fee = rate * (vb.base + vb.in * picked.length + vb.out * 2) + ancestorDeficit(picked, rate);
      if (inVal >= amountSats + fee) return { picked, fee: Math.ceil(fee), inVal };
    }
    throw new Error(`insufficient spendable funds (need ~${amountSats}, have ${inVal} within chain limits)`);
  }
  const track = (txid, fee, vsize, picked, changeOutpoint) => {
    pending.set(txid, { fee, vsize, parents: picked.filter((u) => !u.confirmed).map((u) => u.txid) });
    for (const u of picked) spentOutpoints.add(`${u.txid}:${u.vout}`);
    void changeOutpoint;
  };

  async function fundBtc(address, sats) {
    const rate = await btcRate();
    const { picked, fee, inVal } = select(spendableSet(await utxos(B, btc.address)), sats, rate, BTC_VB);
    const change = inVal - sats - fee;
    const vin = picked.map((u) => ({ txidLE: bin(u.txid).reverse(), vout: u.vout, sequence: 0xfffffffd }));   // RBF-signaling
    const vout = [{ value: BigInt(sats), spk: addressToScriptPubKey(address) }];
    if (change > 546) vout.push({ value: BigInt(change), spk: btc.spk });                                     // sub-dust change → extra fee
    const wits = picked.map((_, i) => {
      const sig = ecdsaSign(btc.priv, bip143Sighash({ version: 2, vin, vout, inputIndex: i, scriptCode: btc.scriptCode, amount: BigInt(picked[i].value), locktime: 0 }));
      return [sig, btc.pub];
    });
    const txHex = hex(serializeSegwit(2, vin, vout, wits, 0));
    const txid = (await (await B("/tx", { method: "POST", headers: { "content-type": "text/plain" }, body: txHex })).text()).trim();
    track(txid, fee, BTC_VB.base + BTC_VB.in * picked.length + BTC_VB.out * vout.length, picked);
    log(`[light] funded ${sats} sats BTC → ${address.slice(0, 16)}… (${txid.slice(0, 12)}, fee ${fee} @ ${rate} sat/vB${picked.some((u) => !u.confirmed) ? ", package-priced" : ""})`);
    return txid;
  }

  async function fundQbit(address, sats) {
    const rate = await qbtRate();
    const { picked, fee, inVal } = select(spendableSet(await utxos(Q, qbit.address)), sats, rate, QBT_VB);
    const change = inVal - sats - fee;
    const vinMeta = picked.map((u) => ({ txidLE: bin(u.txid).reverse(), vout: u.vout, sequence: 0xfffffffd }));
    const vout = [{ value: sats, spk: addressToScriptPubKey(address) }];
    if (change > 1000) vout.push({ value: change, spk: qbit.spk });
    const spentOutputs = picked.map((u) => ({ amount: u.value, spk: qbit.spk }));
    const wits = [];
    for (let i = 0; i < picked.length; i++) {
      const sh = p2mrSighash({ version: 2, locktime: 0, vin: vinMeta, spentOutputs, vout, inputIndex: i, leafScript: qbit.leaf });
      wits.push([await slhDsaSign(qbit.sk, sh), qbit.leaf, P2MR_CONTROL_SINGLE_LEAF]);   // pk-leaf spend: [sig, leaf, 0xc1]
    }
    const txHex = hex(serializeTx({ version: 2, vin: vinMeta.map((v) => [v.txidLE, v.vout, new Uint8Array(0), v.sequence]), vout: vout.map((o) => [BigInt(o.value), o.spk]), wit: wits, locktime: 0 }));
    const txid = (await (await Q("/tx", { method: "POST", headers: { "content-type": "text/plain" }, body: txHex })).text()).trim();
    track(txid, fee, QBT_VB.base + QBT_VB.in * picked.length + QBT_VB.out * vout.length, picked);
    log(`[light] funded ${sats} sats QBT → ${address.slice(0, 16)}… (${txid.slice(0, 12)}, fee ${fee})`);
    return txid;
  }

  return {
    kind: "light",
    addresses: { btc: btc.address, qbit: qbit.address },
    btcHeight:  async () => Number(await (await B("/blocks/tip/height")).text()),
    qbitHeight: async () => Number(await (await Q("/blocks/tip/height")).text()),
    // Claim/refund sinks: the wallet's own (single) addresses — every swap pays back into the seed.
    newBtc:  async () => ({ address: btc.address, spk: btc.spk }),
    newQbit: async () => ({ address: qbit.address, spk: qbit.spk }),
    fundBtc, fundQbit,
    balances: async () => {
      const [b, q] = await Promise.all([utxos(B, btc.address), utxos(Q, qbit.address)]);
      const sum = (us) => spendableSet(us).reduce((n, u) => n + u.value, 0);
      return { btcSats: sum(b), qbtSats: sum(q) };
    },
    _debug: { pending, depthOf },   // test seam
  };
}
