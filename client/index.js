// qbit-swap client library — the shared, environment-agnostic core used by both the browser web app
// and any headless bot (Node). No UI, no network assumptions: pure swap crypto + tx construction.
//
//   Qbit leg (post-quantum): p2mr HTLC leaf, P2MR/BIP-341 sighash, SLH-DSA signing via WASM.
//   Bitcoin leg:             P2WSH HTLC, BIP-143 sighash, ECDSA (secp256k1).
//
// Everything here is validated against regtest nodes (see claim_e2e.js / btc_e2e.js). Chain access
// (fund/watch/confs/broadcast) and party-to-party relay live in the caller (browser -> coordinator,
// or a bot's own RPC) — this library only builds and signs.

export * as encoding from "./encoding.js";

// ── Qbit (p2mr) leg ─────────────────────────────────────────────────────────
export {
  taggedHash, leafHash, singleLeafRoot, p2mrSpk, htlcLeafQbit, singleKeyLeaf,
  p2mrAddress, segwitAddr, P2MR_LEAF_VERSION, P2MR_CONTROL_SINGLE_LEAF, OP,
} from "./p2mr.js";
export { p2mrSighash, SIGHASH_DEFAULT } from "./sighash.js";
export { addressToScriptPubKey, addressCoin } from "./addr.js";
export { parseTx, serializeTx } from "./tx.js";
export { slhDsaSign, slhDsaKeygen } from "./signer.js";

// ── Bitcoin leg ─────────────────────────────────────────────────────────────
export {
  compressedPub, ecdsaSign, htlcWitnessScript, p2wshSpk, p2wshAddr,
  bip143Sighash, serializeSegwit, btcSpend, replayMarkerSpk, REPLAY_PAYLOAD_BYTES,
} from "./bitcoin.js";
export { splitterScript, splitterAddress, splitFunding } from "./fanout.js";
