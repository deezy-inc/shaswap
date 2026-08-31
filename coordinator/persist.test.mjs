// Persistence durability: state is written atomically (temp file + rename), so an interrupted write can
// never leave a truncated/corrupt snapshot that load() would discard. Also checks a fresh process loads
// the persisted swaps back (survives a restart).  Run:  node persist.test.mjs
import { readFileSync, existsSync, rmSync } from "node:fs";
const DB = new URL("./_persist_test.json", import.meta.url).pathname;
rmSync(DB, { force: true }); rmSync(DB + ".tmp", { force: true });
process.env.COORD_CHAIN = "dev"; process.env.COORD_DB = DB;
globalThis.fetch = async () => { throw new Error("no network in this test"); };

let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };

const { createSwap, submitParty } = await import("./swap.js");
const a = createSwap({ btcSats: 20_000_000, qbtSats: 100_000_000 });
const b = createSwap({ btcSats: 50_000_000, qbtSats: 300_000_000 });

// A LONE party joining must persist immediately: party/H arrive once from the client and can't be
// recomputed from chain state. They weren't in the change signature, so a restart between the first
// and second join dropped the first joiner's keys and wedged the swap in CREATED forever.
await submitParty(a, "alice", { qbitPub: "aa", btcPub: "bb", btcDest: "adr1", qbitDest: "adr2", H: "cc" });
const joined = JSON.parse(readFileSync(DB, "utf8")).find((s) => s.id === a.id);
ck(joined?.party?.alice?.btcPub === "bb" && joined?.H === "cc", "a single join (party + H) persists before the second party arrives");

ck(existsSync(DB), "COORD_DB snapshot written on a state change");
ck(!existsSync(DB + ".tmp"), "no leftover .tmp file after the atomic rename");
const dump = JSON.parse(readFileSync(DB, "utf8"));   // throws if the file is ever a partial write
ck(Array.isArray(dump) && dump.length === 2, "snapshot is complete, valid JSON with both swaps");
ck(dump.some((s) => s.id === a.id) && dump.some((s) => s.id === b.id), "both swaps present in the snapshot");
ck(dump.every((s) => !("_sig" in s) && !("presence" in s)), "ephemeral fields (_sig/presence) are stripped");

// A fresh module load (simulating a restart) must read the swaps back from disk.
const fresh = await import("./swap.js?reload=" + Date.now());
ck(!!fresh.getSwap(a.id) && !!fresh.getSwap(b.id), "a restarted coordinator loads the persisted swaps back");

rmSync(DB, { force: true }); rmSync(DB + ".tmp", { force: true });
console.log(ok ? "\nPASS — atomic snapshot write + reload survive a restart" : "\nFAIL");
process.exit(ok ? 0 : 1);
