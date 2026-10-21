import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberStoreError } from "@lares/agent-kit/member-store";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ open: vi.fn(), finish: vi.fn(), start: vi.fn(), lookup: vi.fn(), current: vi.fn(), link: vi.fn(), accept: vi.fn(), create: vi.fn() }));
vi.mock("../lib/auth", () => ({ members: { memberForIdentity: mocks.lookup, currentMember: mocks.current, linkIdentity: mocks.link, acceptInvitation: mocks.accept, createSession: mocks.create }, isConsoleOwner: (m: { id: string; role: string }) => m.id === process.env.AGENT_OWNER_USER_ID && m.role === "owner", SESSION_MAX_AGE: 604800 }));
vi.mock("../lib/console-oidc", () => ({ openFlow: mocks.open, finishSignIn: mocks.finish, startSignIn: mocks.start, consoleRedirect: () => "https://console.example.test/api/auth/callback" }));
import { GET } from "../app/api/auth/[...route]/route";
const owner = { id: "owner-1", role: "owner", status: "active" };
const identity = { issuer: "https://accounts.google.com", subject: "exact-subject" };
const proof = { identity, verifiedAt: new Date() };
const flow = { provider: "google", state: "state", nonce: "nonce", verifier: "verifier", next: "/agents" };
const ctx = (...route: string[]) => ({ params: Promise.resolve({ route }) });
const req = (path = "/api/auth/callback?code=code&state=state") => new NextRequest(`http://internal:3000${path}`, { headers: { cookie: "oauth_flow=signed-cookie; lares_session=old" } });
beforeEach(() => {
  vi.stubEnv("AGENT_OWNER_USER_ID", "owner-1"); vi.stubEnv("CONSOLE_BOOTSTRAP_IDENTITY", undefined);
  mocks.open.mockReset().mockResolvedValue(flow); mocks.finish.mockReset().mockResolvedValue(proof);
  mocks.lookup.mockReset().mockResolvedValue(owner); mocks.current.mockReset().mockResolvedValue(owner);
  mocks.link.mockReset().mockResolvedValue(undefined); mocks.accept.mockReset().mockResolvedValue(undefined);
  mocks.create.mockReset().mockResolvedValue({ member: owner, token: "x".repeat(43) });
  mocks.start.mockReset().mockResolvedValue({ url: new URL("https://accounts.google.com/authorize"), cookie: "sealed" });
});
afterEach(() => vi.unstubAllEnvs());
describe("trusted console admission callback", () => {
  it("creates an opaque revocable session from a freshly verified exact provider identity", async () => {
    const res = await GET(req(), ctx("callback"));
    expect(mocks.finish).toHaveBeenCalledWith(new URL("https://console.example.test/api/auth/callback?code=code&state=state"), flow);
    expect(mocks.create).toHaveBeenCalledWith(proof, expect.any(Date));
    expect(res.headers.get("location")).toBe("https://console.example.test/agents");
    expect(res.headers.get("set-cookie")).toContain(`lares_session=${"x".repeat(43)}`);
    expect(mocks.link).not.toHaveBeenCalled();
  });
  it("sends a second owner or ordinary member only to their own membership page", async () => {
    mocks.create.mockResolvedValue({ member: { ...owner, id: "second" }, token: "x".repeat(43) });
    const res = await GET(req(), ctx("callback"));
    expect(res.headers.get("location")).toBe("https://console.example.test/membership");
  });
  it("never links an unknown identity by email", async () => {
    mocks.lookup.mockResolvedValue(undefined);
    expect((await GET(req(), ctx("callback"))).headers.get("location")).toContain("error=failed");
    expect(mocks.link).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("explicitly adopts the existing active owner without creating or rewriting a user", async () => {
    mocks.lookup.mockResolvedValue(undefined);
    vi.stubEnv("CONSOLE_BOOTSTRAP_IDENTITY", JSON.stringify(identity));
    expect((await GET(req(), ctx("callback"))).headers.get("location")).toContain("/agents");
    expect(mocks.link).toHaveBeenCalledWith("owner-1", "owner-1", proof);
  });
  it.each([{ ...identity, subject: "other" }, { ...identity, issuer: "https://other.test" }, { ...identity, tenantId: "other" }])("refuses mismatched bootstrap issuer/subject/tenant %s", async configured => {
    mocks.lookup.mockResolvedValue(undefined); vi.stubEnv("CONSOLE_BOOTSTRAP_IDENTITY", JSON.stringify(configured));
    await GET(req(), ctx("callback")); expect(mocks.link).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not bootstrap a removed, missing or demoted member", async () => {
    mocks.lookup.mockResolvedValue(undefined); vi.stubEnv("CONSOLE_BOOTSTRAP_IDENTITY", JSON.stringify(identity));
    for (const member of [undefined, { ...owner, role: "member" }]) {
      mocks.current.mockResolvedValue(member); await GET(req(), ctx("callback"));
    }
    expect(mocks.link).not.toHaveBeenCalled();
  });
  it("consumes only the invitation sealed into the original flow, never a callback query token", async () => {
    mocks.open.mockResolvedValue({ ...flow, invitation: "a".repeat(43) });
    await GET(req("/api/auth/callback?code=code&state=state&invite=attacker"), ctx("callback"));
    expect(mocks.accept).toHaveBeenCalledWith("a".repeat(43), proof);
    expect(mocks.lookup).not.toHaveBeenCalled();
    mocks.accept.mockRejectedValue(new MemberStoreError("denied")); mocks.create.mockClear();
    expect((await GET(req(), ctx("callback"))).headers.get("location")).toContain("error=failed");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects tampered/expired cookies and wrong state before provider exchange", async () => {
    mocks.open.mockResolvedValue(null); await GET(req(), ctx("callback"));
    mocks.open.mockResolvedValue(flow); await GET(req("/api/auth/callback?code=code&state=wrong"), ctx("callback"));
    expect(mocks.finish).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects extra auth route segments and unknown providers", async () => {
    expect((await GET(req(), ctx("callback", "extra"))).status).toBe(404);
    expect((await GET(req("/api/auth/login?provider=other"), ctx("login"))).headers.get("location")).toContain("error=failed");
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

// Routes convert typed admission outages to a neutral 503 without downstream work.
it("does not read data or call keeper when admission storage is unavailable", async () => {
  const { ConsoleAdmissionUnavailableError, withConsoleAdmission } = await import("../lib/admission-error");
  const downstream = vi.fn();
  const handler = withConsoleAdmission(async () => { throw new ConsoleAdmissionUnavailableError(); downstream(); return Response.json({ ok: true }); });
  const response = await handler();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "admission-unavailable", message: "Console sign-in storage is unavailable. Try again." });
  expect(downstream).not.toHaveBeenCalled();
});

it("reports verified-provider storage outages as unavailable without issuing a session", async () => {
  mocks.lookup.mockRejectedValue(new Error("private database detail"));
  const response = await GET(req(), ctx("callback"));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private database detail");
  expect(mocks.create).not.toHaveBeenCalled();
});
