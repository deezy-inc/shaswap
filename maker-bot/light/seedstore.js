// Seed phrase encrypted at rest. The mnemonic is sealed with AES-256-GCM under a key stretched from the
// operator's password by scrypt (N=2^15, r=8, p=1 — ~100ms+ per guess), fresh random salt + nonce per
// write, stored 0600. GCM authenticates, so a wrong password (or a tampered file) fails loudly rather
// than yielding garbage keys. The decrypted seed lives only in process memory while the bot runs.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";

const KDF = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export function sealSeed(path, mnemonic, password) {
  if (!password || password.length < 8) throw new Error("password must be at least 8 characters");
  const salt = randomBytes(16), nonce = randomBytes(12);
  const key = scryptSync(password, salt, 32, KDF);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(Buffer.from(mnemonic, "utf8")), c.final()]);
  const out = { v: 1, kdf: "scrypt", N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString("hex"), nonce: nonce.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
  renameSync(tmp, path);
}

export function openSeed(path, password) {
  if (!existsSync(path)) throw new Error(`no sealed seed at ${path} — run with --init to create one`);
  const f = JSON.parse(readFileSync(path, "utf8"));
  const key = scryptSync(password, Buffer.from(f.salt, "hex"), 32, { N: f.N, r: f.r, p: f.p, maxmem: KDF.maxmem });
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(f.nonce, "hex"));
  d.setAuthTag(Buffer.from(f.tag, "hex"));
  try { return Buffer.concat([d.update(Buffer.from(f.ct, "hex")), d.final()]).toString("utf8"); }
  catch { throw new Error("wrong password (or the seed file is corrupt)"); }
}

// Prompt on the tty without echoing; falls back to LIGHT_PASSWORD for headless/systemd runs.
export async function promptPassword(promptText = "wallet password: ") {
  if (process.env.LIGHT_PASSWORD) return process.env.LIGHT_PASSWORD;
  if (!process.stdin.isTTY) throw new Error("no TTY — set LIGHT_PASSWORD for headless runs");
  process.stdout.write(promptText);
  process.stdin.setRawMode(true); process.stdin.resume();
  let pw = "";
  return new Promise((resolve, reject) => {
    const onData = (ch) => {
      const s = ch.toString("utf8");
      for (const c of s) {
        if (c === "\r" || c === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off("data", onData); process.stdout.write("\n"); return resolve(pw); }
        if (c === "") { process.stdin.setRawMode(false); return reject(new Error("aborted")); }   // ^C
        if (c === "" || c === "\b") pw = pw.slice(0, -1);
        else pw += c;
      }
    };
    process.stdin.on("data", onData);
  });
}
