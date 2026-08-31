// Durable per-swap key storage. The bot signs with EPHEMERAL per-swap keys — held only in memory, a
// crash mid-swap would strand its funds: no QBT secret key → can't refund the QBT it locked; no BTC key
// → can't claim the BTC it's owed; (Alice) no preimage secret → can't claim at all. So every swap's
// material is written to disk BEFORE the bot takes any on-chain (or even join) action, and run.js
// resumes open swaps on startup (fulfill is idempotent: re-joining with the same keys is allowed, and
// funding is skipped when the leg is already funded).
//
// Storage: one JSON file per swap under MAKER_KEY_DIR (default ./maker-keys), mode 0600 in a 0700 dir,
// written atomically (temp+rename). Settled swaps rename to .done.json (kept for audit; their keys no
// longer control anything — funds have moved to the wallet's own addresses). The directory sits on the
// SAME trust boundary as the wallet RPC credentials in env: protect the box, not just the file.
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const hex = (b) => (b instanceof Uint8Array ? [...b].map((x) => x.toString(16).padStart(2, "0")).join("") : b);
const bin = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

export function fileKeystore(dir = process.env.MAKER_KEY_DIR || "./maker-keys") {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ok = (id) => typeof id === "string" && /^[a-zA-Z0-9]{3,80}$/.test(id);   // simple tokens only — no path chars
  const path = (id, done = false) => {
    if (!ok(id)) throw new Error(`unsafe swap id for keystore: "${String(id).slice(0, 80)}"`);
    return join(dir, `${id}${done ? ".done" : ""}.json`);
  };
  return {
    dir,
    // Persist a swap's signing material (call BEFORE join/fund). Uint8Array fields are hex-serialized.
    save(rec) {
      const out = {};
      for (const [k, v] of Object.entries(rec)) out[k] = v instanceof Uint8Array ? hex(v) : (v && v.spk instanceof Uint8Array ? { ...v, spk: hex(v.spk) } : v);
      const p = path(rec.swapId), tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      renameSync(tmp, p);
      try { chmodSync(p, 0o600); } catch { /* fs without modes */ }
    },
    // Open (unsettled) records, keys rehydrated to bytes — what resumePending() drives.
    list() {
      const out = [];
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json") || f.endsWith(".done.json") || f.endsWith(".tmp")) continue;
        try {
          const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
          for (const k of ["qbitPk", "qbitSk", "btcPriv", "secret"]) if (typeof r[k] === "string") r[k] = bin(r[k]);
          for (const k of ["btcDest", "qbitDest"]) if (typeof r[k]?.spk === "string") r[k] = { ...r[k], spk: bin(r[k].spk) };
          out.push(r);
        } catch { /* torn/foreign file — skip */ }
      }
      return out;
    },
    markDone(swapId) { try { renameSync(path(swapId), path(swapId, true)); } catch { /* already done/missing */ } },
  };
}
