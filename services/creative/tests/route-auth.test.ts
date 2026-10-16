import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The password is read on first REQUEST, cached per process — so each test needs a fresh
// module instance to isolate its secret file, exactly as the gateway-provider tests do.
async function freshAuth() {
  vi.resetModules();
  return (await import("../agent/channels/eve.js")).basicFromSecretFile;
}

function basic(user: string, pass: string): Request {
  const encoded = Buffer.from(`${user}:${pass}`).toString("base64");
  return new Request("https://creative.test/eve/v1/session", {
    method: "POST",
    headers: { authorization: `Basic ${encoded}` },
  });
}

describe("creative route auth", () => {
  let dir: string;
  let pwPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eve-routeauth-"));
    pwPath = join(dir, "route-password");
    writeFileSync(pwPath, "s3cret-route-password\n", "utf8");
    process.env["EVE_ROUTE_PASSWORD_FILE"] = pwPath;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["EVE_ROUTE_PASSWORD_FILE"];
  });

  it("accepts the correct credential (trailing newline in the secret file is trimmed)", async () => {
    const auth = await freshAuth();
    const result = await auth(basic("eve", "s3cret-route-password"));
    expect(result).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    const auth = await freshAuth();
    expect(await auth(basic("eve", "wrong"))).toBeFalsy();
  });

  it("rejects a wrong username even with the right password", async () => {
    const auth = await freshAuth();
    expect(await auth(basic("someone-else", "s3cret-route-password"))).toBeFalsy();
  });

  it("rejects a request with no Authorization header — this is the production default", async () => {
    const auth = await freshAuth();
    const bare = new Request("https://creative.test/eve/v1/session", { method: "POST" });
    expect(await auth(bare)).toBeFalsy();
  });

  // An empty secret file must NOT degrade into "anyone sending an empty password gets in".
  // Failing loudly is the only safe reading of an empty credential.
  it("throws on an empty secret file rather than authenticating an empty password", async () => {
    writeFileSync(pwPath, "\n", "utf8");
    const auth = await freshAuth();
    await expect(async () => auth(basic("eve", ""))).rejects.toThrow(/secret file is empty/);
  });

  it("throws a path-only error when the secret file is missing", async () => {
    process.env["EVE_ROUTE_PASSWORD_FILE"] = join(dir, "does-not-exist");
    const auth = await freshAuth();
    await expect(async () => auth(basic("eve", "whatever"))).rejects.toThrow(
      `secret file not readable: ${join(dir, "does-not-exist")}`,
    );
  });

  // Regression guard for the trap already paid for once in lib/gateway-provider.ts: `eve build`
  // evaluates this module, and a build has no secrets. Importing it must touch no file.
  it("reads nothing at import — a credential-free build must work", async () => {
    process.env["EVE_ROUTE_PASSWORD_FILE"] = join(dir, "does-not-exist");
    await expect(freshAuth()).resolves.toBeTypeOf("function");
  });
});
