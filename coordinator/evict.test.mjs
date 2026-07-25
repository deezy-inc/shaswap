// Memory bounding: long-settled swaps are evicted from the in-memory working set but stay in the store
// and reload on demand; full-history aggregates (counts/volume) come from the store, not the (now
// bounded) Map. Proves RAM won't grow forever the way the old JSON file did.  Run:  node evict.test.mjs
import { rmSync } from "node:fs";
const DB = new URL("./_evict_test.db", import.meta.url).pathname;
for (const ext of ["", "-wal", "-shm"]) rmSync(DB + ext, { force: true });
process.env.COORD_CHAIN = "dev"; process.env.COORD_DB = DB; process.env.SWAP_EVICT_MS = "86400000";   // 24h
globalThis.fetch = async () => { throw new Error("no network in this test"); };

let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const { createSwap, getSwap, allSwaps, evictSettled, persistedCounts, persistedVolume, recentComplete, swapsIncludingSettled, _store } = await import("./swap.js");

// Two swaps: one long-settled COMPLETE, one still active (CREATED). Persist the terminal state.
const done = createSwap({ btcSats: 20_000_000, qbtSats: 100_000_000 });
const live = createSwap({ btcSats: 50_000_000, qbtSats: 300_000_000 });
done.state = "COMPLETE"; done.settledAt = Date.now() - 2 * 86400000;   // settled 2 days ago
_store.put(done);                                                       // persist the terminal state to the store

ck(allSwaps().length === 2, "both swaps in memory before eviction");
const n = evictSettled();
ck(n === 1, "evictSettled drops exactly the one long-settled swap");
ck(!allSwaps().some((s) => s.id === done.id), "the settled swap is gone from the in-memory working set");
ck(allSwaps().some((s) => s.id === live.id), "the active swap is kept in memory");

// Load-on-demand: getSwap still returns the evicted swap, hydrated from the store.
const loaded = getSwap(done.id);
ck(loaded && loaded.state === "COMPLETE" && loaded.id === done.id, "getSwap reloads the evicted swap from the store on demand");
ck(loaded !== done, "the reloaded swap is a fresh object, not re-added to the Map (working set stays bounded)");
ck(allSwaps().length === 1, "reading an evicted swap did NOT re-grow the working set");

// Full-history aggregates come from the store, so they still count the evicted swap.
const c = persistedCounts();
ck(c.COMPLETE === 1 && c.CREATED === 1, `store counts full history incl. evicted (COMPLETE=${c.COMPLETE}, CREATED=${c.CREATED})`);
const v = persistedVolume();
ck(v.complete === 1 && v.btcSats === 20_000_000 && v.qbtSats === 100_000_000, "store volume sums COMPLETE across all history (incl. evicted)");
ck(recentComplete(10).some((s) => s.id === done.id), "recentComplete surfaces the evicted swap from the store");

// LIST readers (admin swaps table, watchtower panel) must see history: the merged accessor returns the
// evicted swap alongside the working set — regression for "admin API stopped returning completed swaps".
{
  const all = swapsIncludingSettled();
  ck(all.some((s) => s.id === done.id && s.state === "COMPLETE"), "swapsIncludingSettled surfaces the EVICTED completed swap (the admin-list regression)");
  ck(all.some((s) => s.id === live.id), "…alongside the live working set");
  ck(all.find((s) => s.id === live.id) === live, "the in-memory object wins for a live id (fresher than its store row)");
  ck(allSwaps().length === 1, "…without re-growing the working set");
}

// A NOT-yet-old terminal swap is retained (only past the grace do we evict).
const fresh = createSwap({ btcSats: 60_000_000, qbtSats: 400_000_000 });
fresh.state = "REFUNDED"; fresh.settledAt = Date.now() - 60_000;   // 1 min ago
_store.put(fresh);
ck(evictSettled() === 0 && allSwaps().some((s) => s.id === fresh.id), "a freshly-settled swap is NOT evicted (kept until past the grace)");

_store.db.close();
for (const ext of ["", "-wal", "-shm"]) rmSync(DB + ext, { force: true });
console.log(ok ? "\nPASS — long-settled swaps evict from RAM, reload on demand, and history stays complete in the store" : "\nFAIL");
process.exit(ok ? 0 : 1);
