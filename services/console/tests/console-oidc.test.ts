import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { startSignIn, openFlow, finishSignIn, proofFromValidatedClaims } from "../lib/console-oidc";
const google = "https://accounts.google.com";
const tenant = "12345678-1234-1234-1234-123456789abc";
const microsoft = `https://login.microsoftonline.com/${tenant}/v2.0`;
let key: Awaited<ReturnType<typeof generateKeyPair>>, jwk: Awaited<ReturnType<typeof exportJWK>>;
let claims: Record<string, unknown>, badSignature = false, now = false;
let requestCount = 0;
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("CONSOLE_SESSION_SECRET", "test-secret");
  vi.stubEnv("CONSOLE_OAUTH_REDIRECT", "http://localhost:3000/api/auth/callback");
  for (const provider of ["GOOGLE", "MICROSOFT"]) { vi.stubEnv(`${provider}_CLIENT_ID_CONSOLE`, "client"); vi.stubEnv(`${provider}_CLIENT_SECRET_CONSOLE`, "secret"); }
  vi.stubEnv("MICROSOFT_TENANT_ID_CONSOLE", tenant);
  key = await generateKeyPair("RS256"); jwk = await exportJWK(key.publicKey);
  requestCount = 0; claims = {}; badSignature = false; now = false;
  vi.stubGlobal("fetch", vi.fn(async (input: Request | URL | string) => {
    requestCount++;
    const url = new URL(input instanceof Request ? input.url : String(input));
    const issuer = url.host === "accounts.google.com" ? google : microsoft;
    if (url.pathname.endsWith("openid-configuration")) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
    if (url.pathname.endsWith("/keys")) return Response.json({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] });
    if (url.pathname.endsWith("/token")) {
      const signing = badSignature ? (await generateKeyPair("RS256")).privateKey : key.privateKey;
      const token = await new SignJWT({ nonce: "nonce", ...(issuer === microsoft ? { tid: tenant } : {}), ...claims }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(typeof claims.iss === "string" ? claims.iss : issuer).setAudience(typeof claims.aud === "string" ? claims.aud : "client").setSubject(typeof claims.sub === "string" ? claims.sub : "stable-subject").setIssuedAt().setExpirationTime(now ? "-1m" : "5m").sign(signing);
      return Response.json({ access_token: "discarded", token_type: "Bearer", id_token: token });
    }
    throw new Error("Unexpected outbound request in local provider test");
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const flow = (provider: "google" | "microsoft" = "google") => ({ provider, state: "state", nonce: "nonce", verifier: "v".repeat(43), next: "/" });
const callback = () => new URL("http://localhost:3000/api/auth/callback?code=local&state=state");
describe("OIDC client against a local simulated provider response", () => {
  it.each(["google", "microsoft"] as const)("validates %s provider identity with the maintained client", async provider => {
    expect((await finishSignIn(callback(), flow(provider))).identity).toEqual({ issuer: provider === "google" ? google : microsoft, subject: "stable-subject", ...(provider === "microsoft" ? { tenantId: tenant } : {}) });
  });
  it("uses PKCE, state, nonce, sign-in-only scopes and an account picker", async () => {
    const started = await startSignIn("google", "/agents");
    for (const parameter of ["state", "nonce", "code_challenge"]) expect(started.url.searchParams.get(parameter)).toBeTruthy();
    expect(started.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.url.searchParams.get("scope")).toBe("openid email");
    expect(started.url.searchParams.get("prompt")).toBe("select_account");
    expect(await openFlow(started.cookie)).toMatchObject({ provider: "google", next: "/agents" });
    expect(await openFlow(started.cookie + "x")).toBeNull();
    const parts = started.cookie.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    payload.provider = "microsoft"; payload.invitation = "a".repeat(43);
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(await openFlow(parts.join("."))).toBeNull();
  });
  it.each([{ iss: "https://wrong.example" }, { aud: "wrong-client" }, { nonce: "wrong-nonce" }])("refuses wrong issuer/audience/nonce: %s", async changed => {
    claims = changed; await expect(finishSignIn(callback(), flow())).rejects.toThrow();
  });
  it("refuses wrong state before exchanging a code", async () => {
    const url = callback(); url.searchParams.set("state", "wrong");
    await expect(finishSignIn(url, flow())).rejects.toThrow();
    expect(requestCount).toBe(1); // discovery only
  });
  it("validates the actual JWS signature instead of just trusting parsed claims", async () => {
    badSignature = true; await expect(finishSignIn(callback(), flow())).rejects.toThrow();
  });
  it("refuses expired ID tokens", async () => { now = true; await expect(finishSignIn(callback(), flow())).rejects.toThrow(); });
  it("refuses an incorrect Microsoft tenant and personal/common authorities", async () => {
    claims = { tid: "another-tenant" }; await expect(finishSignIn(callback(), flow("microsoft"))).rejects.toThrow();
    for (const value of ["common", "organizations", "consumers", "9188040d-6c67-4c5b-b112-36a304b66dad"]) {
      vi.stubEnv("MICROSOFT_TENANT_ID_CONSOLE", value);
      expect(() => proofFromValidatedClaims("microsoft", {})).toThrow();
    }
  });
  it("never maps identities through email equality", () => {
    const first = proofFromValidatedClaims("google", { iss: google, sub: "one", email: "same@example.test" });
    const second = proofFromValidatedClaims("google", { iss: google, sub: "two", email: "same@example.test" });
    expect(first.identity).not.toEqual(second.identity);
    expect(first.identity).not.toHaveProperty("email");
  });
});
