import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, keyFromEnv } from "../lib/crypto.js";

const KEY = "0".repeat(64);  // 32 bytes hex

describe("crypto (AES-256-GCM)", () => {
  it("round-trips a secret", () => {
    const enc = encryptSecret("refresh-token-xyz", KEY);
    expect(enc).not.toContain("refresh-token-xyz");
    expect(decryptSecret(enc, KEY)).toBe("refresh-token-xyz");
  });
  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("x", KEY)).not.toBe(encryptSecret("x", KEY));
  });
  it("throws when the key is wrong (auth tag mismatch)", () => {
    const enc = encryptSecret("x", KEY);
    expect(() => decryptSecret(enc, "1".repeat(64))).toThrow();
  });
  it("rejects a malformed key", () => {
    expect(() => encryptSecret("x", "tooshort")).toThrow(/64 hex/i);
  });
  it("keyFromEnv reads + validates", () => {
    process.env["TOKEN_ENC_KEY"] = KEY;
    expect(keyFromEnv()).toBe(KEY);
    process.env["TOKEN_ENC_KEY"] = "bad";
    expect(() => keyFromEnv()).toThrow(/64 hex/i);
    delete process.env["TOKEN_ENC_KEY"];
  });
});
