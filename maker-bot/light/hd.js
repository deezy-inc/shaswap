// One seed phrase → keys for BOTH chains, with a one-way wall between the branches.
//
//   BIP39 mnemonic ── PBKDF2 ──► 64-byte master seed
//     ├─ BIP32 HARDENED m/84'/0'/0'/0/i ──► secp256k1 keys (BTC: standard BIP84 P2WPKH)
//     └─ HKDF-SHA256("qbit-swap-mm/slh-dsa/v1", index) ──► 128-byte keygen seeds ──► SLH-DSA (QBT p2mr)
//
// Post-quantum reasoning (why sharing one seed is safe): the master seed is SYMMETRIC material — it is
// never used as an EC key, so Shor's algorithm never applies to it. A quantum adversary who recovers
// every BTC child key from its on-chain pubkeys still faces hash preimages (HMAC/HKDF, hardened BIP32)
// to reach the master or the QBT branch — and Grover's quadratic speedup leaves ≥128-bit quantum
// security there. So the QBT branch keeps SLH-DSA's full post-quantum guarantees even if the entire
// secp256k1 branch is broken. Hardened derivation also means no xpub can link or expose the branches.
//
// PORTABILITY NOTE: BTC follows BIP84, so the phrase restores the BTC side in any standard wallet.
// There is no standard for SLH-DSA derivation paths yet, so the QBT branch is self-consistent to this
// bot (deterministic from the phrase, but qbitd would not derive the same addresses).
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { encoding, compressedPub, segwitAddr, slhDsaKeygen, singleKeyLeaf, p2mrSpk, p2mrAddress } from "@qbit-swap/client";
const { concatBytes, u8 } = encoding;

export const newMnemonic = () => generateMnemonic(wordlist, 128);            // 12 words
export const checkMnemonic = (m) => validateMnemonic(m, wordlist);
export const mnemonicToSeed = (m) => mnemonicToSeedSync(m);                  // 64 bytes

const hash160 = (b) => ripemd160(sha256(b));

// BTC branch: standard BIP84 (m/84'/0'/0'/0/i) P2WPKH — hardened through the account level, so no
// xpub anywhere can bridge toward the master.
export function btcKey(seed, index = 0, hrp = "bc") {
  const node = HDKey.fromMasterSeed(seed).derive(`m/84'/0'/0'/0/${index}`);
  const pub = compressedPub(node.privateKey);
  const h = hash160(pub);
  return {
    priv: node.privateKey, pub,
    spk: concatBytes(u8(0x00, 0x14), h),                                     // P2WPKH
    address: segwitAddr(hrp, 0, h),
    scriptCode: concatBytes(u8(0x76, 0xa9, 0x14), h, u8(0x88, 0xac)),        // BIP143 scriptCode for P2WPKH
  };
}

// QBT branch: HKDF with a versioned, per-index domain label → SLH-DSA keygen seed → single-key p2mr
// leaf (`pk()` template: <push pub> OP_CHECKSIGPQC). Spend witness: [sig, leaf, 0xc1].
export async function qbitKey(seed, index = 0, hrp = "qb") {
  const kseed = hkdf(sha256, seed, undefined, new TextEncoder().encode(`qbit-swap-mm/slh-dsa/v1/${index}`), 128);
  const kp = await slhDsaKeygen(kseed);
  const leaf = singleKeyLeaf(kp.pk);
  return { pk: kp.pk, sk: kp.sk, leaf, spk: p2mrSpk(leaf), address: p2mrAddress(leaf, hrp) };
}
