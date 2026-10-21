import { beforeEach, expect, it, vi } from "vitest";
import { ACCOUNT_FLOW_COOKIE, accountSessionHash, sealAccountFlow, openAccountFlow, type AccountFlow } from "../lib/account-oauth-state";
const mock = vi.hoisted(() => ({ member: vi.fn(), currentSession: vi.fn(), writeToken: vi.fn(), transaction: {}, query: vi.fn(), start: vi.fn(), finish: vi.fn(), begin: vi.fn(), read: vi.fn(), create: vi.fn(), renew: vi.fn(),
  cookies: new Map<string,string>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => mock.cookies.has(name) ? { value: mock.cookies.get(name) } : undefined }) }));
vi.mock("../lib/auth", () => ({ sessionMember: mock.member }));
vi.mock("../lib/db", () => ({ pool: { query: mock.query } }));
vi.mock("@lares/agent-box/lib/oauth-tokens.js", () => ({ writeVerifiedAccountToken: mock.writeToken }));
vi.mock("@lares/agent-kit/member-store", () => ({ currentSession: mock.currentSession }));
vi.mock("@lares/agent-kit/account-store", () => ({ PgAccountStore: class { beginUpdate = mock.begin; read = mock.read; forTrustedAdapter = () => ({ createPersonalAccount: mock.create, renew: mock.renew }); } }));
vi.mock("../lib/accounts", () => ({ googleOrgClientConfig: () => ({ clientId: "data-client", clientSecret: "secret" }), tokenEncKeyHex: () => "key", googleOrgs: () => [{ id: "example" }], orgDomains: () => ({}), resolveOrgForEmail: () => ({ org: "microsoft" }) }));
vi.mock("../lib/microsoft-account-oauth", () => ({ MICROSOFT_DATA_ORG: "microsoft", microsoftDataSettings: () => ({ clientId: "data-client", tenantId: "11111111-2222-4333-8444-555555555555", issuer: "https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0" }), microsoftAccountRedirect: () => "https://console.example.test/api/accounts/microsoft/callback", startMicrosoftAccountConsent: mock.start, finishMicrosoftAccountConsent: mock.finish }));
vi.mock("../lib/account-oauth", () => ({ consoleOrigin: () => "https://console.example.test", accountRedirect: () => "https://console.example.test/api/accounts/microsoft/callback",
  callbackRedirect: (origin: string, p: Record<string,string>) => `${origin}/membership?${new URLSearchParams(p)}`, startAccountConsent: mock.start, finishAccountConsent: mock.finish }));
import { ConsoleAdmissionUnavailableError } from "../lib/admission-error";
import { GET } from "../app/api/accounts/microsoft/callback/route";
import { POST } from "../app/api/accounts/microsoft/start/route";
const tenantId = "11111111-2222-4333-8444-555555555555";
const flow: AccountFlow = { provider: "microsoft", tenantId, intent: "new", memberId: "member-a", sessionHash: accountSessionHash("session"), org: "microsoft", clientId: "data-client", state: "state", nonce: "nonce", verifier: "verifier" };
const ticket = { accountId: "account-a", generation: 3, lifecycleRevision: 4 };
const callback = (state = "state") => GET(new Request(`https://internal.example/api/accounts/microsoft/callback?code=code&state=${state}`));
async function start(values: Record<string,string>) { const form = new FormData(); for (const [key,value] of Object.entries(values)) form.set(key,value); return POST(new Request("https://internal.example/start", { method: "POST", body: form })); }
beforeEach(async () => {
  vi.clearAllMocks(); process.env.CONSOLE_SESSION_SECRET = "test-consent-secret";
  mock.cookies.clear(); mock.cookies.set("lares_session", "session"); mock.cookies.set(ACCOUNT_FLOW_COOKIE, await sealAccountFlow(flow));
  mock.member.mockResolvedValue({ id: "member-a", status: "active", role: "member" });
  mock.currentSession.mockResolvedValue({ id: "member-a" }); mock.writeToken.mockResolvedValue("token-id");
  const persist = async (_member: string, _evidence: unknown, credential: { persist: (db: unknown, context: unknown) => Promise<unknown> }) => credential.persist(mock.transaction, { id: "account-a" });
  mock.create.mockImplementation(persist); mock.renew.mockImplementation((_member, _ticket, _evidence, credential) => persist(_member, _evidence, credential));
  mock.query.mockResolvedValue({ rows: [{ org_id: "microsoft" }] }); mock.begin.mockResolvedValue(ticket); mock.read.mockResolvedValue({ connectorId: "microsoft", providerAccount: { issuer: "https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/v2.0", tenantId } });
  mock.start.mockResolvedValue({ flow, url: new URL("https://login.microsoftonline.com/consent") });
  mock.finish.mockResolvedValue({ adapter: {}, material: { orgId: "microsoft", emailAddress: "own@example.test", scopes: ["openid"], refreshToken: "refresh" } });
});
it("starts member-owned flow with overwrite-only HttpOnly cookie and stable identity", async () => {
  const result = await start({ intent: "new", email: "hint@example.test" });
  expect(result.status).toBe(303); expect(mock.start).toHaveBeenCalledWith(expect.objectContaining({ memberId: "member-a", session: "session" }));
  const cookie = result.headers.get("set-cookie")!; expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure");
  expect(await openAccountFlow(cookie.split(";")[0].split("=")[1])).toEqual(flow);
});
it("refuses managed agent consent and unknown/missing intent before provider work", async () => {
  expect((await start({ agent: "example", email: "own@example.test" })).status).toBe(303);
  await start({ email: "own@example.test" }); await start({ intent: "replace", email: "own@example.test" }); expect(mock.start).not.toHaveBeenCalled();
});
it("captures reconnect ticket before beginning consent and ignores requested org/email", async () => {
  await start({ intent: "reconnect", accountId: "account-a", generation: "3", email: "attacker@example.test", org: "other" });
  expect(mock.begin).toHaveBeenCalledWith("member-a", "account-a", 3); expect(mock.start).toHaveBeenCalledWith(expect.objectContaining({ update: ticket }));
});
it("commits the exact verified account and resources without legacy agent connection", async () => {
  const result = await callback(); expect(mock.create).toHaveBeenCalledWith("member-a", null, expect.objectContaining({ persist: expect.any(Function) }), [0,1]);
  expect(result.headers.get("location")).toContain("pending"); expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(mock.finish.mock.calls[0][0].origin).toBe("https://console.example.test");
  expect(mock.currentSession).toHaveBeenCalledWith(mock.transaction, "session", "member-a", { lock: "share" });
  expect(mock.writeToken).toHaveBeenCalledWith(mock.transaction, { id: "account-a" }, "key", expect.objectContaining({ refreshToken: "refresh" }));
});
it.each(["session", "member", "cookie", "state"])("refuses changed %s before any external provider call", async change => {
  if (change === "session") mock.cookies.set("lares_session", "another-session");
  if (change === "member") mock.member.mockResolvedValue({ id: "member-b" });
  if (change === "cookie") mock.cookies.delete(ACCOUNT_FLOW_COOKIE);
  const result = await callback(change === "state" ? "another-state" : "state");
  expect(mock.finish).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled(); expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
});
it("rechecks reconnect lifecycle before provider work and refuses stale revision", async () => {
  mock.cookies.set(ACCOUNT_FLOW_COOKIE, await sealAccountFlow({ ...flow, intent: "reconnect", update: ticket })); mock.begin.mockResolvedValue({ ...ticket, lifecycleRevision: 5 });
  await callback(); expect(mock.finish).not.toHaveBeenCalled(); expect(mock.renew).not.toHaveBeenCalled();
});
it("returns neutral terminal failure for raw provider and database errors", async () => {
  mock.finish.mockRejectedValue(new Error("PRIVATE PROVIDER TOKEN SQL ERROR")); const result = await callback();
  expect(decodeURIComponent(result.headers.get("location")!)).not.toContain("PRIVATE"); expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
});

it("preserves admission storage outage as 503 and clears the consent cookie", async () => {
  mock.member.mockRejectedValue(new ConsoleAdmissionUnavailableError()); const result = await callback();
  expect(result.status).toBe(503); expect(result.headers.get("set-cookie")).toContain("Max-Age=0"); expect(mock.finish).not.toHaveBeenCalled();
});

it.each(["new", "reconnect"] as const)("refuses %s when the exact session ends during provider work, before token persistence", async intent => {
  if (intent === "reconnect") mock.cookies.set(ACCOUNT_FLOW_COOKIE, await sealAccountFlow({ ...flow, intent, update: ticket }));
  mock.finish.mockImplementationOnce(async () => {
    mock.currentSession.mockResolvedValue(undefined);
    return { adapter: {}, material: { scopes: ["openid"], refreshToken: "refresh" } };
  });
  const result = await callback();
  expect(mock.currentSession).toHaveBeenCalledWith(mock.transaction, "session", "member-a", { lock: "share" });
  expect(mock.writeToken).not.toHaveBeenCalled();
  expect(result.headers.get("location")).toContain("error=");
  expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
});

it("refuses a sealed Google flow before Microsoft provider work", async () => {
  const { tenantId: _tenant, ...base } = flow;
  mock.cookies.set(ACCOUNT_FLOW_COOKIE, await sealAccountFlow({ ...base, provider: "google" }));
  await callback(); expect(mock.finish).not.toHaveBeenCalled();
});
it("refuses another provider or tenant account at reconnect start", async () => {
  mock.read.mockResolvedValue({ connectorId: "google", providerAccount: {} });
  await start({ intent: "reconnect", accountId: "account-a", generation: "3" }); expect(mock.start).not.toHaveBeenCalled();
});
