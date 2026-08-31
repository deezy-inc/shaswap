// Decode a receiving address to its scriptPubKey, so the wallet-agnostic app can build spend outputs
// client-side without asking a node. Supports bech32/bech32m witness programs (v0 P2WPKH/P2WSH,
// v1 P2TR, v2 P2MR/qbit) and base58check legacy (P2PKH, P2SH). Chain-neutral: any hrp / version byte.
import { concatBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

const u8 = (...b) => Uint8Array.from(b);
const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHREV = Object.fromEntries([...CH].map((c, i) => [c, i]));
const polymod = (v) => {
  const g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1;
  for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) c ^= ((b >> i) & 1) ? g[i] : 0; }
  return c >>> 0;
};
const hrpExpand = (h) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];
function convert5to8(data) {
  let acc = 0, bits = 0; const out = [];
  for (const b of data) { acc = (acc << 5) | b; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) throw new Error("bad bech32 padding");
  return out;
}

function decodeBech32(addr) {
  const lower = addr.toLowerCase();
  if (lower !== addr && addr.toUpperCase() !== addr) throw new Error("mixed-case address");
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) throw new Error("no hrp");
  const hrp = lower.slice(0, pos);
  const data = [...lower.slice(pos + 1)].map((c) => { const v = CHREV[c]; if (v === undefined) throw new Error("bad char"); return v; });
  const pm = polymod([...hrpExpand(hrp), ...data]);
  const spec = pm === 1 ? "bech32" : pm === 0x2bc830a3 ? "bech32m" : null;
  if (!spec) throw new Error("bad bech32 checksum");
  const witver = data[0];
  const program = Uint8Array.from(convert5to8(data.slice(1, -6)));
  if (witver === 0 && spec !== "bech32") throw new Error("v0 must be bech32");
  if (witver !== 0 && spec !== "bech32m") throw new Error("v1+ must be bech32m");
  if (witver > 16 || program.length < 2 || program.length > 40) throw new Error("bad witness program");
  if (witver === 0 && program.length !== 20 && program.length !== 32) throw new Error("bad v0 program length");
  return { hrp, witver, program };
}
const witnessSpk = (witver, program) => concatBytes(u8(witver === 0 ? 0 : 0x50 + witver, program.length), program);

// ── base58check (legacy P2PKH / P2SH) ────────────────────────────────────────
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  let bytes = hex === "0" ? [] : hex.match(/../g).map((h) => parseInt(h, 16));
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
function decodeBase58Check(addr) {
  const raw = b58decode(addr);
  const payload = raw.slice(0, -4), chk = raw.slice(-4);
  const h = sha256(sha256(payload));
  for (let i = 0; i < 4; i++) if (h[i] !== chk[i]) throw new Error("bad base58check checksum");
  return { version: payload[0], hash: payload.slice(1) };  // hash = 20 bytes
}

// Known legacy version bytes: P2PKH (0x00 main / 0x6f test/regtest), P2SH (0x05 main / 0xc4 test).
const P2PKH = new Set([0x00, 0x6f]), P2SH = new Set([0x05, 0xc4]);

// Which coin an address belongs to, by network prefix — so the app can reject a BTC address where a
// QBT one is needed (or vice versa), which would otherwise send funds to an unspendable cross-chain
// output. Qbit is p2mr/bech32m only (no legacy base58); Bitcoin has bech32 + base58.
const BTC_HRPS = ["bcrt", "bc", "tb", "sb"];
const QBIT_HRPS = ["qbrt", "qbt", "tqb", "qb"];
export function addressCoin(addr) {
  const l = (addr || "").trim().toLowerCase();
  for (const h of QBIT_HRPS) if (l.startsWith(h + "1")) { try { decodeBech32(l); return "qbit"; } catch { return null; } }
  for (const h of BTC_HRPS) if (l.startsWith(h + "1")) { try { decodeBech32(l); return "btc"; } catch { return null; } }
  if (/^[1235mn]/.test((addr || "").trim())) { try { addressToScriptPubKey(addr.trim()); return "btc"; } catch { /* not base58 */ } }   // btc legacy
  return null;
}
// The coin an address's HRP maps to ("btc" | "qbit"), or null if unknown — split out from decode so
// addressToScriptPubKey can ENFORCE the network instead of silently cross-encoding (see below).
export function addressHrpCoin(addr) {
  const l = (addr || "").trim().toLowerCase();
  const sep = l.lastIndexOf("1");
  if (sep < 1) return null;
  const hrp = l.slice(0, sep);
  if (QBIT_HRPS.includes(hrp)) return "qbit";
  if (BTC_HRPS.includes(hrp)) return "btc";
  return null;
}

export function addressToScriptPubKey(addr, { coin } = {}) {
  // HRP confusion guard: an optional expected "btc"|"qbit". Without it the decoder HAPPILY turns a
  // qbit/bech32m address into a raw witness spk — e.g. a qbrt1… (witness v2) used as a BTC destination
  // yields an undefined-witness-version program, which on Bitcoin is ANYONE-CAN-SPEND. Callers that
  // know the target chain (webapp, maker-bot) pass `coin` and get a hard failure on a mismatch.
  let bechErr;
  try {
    const { hrp, witver, program } = decodeBech32(addr);
    if (coin) {
      if (coin === "btc" && !BTC_HRPS.includes(hrp)) throw new Error(`address hrp "${hrp}" is not a Bitcoin network`);
      if (coin === "qbit" && !QBIT_HRPS.includes(hrp)) throw new Error(`address hrp "${hrp}" is not a Qbit network`);
    }
    return witnessSpk(witver, program);
  } catch (e) {
    bechErr = e;
    if (coin && (coin === "btc" ? BTC_HRPS : QBIT_HRPS).length) throw e;   // hrp mismatch → fail fast with the real reason
  }
  try {
    const { version, hash } = decodeBase58Check(addr);
    if (hash.length !== 20) throw new Error("bad legacy hash length");
    if (coin === "qbit") throw new Error("base58 legacy is not a Qbit address format");
    if (P2PKH.has(version)) return concatBytes(u8(0x76, 0xa9, 0x14), hash, u8(0x88, 0xac));  // OP_DUP HASH160 <20> EQUALVERIFY CHECKSIG
    if (P2SH.has(version)) return concatBytes(u8(0xa9, 0x14), hash, u8(0x87));                // HASH160 <20> EQUAL
    throw new Error(`unrecognized version 0x${version.toString(16)}`);
  } catch (b58Err) {
    throw new Error(`unrecognized address "${addr}" (bech32: ${bechErr.message}; base58: ${b58Err.message})`);
  }
}
