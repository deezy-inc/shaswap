// In-memory chain stand-in for the coordinator's `qbit`/`btc` adapters, so a full swap can be driven
// end-to-end over the REAL coordinator HTTP API without a live regtest node. It models exactly what the
// coordinator reads: funding detection (findOutput), confirmations (height), spent-detection
// (isUnspent), broadcast (parse → spend inputs, create outputs, keep the witness), and getTx (so the
// coordinator can extract the revealed preimage from a claim's witness). Not a validator — testAccept
// always allows; tx VALIDITY is covered by the client library's own e2e. What this proves is the
// bot↔coordinator protocol: pricing, join, staggered funding, claim-on-reveal, and refund-on-timeout.
import { parseTx, addressToScriptPubKey } from "@qbit-swap/client";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

const rand = (n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; };
const txidOf = (bytes) => hex(sha256(bytes));                       // deterministic id (not a real double-sha, but self-consistent)
const revHex = (leBytes) => hex(Uint8Array.from(leBytes).reverse());

export class MockChain {
  constructor(name) { this.name = name; this.backend = "mock"; this.watch = "scan"; this.height = 1;
    this.utxo = new Map();       // `${txid}:${vout}` -> { txid, vout, spkHex, amountSats, height, spent }
    this.tx = new Map();         // txid -> parsed tx (vin/vout/wit)
    this.addr = new Map();       // address -> spkHex (so the bot can fund by address)
  }
  register(address, spkHex) { this.addr.set(address, spkHex); return this; }
  mine(n = 1) { this.height += n; return this.height; }
  // A wallet "send" to an spk: mint a fresh confirmed UTXO. Returns the funding txid.
  fundSpk(spkHex, amountSats) {
    const txid = txidOf(rand(32)), key = `${txid}:0`;
    this.utxo.set(key, { txid, vout: 0, spkHex, amountSats, height: this.height, spent: false });
    return txid;
  }
  fundAddr(address, amountSats) {
    const spk = this.addr.get(address) || hex(addressToScriptPubKey(address));   // decode any HTLC address → spk (no pre-registration needed)
    return this.fundSpk(spk, amountSats);
  }
  // ── the surface the coordinator calls ──────────────────────────────────────
  async heightFn() { return this.height; }
  async findOutput(spkHex) {
    for (const u of this.utxo.values()) if (u.spkHex === spkHex && !u.spent) return { txid: u.txid, vout: u.vout, amountSats: u.amountSats, height: u.height };
    return null;
  }
  async isUnspent(txid, vout) { const u = this.utxo.get(`${txid}:${vout}`); return !!u && !u.spent; }
  async testAccept() { return { allowed: true }; }
  async broadcast(txHex) {
    const bytes = Uint8Array.from(txHex.match(/../g).map((h) => parseInt(h, 16)));
    const t = parseTx(bytes), txid = txidOf(bytes);
    for (const [prevout, vout] of t.vin) { const k = `${revHex(prevout)}:${vout}`; const u = this.utxo.get(k); if (u) u.spent = true; }
    t.vout.forEach(([value, spk], i) => this.utxo.set(`${txid}:${i}`, { txid, vout: i, spkHex: hex(spk), amountSats: Number(value), height: this.height, spent: false }));
    this.tx.set(txid, t);
    return txid;
  }
  async getTx(txid) {
    const t = this.tx.get(txid);
    if (!t) throw new Error(`mockchain: unknown tx ${txid}`);
    return { vin: t.vin.map((_, i) => ({ txinwitness: (t.wit[i] || []).map(hex) })), vout: t.vout.map(([v, spk]) => ({ value: Number(v), scriptPubKey: { hex: hex(spk) } })), status: { confirmed: true } };
  }
  async confs(fundingHeight) { return this.height - fundingHeight + 1; }
  async confTarget() { return { confs: 2, equivalentBtcConfs: 6, model: { security_per_confirmation: 50, total_observed_hashrate: 1 } }; }
  async pruneWatch() {}
}

// Monkeypatch the coordinator's imported chain singletons in place (they're the same object the swap
// engine closed over), so the running server reads from these mocks.
export function installMocks(qbit, btc) {
  const m = { qbit: new MockChain("qbit"), btc: new MockChain("btc") };
  for (const [leg, real] of [["qbit", qbit], ["btc", btc]]) {
    const mock = m[leg];
    real.backend = "mock"; real.watch = "scan";
    real.height = () => mock.heightFn();
    for (const fn of ["findOutput", "isUnspent", "testAccept", "broadcast", "getTx", "confs", "confTarget", "pruneWatch"]) real[fn] = (...a) => mock[fn](...a);
  }
  return m;
}
