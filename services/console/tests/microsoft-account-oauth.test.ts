import { readFileSync, readdirSync } from "node:fs";
import { startTestDb, type TestDb } from "@lares/agent-box/tests/helpers/pg.js";
import { PgAccountStore } from "@lares/agent-kit/account-store";
import { PgMemberStore, currentSession } from "@lares/agent-kit/member-store";
import { writeVerifiedAccountToken, getDecryptedRefreshToken } from "@lares/agent-box/lib/oauth-tokens.js";
import { decryptSecret } from "@lares/agent-box/lib/crypto.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
vi.mock("../lib/db", () => ({ pool: {} }));
import { MICROSOFT_DATA_SCOPES, microsoftDataSettings, startMicrosoftAccountConsent, finishMicrosoftAccountConsent } from "../lib/microsoft-account-oauth";
import { accountSessionHash, type AccountFlow } from "../lib/account-oauth-state";
const tenantId = "11111111-2222-4333-8444-555555555555", oid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const flow: AccountFlow = { provider: "microsoft", tenantId, org: "microsoft", intent: "new", memberId: "member-a",
  sessionHash: accountSessionHash("session"), clientId: "data-client", state: "state", nonce: "nonce", verifier: "v".repeat(43) };
const callback = () => new URL("http://localhost:3000/api/accounts/microsoft/callback?code=code&state=state");
let claims: Record<string,unknown>, tokenResponse: Record<string,unknown>, me: Record<string,unknown>, mailbox: Record<string,unknown>, calendar: Record<string,unknown>, badSignature: boolean, graphStatus: number;
let reads: { path: string; select: string | null; authorization: string | null; signal: AbortSignal | null | undefined; redirect: RequestRedirect | undefined; sdkTelemetry: string | null }[];
beforeEach(async () => {
  vi.stubEnv("CONSOLE_OAUTH_REDIRECT", "http://localhost:3000/api/auth/callback");
  vi.stubEnv("MICROSOFT_TENANT_ID_DATA", tenantId); vi.stubEnv("MICROSOFT_CLIENT_ID_DATA", "data-client"); vi.stubEnv("MICROSOFT_CLIENT_SECRET_DATA", "data-secret");
  vi.stubEnv("MICROSOFT_CLIENT_ID_CONSOLE", "sign-in-client");
  const key = await generateKeyPair("RS256"), jwk = await exportJWK(key.publicKey);
  claims = {}; tokenResponse = {}; badSignature = false; reads = []; graphStatus = 200;
  me = { id: oid, userType: "Member", mail: "own@example.test", userPrincipalName: "upn@example.test" };
  mailbox = { id: "inbox-id" }; calendar = { id: "primary-id", name: "Calendar", isDefaultCalendar: true };
  vi.stubGlobal("fetch", vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("openid-configuration")) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
    if (url.pathname.endsWith("/keys")) return Response.json({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] });
    if (url.pathname.endsWith("/token")) {
      const signing = badSignature ? (await generateKeyPair("RS256")).privateKey : key.privateKey;
      const id = await new SignJWT({ nonce: "nonce", tid: tenantId, oid, ...claims }).setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(String(claims.iss ?? issuer)).setSubject(String(claims.sub ?? "client-scoped-subject"))
        .setAudience(String(claims.aud ?? "data-client")).setIssuedAt().setExpirationTime("5m").sign(signing);
      return Response.json({ access_token: "same-grant-access", refresh_token: "refresh", token_type: "Bearer",
        scope: "User.Read Mail.Read Calendars.Read", id_token: id, ...tokenResponse });
    }
    if (url.hostname === "graph.microsoft.com") {
      const signal = input instanceof Request ? input.signal : init?.signal;
      if (signal?.aborted) throw signal.reason;
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      reads.push({ path: url.pathname, select: url.searchParams.get("$select"), authorization: headers.get("authorization"), signal: input instanceof Request ? input.signal : init?.signal, redirect: init?.redirect, sdkTelemetry: headers.get("sdkversion") });
      if (graphStatus !== 200) return Response.json({ error: { code: "MailboxNotEnabledForRESTAPI", message: "PRIVATE PROVIDER DATA" } }, { status: graphStatus });
      if (url.pathname === "/v1.0/me") return Response.json(me);
      if (url.pathname === "/v1.0/me/mailFolders/inbox") return Response.json(mailbox);
      if (url.pathname === "/v1.0/me/calendar") return Response.json(calendar);
    }
    throw new Error("Unexpected outbound request");
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("Microsoft work data consent with real OIDC and Graph SDK libraries", () => {
  it("uses the distinct fixed-tenant data client, PKCE, state, nonce and read-only permissions", async () => {
    const result = await startMicrosoftAccountConsent({ memberId: "member-a", session: "session" });
    expect(result.flow).toMatchObject({ provider: "microsoft", tenantId, org: "microsoft", memberId: "member-a", sessionHash: accountSessionHash("session"), clientId: "data-client" });
    expect(result.url.searchParams.get("client_id")).toBe("data-client");
    expect(result.url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/accounts/microsoft/callback");
    expect(result.url.searchParams.get("scope")).toBe(MICROSOFT_DATA_SCOPES.join(" "));
    expect(result.url.searchParams.get("code_challenge_method")).toBe("S256");
    for (const key of ["nonce", "state", "code_challenge"]) expect(result.url.searchParams.get(key)).toBeTruthy();
  });
  it("binds tenant and oid, verifies mailbox availability and own default calendar using one grant", async () => {
    claims = { sub: "different-client-scoped-id", email: "unrelated@example.test" };
    const result = await finishMicrosoftAccountConsent(callback(), flow);
    expect(await result.adapter.verifyAccount(null)).toEqual({ issuer, tenantId, subject: oid, label: "own@example.test" });
    expect(await result.adapter.verifyResource({} as never, 0)).toEqual({ resourceKind: "mailbox", externalId: oid, providerLabel: "own@example.test" });
    expect(await result.adapter.verifyResource({} as never, 1)).toEqual({ resourceKind: "calendar", externalId: "primary-id", providerLabel: "Calendar" });
    await expect(result.adapter.verifyResource({} as never, 2)).rejects.toThrow();
    expect(reads.map(r => r.path)).toEqual(["/v1.0/me", "/v1.0/me/mailFolders/inbox", "/v1.0/me/calendar"]);
    expect(reads.every(r => r.authorization === "Bearer same-grant-access")).toBe(true);
    expect(reads.every(r => r.signal === reads[0].signal && r.signal instanceof AbortSignal && r.redirect === "error" && r.sdkTelemetry === null)).toBe(true);
    expect(result.material.refreshToken).toBe("refresh");
    expect(result.material.orgId).toBe("microsoft");
    expect(await result.adapter.verifyAccount(null)).not.toHaveProperty("refreshToken");
  });
  it.each([{ iss: "https://wrong.example" }, { aud: "sign-in-client" }, { nonce: "wrong" }, { tid: "99999999-2222-4333-8444-555555555555" }, { oid: "not-an-object-id" }, { idp: "live.com" }, { tid: "9188040d-6c67-4c5b-b112-36a304b66dad" }])("refuses invalid work claims %s before Graph", async changed => {
    claims = changed; await expect(finishMicrosoftAccountConsent(callback(), flow)).rejects.toThrow(); expect(reads).toEqual([]);
  });
  it("requires a valid provider signature", async () => { badSignature = true; await expect(finishMicrosoftAccountConsent(callback(), flow)).rejects.toThrow(); expect(reads).toEqual([]); });
  it.each([{ refresh_token: undefined }, { scope: undefined }, { scope: "openid User.Read Mail.Read" }, { scope: "User.Read Calendars.Read" }, { scope: "User.Read Mail.Read Calendars.Read Mail.Send" }])("refuses incomplete actual consent %s", async changed => {
    tokenResponse = changed; await expect(finishMicrosoftAccountConsent(callback(), flow)).rejects.toThrow(); expect(reads).toEqual([]);
  });
  it("accepts fully qualified granted Graph scopes", async () => { tokenResponse = { scope: "https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Calendars.Read" }; await expect(finishMicrosoftAccountConsent(callback(), flow)).resolves.toBeDefined(); });
  it.each([{ id: "different-object" }, { userType: "Guest" }, { userType: undefined }])("refuses mismatched or guest Graph identity %s before mailbox access", async changed => {
    me = { ...me, ...changed }; await expect(finishMicrosoftAccountConsent(callback(), flow)).rejects.toThrow(); expect(reads).toHaveLength(1);
  });
  it("does not equate an email or UPN with mailbox availability", async () => { mailbox = {}; await expect(finishMicrosoftAccountConsent(callback(), flow)).rejects.toThrow(); });
  it.each([{ id: undefined }, { isDefaultCalendar: false }, { isDefaultCalendar: undefined }])("refuses missing or non-default calendar %s", async changed => {
    calendar = { ...calendar, ...changed }; await expect(finishMicrosoftAccountConsent(callback(), flow)).rejects.toThrow();
  });
  it("does not retry a throttled consent verification", async () => { graphStatus = 429; await expect(finishMicrosoftAccountConsent(callback(), flow)).rejects.toMatchObject({ kind: "rate-limited" }); expect(reads).toHaveLength(1); });
  it("preserves timeout internally without retaining a raw provider error", async () => {
    const abort = new AbortController(); abort.abort(new DOMException("PRIVATE RAW DATA", "TimeoutError"));
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 15_000 ? abort.signal : originalTimeout(ms));
    await expect(finishMicrosoftAccountConsent(callback(), flow)).rejects.toMatchObject({ kind: "timeout", message: "Microsoft consent resource verification timeout" });
  });
  it("refuses unavailable Graph resources", async () => { graphStatus = 403; await expect(finishMicrosoftAccountConsent(callback(), flow)).rejects.toMatchObject({ kind: "denied" }); });
  it.each(["common", "organizations", "consumers", "9188040d-6c67-4c5b-b112-36a304b66dad"])("refuses non-work data tenant %s", tenant => { vi.stubEnv("MICROSOFT_TENANT_ID_DATA", tenant); expect(() => microsoftDataSettings()).toThrow(); });
  it.each([{ provider: "google" }, { tenantId: "99999999-2222-4333-8444-555555555555" }, { clientId: "another-client" }, { org: "request-org" }])("refuses changed flow configuration %s before provider calls", async changed => {
    await expect(finishMicrosoftAccountConsent(callback(), { ...flow, ...changed } as AccountFlow)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});

describe("verified Microsoft consent through real shared PostgreSQL custody", () => {
  let database: TestDb;
  const key = "1".repeat(64);
  beforeAll(async () => {
    database = await startTestDb();
    const sql = new URL("../../box/sql/", import.meta.url);
    for (const name of readdirSync(sql).filter(name => name.endsWith(".sql") && name !== "001_baseline.sql").sort())
      await database.pool.query(readFileSync(new URL(name, sql), "utf8"));
    await database.pool.query("INSERT INTO orgs(id,display_name) VALUES ('fixture-org','Fixture') ON CONFLICT DO NOTHING");
    await database.pool.query("INSERT INTO users(id,display_name,org_id,status) VALUES ('member-a','A','fixture-org','active'),('member-b','B','fixture-org','active')");
  }, 120_000);
  afterAll(async () => { await database?.stop(); });
  beforeEach(async () => { await database.pool.query("DELETE FROM connected_accounts"); await database.pool.query("DELETE FROM oauth_tokens"); });
  const credential = (verified: Awaited<ReturnType<typeof finishMicrosoftAccountConsent>>, session?: string) => ({
    persist: async (db: Parameters<typeof writeVerifiedAccountToken>[0], context: Parameters<typeof writeVerifiedAccountToken>[1]) => {
      if (session && !await currentSession(db, session, "member-a", { lock: "share" })) throw new Error("Consent session unavailable");
      return writeVerifiedAccountToken(db, context, key, { ...verified.material, scopes: [...verified.material.scopes] });
    },
  });
  it("stores exact Microsoft identity/resources/encrypted custody, renews the same account, and revokes access", async () => {
    const verified = await finishMicrosoftAccountConsent(callback(), flow), store = new PgAccountStore(database.pool), adapter = store.forTrustedAdapter(verified.adapter);
    const account = await adapter.createPersonalAccount("member-a", null, credential(verified), [0, 1]);
    expect(account.connectorId).toBe("microsoft"); expect(account.providerAccount).toEqual({ issuer, tenantId, subject: oid, label: "own@example.test" });
    expect(await store.list("member-b")).toEqual([]);
    const resources = await store.listResources("member-a", account.id, account.generation);
    expect(resources.map(r => r.externalId).sort()).toEqual([oid, "primary-id"].sort());
    const row = (await database.pool.query("SELECT t.* FROM oauth_tokens t JOIN connected_account_credentials c ON c.oauth_token_id=t.id WHERE c.account_id=$1", [account.id])).rows[0];
    expect(row.org_id).toBe("microsoft"); expect(row.provider).toBe("microsoft"); expect(row.principal).toBe("member-a");
    expect(row.refresh_token_enc).not.toContain("refresh"); expect(decryptSecret(row.refresh_token_enc, key)).toBe("refresh");
    await expect(getDecryptedRefreshToken(database.pool, key, "member-a", "microsoft")).rejects.toThrow();
    const update = await store.beginUpdate("member-a", account.id, account.generation);
    const renewed = await adapter.renew("member-a", update, null, credential(verified), [0, 1]);
    expect(renewed.id).toBe(account.id); expect(await store.listResources("member-a", account.id, renewed.generation)).toEqual(resources);
    const stopped = await store.setStatus("member-a", await store.beginUpdate("member-a", account.id, renewed.generation), "revoked");
    expect(stopped.generation).toBeGreaterThan(renewed.generation);
    await expect(store.resolvePersonalResource("member-a", { accountId: account.id, generation: renewed.generation, resourceBindingId: resources[0].id }, resources[0].resourceKind)).rejects.toThrow();
    await expect(adapter.renew("member-a", update, null, credential(verified), [0, 1])).rejects.toThrow();
  });
  it("refuses a different verified object or default calendar on reconnect without replacing custody", async () => {
    const original = await finishMicrosoftAccountConsent(callback(), flow), store = new PgAccountStore(database.pool);
    const account = await store.forTrustedAdapter(original.adapter).createPersonalAccount("member-a", null, credential(original), [0, 1]);
    const before = (await database.pool.query("SELECT * FROM oauth_tokens")).rows;
    claims = { oid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" }; me.id = claims.oid;
    const other = await finishMicrosoftAccountConsent(callback(), flow);
    await expect(store.forTrustedAdapter(other.adapter).renew("member-a", await store.beginUpdate("member-a", account.id, account.generation), null, credential(other), [0, 1])).rejects.toThrow();
    claims = {}; me.id = oid; calendar.id = "different-calendar";
    const changed = await finishMicrosoftAccountConsent(callback(), flow);
    await expect(store.forTrustedAdapter(changed.adapter).renew("member-a", await store.beginUpdate("member-a", account.id, account.generation), null, credential(changed), [0, 1])).rejects.toThrow();
    expect((await database.pool.query("SELECT * FROM oauth_tokens")).rows).toEqual(before);
  });
  it.each(["new", "reconnect"] as const)("rolls back Microsoft %s when the exact console session ends during provider work", async intent => {
    const store = new PgAccountStore(database.pool), members = new PgMemberStore(database.pool);
    const proof = { identity: { issuer: "https://login.example.test", subject: "member-a" }, verifiedAt: new Date() };
    await members.linkIdentity("member-a", "member-a", proof);
    const session = await members.createSession(proof, new Date(Date.now()+60_000));
    const original = await finishMicrosoftAccountConsent(callback(), flow);
    const account = intent === "reconnect" ? await store.forTrustedAdapter(original.adapter).createPersonalAccount("member-a", null, credential(original), [0, 1]) : undefined;
    const snapshot = async () => ({ accounts: (await database.pool.query("SELECT * FROM connected_accounts ORDER BY id")).rows,
      tokens: (await database.pool.query("SELECT * FROM oauth_tokens ORDER BY id")).rows,
      resources: (await database.pool.query("SELECT * FROM connected_resource_bindings ORDER BY id")).rows });
    const before = await snapshot(), providerFetch = globalThis.fetch;
    let revokedDuringProviderRead = false;
    vi.stubGlobal("fetch", async (input: Request | URL | string, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/v1.0/me/calendar") {
        await members.revokeSession(session.token); revokedDuringProviderRead = true;
      }
      return providerFetch(input, init);
    });
    const verified = await finishMicrosoftAccountConsent(callback(), flow);
    expect(revokedDuringProviderRead).toBe(true);
    const adapter = store.forTrustedAdapter(verified.adapter);
    await expect(account ? adapter.renew("member-a", await store.beginUpdate("member-a", account.id, account.generation), null, credential(verified, session.token), [0, 1])
      : adapter.createPersonalAccount("member-a", null, credential(verified, session.token), [0, 1])).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});
