import { describe, it, expect } from "vitest";
import { defineCredentialType, runCredentialTest } from "../src/credential.js";
import { RequestError } from "../src/request-error.js";

const apiKey = defineCredentialType<{ kind: "api_key"; integration: string; secretFile: string }>({
  kind: "api_key",
  validate: (c) => (c.secretFile.trim() === "" ? ["secretFile is empty"] : []),
  test: async (_c, { request }) => {
    const me = await request.json<{ email: string }>("https://vendor.test/me");
    return { ok: true, identity: me.email };
  },
});

describe("credential types", () => {
  it("validates before anything is stored", () => {
    expect(apiKey.validate({ kind: "api_key", integration: "v", secretFile: "" })).toEqual(["secretFile is empty"]);
    expect(apiKey.validate({ kind: "api_key", integration: "v", secretFile: "v_key" })).toEqual([]);
  });

  it("a passing test names the identity, never the secret", async () => {
    const request = { json: async () => ({ email: "owner@example.test" }) } as never;
    const r = await runCredentialTest(apiKey, { kind: "api_key", integration: "v", secretFile: "v_key" }, { request });
    expect(r).toEqual({ ok: true, identity: "owner@example.test" });
  });

  it("a failing test comes back as one of the four kinds, never as a throw", async () => {
    const request = { json: async () => { throw new RequestError("not_authorised", "vendor refused the key", { integration: "v", status: 401 }); } } as never;
    const r = await runCredentialTest(apiKey, { kind: "api_key", integration: "v", secretFile: "v_key" }, { request });
    expect(r).toEqual({ ok: false, kind: "not_authorised", message: "vendor refused the key" });
  });

  it("an unexpected throw still comes back as a down, not as an exception", async () => {
    const request = { json: async () => { throw new TypeError("boom"); } } as never;
    const r = await runCredentialTest(apiKey, { kind: "api_key", integration: "v", secretFile: "v_key" }, { request });
    expect(r).toMatchObject({ ok: false, kind: "down" });
  });

  it("a credential holds file names and references, never a secret value", () => {
    const c = { kind: "api_key", integration: "v", secretFile: "v_key" } as const;
    expect(Object.values(c).every((v) => typeof v === "string" && !v.includes("Bearer"))).toBe(true);
    // The type has no field a secret could live in — this is a compile-time property, pinned here
    // as a reminder for whoever adds the next field.
    expect(Object.keys(c).sort()).toEqual(["integration", "kind", "secretFile"]);
  });

  it("a real secret value never appears in the serialised credential or a test() result, on success or on failure", async () => {
    const secretValue = "sk-live-do-not-leak-this-9f2c7";
    // The credential the console would store — it names the secret's FILE, never the value.
    const cred = { kind: "api_key", integration: "v", secretFile: "v_key" } as const;

    // A well-behaved test() reads the secret from wherever secretFile points (never from the
    // credential object, which has no field for it), uses it in the request, and never lets it
    // reach the message it returns or throws — the invariant this test proves.
    const type = defineCredentialType<{ kind: "api_key"; integration: string; secretFile: string }>({
      kind: "api_key",
      validate: () => [],
      test: async (_c, { request }) => {
        const me = await request.json<{ email: string }>("https://vendor.test/me", {
          headers: { Authorization: `Bearer ${secretValue}` },
        });
        return { ok: true, identity: me.email };
      },
    });

    const okRequest = { json: async () => ({ email: "owner@example.test" }) } as never;
    const okResult = await runCredentialTest(type, cred, { request: okRequest });
    expect(JSON.stringify(cred)).not.toContain(secretValue);
    expect(JSON.stringify(okResult)).not.toContain(secretValue);

    const failingRequest = {
      json: async () => {
        throw new RequestError("not_authorised", "vendor refused the key", { integration: "v", status: 401 });
      },
    } as never;
    const failResult = await runCredentialTest(type, cred, { request: failingRequest });
    expect(JSON.stringify(cred)).not.toContain(secretValue);
    expect(JSON.stringify(failResult)).not.toContain(secretValue);
  });
});
