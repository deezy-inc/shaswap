// Per-leg chain configuration. The engine has two chain SLOTS with fixed internal keys — "btc" (the
// fromLeg: the initiator/QBT-buyer funds it) and "qbit" (the toLeg: the seller funds it). The KEYS are
// wire/persistence names and never change (API fields, sqlite rows, and the webapp all speak
// btcSats/qbtSats); what each slot actually IS comes from here — so the second slot can be any UTXO
// chain that speaks Bitcoin-Core-compatible RPC. Select it with ONE env:
//
//   CHAIN2=qbit     (default) the qbit chain — p2mr HTLCs, SLH-DSA, conftarget-rpc reorg model
//   CHAIN2=bip110   the BTC/Blake2b fork (Knots v29.4.x lineage, BIP-110 active): standard Bitcoin
//                   script → P2WSH + ECDSA HTLCs, "fixed" reorg model (young Blake2b hashrate can't be
//                   subsidy-priced), and — because both chains share pre-fork history — REPLAY
//                   PROTECTION: BTC-side sweeps carry a >83-byte OP_RETURN, which BIP-110 (the
//                   datacarrier restriction itself) makes un-relayable on the fork chain. Fork-side
//                   sweeps have no marker trick (the fork ENFORCES small datacarrier); its opt-in
//                   SIGHASH_UNIFIED is a follow-up once the client stabilizes — until then fund the
//                   fork leg from post-fork (split) coins so the funding chain can't mirror.
//
// Every per-slot knob (env overrides the preset; legacy QBIT_* envs still work for the second slot):
//   label            display ticker (view.chains; wire fields stay btcSats/qbtSats)
//   hrp              bech32 hrp for HTLC deposit addresses (a fork pair uses "bc" on BOTH slots)
//   blockSecs        target block time — converts wall-clock timelock windows to per-chain blocks
//   minSats          minimum swap size on this leg
//   minConfs         floor on the reorg-safe confirmation gate
//   script           HTLC family: "p2wsh-ecdsa" (Bitcoin-family) | "p2mr-slhdsa" (qbit)
//   reorgModel       value-scaled gate pricing: "btc-subsidy" | "conftarget-rpc" | "fixed"
//   fixedConfs       reorg depth for reorgModel="fixed" — scaled by swap value:
//                    the base depth applies at `fixedScaleBtc` BTC of swap value; every additional
//                    doubling of value adds one conf (1 conf at ≤scale, 2 at 2×, 3 at 4×, … capped at
//                    fixedMaxConfs). So a small swap settles fast while a large one gets a deep burial.
//   fixedScaleBtc    swap value (in whole BTC) at which the base fixedConfs applies
//   fixedMaxConfs    hard ceiling on the scaled fixed-confs depth
//   trustUnconfirmed treat a 0-conf (mempool) deposit on THIS leg as final: the claimable gate, the
//                    sequenced-funding gate, and the broadcast hold-gate all pass at 0-conf. UNSAFE
//                    against an adversarial counterparty (RBF/double-spend) — for trusted settings
//                    only (your own maker on both sides, demos, fork pairs where speed wins).
//   replayOpReturn   sweeps (claim/refund) on THIS leg must carry a >83-byte OP_RETURN. The
//                    coordinator ENFORCES it at broadcast; clients build it (btcSpend `replay`).
//
// Reads are per-call (no cache) so tests can flip env live; the coordinator reads these at swap-derive
// and gate time, so a restart applies a config change to NEW swaps only (derived HTLCs are immutable).
import { replayMarkerSpk as clientReplayMarkerSpk } from "../client/index.js";

const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);
const num = (k, d) => Number(env(k, d));
const flag = (k, d = false) => { const v = env(k, null); return v == null ? d : ["1", "true", "yes"].includes(String(v).toLowerCase()); };

export const SCRIPTS = ["p2wsh-ecdsa", "p2mr-slhdsa"];
export const REORG_MODELS = ["btc-subsidy", "conftarget-rpc", "fixed"];

// Presets for the second slot. `bip110` is a POLICY/PoW fork of Bitcoin (Blake2b PoW, 164-byte v2
// headers — both invisible at the RPC/tx layer we use): tx format, script rules, and ECDSA sighash are
// stock Bitcoin, so the standard P2WSH HTLC family applies as-is.
// A preset names BOTH sides: on a fork pair, plain "BTC" is ambiguous — the pair is displayed as
// BTC-SHA256 ⇄ BTC-Blake2b so users always know which chain of the fork they're on.
const CHAIN2_PRESETS = {
  qbit:   { label: "QBT",         btcLabel: "BTC",        hrp: "qbrt", blockSecs: 60,  minSats: 200000, minConfs: 1, script: "p2mr-slhdsa", reorgModel: "conftarget-rpc", fixedConfs: 6,  btcReplay: false, forkTwin: false, esplora: "https://mempool.space/api",  btcExplorer: "https://mempool.space/tx/",          qbitExplorer: "https://qbitmempool.robertclarke.com/tx/" },
  bip110: { label: "BTC-Blake2b", btcLabel: "BTC-SHA256", hrp: "bc",   blockSecs: 600, minSats: 50000,  minConfs: 1, script: "p2wsh-ecdsa", reorgModel: "fixed",          fixedConfs: 1, fixedScaleBtc: 0.01, fixedMaxConfs: 12, btcReplay: true,  forkTwin: true,  esplora: "https://mempool.space/api", btcExplorer: "https://mempool.space/tx/",      qbitExplorer: "https://mempool.guide/tx/" },
};
export const chain2Preset = () => env("CHAIN2", "qbit");
// The pair's default BTC-side Esplora endpoint (fees + the optional esplora chain backend). The
// "btc" slot is REAL Bitcoin on every preset — including bip110, where only the SECOND slot is the
// Blake2b fork (mempool.guide is the fork's explorer, wrong chain for BTC-side fees/funding) — so
// this is mempool.space across presets. Env override (ESPLORA_URL / MEMPOOL_URL) always wins.
export const pairEsploraUrl = () => env("ESPLORA_URL", CHAIN2_PRESETS[chain2Preset()]?.esplora || "https://mempool.space/api");
// Fork pairs share pre-fork history + tx format, so an UNPROTECTED deposit can be replayed onto the
// other chain — an identical "twin" UTXO at the same outpoint, paying the same HTLC script. When this
// flag is on, clients pre-sign a refund-path sweep of that twin (valid on the OTHER chain) and the
// watchtower returns it to the sender's refund address once the timelock allows (see driveTwinSweep).
export const forkTwinPair = () => flag("FORK_TWIN", !!CHAIN2_PRESETS[chain2Preset()]?.forkTwin);

export function chainCfg(leg) {
  const p = CHAIN2_PRESETS[chain2Preset()];
  if (!p) throw new Error(`CHAIN2="${chain2Preset()}" — unknown preset (${Object.keys(CHAIN2_PRESETS).join("|")})`);
  if (leg === "btc") return {
    label: env("BTC_LABEL", p.btcLabel),
    hrp: env("BTC_HRP", "bcrt"),
    blockSecs: num("BTC_BLOCK_SECS", 600),
    minSats: num("MIN_BTC_SATS", 50000),
    minConfs: num("MIN_CONFS_BTC", 1),
    script: env("BTC_SCRIPT", "p2wsh-ecdsa"),
    reorgModel: env("BTC_REORG_MODEL", "btc-subsidy"),
    // Hard ceiling on the value-scaled confirmation depth for the BTC leg. One BTC conf ≈ one block
    // subsidy of work (≈3.125 BTC); at REORG_MARGIN=3× that's ≈9.4 BTC of reorg cost per conf, so 3
    // confs secure up to ~3 BTC of swap value — beyond that the model is over-conservative and the wait
    // just grows the timelock without meaningfully raising the bar. Default 3; env-overridable.
    maxConfs: num("BTC_MAX_CONFS", 3),
    fixedConfs: num("BTC_FIXED_CONFS", 6),
    trustUnconfirmed: flag("BTC_TRUST_UNCONFIRMED"),
    replayOpReturn: flag("BTC_REPLAY_OPRETURN", p.btcReplay),   // preset default: ON for the bip110 pair
  };
  // second slot: preset base, env overrides (ALT_* preferred; legacy QBIT_*/MIN_QBT_SATS still honored)
  const alt = (k, legacyK, d) => env(`ALT_${k}`, env(legacyK, d));
  return {
    label: alt("LABEL", "QBIT_LABEL", p.label),
    hrp: alt("HRP", "QBIT_HRP", p.hrp),
    blockSecs: Number(alt("BLOCK_SECS", "QBIT_BLOCK_SECS", p.blockSecs)),
    minSats: Number(alt("MIN_SATS", "MIN_QBT_SATS", p.minSats)),
    minConfs: Number(alt("MIN_CONFS", "MIN_CONFS_QBIT", p.minConfs)),
    script: alt("SCRIPT", "QBIT_SCRIPT", p.script),
    reorgModel: alt("REORG_MODEL", "QBIT_REORG_MODEL", p.reorgModel),
    fixedConfs: Number(alt("FIXED_CONFS", "QBIT_FIXED_CONFS", p.fixedConfs)),
    fixedScaleBtc: Number(alt("FIXED_SCALE_BTC", "QBIT_FIXED_SCALE_BTC", p.fixedScaleBtc ?? 0.01)),
    fixedMaxConfs: Number(alt("FIXED_MAX_CONFS", "QBIT_FIXED_MAX_CONFS", p.fixedMaxConfs ?? 12)),
    maxConfs: Number(alt("MAX_CONFS", "QBIT_MAX_CONFS", 0)),   // 0 = no cap (conftarget-rpc prices it)
    trustUnconfirmed: flag("ALT_TRUST_UNCONFIRMED") || flag("QBIT_TRUST_UNCONFIRMED"),
    replayOpReturn: flag("ALT_REPLAY_OPRETURN") || flag("QBIT_REPLAY_OPRETURN"),
  };
}
// The public projection clients configure themselves from (GET /chains, serve.js injection, view).
export const publicChains = () => Object.fromEntries(["btc", "qbit"].map((leg) => {
  const { label, hrp, blockSecs, minSats, script, trustUnconfirmed, replayOpReturn } = chainCfg(leg);
  const p = CHAIN2_PRESETS[chain2Preset()];
  return [leg, { label, hrp, blockSecs, minSats, script, trustUnconfirmed, replayOpReturn, forkTwin: forkTwinPair(),
    explorer: env(`${leg.toUpperCase()}_EXPLORER`, leg === "btc" ? p.btcExplorer : p.qbitExplorer) }];
}));

// Validate once at startup — catch a typo'd preset/script/model before any swap derives from it.
export function validateChains() {
  chainCfg("btc");   // throws on an unknown CHAIN2
  for (const leg of ["btc", "qbit"]) {
    const c = chainCfg(leg);
    if (!SCRIPTS.includes(c.script)) throw new Error(`${leg}: unknown script family "${c.script}" (${SCRIPTS.join("|")})`);
    if (!REORG_MODELS.includes(c.reorgModel)) throw new Error(`${leg}: unknown reorg model "${c.reorgModel}" (${REORG_MODELS.join("|")})`);
    if (!(c.blockSecs > 0) || !(c.minSats > 0) || !(c.minConfs >= 0) || !(c.fixedConfs > 0)) throw new Error(`${leg}: blockSecs/minSats/minConfs/fixedConfs must be positive`);
    if (c.trustUnconfirmed) console.error(`[chains] ⚠ ${leg} (${c.label}): TRUST-UNCONFIRMED ON — 0-conf deposits treated as final; safe only between trusted parties`);
    if (c.replayOpReturn) console.error(`[chains] ${leg} (${c.label}): replay protection ON — sweeps must carry a >83-byte OP_RETURN`);
  }
  // Under CHAIN2=bip110 the second slot's node config must use the BIP110_* names — refusing to boot
  // on the legacy QBIT_* names keeps a fork-pair deployment from silently pointing at a qbit node.
  // Dev/mock backends (COORD_CHAIN=dev harnesses) are exempt: they have no node to configure.
  if (chain2Preset() === "bip110") {
    const be = env("BIP110_BACKEND", null), legacy = env("QBIT_BACKEND", null);
    const effective = be || legacy || env("COORD_CHAIN", "dev");
    if (effective !== "dev") {
      if (!be) throw new Error(`CHAIN2=bip110 requires BIP110_BACKEND${legacy ? " (found legacy QBIT_BACKEND — rename it and its siblings to BIP110_*)" : ""}`);
      if (be === "rpc" && !env("BIP110_RPC_URL", null)) throw new Error("CHAIN2=bip110 with BIP110_BACKEND=rpc requires BIP110_RPC_URL");
    }
  }
  const [b, q] = [chainCfg("btc"), chainCfg("qbit")];
  console.log(`[chains] pair: ${b.label} (${b.script}) ⇄ ${q.label} (${q.script}) · CHAIN2=${chain2Preset()}`);
}
// Re-export the client lib's marker (single source of truth for coordinator enforcement + tests).
export const replayMarkerSpk = clientReplayMarkerSpk;
// Does a parsed tx's output set carry the replay marker? (any OP_RETURN whose total spk exceeds the
// 83-byte datacarrier cap + overhead — i.e. a payload BIP-110 policy will not relay/mine.)
export const hasReplayMarker = (txOuts) => txOuts.some(([, spk]) => spk[0] === 0x6a && spk.length > 85);
