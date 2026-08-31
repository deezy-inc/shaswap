// Minimal BIP-144 segwit transaction codec. Ports reference/txcodec.py. Fail closed on malformed input:
// any consumer (splicePreimage, hasReplayMarker) must never act on silently-corrupted data.
import { concatBytes, u8, leU, compactSize } from "./encoding.js";

class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  take(n) {
    if (this.i + n > this.b.length) throw new Error("truncated tx");
    const v = this.b.subarray(this.i, this.i + n); this.i += n; return v;
  }
  u(n) { let x = 0n; const v = this.take(n); for (let k = n - 1; k >= 0; k--) x = (x << 8n) | BigInt(v[k]); return x; }
  num(n) { return Number(this.u(n)); }
  cs() {
    const x = this.num(1);
    if (x < 0xfd) return x;
    if (x === 0xfd) { const y = this.num(2); if (y < 0xfd) throw new Error("non-minimal compactSize"); return y; }
    if (x === 0xfe) { const y = this.num(4); if (y < 0x10000) throw new Error("non-minimal compactSize"); return y; }
    const y = Number(this.u(8)); if (y < 0x100000000) throw new Error("non-minimal compactSize"); return y;
  }
}

export function parseTx(hexOrBytes) {
  const bytes = typeof hexOrBytes === "string"
    ? (() => { const m = hexOrBytes.match(/../g); if (!m || m.length * 2 !== hexOrBytes.length) throw new Error("bad tx hex"); return Uint8Array.from(m.map((h) => parseInt(h, 16))); })()
    : hexOrBytes;
  const r = new Reader(bytes);
  const version = r.num(4);
  let segwit = false;
  if (r.b[r.i] === 0x00 && r.b[r.i + 1] === 0x01) { r.take(2); segwit = true; }
  const vin = [];
  for (let k = r.cs(); k > 0; k--) { const prevout = r.take(32).slice(); const vout = r.num(4); const script = r.take(r.cs()).slice(); const seq = r.num(4); vin.push([prevout, vout, script, seq]); }
  const vout = [];
  for (let k = r.cs(); k > 0; k--) { const val = r.u(8); const spk = r.take(r.cs()).slice(); vout.push([val, spk]); }
  const wit = vin.map(() => []);
  if (segwit) for (let k = 0; k < vin.length; k++) { const items = []; for (let j = r.cs(); j > 0; j--) items.push(r.take(r.cs()).slice()); wit[k] = items; }
  const locktime = r.num(4);
  if (r.i !== bytes.length) throw new Error("trailing bytes after tx");
  if (segwit && wit.length !== vin.length) throw new Error("witness count != vin count");
  if (!segwit && wit.some((w) => w.length)) throw new Error("non-segwit tx carries witness");
  return { version, vin, vout, wit, locktime };
}

export function serializeTx(t) {
  if (t.wit.length !== t.vin.length) throw new Error("wit length must equal vin length");
  const hasWit = t.wit.some((w) => w.length > 0);
  const parts = [leU(t.version, 4), ...(hasWit ? [u8(0x00, 0x01)] : []), compactSize(t.vin.length)];
  for (const [prevout, vout, script, seq] of t.vin) parts.push(prevout, leU(vout, 4), compactSize(script.length), script, leU(seq, 4));
  parts.push(compactSize(t.vout.length));
  for (const [val, spk] of t.vout) parts.push(leU(val, 8), compactSize(spk.length), spk);
  if (hasWit) for (const stack of t.wit) { parts.push(compactSize(stack.length)); for (const item of stack) parts.push(compactSize(item.length), item); }
  parts.push(leU(t.locktime, 4));
  return concatBytes(...parts);
}
