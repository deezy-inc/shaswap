// Keyless chain adapter for the coordinator: watch (funding), confirmations, spent-detection,
// broadcast — no wallet, no keys. Each chain picks a backend independently via env:
//
//   <CHAIN>_BACKEND = "dev" | "rpc" | "esplora"   (falls back to COORD_CHAIN, then "dev")
//
//   dev      — shells to a node CLI (optionally over ssh). Set <CHAIN>_CLI and, to run remotely,
//              <CHAIN>_SSH_HOST. This is the local-lab transport; no hostnames are baked in.
//   rpc      — direct JSON-RPC over HTTP. Set <CHAIN>_RPC_URL (e.g. http://user:pass@host:port).
//   esplora  — mempool.space / Esplora REST API (BTC leg only; no own Bitcoin node needed). Set
//              ESPLORA_URL (default https://mempool.space/api). Includes rate-limit handling.
//
// The "esplora" backend is the mempool.space/Esplora REST client (BTC only), so the coordinator runs the
// QBT leg as "dev" or "rpc" against a qbitd — which also serves the reorg-safe confirmation gate
// (getconfirmationtarget), a qbitd RPC. (This is about the coordinator's own data source; it says nothing
// about how broadcastable QBT is — like BTC, anyone can relay a QBT tx to a public node.)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
const pexec = promisify(execFile);

const env = (k, d) => process.env[k] ?? d;
// Second-slot env names follow the ACTIVE preset: under CHAIN2=bip110 the canonical names are
// BIP110_BACKEND / BIP110_RPC_URL / BIP110_WATCH / BIP110_WATCH_WALLET — the legacy QBIT_* names
// still work as a fallback so the default (qbit) pair and old deployments are untouched.
const slotEnv = (name, suffix, d) => {
  if (name === "qbit" && env("CHAIN2", "qbit") === "bip110" && env(`BIP110_${suffix}`) != null) return env(`BIP110_${suffix}`);
  return env(`${name.toUpperCase()}_${suffix}`, d);
};
const backendOf = (name) => slotEnv(name, "BACKEND", env("COORD_CHAIN", "dev"));
const cliOf = (name) => slotEnv(name, "CLI", `${name === "btc" ? "bitcoin-cli" : "qbit-cli"} -regtest -rpcuser=lab -rpcpassword=lab`);
const sshOf = (name) => slotEnv(name, "SSH_HOST", "");      // empty = run the CLI locally
const rpcUrlOf = (name) => slotEnv(name, "RPC_URL", "");
// Watch-only wallet name, per leg (BTC_WATCH_WALLET / QBIT_WATCH_WALLET / BIP110_WATCH_WALLET),
// falling back to the shared legacy WATCH_WALLET so existing deployments keep working.
const watchWalletOf = (name) => slotEnv(name, "WATCH_WALLET", env("WATCH_WALLET", "qbitswap-watch"));

// ── Esplora REST client with rate-limit handling (shared min-interval + 429/5xx backoff) ──────
const ESPLORA_URL = env("ESPLORA_URL", "https://mempool.space/api").replace(/\/$/, "");
const ESPLORA_MIN_INTERVAL_MS = Number(env("ESPLORA_MIN_INTERVAL_MS", 150));   // ~6.6 req/s ceiling
const ESPLORA_MAX_RETRIES = Number(env("ESPLORA_MAX_RETRIES", 6));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let gate = Promise.resolve();                                                   // serializes + spaces requests
function throttle() { const p = gate.then(() => sleep(ESPLORA_MIN_INTERVAL_MS)); gate = p.catch(() => {}); return p; }
const backoffMs = (attempt, retryAfterSec) => (retryAfterSec ? retryAfterSec * 1000 : Math.min(10000, 300 * 2 ** attempt));
async function esplora(path, opts = {}, attempt = 0) {
  await throttle();
  let res;
  try { res = await fetch(ESPLORA_URL + path, opts); }
  catch (e) { if (attempt < ESPLORA_MAX_RETRIES) { await sleep(backoffMs(attempt)); return esplora(path, opts, attempt + 1); } throw e; }
  if (res.status === 429 || res.status >= 500) {                                // rate limited / transient
    if (attempt < ESPLORA_MAX_RETRIES) { await sleep(backoffMs(attempt, Number(res.headers.get("retry-after")) || 0)); return esplora(path, opts, attempt + 1); }
    throw new Error(`esplora ${res.status} on ${path}`);
  }
  return res;
}
const scripthash = (spkHex) => bytesToHex(sha256(hexToBytes(spkHex)).reverse());   // Esplora address index key

export class Chain {
  // watch method for the rpc backend: "wallet" (watch-only import — mainnet-safe, needed for Bitcoin)
  // or "scan" (scantxoutset — fine on a small UTXO set like Qbit's, and no p2mr-descriptor dependency).
  constructor(name) { this.name = name; this.backend = backendOf(name); this.watch = slotEnv(name, "WATCH", name === "btc" ? "wallet" : "scan"); }

  // ── dev/rpc transport ────────────────────────────────────────────────────────
  async rpc(...args) { return this.backend === "rpc" ? this.#jsonRpc(this.#coerce(args)) : this.#cli(this.#coerce(args)); }
  async rpcWallet(wallet, ...args) { return this.backend === "rpc" ? this.#jsonRpc(this.#coerce(args), wallet) : this.#cli(this.#coerce(args), `-rpcwallet=${wallet}`); }
  #coerce(args) { return args.map((x) => (x === true ? "true" : x === false ? "false" : String(x))); }
  async #cli(a, extra = "") {
    const cmd = `${cliOf(this.name)} ${extra} ` + a.map((x) => `'${x.replace(/'/g, "'\\''")}'`).join(" ");
    const host = sshOf(this.name);
    const { stdout } = host
      ? await pexec("ssh", ["-o", "ConnectTimeout=15", host, cmd], { maxBuffer: 64 << 20 })
      : await pexec("sh", ["-c", cmd], { maxBuffer: 64 << 20 });
    const s = stdout.trim(); try { return JSON.parse(s); } catch { return s; }
  }
  async #jsonRpc(a, wallet) {
    const [method, ...rest] = a;
    const params = rest.map((p) => { try { return JSON.parse(p); } catch { return p; } });
    const u = new URL(rpcUrlOf(this.name));
    const auth = u.username ? "Basic " + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64") : undefined;
    const r = await fetch(`${u.protocol}//${u.host}${wallet ? `/wallet/${wallet}` : "/"}`, {
      method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: "1.0", id: "coord", method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }

  // ── reads (dispatch to esplora when configured) ──────────────────────────────
  // Tip height, cached for a fraction of the watcher tick. The watcher polls EVERY swap each ~2s tick and
  // each poll() reads both chains' heights — uncached that's 2×(active swaps) getblockcount RPCs per
  // tick, all returning the same tip. Cache it briefly so it's ~one RPC per chain per tick regardless of
  // swap count. Blocks are minutes apart, so a sub-second-stale tip is harmless. (dev/mock backends
  // replace height() wholesale, so tests bypass this.)
  async height() {
    const ttl = Number(process.env.HEIGHT_CACHE_MS || 1500);
    if (this._h && Date.now() - this._h.at < ttl) return this._h.v;
    const v = this.backend === "esplora"
      ? Number(await (await esplora("/blocks/tip/height")).text())
      : Number(await this.rpc("getblockcount"));
    this._h = { v, at: Date.now() };
    return v;
  }
  // Locate a confirmed UTXO paying `spkHex`. Returns null until seen. Funding-watch method by backend:
  //   esplora — indexed scripthash lookup (O(1), no scan)
  //   rpc     — a forward-only watch-only wallet (import once with timestamp "now", then listunspent);
  //             this is the mainnet-safe path — NEVER scantxoutset, which rescans the whole UTXO set
  //   dev     — scantxoutset, fine only because regtest's UTXO set is tiny
  async findOutput(spkHex) {
    // Returns the funding output as soon as it is seen — INCLUDING while still in the mempool
    // (`height: null`, unconfirmed). Callers gate on confirmations themselves (the reorg-safe claim
    // gate); reporting the 0-conf deposit lets the UI show "detected in mempool" and the watchtower
    // pre-sign recovery against the (already-known) outpoint.
    if (this.backend === "esplora") {
      const utxos = await (await esplora(`/scripthash/${scripthash(spkHex)}/utxo`)).json();
      const u = (utxos || [])[0];
      return u ? { txid: u.txid, vout: u.vout, amountSats: u.value, height: u.status?.confirmed ? u.status.block_height : null } : null;
    }
    // Watch-only descriptor wallet: import the HTLC scriptPubKey once, then listunspent 0 sees the
    // deposit at 0-conf (mempool) and after it confirms. Works on any backend (rpc over HTTP, dev over
    // the CLI) — the node just needs wallet RPCs available (a watch-only wallet holds no keys, so this
    // is compatible with a keyless node). Preferred for both BTC and QBT; scales with watched addresses,
    // not mempool size.
    if (this.watch === "wallet") {
      let utxos;
      try {
        const wallet = await this.#ensureWatched(spkHex);
        utxos = await this.rpcWallet(wallet, "listunspent", 0, 9999999, "[]", true);   // minconf 0 -> includes mempool
      } catch (e) {
        // Self-heal a wallet that unloaded OUT FROM UNDER the process (a bitcoind restart doesn't
        // reload wallets unless load_on_startup was set): #ensureWatched's per-process latch would
        // otherwise keep trusting a wallet that's gone, failing every poll until a coordinator
        // restart. Drop the latch and reopen — the descriptors persist in the wallet on disk, and
        // watched spks re-import idempotently as each swap's poll comes around.
        if (!/not loaded|does not exist|not found/i.test(String(e.message))) throw e;
        this._watched = null;
        const wallet = await this.#ensureWatched(spkHex);
        utxos = await this.rpcWallet(wallet, "listunspent", 0, 9999999, "[]", true);
      }
      const u = (utxos || []).find((x) => x.scriptPubKey === spkHex);
      if (!u) return null;
      const c = u.confirmations || 0;
      return { txid: u.txid, vout: u.vout, amountSats: Math.round(u.amount * 1e8), height: c > 0 ? (await this.height()) - c + 1 : null };
    }
    // dev, or rpc with watch=scan (e.g. Qbit): scantxoutset — cheap on a small/regtest UTXO set. This
    // sees CONFIRMED outputs only; if nothing is confirmed yet, fall through to a mempool scan so a
    // deposit is still detected at 0-conf. (Qbit's mainnet node runs -disablewallet, so the wallet
    // listunspent path isn't available there — but getrawmempool always is.)
    const scan = await this.rpc("scantxoutset", "start", JSON.stringify([`raw(${spkHex})`]));
    const u = (scan.unspents || [])[0];
    if (u) return { txid: u.txid, vout: u.vout, amountSats: Math.round(u.amount * 1e8), height: u.height };
    return await this.#findInMempool(spkHex);
  }
  // Wallet-free 0-conf detection: look through the mempool for an output paying `spkHex`. Cheap on a
  // young/quiet chain (Qbit); bounded by MEMPOOL_SCAN_CAP so a flooded mempool can't stall a poll.
  async #findInMempool(spkHex) {
    let ids;
    try { ids = await this.rpc("getrawmempool"); } catch { return null; }
    const cap = Number(env("MEMPOOL_SCAN_CAP", 2000));
    for (const txid of (ids || []).slice(0, cap)) {
      let tx;
      try { tx = await this.rpc("getrawtransaction", txid, true); } catch { continue; }   // works for mempool txs w/o txindex
      const vout = (tx.vout || []).findIndex((o) => o.scriptPubKey?.hex === spkHex);
      if (vout >= 0) return { txid, vout, amountSats: Math.round(tx.vout[vout].value * 1e8), height: null };
    }
    return null;
  }
  // Import an HTLC scriptPubKey into a dedicated watch-only wallet, forward-only (no historical rescan
  // — HTLC addresses are fresh). Idempotent per process; safe to call every poll.
  async #ensureWatched(spkHex) {
    if (!this._watched) { this._watchWallet = watchWalletOf(this.name); this._watched = new Set(); await this.#openWallet(this._watchWallet); }
    if (this._watched.has(spkHex)) return this._watchWallet;
    await this.#importSpk(this._watchWallet, spkHex);
    this._watched.add(spkHex);
    return this._watchWallet;
  }
  async #openWallet(name) {
    try { await this.rpc("createwallet", name, true, true, "", false, true, true); } catch { /* exists */ }   // watch-only descriptor wallet, load_on_startup
    try { await this.rpc("loadwallet", name, true); } catch { /* already loaded */ }                          // load_on_startup=true: survive bitcoind restarts
  }
  async #importSpk(wallet, spkHex) {
    const info = await this.rpcWallet(wallet, "getdescriptorinfo", `raw(${spkHex})`);
    await this.rpcWallet(wallet, "importdescriptors", JSON.stringify([{ desc: info.descriptor, timestamp: "now" }]));
  }
  // Purge settled swaps' descriptors so the watch-only wallet doesn't balloon over time. Bitcoin Core
  // has no removedescriptors, so we rotate to a fresh wallet generation holding only `keepSpks` (the
  // still-active swaps), import into it before unloading the old one (no coverage gap), then drop the
  // old wallet. Safe on a pruned node: kept addresses re-import forward-only, and a funded leg no
  // longer needs the wallet (spent-detection is gettxout on the UTXO set; its outpoint is recorded).
  async pruneWatch(keepSpks, threshold = Number(env("WATCH_PRUNE_THRESHOLD", 500))) {
    if (this.backend !== "rpc" || this.watch !== "wallet" || !this._watched) return;
    const keep = new Set(keepSpks);
    // Count-driven, not time-driven: let settled descriptors amortize, then rotate once. A wallet with
    // a few hundred stale descriptors is harmless, so there's no rush — this is unrelated to block time.
    const droppable = [...this._watched].filter((s) => !keep.has(s)).length;
    if (droppable < Math.max(1, threshold)) return;
    const gen = (this._gen || 0) + 1;
    const next = `${watchWalletOf(this.name)}-g${gen}`;
    await this.#openWallet(next);
    for (const spk of keep) { try { await this.#importSpk(next, spk); } catch { /* skip */ } }
    const prev = this._watchWallet;
    this._watchWallet = next; this._watched = new Set(keep); this._gen = gen;
    if (prev && prev !== next) { try { await this.rpc("unloadwallet", prev); } catch { /* already gone */ } }
    return { wallet: next, kept: keep.size };
  }
  async confs(fundingHeight) { return (await this.height()) - fundingHeight + 1; }
  async isUnspent(txid, vout) {
    if (this.backend === "esplora") { const o = await (await esplora(`/tx/${txid}/outspend/${vout}`)).json(); return !o.spent; }
    const o = await this.rpc("gettxout", txid, vout, true); return o != null && o !== "null" && o !== "";
  }
  // The txid that SPENT an outpoint (a claim or refund), or null if still unspent / unknown. Best-effort:
  //   esplora — /outspend gives the spender directly (confirmed or mempool);
  //   rpc/dev — gettxspendingprevout finds a MEMPOOL spender (Bitcoin Core 24+). The coordinator polls
  //             every ~2s, so an out-of-band claim is nearly always seen while still 0-conf; a spend that
  //             confirmed entirely between polls (never seen in-mempool by us) may return null.
  async spendingTxid(txid, vout) {
    try {
      if (this.backend === "esplora") { const o = await (await esplora(`/tx/${txid}/outspend/${vout}`)).json(); return o?.spent ? (o.txid || null) : null; }
      const r = await this.rpc("gettxspendingprevout", JSON.stringify([{ txid, vout }]));
      const hit = Array.isArray(r) ? r.find((x) => x.spendingtxid) : null;
      return hit?.spendingtxid || null;
    } catch { return null; }   // method unsupported / node transient — caller retries next tick
  }
  async testAccept(txHex) {
    if (this.backend === "esplora") return { allowed: true };   // Esplora has no testmempoolaccept; broadcast surfaces errors
    const r = (await this.rpc("testmempoolaccept", JSON.stringify([txHex])))[0]; return { allowed: r.allowed, reason: r["reject-reason"] };
  }
  async broadcast(txHex) {
    if (this.backend === "esplora") { const res = await esplora("/tx", { method: "POST", headers: { "content-type": "text/plain" }, body: txHex }); if (!res.ok) throw new Error(`broadcast rejected: ${await res.text()}`); return (await res.text()).trim(); }
    return this.rpc("sendrawtransaction", txHex);
  }
  async getTx(txid) {
    if (this.backend === "esplora") { const tx = await (await esplora(`/tx/${txid}`)).json(); return { vin: (tx.vin || []).map((i) => ({ txinwitness: i.witness || [] })), vout: tx.vout, status: tx.status }; }
    if (this.backend === "rpc") {
      // Pruned-safe: read via the watch-only wallet — gettransaction returns wallet-relevant txs
      // (the claim spends an address we watch) without needing txindex. Fall back to getrawtransaction.
      try { const g = await this.rpcWallet(this._watchWallet || watchWalletOf(this.name), "gettransaction", txid, true, true); if (g?.decoded) return g.decoded; } catch { /* not a wallet tx */ }
    }
    return this.rpc("getrawtransaction", txid, true);
  }

  // Node-driven feerate estimate (sat/vB), shaped like the mempool.space recommendation. Used for the
  // Qbit leg, which has no external fee oracle: ask the node's own `estimatesmartfee`, and fall back to
  // the mempool relay floor (`getmempoolinfo`) when the node has no estimate yet (a young/quiet chain
  // like regtest returns none). estimatesmartfee.feerate is BTC/kvB → ×1e5 = sat/vB.
  async feeBundle() {
    const est = async (target, mode) => {
      try { const r = await this.rpc("estimatesmartfee", target, mode); if (r && r.feerate > 0) return r.feerate * 1e5; } catch { /* unsupported / no data */ }
      return null;
    };
    let floor = 1;
    try { const mi = await this.rpc("getmempoolinfo"); const f = mi?.mempoolminfee ?? mi?.minrelaytxfee; if (f > 0) floor = f * 1e5; } catch { /* keep 1 */ }
    const norm = (v) => Math.max(1, Math.round(v ?? floor));
    const [fast, half, hour] = [await est(1, "CONSERVATIVE"), await est(3, "ECONOMICAL"), await est(6, "ECONOMICAL")];
    // `minimumFee` = the node's min-relay feerate (matches the mempool.space field name); the client
    // uses it as the absolute fee floor so a sweep never drops below relay.
    return { fastestFee: norm(fast), halfHourFee: norm(half ?? fast), hourFee: norm(hour ?? half ?? fast), minimumFee: Math.max(1, Math.round(floor)) };
  }

  // Qbit only: the node's hashrate/reorg model. We use `model.security_per_confirmation` (BTC
  // confirmations of security each qbit confirmation buys, from observed chainwork incl. AuxPoW) to
  // price a qbit reorg in BTC. `required_confirmations` targets a fixed 6-BTC-conf equivalent; we don't
  // gate on it — we scale confirmations to the swap's value instead (swap.js).
  async confTarget(valueSats, level = "high") {
    const r = await this.rpc("getconfirmationtarget", valueSats, level);
    return { confs: r.required_confirmations, minutes: r.required_minutes, equivalentBtcConfs: r.equivalent_btc_confirmations, level: r.security_level, model: r.model };
  }
  // dev helpers (regtest only)
  async mine(n, addr) { return this.rpc("generatetoaddress", n, addr); }
  async newAddress(wallet) { return this.rpcWallet(wallet, "getnewaddress"); }
}

export const qbit = new Chain("qbit");
export const btc = new Chain("btc");
