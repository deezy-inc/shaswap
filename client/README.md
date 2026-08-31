**English** · [简体中文](README.zh-CN.md)

# qbit-swap client library (JS)

The environment-agnostic core of the atomic-swap client — the same code the browser web app and any
headless market-maker **bot** (Node) consume. Pure swap crypto + transaction construction; no UI, no
network assumptions.

- **Qbit leg (post-quantum):** p2mr HTLC leaf, P2MR/BIP-341 sighash, SLH-DSA signing via the WASM
  module in `../wasm`.
- **Bitcoin leg:** P2WSH HTLC, BIP-143 sighash, ECDSA (`@noble/secp256k1`).

Chain access (fund / watch / reorg-safe confirmations / broadcast) and party-to-party relay live in
the caller — the browser talks to the coordinator; a bot uses its own node RPC. This library only
builds and signs.

## Validation (all against regtest nodes built from `main`)
- `node test.js` — p2mr leaf root, bech32m address, and P2MR sighash match golden vectors.
- `node claim_e2e.js` — a p2mr HTLC claim built and signed entirely in JS (WASM SLH-DSA) is accepted
  by the qbit node; the preimage is revealed on-chain.
- `node btc_e2e.js` — a P2WSH HTLC claim and a CLTV-gated refund are accepted by bitcoind.

## Notes
- ECDSA signing must pass `{ prehash: false }` to noble so it signs the raw BIP-143 digest (bitcoin
  double-SHA256), not `sha256(digest)`.
- The WASM signer is loaded via `signer.js`; in a browser build the same Emscripten module loads with
  `ENVIRONMENT=web`.
- **Fail-closed economics (audit hardening).** The library is the last checkpoint before a signature
  exists, so it refuses to build a bad spend: `leU` range-checks (no silent wrap), `btcSpend` requires
  a valid branch, a 32-byte claim preimage, a sane locktime, and `0 < outVal ≤ amount` with
  `outVal + extraOut ≤ amount` (a negative/over-funded fee output is a bug, not a signed tx);
  `htlcWitnessScript`/`htlcLeafQbit` validate key/hash lengths and the CLTV block-height range;
  `bip143Sighash` rejects any sighash type other than SIGHASH_ALL; `addressToScriptPubKey(addr, {coin})`
  can enforce the intended network (an hrp mismatch fails instead of cross-encoding to an
  anyone-can-spend output); `parseTx`/`serializeTx` fail closed on truncation, non-minimal varints, and
  witness/vin mismatches.
