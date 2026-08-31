// Byte helpers + Bitcoin var-length encodings, shared across the swap client.
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils.js";
export { bytesToHex, hexToBytes, concatBytes };

export const u8 = (...xs) => Uint8Array.from(xs);

export function leU(n, bytes) {           // little-endian encode a (BigInt|number) into `bytes`
  n = BigInt(n);
  if (n < 0n || n >= (1n << BigInt(8 * bytes))) throw new RangeError(`leU: ${n} out of range for ${bytes} bytes`);   // never silently wrap a value into a signed tx
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

export function compactSize(n) {
  n = Number(n);
  if (n < 0xfd) return u8(n);
  if (n <= 0xffff) return concatBytes(u8(0xfd), leU(n, 2));
  if (n <= 0xffffffff) return concatBytes(u8(0xfe), leU(n, 4));
  return concatBytes(u8(0xff), leU(n, 8));
}

export function pushData(data) {          // minimal script push of `data`
  const n = data.length;
  if (n < 0x4c) return concatBytes(u8(n), data);
  if (n <= 0xff) return concatBytes(u8(0x4c, n), data);
  if (n <= 0xffff) return concatBytes(u8(0x4d), leU(n, 2), data);
  return concatBytes(u8(0x4e), leU(n, 4), data);
}

export function scriptNum(n) {            // minimal CScriptNum (for CLTV operand)
  n = Number(n);
  if (n === 0) return new Uint8Array(0);
  const neg = n < 0; let a = Math.abs(n); const out = [];
  while (a) { out.push(a & 0xff); a = Math.floor(a / 256); }
  if (out[out.length - 1] & 0x80) out.push(neg ? 0x80 : 0x00);
  else if (neg) out[out.length - 1] |= 0x80;
  return Uint8Array.from(out);
}

// A CLTV operand is a block HEIGHT in this protocol: 0 would make the HTLC instantly refundable
// (watchtower refunds race the claim), a negative one fails OP_CLTV at spend time (BIP-65) and bricks
// the refund path forever, and ≥500000000 switches CLTV to timestamp semantics. Fail closed.
export function checkLocktime(locktime) {
  if (!Number.isSafeInteger(locktime) || locktime <= 0 || locktime >= 500000000)
    throw new Error(`bad HTLC locktime ${locktime} (must be a block height, 1..499999999)`);
}
