// Durable per-swap key storage: atomic 0600 writes in a 0700 dir, byte-exact key round-trips, list()
// returns only OPEN swaps, markDone retires a record without deleting it, torn files are skipped.
//   Run:  node test/keystore.test.mjs
import { rmSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileKeystore } from "../keystore.js";

let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const DIR = new URL("./_keys_test", import.meta.url).pathname;
rmSync(DIR, { recursive: true, force: true });

const ks = fileKeystore(DIR);
ck((statSync(DIR).mode & 0o777) === 0o700, "keystore dir created 0700");

// save → 0600 file, no tmp residue; keys round-trip byte-exact (incl. Alice's secret + dest spks)
const rec = {
  swapId: "swapA", token: "tokA", role: "alice",
  qbitPk: Uint8Array.from([1, 2, 3]), qbitSk: Uint8Array.from([4, 5, 6, 7]),
  btcPriv: Uint8Array.from(Array(32).fill(9)), secret: Uint8Array.from(Array(32).fill(0xab)),
  btcDest: { address: "bc1qme", spk: Uint8Array.from([0, 20, 1]) }, qbitDest: { address: "qb1me", spk: Uint8Array.from([0x51, 2]) },
  at: 123,
};
ks.save(rec);
ks.save({ swapId: "swapB", token: "tokB", role: "bob", qbitPk: Uint8Array.of(9), qbitSk: Uint8Array.of(8), btcPriv: Uint8Array.of(7), btcDest: { address: "x", spk: Uint8Array.of(1) }, qbitDest: { address: "y", spk: Uint8Array.of(2) }, at: 124 });
ck((statSync(join(DIR, "swapA.json")).mode & 0o777) === 0o600, "record file is 0600 (owner-only)");
ck(!readdirSync(DIR).some((f) => f.endsWith(".tmp")), "atomic write leaves no .tmp residue");

const back = ks.list().find((r) => r.swapId === "swapA");
ck(back.token === "tokA" && back.role === "alice", "token + role round-trip");
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
ck(back.secret instanceof Uint8Array && eq([...back.secret], [...rec.secret]), "Alice's preimage secret round-trips byte-exact");
ck(eq([...back.qbitSk], [...rec.qbitSk]) && eq([...back.btcPriv], [...rec.btcPriv]), "signing keys round-trip byte-exact");
ck(back.btcDest.address === "bc1qme" && eq([...back.btcDest.spk], [0, 20, 1]), "dest address + spk round-trip");

// markDone retires (renames, not deletes) and drops it from list()
ks.markDone("swapA");
ck(ks.list().length === 1 && ks.list()[0].swapId === "swapB", "done swap leaves list(); open one remains");
ck(existsSync(join(DIR, "swapA.done.json")), "done record is retired to .done.json (kept for audit)");

// torn/foreign files are skipped, not fatal
writeFileSync(join(DIR, "torn.json"), "{not json");
ck(ks.list().length === 1, "a torn record file is skipped without breaking list()");

rmSync(DIR, { recursive: true, force: true });
console.log(ok ? "\nPASS — keystore: 0600 atomic persistence, byte-exact key recovery, done-retirement" : "\nFAIL");
process.exit(ok ? 0 : 1);
