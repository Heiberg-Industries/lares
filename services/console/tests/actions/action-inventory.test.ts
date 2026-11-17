import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Real lib/auth with the same stand-ins tests/auth.test.ts uses: used only to prove that the guards the
// inventory relies on really refuse a person who is not the owner.
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), query: vi.fn(), cookie: vi.fn() }));
vi.mock("@lares/agent-kit/member-store", () => ({ PgMemberStore: class { sessionMember = mocks.lookup } }));
vi.mock("../../lib/db", () => ({ pool: { query: mocks.query } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));

import { generate, inventoryPath, overridesPath, render, type Overrides, type Row } from "./generate";
import { isConsoleOwner, requireConsoleMember, requireConsolePage, requireMember, verify } from "../../lib/auth";

const REGENERATE = "Run `pnpm -C services/console run actions:inventory`, read the diff, and commit it on purpose.";
/** Owner decision: every page except chat and membership stays owner-only for now. */
const RULE_OPEN_PAGES = ["/chat", "/chat/[name]", "/membership"];

const overrides = JSON.parse(readFileSync(overridesPath, "utf8")) as Overrides;
const inventory = generate();
const rows: Row[] = [...inventory.pages, ...inventory.actions, ...inventory.routes];
const pages = inventory.pages.filter(p => p.kind === "page");

describe("console action inventory", () => {
  it("is exactly what the generator produces from the code now", () => {
    expect(render(inventory), `The committed inventory is out of date. ${REGENERATE}`).toBe(readFileSync(inventoryPath, "utf8"));
  });

  it("finds the pages, actions and routes that are on disk", () => {
    expect(pages.length).toBeGreaterThan(20);
    expect(inventory.actions.length).toBeGreaterThan(60);
    expect(inventory.routes.length).toBeGreaterThan(15);
    expect(new Set(rows.map(r => `${r.kind}:${r.id}`)).size, "row ids must be unique").toBe(rows.length);
  });

  it("has no row whose guard is unknown", () => {
    const unknown = rows.filter(r => r.source === "unknown" || r.act === "unknown" || r.see === "unknown").map(r => r.id);
    expect(unknown, "Add each one to overrides.json (guards) with a one-line reason, or fix the code so the guard can be read.").toEqual([]);
  });

  it("keeps the override table honest: every entry is needed, and says why", () => {
    const needed = new Set(rows.filter(r => r.source === "override").map(r => r.id));
    expect([...needed].sort(), "overrides.json guards must list exactly the rows the generator cannot derive").toEqual(Object.keys(overrides.guards).sort());
    for (const [section, table] of Object.entries({ guards: overrides.guards, getChangesState: overrides.getChangesState, publicByDesign: overrides.publicByDesign, awaitingOwnerDecision: overrides.awaitingOwnerDecision })) {
      for (const [id, value] of Object.entries(table)) {
        const reason = typeof value === "string" ? value : value.reason;
        expect(reason.trim().length, `${section}: ${id} needs a reason`).toBeGreaterThan(15);
      }
    }
    const routeIds = new Set(inventory.routes.map(r => r.id));
    for (const id of Object.keys(overrides.getChangesState)) expect(routeIds.has(id), `getChangesState: ${id} is not a route`).toBe(true);
    for (const row of inventory.routes) if (row.methods === "GET") expect(row.changesState, row.id).toBe(row.id in overrides.getChangesState);
  });

  it("lets only chat and membership (plus the named exceptions) be reached by a non-owner", () => {
    const reachable = pages.filter(p => p.see !== "owner").map(p => p.id).sort();
    const allowed = [...RULE_OPEN_PAGES, ...Object.keys(overrides.publicByDesign), ...Object.keys(overrides.awaitingOwnerDecision)].sort();
    expect(reachable, "A page other than chat and membership is open to someone who is not the owner. Make it owner-only, or ask the owner and record the decision in overrides.json.").toEqual(allowed);
    for (const id of [...Object.keys(overrides.publicByDesign), ...Object.keys(overrides.awaitingOwnerDecision)]) {
      expect(RULE_OPEN_PAGES, `${id} is already open by rule`).not.toContain(id);
    }
  });

  it("keeps the chat and membership pages for members, signed in", () => {
    for (const id of RULE_OPEN_PAGES) expect(pages.find(p => p.id === id)?.see, id).toBe("member");
  });

  it("refuses a non-owner at every other page: the owner guard is the first thing the page does", () => {
    const ownerPages = pages.filter(p => !RULE_OPEN_PAGES.includes(p.id) && !(p.id in overrides.publicByDesign) && !(p.id in overrides.awaitingOwnerDecision));
    expect(ownerPages.length).toBeGreaterThan(15);
    for (const page of ownerPages) {
      expect(page.see, page.id).toBe("owner");
      expect(page.act === "owner" || page.act === "none", `${page.id}: acts as ${page.act}`).toBe(true);
      expect(page.guards, page.id).toContain("requireConsolePage");
    }
  });

  it("never lets a member-level action sit only on owner-only pages or on no page", () => {
    const memberPages = new Set([...RULE_OPEN_PAGES, ...Object.keys(overrides.publicByDesign), ...Object.keys(overrides.awaitingOwnerDecision)]);
    for (const action of inventory.actions.filter(a => a.act === "member" || a.act === "public")) {
      expect(action.usedBy!.some(u => memberPages.has(u)), `${action.id} admits any member but no member page uses it; it probably needs the owner check`).toBe(true);
    }
  });

  it("only owner-gates actions and routes through guards this suite has proved", () => {
    const proved = new Set(["requireConsolePage", "requireConsoleMember", "verify", "isConsoleOwner", "requireMember", "sessionMember", "signedInMember"]);
    for (const row of rows) for (const guard of row.guards) expect(proved.has(guard), `${row.id} relies on ${guard}; add a behaviour check for it below`).toBe(true);
  });
});

const owner = { id: "owner-1", organisationId: "org", role: "owner", status: "active", automationMode: "draft-and-ask" };
beforeEach(() => {
  vi.stubEnv("AGENT_OWNER_USER_ID", "owner-1");
  mocks.lookup.mockReset().mockResolvedValue(owner);
  mocks.query.mockReset().mockResolvedValue({ rows: [{ primary_email: "owner@example.test" }] });
  mocks.cookie.mockReset().mockReturnValue({ value: "opaque" });
});
afterEach(() => vi.unstubAllEnvs());

describe("the owner guards the inventory relies on really refuse a non-owner", () => {
  const notOwners = [
    ["a member", { ...owner, id: "member-1", role: "member" }],
    ["a different owner", { ...owner, id: "owner-2" }],
  ] as const;
  for (const [who, person] of notOwners) {
    it(`refuses ${who}`, async () => {
      mocks.lookup.mockResolvedValue(person);
      expect(isConsoleOwner(person as never)).toBe(false);
      await expect(requireConsolePage()).rejects.toThrow("redirect:/membership");
      await expect(requireConsoleMember()).rejects.toThrow("owner admission required");
      expect(await verify("opaque")).toBeNull();
    });
  }
  it("sends someone who is signed out to sign in, and refuses their actions", async () => {
    mocks.lookup.mockResolvedValue(null);
    await expect(requireConsolePage()).rejects.toThrow("redirect:/sign-in");
    await expect(requireMember()).rejects.toThrow("redirect:/sign-in");
    await expect(requireConsoleMember()).rejects.toThrow("owner admission required");
    expect(await verify("opaque")).toBeNull();
  });
  it("lets the designated owner through", async () => {
    expect(isConsoleOwner(owner as never)).toBe(true);
    await expect(requireConsolePage()).resolves.toMatchObject({ id: "owner-1" });
    await expect(requireConsoleMember()).resolves.toMatchObject({ id: "owner-1" });
    expect(await verify("opaque")).toBe("owner@example.test");
  });
});
