import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberStoreError } from "@lares/agent-kit/member-store";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ open: vi.fn(), finish: vi.fn(), start: vi.fn(), lookup: vi.fn(), current: vi.fn(), eligible: vi.fn(), bootstrap: vi.fn(), link: vi.fn(), accept: vi.fn(), create: vi.fn(), seal: vi.fn() }));
vi.mock("../lib/auth", () => ({ members: { memberForIdentity: mocks.lookup, currentMember: mocks.current, firstOwnerBootstrapEligible: mocks.eligible, bootstrapFirstOwnerIdentity: mocks.bootstrap, linkIdentity: mocks.link, acceptInvitation: mocks.accept, createSession: mocks.create }, isConsoleOwner: (m: { id: string; role: string; status?: string }) => m.id === process.env.AGENT_OWNER_USER_ID && m.role === "owner" && (m.status === undefined || m.status === "active"), SESSION_MAX_AGE: 604800 }));
vi.mock("../lib/console-oidc", () => ({ openFlow: mocks.open, finishSignIn: mocks.finish, startSignIn: mocks.start, consoleRedirect: () => "https://console.example.test/api/auth/callback" }));
vi.mock("../lib/owner-bootstrap-receipt", async () => {
  const actual = await vi.importActual<typeof import("../lib/owner-bootstrap-receipt")>("../lib/owner-bootstrap-receipt");
  return { ...actual, sealOwnerDiscoveryReceipt: mocks.seal };
});
import { GET } from "../app/api/auth/[...route]/route";
import { ownerBootstrapDigest, ownerDiscoveryDigest } from "../lib/owner-bootstrap-receipt";
const owner = { id: "owner-1", role: "owner", status: "active" };
const identity = { issuer: "https://accounts.google.com", subject: "exact-subject" };
const proof = { identity, verifiedAt: new Date() };
const flow = { provider: "google", state: "state", nonce: "nonce", verifier: "verifier", next: "/agents" };
const ctx = (...route: string[]) => ({ params: Promise.resolve({ route }) });
const req = (path = "/api/auth/callback?code=code&state=state") => new NextRequest(`http://internal:3000${path}`, { headers: { cookie: "oauth_flow=signed-cookie; lares_session=old; lares_owner_discovery=old-receipt" } });
const selection = (selectedIdentity = identity) => ({ ownerId: "owner-1", organisationId: "example.test", installationOrigin: "https://console.example.test", identity: selectedIdentity, digest: ownerBootstrapDigest("owner-1", "example.test", "https://console.example.test", selectedIdentity) });
beforeEach(() => {
  vi.stubEnv("AGENT_OWNER_USER_ID", "owner-1"); vi.stubEnv("CONSOLE_BOOTSTRAP_IDENTITY", undefined);
  mocks.open.mockReset().mockResolvedValue(flow); mocks.finish.mockReset().mockResolvedValue(proof);
  mocks.lookup.mockReset().mockResolvedValue(owner); mocks.current.mockReset().mockResolvedValue(owner);
  mocks.eligible.mockReset().mockResolvedValue(false); mocks.bootstrap.mockReset().mockResolvedValue(undefined);
  mocks.link.mockReset().mockResolvedValue(undefined); mocks.accept.mockReset().mockResolvedValue(undefined);
  mocks.seal.mockReset().mockResolvedValue("signed-discovery-receipt");
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
  it("pins the exact selected provider identity through the atomic first-owner binder", async () => {
    mocks.lookup.mockResolvedValue(undefined);
    vi.stubEnv("CONSOLE_BOOTSTRAP_IDENTITY", JSON.stringify(selection()));
    expect((await GET(req(), ctx("callback"))).headers.get("location")).toContain("/agents");
    expect(mocks.bootstrap).toHaveBeenCalledWith("owner-1", "example.test", proof);
    expect(mocks.link).not.toHaveBeenCalled();
  });
  it.each([{ ...identity, subject: "other" }, { ...identity, issuer: "https://other.test" }, { ...identity, tenantId: "other" }])("refuses mismatched bootstrap issuer/subject/tenant %s", async configured => {
    mocks.lookup.mockResolvedValue(undefined); vi.stubEnv("CONSOLE_BOOTSTRAP_IDENTITY", JSON.stringify(selection(configured)));
    await GET(req(), ctx("callback")); expect(mocks.bootstrap).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("refuses a selected tuple pinned to another public installation origin", async () => {
    mocks.lookup.mockResolvedValue(undefined);
    vi.stubEnv("CONSOLE_BOOTSTRAP_IDENTITY", JSON.stringify({ ...selection(), installationOrigin: "https://other.test" }));
    expect((await GET(req(), ctx("callback"))).headers.get("location")).toContain("error=failed");
    expect(mocks.bootstrap).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not issue a session when the atomic first-owner binder refuses stale eligibility", async () => {
    mocks.lookup.mockResolvedValue(undefined); vi.stubEnv("CONSOLE_BOOTSTRAP_IDENTITY", JSON.stringify(selection()));
    mocks.bootstrap.mockRejectedValue(new MemberStoreError("denied"));
    expect((await GET(req(), ctx("callback"))).headers.get("location")).toContain("error=failed");
    expect(mocks.bootstrap).toHaveBeenCalledWith("owner-1", "example.test", proof);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("shows a verified setup receipt without creating a session or linking an identity", async () => {
    mocks.lookup.mockResolvedValue(undefined); mocks.eligible.mockResolvedValue(true);
    const res = await GET(req(), ctx("callback"));
    expect(res.headers.get("location")).toBe("https://console.example.test/sign-in?setup=owner");
    expect(res.headers.get("set-cookie")).toContain("lares_owner_discovery=signed-discovery-receipt");
    expect(mocks.seal).toHaveBeenCalledWith({ installationOrigin: "https://console.example.test", identity, digest: ownerDiscoveryDigest("https://console.example.test", identity) });
    expect(mocks.bootstrap).not.toHaveBeenCalled(); expect(mocks.link).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).not.toContain("lares_session=");
  });
  it("clears a prior discovery receipt when a new login flow starts", async () => {
    const res = await GET(req("/api/auth/login"), ctx("login"));
    expect(res.headers.get("set-cookie")).toContain("lares_owner_discovery=;");
    expect(res.headers.get("set-cookie")).toContain("oauth_flow=sealed");
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
