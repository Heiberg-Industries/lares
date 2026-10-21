import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
const api = vi.hoisted(() => ({ profile: vi.fn(), calendar: vi.fn(), setCredentials: vi.fn() }));
vi.mock("googleapis", () => ({ google: { auth: { OAuth2: class { setCredentials = api.setCredentials; } },
  gmail: () => ({ users: { getProfile: api.profile } }), calendar: () => ({ calendarList: { get: api.calendar } }) } }));
vi.mock("../lib/db", () => ({ pool: {} }));
import { GOOGLE_PERSONAL_READ_SCOPES, googlePersonalConsentScopes } from "@lares/agent-kit/personal-consent";
import { GOOGLE_SCOPES } from "../lib/accounts";
import { startAccountConsent, finishAccountConsent, callbackRedirect } from "../lib/account-oauth";
import { accountSessionHash, type AccountFlow } from "../lib/account-oauth-state";
const issuer = "https://accounts.google.com";
const flow: AccountFlow = { power: "read", provider: "google", intent: "new", memberId: "member-a", sessionHash: accountSessionHash("session"), org: "example", clientId: "data-client", state: "state", nonce: "nonce", verifier: "v".repeat(43) };
let claims: Record<string, unknown>, response: Record<string, unknown>, badSignature: boolean;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("CONSOLE_OAUTH_REDIRECT", "http://localhost:3000/api/auth/callback");
  vi.stubEnv("GOOGLE_CLIENT_ID_EXAMPLE", "data-client"); vi.stubEnv("GOOGLE_CLIENT_SECRET_EXAMPLE", "data-secret");
  vi.stubEnv("GOOGLE_CLIENT_ID_CONSOLE", "sign-in-client");
  const key = await generateKeyPair("RS256"), jwk = await exportJWK(key.publicKey);
  claims = {}; response = {}; badSignature = false;
  api.profile.mockResolvedValue({ data: { emailAddress: "own@example.test" } });
  api.calendar.mockResolvedValue({ data: { id: "own-calendar", primary: true, accessRole: "owner", summary: "Calendar" } });
  vi.stubGlobal("fetch", vi.fn(async (input: Request | URL | string) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("openid-configuration")) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
    if (url.pathname.endsWith("/keys")) return Response.json({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] });
    if (url.pathname.endsWith("/token")) {
      const signing = badSignature ? (await generateKeyPair("RS256")).privateKey : key.privateKey;
      const id = await new SignJWT({ nonce: "nonce", ...claims }).setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(String(claims.iss ?? issuer)).setSubject(String(claims.sub ?? "provider-subject"))
        .setAudience(String(claims.aud ?? "data-client")).setIssuedAt().setExpirationTime("5m").sign(signing);
      return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", scope: GOOGLE_SCOPES.join(" "), id_token: id, ...response });
    }
    throw new Error("Unexpected outbound request");
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const callback = () => new URL("http://localhost:3000/api/accounts/google/callback?code=code&state=state");
describe("Google account consent against local simulated provider", () => {
  it("uses data client, distinct callback, PKCE, state, nonce, offline consent and identity scope", async () => {
    const result = await startAccountConsent({ memberId: "member-a", session: "session", org: "example", loginHint: "hint@example.test" });
    expect(result.flow).toMatchObject({ memberId: "member-a", sessionHash: accountSessionHash("session"), clientId: "data-client", intent: "new" });
    expect(result.url.searchParams.get("client_id")).toBe("data-client");
    expect(result.url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/accounts/google/callback");
    expect(result.url.searchParams.get("scope")).toBe(GOOGLE_PERSONAL_READ_SCOPES.join(" "));
    expect(result.flow.power).toBe("read");
    expect(result.url.searchParams.get("code_challenge_method")).toBe("S256");
    for (const key of ["nonce", "state", "code_challenge"]) expect(result.url.searchParams.get(key)).toBeTruthy();
  });
  it("validates identity and owns both resources with the same grant, never linking by email", async () => {
    claims = { email: "unrelated@example.test" };
    const result = await finishAccountConsent(callback(), flow);
    expect(await result.adapter.verifyAccount(null)).toEqual({ issuer, subject: "provider-subject", label: "own@example.test" });
    expect(api.setCredentials).toHaveBeenCalledWith({ access_token: "access", refresh_token: "refresh" });
    expect(api.profile).toHaveBeenCalledWith({ userId: "me" });
    expect(api.calendar).toHaveBeenCalledWith({ calendarId: "primary" });
    expect(result.material.scopes).toEqual(GOOGLE_SCOPES);
  });
  it.each([{ iss: "https://wrong.example" }, { aud: "sign-in-client" }, { nonce: "wrong" }])("refuses identity claims %s before resource reads", async changed => {
    claims = changed; await expect(finishAccountConsent(callback(), flow)).rejects.toThrow(); expect(api.profile).not.toHaveBeenCalled();
  });
  it("requires valid signature", async () => { badSignature = true; await expect(finishAccountConsent(callback(), flow)).rejects.toThrow(); expect(api.profile).not.toHaveBeenCalled(); });
  it.each([{ refresh_token: undefined }, { scope: undefined }, { scope: "openid" }])("refuses incomplete actual consent %s", async changed => {
    response = changed; await expect(finishAccountConsent(callback(), flow)).rejects.toThrow(); expect(api.profile).not.toHaveBeenCalled();
  });
  it.each([{ primary: false }, { accessRole: "writer" }, { id: null }])("refuses unowned/nonprimary calendar %s", async changed => {
    api.calendar.mockResolvedValue({ data: { id: "own", primary: true, accessRole: "owner", ...changed } });
    await expect(finishAccountConsent(callback(), flow)).rejects.toThrow();
  });
  it("returns to member page with encoded neutral flash text", () => { expect(callbackRedirect("https://console.example", { added: "Saved consent" })).toBe("https://console.example/membership?added=Saved+consent"); });
});

it("requests the closed send profile only after explicit selection", async () => {
  const result = await startAccountConsent({ memberId: "member-a", session: "session", org: "example", power: "read+mail-send" });
  expect(result.flow.power).toBe("read+mail-send");
  expect(result.url.searchParams.get("scope")).toBe(googlePersonalConsentScopes("read+mail-send").join(" "));
  expect(result.url.searchParams.get("scope")).not.toMatch(/compose|calendar.events|drive/);
});
it("accepts minimal personal read consent without email/profile/legacy permissions", async () => {
  response = { scope: GOOGLE_PERSONAL_READ_SCOPES.join(" ") };
  await expect(finishAccountConsent(callback(), flow)).resolves.toBeDefined();
  await expect(finishAccountConsent(callback(), { ...flow, power: "read+mail-send" })).rejects.toThrow(/incomplete/);
});
it.each(["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"])("accepts verified known send-capable scope %s without assigning engine authority", async scope => {
  response = { scope: [...GOOGLE_PERSONAL_READ_SCOPES, scope].join(" ") };
  const result = await finishAccountConsent(callback(), { ...flow, power: "read+mail-send" });
  expect(result.material.scopes).toContain(scope); expect(result).not.toHaveProperty("authority");
});
it("refuses unknown Google scope before resource verification", async () => {
  response = { scope: [...GOOGLE_PERSONAL_READ_SCOPES, "https://www.googleapis.com/auth/drive"].join(" ") };
  await expect(finishAccountConsent(callback(), flow)).rejects.toThrow(); expect(api.profile).not.toHaveBeenCalled();
});
