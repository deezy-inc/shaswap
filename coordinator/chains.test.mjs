// Chain-pair config: preset selection (CHAIN2=qbit|bip110), env overrides + legacy QBIT_* back-compat,
// validation, and the replay-marker helpers. Env is read per-call, so this flips it live.
//   Run:  node chains.test.mjs
import { chainCfg, publicChains, validateChains, replayMarkerSpk, hasReplayMarker } from "./chains.js";
import { parseTx } from "../client/index.js";

let ok = true; const ck = (c, m) => { console.log((c ? "[ok] " : "[FAIL] ") + m); ok = ok && c; };
const clean = () => { for (const k of Object.keys(process.env)) if (/^(CHAIN2|ALT_|QBIT_|BTC_(LABEL|SCRIPT|REORG|FIXED|TRUST|REPLAY)|MIN_QBT)/.test(k)) delete process.env[k]; };

// ── default: the qbit pair, exactly as before the refactor ───────────────────────────────────────
clean();
let q = chainCfg("qbit"), b = chainCfg("btc");
ck(q.label === "QBT" && q.script === "p2mr-slhdsa" && q.reorgModel === "conftarget-rpc" && q.blockSecs === 60 && q.minSats === 200000, "CHAIN2 default = qbit preset (p2mr/SLH-DSA, conftarget-rpc, 60s blocks)");
ck(b.script === "p2wsh-ecdsa" && b.reorgModel === "btc-subsidy" && !b.replayOpReturn && !b.trustUnconfirmed, "btc slot defaults: p2wsh, subsidy model, no replay/trust");
validateChains();   // must not throw

// legacy env still wins (existing deploys change nothing)
process.env.QBIT_HRP = "qb"; process.env.MIN_QBT_SATS = "300000"; process.env.QBIT_BLOCK_SECS = "75";
q = chainCfg("qbit");
ck(q.hrp === "qb" && q.minSats === 300000 && q.blockSecs === 75, "legacy QBIT_*/MIN_QBT_SATS envs still override the preset");
process.env.ALT_HRP = "tb";
ck(chainCfg("qbit").hrp === "tb", "ALT_* wins over legacy QBIT_* when both are set");

// ── the bip110 fork pair: ONE env flips the whole identity ───────────────────────────────────────
clean();
process.env.CHAIN2 = "bip110";
q = chainCfg("qbit"); b = chainCfg("btc");
ck(q.label === "B110" && q.script === "p2wsh-ecdsa" && q.hrp === "bc" && q.blockSecs === 600, "CHAIN2=bip110 → P2WSH+ECDSA second leg, bc addresses, 600s blocks");
ck(q.reorgModel === "fixed" && q.fixedConfs === 12, "bip110 uses the fixed-confs reorg model (Blake2b hashrate can't be subsidy-priced)");
ck(b.replayOpReturn === true, "bip110 preset turns ON BTC-side replay protection by default");
ck(q.replayOpReturn === false, "fork side has no marker trick (BIP-110 IS the datacarrier limit) — off by default");
process.env.BTC_REPLAY_OPRETURN = "0";
ck(chainCfg("btc").replayOpReturn === false, "explicit env can still override the preset's replay default");
delete process.env.BTC_REPLAY_OPRETURN;
process.env.ALT_FIXED_CONFS = "3";
ck(chainCfg("qbit").fixedConfs === 3, "preset knobs remain env-tunable (ALT_FIXED_CONFS)");
validateChains();

// trust-unconfirmed flags parse on either side
process.env.BTC_TRUST_UNCONFIRMED = "1"; process.env.ALT_TRUST_UNCONFIRMED = "true";
ck(chainCfg("btc").trustUnconfirmed && chainCfg("qbit").trustUnconfirmed, "per-leg trust-unconfirmed flags");
const pub = publicChains();
ck(pub.btc.trustUnconfirmed === true && pub.qbit.script === "p2wsh-ecdsa" && !("fixedConfs" in pub.qbit), "publicChains projects the client-relevant fields only");

// bad config refuses to start
process.env.CHAIN2 = "dogecoin";
let threw = null; try { validateChains(); } catch (e) { threw = e; }
ck(/unknown preset/.test(threw?.message), "unknown CHAIN2 preset refuses to start");
clean(); process.env.ALT_SCRIPT = "p2tr-schnorr";
threw = null; try { validateChains(); } catch (e) { threw = e; }
ck(/unknown script family/.test(threw?.message), "unknown script family refuses to start");
clean();

// ── replay marker helpers ────────────────────────────────────────────────────────────────────────
const spk = replayMarkerSpk();
ck(spk[0] === 0x6a && spk.length === 103 && spk.length - 3 > 83, `marker spk = OP_RETURN + ${spk.length - 3}B payload (> the 83B datacarrier cap)`);
ck(hasReplayMarker([[0n, spk]]), "hasReplayMarker sees the marker output");
ck(!hasReplayMarker([[0n, Uint8Array.of(0x6a, 0x4c, 80, ...new Uint8Array(80))]]), "an ≤83-byte OP_RETURN does NOT count (it would relay on the fork)");
ck(!hasReplayMarker([[1000n, Uint8Array.of(0x00, 0x14, ...new Uint8Array(20))]]), "ordinary outputs don't count");
void parseTx;   // (imported for symmetry with the enforcement path; parsing is covered in the e2e)

console.log(ok ? "\nPASS — chain presets, env back-compat, validation, and the replay marker all hold" : "\nFAIL");
process.exit(ok ? 0 : 1);
