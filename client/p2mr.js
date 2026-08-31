// Qbit p2mr primitives + the BTC<->QBT atomic-swap HTLC leaf (Qbit leg). Ports reference/p2mr.py.
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, u8, compactSize, pushData, scriptNum, hexToBytes, checkLocktime } from "./encoding.js";

export const OP = { IF: 0x63, ELSE: 0x67, ENDIF: 0x68, DROP: 0x75, SIZE: 0x82, EQUALVERIFY: 0x88,
                    SHA256: 0xa8, CHECKLOCKTIMEVERIFY: 0xb1, CHECKSIGPQC: 0xb3 };
export const P2MR_LEAF_VERSION = 0xc0;
export const P2MR_CONTROL_SINGLE_LEAF = u8(P2MR_LEAF_VERSION | 0x01); // 0xc1

export function taggedHash(tag, msg) {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, msg));
}

export function leafHash(script, leafVersion = P2MR_LEAF_VERSION) {
  return taggedHash("P2MRLeaf", concatBytes(u8(leafVersion), compactSize(script.length), script));
}
export const singleLeafRoot = (script) => leafHash(script);          // single-leaf tree root == leaf hash
export const p2mrSpk = (script) => concatBytes(u8(0x52, 0x20), singleLeafRoot(script));

// OP_IF OP_SIZE 32 OP_EQUALVERIFY <hashlock><recv>CHECKSIGPQC OP_ELSE <cltv>CLTV DROP <fund>CHECKSIGPQC OP_ENDIF
// The OP_SIZE 32 OP_EQUALVERIFY guard pins the preimage to exactly 32 bytes: the same secret must
// satisfy the hashlock on BOTH chains identically, so neither leg can be claimed with a differently
// encoded/padded preimage that hashes to H on one chain but not the other.
export function htlcLeafQbit(hashH, recvPub, fundPub, locktime) {
  if (hashH.length !== 32 || recvPub.length !== 32 || fundPub.length !== 32) throw new Error("bad key/hash length");
  checkLocktime(locktime);
  return concatBytes(
    u8(OP.IF, OP.SIZE), pushData(scriptNum(32)), u8(OP.EQUALVERIFY),
    u8(OP.SHA256), pushData(hashH), u8(OP.EQUALVERIFY),
    pushData(recvPub), u8(OP.CHECKSIGPQC),
    u8(OP.ELSE), pushData(scriptNum(locktime)), u8(OP.CHECKLOCKTIMEVERIFY, OP.DROP),
    pushData(fundPub), u8(OP.CHECKSIGPQC), u8(OP.ENDIF));
}

export const singleKeyLeaf = (pqcPub) => concatBytes(pushData(pqcPub), u8(OP.CHECKSIGPQC)); // 0x20<pk>0xb3

// ── bech32m (BIP-350) ───────────────────────────────────────────────────────
const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const polymod = (v) => {
  const g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1;
  for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) c ^= ((b >> i) & 1) ? g[i] : 0; }
  return c >>> 0;
};
const hrpExpand = (h) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];
function convert8to5(data) {
  let acc = 0, bits = 0; const out = [];
  for (const b of data) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}
export function segwitAddr(hrp, witver, program) {
  const data = [witver, ...convert8to5(program)];
  const constant = witver !== 0 ? 0x2bc830a3 : 1;
  const pm = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ constant;
  const chk = [...Array(6)].map((_, i) => (pm >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...chk].map((d) => CH[d]).join("");
}
export const p2mrAddress = (script, hrp) => segwitAddr(hrp, 2, singleLeafRoot(script));
