import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";

// Set env before module import so auth.ts picks up the secret.
// NODE_ENV is "test" so fail-closed production guards don't fire.
beforeAll(() => {
  process.env.CONSOLE_SESSION_SECRET = "test-secret-for-unit";
  process.env.CONSOLE_ALLOWED_EMAILS = "alice@example.com,bob@example.com";
});

// Dynamic import so env is set first
const authModule = () => import("../lib/auth");

describe("sign / verify", () => {
  it("round-trips an email", async () => {
    const { sign, verify } = await authModule();
    const cookie = await sign("alice@example.com");
    expect(await verify(cookie)).toBe("alice@example.com");
  });

  it("returns null for a tampered signature", async () => {
    const { sign, verify } = await authModule();
    const cookie = await sign("alice@example.com");
    // Replace the last 3 chars of the sig portion to corrupt it
    const tampered = cookie.slice(0, -3) + "xxx";
    expect(await verify(tampered)).toBeNull();
  });

  it("returns null for a tampered body", async () => {
    const { sign, verify } = await authModule();
    const cookie = await sign("alice@example.com");
    // Flip a char in the body portion (before the first dot)
    const dot = cookie.indexOf(".");
    const corruptBody = "X" + cookie.slice(1, dot) + cookie.slice(dot);
    expect(await verify(corruptBody)).toBeNull();
  });

  it("returns null for garbage input", async () => {
    const { verify } = await authModule();
    expect(await verify(undefined)).toBeNull();
    expect(await verify("notacookie")).toBeNull();
    expect(await verify("")).toBeNull();
  });

  it("returns null when body is missing", async () => {
    const { verify } = await authModule();
    expect(await verify(".onlysig")).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const { _signWithExp, verify } = await authModule();
    // exp = 1 second in the past
    const pastExp = Math.floor(Date.now() / 1000) - 1;
    const expiredCookie = await _signWithExp("alice@example.com", pastExp);
    expect(await verify(expiredCookie)).toBeNull();
  });

  it("accepts a token that has not yet expired", async () => {
    const { _signWithExp, verify } = await authModule();
    // exp = 60 seconds in the future
    const futureExp = Math.floor(Date.now() / 1000) + 60;
    const cookie = await _signWithExp("alice@example.com", futureExp);
    expect(await verify(cookie)).toBe("alice@example.com");
  });

  it("returns the email for a valid cookie when the email IS on the allow-list", async () => {
    // CONSOLE_ALLOWED_EMAILS includes alice@example.com (set in beforeAll)
    const { sign, verify } = await authModule();
    const cookie = await sign("alice@example.com");
    expect(await verify(cookie)).toBe("alice@example.com");
  });

  it("returns null for a valid cookie when the email is NOT on the allow-list (I2)", async () => {
    // eve@example.com is a validly-signed, non-expired token but not in the allow-list
    const { sign, verify } = await authModule();
    const cookie = await sign("eve@example.com");
    expect(await verify(cookie)).toBeNull();
  });
});

describe("allowed", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not admit anyone without an explicit development allow-list", async () => {
    vi.stubEnv("CONSOLE_ALLOWED_EMAILS", undefined);
    const { allowed } = await authModule();
    expect(allowed("owner@example.com")).toBe(false);
    expect(allowed("")).toBe(false);
  });

  it("ignores empty allow-list entries", async () => {
    vi.stubEnv("CONSOLE_ALLOWED_EMAILS", " , alice@example.com, ");
    const { allowed } = await authModule();
    expect(allowed("")).toBe(false);
    expect(allowed("alice@example.com")).toBe(true);
  });

  it("returns true for an email in the allow-list", async () => {
    const { allowed } = await authModule();
    expect(allowed("alice@example.com")).toBe(true);
    expect(allowed("bob@example.com")).toBe(true);
  });

  it("returns false for an email not in the allow-list", async () => {
    const { allowed } = await authModule();
    expect(allowed("eve@example.com")).toBe(false);
    expect(allowed("")).toBe(false);
  });
});
