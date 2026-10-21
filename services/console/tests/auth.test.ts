import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), query: vi.fn(), cookie: vi.fn(), keeper: vi.fn() }));
vi.mock("@lares/agent-kit/member-store", () => ({ PgMemberStore: class { sessionMember = mocks.lookup } }));
vi.mock("../lib/db", () => ({ pool: { query: mocks.query } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("../lib/keeper-client", () => ({ keeper: mocks.keeper, KeeperRefusedError: class extends Error {}, KeeperUnavailableError: class extends Error {} }));
import { verify, sessionMember, signedInMember, requireConsolePage, requireConsoleMember, requireMember } from "../lib/auth";
const owner = { id: "owner-1", organisationId: "org", role: "owner", status: "active", automationMode: "draft-and-ask" };
beforeEach(() => {
  vi.stubEnv("AGENT_OWNER_USER_ID", "owner-1");
  mocks.lookup.mockReset().mockResolvedValue(owner);
  mocks.query.mockReset().mockResolvedValue({ rows: [{ primary_email: "owner@example.test" }] });
  mocks.cookie.mockReset().mockReturnValue({ value: "opaque" });
  mocks.keeper.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe("current database member and session admission", () => {
  it("gets the address for legacy transport only after exact stable owner admission", async () => {
    expect(await verify("opaque")).toBe("owner@example.test");
    expect(mocks.lookup).toHaveBeenCalledWith("opaque");
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("id=$1 AND status='active'"), ["owner-1"]);
  });
  it("accepts active members for their own membership, never the legacy global console", async () => {
    mocks.lookup.mockResolvedValue({ ...owner, id: "second", role: "member" });
    expect(await signedInMember()).toMatchObject({ id: "second" });
    expect(await requireMember()).toMatchObject({ id: "second" });
    expect(await verify("opaque")).toBeNull();
    await expect(requireConsoleMember()).rejects.toThrow("owner admission required");
    await expect(requireConsolePage()).rejects.toThrow("redirect:/membership");
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([{ id: "second", role: "owner" }, { id: "owner-1", role: "member" }, { id: "owner-1", role: "owner", status: "removed" }])("refuses a different owner, demoted or inactive owner: %s", async changes => {
    mocks.lookup.mockResolvedValue({ ...owner, ...changes });
    expect(await verify("opaque")).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("refuses missing configuration instead of widening to all owners", async () => {
    vi.stubEnv("AGENT_OWNER_USER_ID", "");
    expect(await verify("opaque")).toBeNull();
  });
  it("rechecks revocation/removal on every invocation and distinguishes a DB outage", async () => {
    expect(await verify("opaque")).toBe("owner@example.test");
    mocks.lookup.mockResolvedValue(undefined);
    expect(await verify("opaque")).toBeNull();
    await expect(requireConsolePage()).rejects.toThrow("redirect:/sign-in");
    mocks.lookup.mockRejectedValue(new Error("database offline"));
    await expect(sessionMember("opaque")).rejects.toThrow("storage is unavailable");
    expect(await sessionMember(undefined)).toBeNull();
  });
  it("keeps transport address lookup outages unavailable instead of signing out", async () => {
    mocks.query.mockRejectedValue(new Error("private database error detail"));
    await expect(verify("opaque")).rejects.toThrow("Console sign-in storage is unavailable. Try again.");
  });
  it("real inbox and credential routes return unavailable before data reads or keeper calls", async () => {
    mocks.lookup.mockRejectedValue(new Error("private database detail"));
    const inbox = await import("../app/api/inbox/route");
    const credential = await import("../app/api/credentials/notion/route");
    const responses = [await inbox.GET(new Request("https://console.example.test/api/inbox")), await credential.GET(new Request("https://console.example.test/api/credentials/notion"))];
    for (const response of responses) {
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).toContain("admission-unavailable"); expect(text).not.toContain("private database detail");
    }
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it("does not use allow-listed or provider emails as authority", async () => {
    vi.stubEnv("CONSOLE_ALLOWED_EMAILS", "attacker@example.test");
    mocks.lookup.mockResolvedValue(undefined);
    expect(await verify("legacy-email.signature")).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
