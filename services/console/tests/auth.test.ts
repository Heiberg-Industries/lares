import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), query: vi.fn(), cookie: vi.fn(), keeper: vi.fn() }));
vi.mock("@lares/agent-kit/member-store", () => ({ PgMemberStore: class { sessionMember = mocks.lookup } }));
vi.mock("../lib/db", () => ({ pool: { query: mocks.query } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("../lib/keeper-client", () => ({ keeper: mocks.keeper, KeeperRefusedError: class extends Error {}, KeeperUnavailableError: class extends Error {} }));
import { actingAddress,consoleLevel,mayUse,memberAuditAddress,sessionMember,signedInMember,requirePage,requireAction,REFUSED_PAGE } from "../lib/auth";
const owner = { id: "owner-1", organisationId: "org", role: "owner", status: "active", automationMode: "draft-and-ask" };
const admin = { ...owner, id: "admin-1", role: "admin" };
const member = { ...owner, id: "member-1", role: "member" };
const LEVELS = ["owner", "admin", "member"] as const;
beforeEach(() => {
  vi.stubEnv("AGENT_OWNER_USER_ID", "owner-1");
  mocks.lookup.mockReset().mockResolvedValue(owner);
  mocks.query.mockReset().mockResolvedValue({ rows: [{ primary_email: "owner@example.test" }] });
  mocks.cookie.mockReset().mockReturnValue({ value: "opaque" });
  mocks.keeper.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("the one check: may this person use something of this level", () => {
  // person, then what they may use: owner level, admin level, member level
  it.each([
    ["the named owner", owner, true, true, true],
    ["an admin", admin, false, true, true],
    ["a member", member, false, false, true],
    ["a limited member", { ...member, role: "restricted" }, false, false, true],
    ["a second person with the owner role who is not the named owner", { ...owner, id: "owner-2" }, false, false, true],
    ["the named owner's id with the member role", { ...owner, role: "member" }, false, false, true],
    ["the named owner's id with the admin role", { ...owner, role: "admin" }, false, true, true],
    ["a role this code does not know", { ...member, role: "superuser" }, false, false, true],
    ["a person with no role at all", { ...member, role: undefined }, false, false, true],
    ["an invited person who has not signed in", { ...admin, status: "invited" }, false, false, false],
    ["a removed owner", { ...owner, status: "removed" }, false, false, false],
    ["a removed admin", { ...admin, status: "removed" }, false, false, false],
    ["nobody (signed out)", null, false, false, false],
    ["nobody (undefined)", undefined, false, false, false],
  ])("%s", (_who, person, asOwner, asAdmin, asMember) => {
    expect([mayUse(person as never, "owner"), mayUse(person as never, "admin"), mayUse(person as never, "member")]).toEqual([asOwner, asAdmin, asMember]);
  });
  it("reads a level it does not know as owner, so a mistake closes instead of opening", () => {
    for (const level of ["", "Admin", "root", undefined, null]) {
      expect(mayUse(admin as never, level as never), String(level)).toBe(false);
      expect(mayUse(member as never, level as never), String(level)).toBe(false);
      expect(mayUse(owner as never, level as never), String(level)).toBe(true);
    }
  });
  it("has no owner at all when the owner id is not configured, instead of widening to every owner; an admin stays an admin", () => {
    vi.stubEnv("AGENT_OWNER_USER_ID", "");
    expect(LEVELS.map(level => mayUse(owner as never, level))).toEqual([false, false, true]);
    expect(LEVELS.map(level => mayUse(admin as never, level))).toEqual([false, true, true]);
  });
  it("names the level a person holds, for the menu, and never more than the check gives", () => {
    expect([owner, admin, member, { ...member, role: "superuser" }, { ...owner, id: "owner-2" }, { ...admin, status: "removed" }, null].map(p => consoleLevel(p as never)))
      .toEqual(["owner", "admin", "member", "member", "member", null, null]);
  });
});

describe("the guards every page, action and route goes through", () => {
  const people = [["owner", owner], ["admin", admin], ["member", member], ["unknown role", { ...member, role: "superuser" }]] as const;
  const allowed: Record<string, string[]> = { owner: ["owner", "admin", "member"], admin: ["admin", "member"], member: ["member"], "unknown role": ["member"] };
  for (const [who, person] of people) for (const level of LEVELS) {
    const ok = allowed[who]!.includes(level);
    it(`${who} at a ${level}-level page, action and address: ${ok ? "let in" : "refused"}`, async () => {
      mocks.lookup.mockResolvedValue(person);
      mocks.query.mockResolvedValue({ rows: [{ primary_email: `${person.id}@example.test` }] });
      if (ok) {
        await expect(requirePage(level)).resolves.toMatchObject({ id: person.id });
        await expect(requireAction(level)).resolves.toMatchObject({ id: person.id });
        expect(await actingAddress(level)).toBe(`${person.id}@example.test`);
      } else {
        await expect(requirePage(level)).rejects.toThrow(`redirect:${REFUSED_PAGE}`);
        await expect(requireAction(level)).rejects.toThrow(`Console ${level} admission required`);
        expect(await actingAddress(level)).toBeNull();
        expect(mocks.query, "nothing is read for a refused person").not.toHaveBeenCalled();
      }
    });
  }
  it("sends a signed-out person to sign in, and refuses their actions, at every level", async () => {
    mocks.lookup.mockResolvedValue(undefined);
    for (const level of LEVELS) {
      await expect(requirePage(level)).rejects.toThrow("redirect:/sign-in");
      await expect(requireAction(level)).rejects.toThrow(`Console ${level} admission required`);
      expect(await actingAddress(level)).toBeNull();
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("sends a refused person to Your membership with the mark that makes that page say why", () => {
    expect(REFUSED_PAGE).toBe("/your-membership?refused=1");
  });
});

describe("who did this: the signed-in person's own address, never the owner's for someone else", () => {
  it("looks up the admin's own row, pinned to the role the session holds", async () => {
    mocks.lookup.mockResolvedValue(admin);
    mocks.query.mockImplementation(async (_sql: string, values: unknown[]) => ({ rows: [{ primary_email: values[0] === "admin-1" ? "admin@example.test" : "owner@example.test" }] }));
    expect(await actingAddress("admin")).toBe("admin@example.test");
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith("SELECT primary_email FROM users WHERE id=$1 AND status='active' AND org_role=$2", ["admin-1", "admin"]);
    expect(mocks.query.mock.calls.flat(2)).not.toContain("owner-1");
  });
  it("gets the owner's address only after exact stable owner admission", async () => {
    expect(await actingAddress("owner")).toBe("owner@example.test");
    expect(mocks.lookup).toHaveBeenCalledWith("opaque");
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("id=$1 AND status='active'"), ["owner-1", "owner"]);
  });
  it("gives no address when the row is gone, the role changed since the session was read, or the address is not one", async () => {
    mocks.lookup.mockResolvedValue(admin);
    for (const result of [{ rows: [] }, { rows: [{ primary_email: null }] }, { rows: [{ primary_email: "not an address" }] }, { rows: [{ primary_email: "a@b,c@d" }] }]) {
      mocks.query.mockResolvedValue(result);
      expect(await actingAddress("admin")).toBeNull();
    }
  });
});

describe("current database member and session admission", () => {
  it("accepts active members for their own membership, never the shared console", async () => {
    mocks.lookup.mockResolvedValue({ ...owner, id: "second", role: "member" });
    expect(await signedInMember()).toMatchObject({ id: "second" });
    expect(await requirePage("member")).toMatchObject({ id: "second" });
    expect(await actingAddress("owner")).toBeNull();
    expect(await actingAddress("admin")).toBeNull();
    await expect(requireAction("owner")).rejects.toThrow("owner admission required");
    await expect(requirePage("owner")).rejects.toThrow("redirect:/your-membership");
    await expect(requirePage("admin")).rejects.toThrow("redirect:/your-membership");
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("derives a non-owner audit address from an active member row without making it authority",async()=>{
    mocks.lookup.mockResolvedValue({...owner,id:'11111111-1111-4111-8111-111111111111',role:'member'});
    expect(await sessionMember('opaque')).toMatchObject({id:'11111111-1111-4111-8111-111111111111',role:'member'});
    expect(await memberAuditAddress('11111111-1111-4111-8111-111111111111')).toBe('owner@example.test');
    expect(mocks.query).toHaveBeenCalledWith("SELECT primary_email FROM users WHERE id=$1 AND status='active'",
      ['11111111-1111-4111-8111-111111111111']);
    expect(await actingAddress('owner')).toBeNull();
  });
  it.each([{rows:[]},{rows:[{primary_email:'not-an-email'}]}])('does not mint an audit address without a current active valid address: %s',async result=>{
    mocks.query.mockResolvedValue(result);
    expect(await memberAuditAddress('member-id')).toBeNull();
  });
  it.each([{ id: "second", role: "owner" }, { id: "owner-1", role: "member" }, { id: "owner-1", role: "owner", status: "removed" }])("refuses a different owner, demoted or inactive owner: %s", async changes => {
    mocks.lookup.mockResolvedValue({ ...owner, ...changes });
    expect(await actingAddress("owner")).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("refuses missing configuration instead of widening to all owners", async () => {
    vi.stubEnv("AGENT_OWNER_USER_ID", "");
    expect(await actingAddress("owner")).toBeNull();
  });
  it("rechecks revocation/removal on every invocation and distinguishes a DB outage", async () => {
    expect(await actingAddress("owner")).toBe("owner@example.test");
    mocks.lookup.mockResolvedValue(undefined);
    expect(await actingAddress("owner")).toBeNull();
    await expect(requirePage("owner")).rejects.toThrow("redirect:/sign-in");
    mocks.lookup.mockRejectedValue(new Error("database offline"));
    await expect(sessionMember("opaque")).rejects.toThrow("storage is unavailable");
    for (const level of LEVELS) {
      await expect(requirePage(level)).rejects.toThrow("storage is unavailable");
      await expect(requireAction(level)).rejects.toThrow("storage is unavailable");
      await expect(actingAddress(level)).rejects.toThrow("storage is unavailable");
    }
    expect(await sessionMember(undefined)).toBeNull();
  });
  it("keeps transport address lookup outages unavailable instead of signing out", async () => {
    mocks.query.mockRejectedValue(new Error("private database error detail"));
    await expect(actingAddress("owner")).rejects.toThrow("Console sign-in storage is unavailable. Try again.");
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
    mocks.cookie.mockReturnValue({ value: "legacy-email.signature" });
    for (const level of LEVELS) expect(await actingAddress(level)).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
