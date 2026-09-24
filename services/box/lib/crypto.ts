// services/box/lib/crypto.ts
// AES-256-GCM secret encryption for OAuth refresh tokens at rest.
// Ported from nora/packages/shared/src/crypto.ts. Storage format: base64(IV || ciphertext || authTag).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;        // GCM standard nonce
const TAG_BYTES = 16;       // GCM auth tag

function keyBuf(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("encryption key must be 64 hex chars (32 bytes)");
  return Buffer.from(keyHex, "hex");
}

export function encryptSecret(plaintext: string, keyHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBuf(keyHex), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

export function decryptSecret(encoded: string, keyHex: string): string {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyBuf(keyHex), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function keyFromEnv(varName = "TOKEN_ENC_KEY"): string {
  const k = process.env[varName] ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${varName} must be 64 hex chars (32 bytes)`);
  return k;
}
