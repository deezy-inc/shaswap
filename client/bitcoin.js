// Bitcoin leg: P2WSH HTLC + BIP143 signing (ECDSA via @noble/secp256k1). Ports reference/bitcoin_htlc.py.
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import * as secp from "@noble/secp256k1";
import { concatBytes, u8, leU, compactSize, pushData, scriptNum, checkLocktime } from "./encoding.js";
import { segwitAddr } from "./p2mr.js";

// noble/secp256k1 v2 needs its hash primitives provided.
secp.hashes.sha256 = sha256;
secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);

const OP = { IF: 0x63, ELSE: 0x67, ENDIF: 0x68, DROP: 0x75, SIZE: 0x82, EQUALVERIFY: 0x88, SHA256: 0xa8, CHECKSIG: 0xac, CLTV: 0xb1 };
const dsha = (b) => sha256(sha256(b));

export const compressedPub = (privBytes) => secp.getPublicKey(privBytes, true);

function derFromCompact(compact64) {                    // r||s (32+32 BE) -> DER
  const trim = (x) => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; x = x.slice(i); return (x[0] & 0x80) ? concatBytes(u8(0x00), x) : x; };
  const r = trim(compact64.slice(0, 32)), s = trim(compact64.slice(32, 64));
  return concatBytes(u8(0x30, r.length + s.length + 4, 0x02, r.length), r, u8(0x02, s.length), s);
}
export function ecdsaSign(privBytes, digest32) {       // low-S DER + SIGHASH_ALL byte
  // prehash:false -> sign the (already double-SHA256'd) sighash as-is, not sha256(sighash)
  const compact = secp.sign(digest32, privBytes, { lowS: true, prehash: false }); // Uint8Array(64), low-S
  return concatBytes(derFromCompact(compact), u8(0x01));
}

// OP_IF OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <H> OP_EQUALVERIFY <claim> CHECKSIG OP_ELSE <cltv> CLTV DROP <refund> CHECKSIG OP_ENDIF
// OP_SIZE 32 OP_EQUALVERIFY pins the preimage length to 32 bytes so the same secret satisfies both
// legs' hashlocks identically (defense against a differently-sized preimage across chains).
export function htlcWitnessScript(hashH, claimPub, refundPub, locktime) {
  if (hashH.length !== 32 || claimPub.length !== 33 || refundPub.length !== 33) throw new Error("bad key/hash length");
  checkLocktime(locktime);
  return concatBytes(
    u8(OP.IF, OP.SIZE), pushData(scriptNum(32)), u8(OP.EQUALVERIFY),
    u8(OP.SHA256), pushData(hashH), u8(OP.EQUALVERIFY), pushData(claimPub), u8(OP.CHECKSIG),
    u8(OP.ELSE), pushData(scriptNum(locktime)), u8(OP.CLTV, OP.DROP), pushData(refundPub), u8(OP.CHECKSIG), u8(OP.ENDIF));
}
// A CLTV operand is a block HEIGHT in this protocol — shared validator lives in encoding.js
// (re-exported here so existing bitcoin.js callers keep working).
export { checkLocktime } from "./encoding.js";
export const p2wshSpk = (ws) => concatBytes(u8(0x00, 0x20), sha256(ws));
export const p2wshAddr = (ws, hrp = "bcrt") => segwitAddr(hrp, 0, sha256(ws));

// vin: [{txidLE, vout, sequence}], vout: [{value, spk}]
export function bip143Sighash({ version, vin, vout, inputIndex, scriptCode, amount, locktime, hashType = 1 }) {
  if (hashType !== 1) throw new Error(`unsupported sighash type ${hashType} (only SIGHASH_ALL is implemented)`);
  const hashPrevouts = dsha(concatBytes(...vin.map((i) => concatBytes(i.txidLE, leU(i.vout, 4)))));
  const hashSequence = dsha(concatBytes(...vin.map((i) => leU(i.sequence, 4))));
  const hashOutputs = dsha(concatBytes(...vout.map((o) => concatBytes(leU(o.value, 8), compactSize(o.spk.length), o.spk))));
  const inp = vin[inputIndex];
  return dsha(concatBytes(
    leU(version, 4), hashPrevouts, hashSequence, inp.txidLE, leU(inp.vout, 4),
    compactSize(scriptCode.length), scriptCode, leU(amount, 8), leU(inp.sequence, 4),
    hashOutputs, leU(locktime, 4), leU(hashType, 4)));
}

export function serializeSegwit(version, vin, vout, witnesses, locktime) {
  const parts = [leU(version, 4), u8(0x00, 0x01), compactSize(vin.length)];
  for (const i of vin) parts.push(i.txidLE, leU(i.vout, 4), u8(0x00), leU(i.sequence, 4)); // empty scriptSig
  parts.push(compactSize(vout.length));
  for (const o of vout) parts.push(leU(o.value, 8), compactSize(o.spk.length), o.spk);
  for (const w of witnesses) { parts.push(compactSize(w.length)); for (const it of w) parts.push(compactSize(it.length), it); }
  parts.push(leU(locktime, 4));
  return concatBytes(...parts);
}

// Fork replay-protection marker: an OP_RETURN whose payload exceeds the 83-byte datacarrier policy
// cap. A BIP-110 (RDTS) chain will not relay or mine a transaction carrying it, while stock Core
// will — so a sweep built WITH the marker settles on exactly one side of a policy-fork pair. Fixed,
// greppable content; the protection is the SIZE, not the bytes. spk = OP_RETURN OP_PUSHDATA1 <100B>.
export const REPLAY_PAYLOAD_BYTES = 100;
export function replayMarkerSpk() {
  const payload = new Uint8Array(REPLAY_PAYLOAD_BYTES);
  payload.set(new TextEncoder().encode("shaswap replay guard: this transaction is intended for exactly one chain of a policy fork.").slice(0, REPLAY_PAYLOAD_BYTES));
  return concatBytes(u8(0x6a, 0x4c, REPLAY_PAYLOAD_BYTES), payload);
}

// Build a signed P2WSH HTLC spend. branch: "claim" (needs preimage) or "refund" (after CLTV).
// `replay: true` appends the zero-value replay marker output (signed with the rest, so it can't be
// stripped without invalidating the signature — required by the coordinator on replay-protected legs).
// This is the LAST fail-closed point before a signature exists: validate the economics, because
// callers may be building from coordinator-reported (hostile) data.
export function btcSpend({ prevTxidLE, vout, amount, ws, priv, destSpk, outVal, branch, preimage, locktime = 0, extraOut = null, replay = false }) {
  if (branch !== "claim" && branch !== "refund") throw new Error(`bad branch "${branch}"`);
  // A claim's preimage must be the real 32-byte secret — EXCEPT the empty placeholder used when
  // pre-signing the watchtower ladder preimage-LESS (the participant doesn't know the secret yet;
  // the coordinator splices it into the witness at broadcast, which can't alter the signed outputs).
  // Rejecting the placeholder silently disarmed every participant-side safety net.
  if (branch === "claim" && preimage.length !== 32 && preimage.length !== 0) throw new Error(`claim preimage must be 32 bytes, or empty when pre-signing for the watchtower (got ${preimage.length})`);
  if (branch === "refund") checkLocktime(locktime);
  amount = BigInt(amount); outVal = BigInt(outVal);
  if (amount <= 0n) throw new Error(`bad input amount ${amount}`);
  if (outVal <= 0n || outVal > amount) throw new Error(`bad outVal ${outVal} against input ${amount} (fee would eat the output)`);
  if (prevTxidLE.length !== 32) throw new Error("prevTxidLE must be 32 bytes");
  if (!Number.isSafeInteger(vout) || vout < 0) throw new Error(`bad vout ${vout}`);
  const seq = branch === "refund" ? 0xfffffffe : 0xffffffff;
  const vin = [{ txidLE: prevTxidLE, vout, sequence: seq }];
  const outs = [{ value: outVal, spk: destSpk }];
  // Optional second output — the coordinator fee, on a successful claim. It's inside the signed set of
  // outputs (the sighash below covers `outs`), so it can't be altered without re-signing.
  if (extraOut) {
    const ev = BigInt(extraOut.value);
    if (ev <= 0n || outVal + ev > amount) throw new Error(`bad extraOut value ${ev} (outputs exceed the input)`);
    outs.push({ value: ev, spk: extraOut.spk });
  }
  if (replay) outs.push({ value: 0n, spk: replayMarkerSpk() });
  const sig = ecdsaSign(priv, bip143Sighash({ version: 2, vin, vout: outs, inputIndex: 0, scriptCode: ws, amount, locktime }));
  const witness = branch === "claim" ? [sig, preimage, u8(0x01), ws] : [sig, new Uint8Array(0), ws];
  return serializeSegwit(2, vin, outs, [witness], locktime);
}
