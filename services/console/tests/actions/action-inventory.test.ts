import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Real lib/auth with the same stand-ins tests/auth.test.ts uses: used only to prove that the guards the
// inventory relies on really refuse a person below the level written at the call.
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), query: vi.fn(), cookie: vi.fn() }));
vi.mock("@lares/agent-kit/member-store", () => ({ PgMemberStore: class { sessionMember = mocks.lookup; currentMember = async (id: string) => (id === "owner-1" ? { id: "owner-1", organisationId: "org", role: "owner", status: "active", automationMode: "draft-and-ask" } : undefined) } }));
vi.mock("../../lib/db", () => ({ pool: { query: mocks.query } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));

import { AUTH_GUARDS, AUTH_LOOKUPS, AUTH_NOT_GUARDS, consoleRoot, generate, inventoryPath, overridesPath, render, scanActionSource, type Overrides, type Row } from "./generate";
import * as auth from "../../lib/auth";
import { actingAddress, mayUse, requireAction, requirePage, sessionMember, signedInMember } from "../../lib/auth";

const REGENERATE = "Run `pnpm -C services/console run actions:inventory`, read the diff, and commit it on purpose.";
/**
 * The owner's decision, written out. Three levels: owner, admin, member. Every page, action and route is
 * listed here with its level ON PURPOSE; the tests below fail when the code and these lists disagree, in
 * either direction. Anything new that is not placed here fails too: the default is owner, and opening
 * something to an admin or a member is a line somebody adds here and the owner can read.
 */
/** A member is exactly as before this change: Chat, Your accounts, Your membership. */
const MEMBER_PAGES = ["/chat", "/chat/[name]", "/your-accounts", "/your-membership"];
/** An admin may also open these. */
const ADMIN_PAGES = [
  "/", "/reviews",
  "/agents", "/agents/[name]", "/writing-style",
  "/integrations", "/integrations/[id]", "/outside-tools", "/outside-tools/[id]", "/outside-tools/new",
  "/deadlines", "/meeting-follow-ups", "/saved-preferences",
  "/permission-checks", "/alerts",
  "/quiet-hours-and-delivery", "/alert-routing", "/alert-routing/catalogue",
];
/** Only the owner: members and roles, backups, the installation's general settings. And creating or editing an
 * agent: the keeper saves whatever the console sends, so until it checks for itself an admin could use the form to
 * give an agent more access or to speak to it as the owner (see OWNER_ACTIONS). An admin sees agents, not the form. */
const OWNER_PAGES = ["/backups", "/general", "/members", "/agents/new", "/agents/[name]/edit"];

/** Actions any signed-in member may call. Each acts on the caller's own things only. Unchanged by the admin role. */
const MEMBER_ACTIONS = [
  "accounts.readPersonalSendCard", "accounts.removeAccount", "members.signOutEverywhere",
  "outside-discovery.acceptOutsideDescriptorReview", "outside-discovery.applyOutsideCredentialCandidate", "outside-discovery.discoverOutsideTools",
  "outside-discovery.inspectOutsideDiscovery", "outside-discovery.listOutsideDiscoveryTargets", "outside-discovery.previewOutsideCredentialApply",
  "outside-discovery.previewOutsideDescriptorReview", "outside-discovery.previewOutsideDiscovery", "outside-discovery.publishOutsideDescriptorReview",
  "outside-discovery.removeOutsideCredential", "outside-discovery.stageOutsideCredentialCandidate",
  "private-metadata.createPrivateMetadataDataset", "private-metadata.issuePrivateMetadataDevice", "private-metadata.previewPrivateMetadataTarget",
  "private-metadata.privateMetadataDeviceStatus", "private-metadata.revokePrivateMetadataDevice",
];
/** Actions that stay with the owner, each with the reason. Several sit on a page an admin may open. */
const OWNER_ACTIONS: Record<string, string> = {
  "agent-access.adoptAgent": "decides who owns an agent",
  "agent-access.saveAgentAccess": "decides which people may use or edit an agent",
  "autonomy.setAutonomy": "decides whether an agent asks before it acts, also on the owner's own mail and calendar",
  "avatar.saveAvatar": "part of the agent form, which is the owner's",
  // The keeper carries out every definition.* request without a check of its own.
  "definition.createAgent": "a new agent's access and instructions are whatever is sent; the owner pays for it",
  "definition.saveDefinition": "can give an agent more access, change how freely it acts and rewrite what it does with the owner's mail",
  "definition.setDoorEnabled": "saves the agent's definition",
  "definition.connectDoor": "whoever supplies a chat app's credentials can speak to the agent as the owner",
  "definition.registerTelegram": "part of setting up a chat door",
  "definition.verifyDoor": "part of setting up a chat door",
  "definition.doorStatus": "part of the agent form, which is the owner's",
  "definition.applyConnections": "starts or restarts an agent with what was saved",
  "definition.retireAgent": "stops an agent for everyone",
  "definition.listConversations": "lists the conversations people have with an agent",
  "definition.agentRuntime": "part of the agent form, which is the owner's",
  "definition.acceptOutsideDescriptions": "lets a tool whose description changed run again",
  "definition.acceptNotionSyncPreview": "an installation setting (Notion sync)",
  "definition.runNotionSyncPreview": "an installation setting (Notion sync)",
  "definition.setNotionSync": "an installation setting (Notion sync)",
  "definition.setMeetingsSource": "an installation setting (which Notion database holds meetings)",
  "definition.setAgentLimit": "a General setting",
  "definition.setAgentSetting": "a General setting",
  "definition.deleteAgent": "deletes the installation's data",
  "definition.startFreshConversation": "throws a conversation away",
  "definition.claimCode": "the keeper records whoever asks as the agent's owner address",
  "delivery.sendTestBrief": "sent to the owner and paid by the owner",
  "delivery.testBriefStatus": "part of the agent form, which is the owner's",
  "inbox.markRead": "the owner's message inbox",
  "members.createInvitation": "members and roles",
  "members.removeMember": "members and roles",
  "members.revokeInvitation": "members and roles",
  "members.setInitialMemberLimit": "members and roles",
  "members.setMemberRole": "members and roles: only the owner changes a role",
  "members.signOutMember": "members and roles",
  "outside-connect.connectSetDanger": "the danger zone",
  "outside-connect.connectSwitchOnTrust": "whether an agent asks before it acts: a new run-without-asking switch is the owner's alone",
  "outside-connectors.removeConnector": "takes a connector from every agent and erases its held tokens",
};

/** Every route with a session, and its level. The rest are the machine and sign-in routes named in overrides.json. */
const ROUTE_LEVELS: Record<string, "member" | "admin" | "owner"> = {
  "GET /api/accounts/google/callback": "member", "POST /api/accounts/google/start": "member",
  "GET /api/accounts/microsoft/callback": "member", "POST /api/accounts/microsoft/start": "member",
  "GET /api/agent-mailbox": "member", "POST /api/agent-mailbox": "member",
  "GET /api/chat/[name]/[...path]": "member", "POST /api/chat/[name]/[...path]": "member",
  "GET /api/agents/[name]/avatar": "member", // a member only for an agent they may chat with; see the admin-parts test
  "GET /api/clipping": "admin",
  "POST /api/clipping": "owner",
  "GET /api/notion-proposals": "admin",
  "POST /api/notion-proposals": "owner",
  "GET /api/credentials/notion": "owner", "POST /api/credentials/notion": "owner",
  "GET /api/inbox": "owner",
  "POST /api/provider-key": "owner",
};

const overrides = JSON.parse(readFileSync(overridesPath, "utf8")) as Overrides;
const inventory = generate();
const rows: Row[] = [...inventory.pages, ...inventory.actions, ...inventory.routes];
const pages = inventory.pages.filter(p => p.kind === "page");

/** Counts "use server" string literals with the TypeScript scanner, a different route from the generator's tree walk. */
function countDirectives(text: string): number {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, text);
  let count = 0;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.StringLiteral && scanner.getTokenValue() === "use server") count++;
  }
  return count;
}
const sourceFiles = (folder: string): string[] =>
  readdirSync(folder).flatMap(name => {
    const path = join(folder, name);
    if (name === "node_modules" || name === ".next") return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

describe("action discovery does not miss anything", () => {
  it("accounts for every \"use server\" directive in app, components and lib, at the top of a file or inside a function", () => {
    let onDisk = 0;
    for (const folder of ["app", "components", "lib"]) for (const file of sourceFiles(join(consoleRoot, folder))) onDisk += countDirectives(readFileSync(file, "utf8"));
    expect(inventory.useServerDirectives, "A \"use server\" directive exists that the generator did not list. Find it with grep and make the generator read it.").toBe(onDisk);
  });

  it("turns an exported name it cannot read as a function into an unknown row (fixture)", () => {
    const wrapped = scanActionSource("fixture.ts", `"use server";\nexport const danger = wrap(async () => {});\nexport async function ok() {}\nexport const arrow = async () => {};\n`);
    expect(wrapped).toMatchObject({ fileLevel: true, functions: ["ok", "arrow"], unrecognised: ["danger"], inline: 0 });
    const others = scanActionSource("fixture.ts", `'use server';\nexport { a } from "./a";\nexport * from "./b";\nexport default async function () {}\nexport const { x } = obj;\nexport type T = string;\nexport interface I {}\n`);
    expect(others.unrecognised).toEqual(["a", "*", "default", "(destructured export)"]);
    expect(others.functions).toEqual([]);
  });

  it("finds a directive inside a function body, and does not count a file without one (fixture)", () => {
    const page = scanActionSource("page.tsx", `export default function Page() {\n  async function save() {\n    "use server";\n  }\n  return null;\n}\n`);
    expect(page).toMatchObject({ fileLevel: false, inline: 1, functions: [], unrecognised: [] });
    expect(scanActionSource("plain.ts", `export const a = 1; // "use server" in a comment\n`)).toMatchObject({ fileLevel: false, inline: 0 });
    const both = scanActionSource("both.ts", `"use server";\nexport async function a() { async function b() { "use server"; } }\n`);
    expect(both).toMatchObject({ fileLevel: true, inline: 1, functions: ["a"] });
  });

  it("makes the count check able to fail: counting only the top of the file would miss a hidden directive (fixture)", () => {
    const text = `"use server";\nexport async function a() { if (x) { "use server"; } }\n`;
    const scan = scanActionSource("f.ts", text);
    expect((scan.fileLevel ? 1 : 0) + scan.inline).toBe(countDirectives(text));
    expect(scan.fileLevel ? 1 : 0).not.toBe(countDirectives(text));
  });
});

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
    for (const [section, table] of Object.entries({ guards: overrides.guards, getChangesState: overrides.getChangesState, publicByDesign: overrides.publicByDesign })) {
      for (const [id, value] of Object.entries(table)) {
        const reason = typeof value === "string" ? value : value.reason;
        expect(reason.trim().length, `${section}: ${id} needs a reason`).toBeGreaterThan(15);
      }
    }
    const routeIds = new Set(inventory.routes.map(r => r.id));
    for (const id of Object.keys(overrides.getChangesState)) expect(routeIds.has(id), `getChangesState: ${id} is not a route`).toBe(true);
    for (const row of inventory.routes) if (row.methods === "GET") expect(row.changesState, row.id).toBe(row.id in overrides.getChangesState);
  });

  it("gives every page the level the owner decided, and no page a level by accident", () => {
    const byLevel = (level: string) => pages.filter(p => p.see === level).map(p => p.id).sort();
    expect(byLevel("member"), "Pages a member may open. A member is exactly as before the admin role: chat, their accounts, their membership.").toEqual([...MEMBER_PAGES].sort());
    expect(byLevel("admin"), "Pages an admin may open. Opening another page to admins is a line added to ADMIN_PAGES on purpose.").toEqual([...ADMIN_PAGES].sort());
    expect(byLevel("owner"), "Pages only the owner may open.").toEqual([...OWNER_PAGES].sort());
    expect(byLevel("public"), "Pages a signed-out person must reach.").toEqual(Object.keys(overrides.publicByDesign).sort());
    expect(new Set([...MEMBER_PAGES, ...ADMIN_PAGES, ...OWNER_PAGES, ...Object.keys(overrides.publicByDesign)]).size, "a page is listed at two levels").toBe(pages.length);
  });

  it("keeps Members, Backups and General away from an admin, and everything but chat, accounts and membership away from a member", () => {
    for (const id of ["/members", "/backups", "/general"]) expect(pages.find(p => p.id === id)?.see, id).toBe("owner");
    for (const page of pages) if (!MEMBER_PAGES.includes(page.id) && !(page.id in overrides.publicByDesign)) expect(["admin", "owner"], `${page.id} is open to a member`).toContain(page.see);
  });

  it("refuses at every page that needs a session: the page guard is there, and the page never acts more openly than it opens", () => {
    const strict = { public: 0, member: 1, admin: 2, owner: 3 } as Record<string, number>;
    const guarded = pages.filter(p => !(p.id in overrides.publicByDesign));
    expect(guarded.length).toBeGreaterThan(20);
    for (const page of guarded) {
      expect(page.guards, page.id).toContain("requirePage");
      if (page.act !== "none") expect(strict[page.act]!, `${page.id}: opens as ${page.see}, acts as ${page.act}`).toBeGreaterThanOrEqual(strict[page.see!]!);
    }
  });

  it("gives every action the level the owner decided: the member list and the owner list are exact, the rest is admin", () => {
    const byLevel = (level: string) => inventory.actions.filter(a => a.act === level).map(a => a.id).sort();
    expect(byLevel("member"), "Actions any member may call. Nothing that was owner-only may appear here.").toEqual([...MEMBER_ACTIONS].sort());
    expect(byLevel("owner"), "Actions that stay with the owner. One that leaves this list became open to admins.").toEqual(Object.keys(OWNER_ACTIONS).sort());
    expect(byLevel("public"), "No action is callable without a session.").toEqual([]);
    expect(byLevel("admin").length + MEMBER_ACTIONS.length + Object.keys(OWNER_ACTIONS).length).toBe(inventory.actions.length);
    for (const [id, reason] of Object.entries(OWNER_ACTIONS)) expect(reason.length, `${id} needs its reason`).toBeGreaterThan(10);
  });

  it("keeps whole files at one level unless the exception is written down", () => {
    // An action follows the page it serves. These files are entirely the level named; a new action in one of them
    // at another level fails here until it is placed on purpose (the lists above then say why).
    const whole: Record<string, string> = {
      "agent-access": "owner", inbox: "owner", autonomy: "owner", avatar: "owner", definition: "owner",
      deadlines: "admin", "meeting-series": "admin", proactivity: "admin", signals: "admin", taste: "admin", voice: "admin", waiting: "admin",
      accounts: "member", "outside-discovery": "member", "private-metadata": "member",
    };
    const mixed = ["delivery", "members", "outside-connect", "outside-connectors"];
    const files = new Set(inventory.actions.map(a => a.id.split(".")[0]!));
    expect([...files].sort(), "an action file is not placed at a level").toEqual([...Object.keys(whole), ...mixed].sort());
    for (const action of inventory.actions) {
      const file = action.id.split(".")[0]!;
      if (file in whole) expect(action.act, action.id).toBe(whole[file]);
    }
    // In the mixed files everything is admin except what the owner list names and the one member action.
    for (const action of inventory.actions.filter(a => mixed.includes(a.id.split(".")[0]!)))
      expect(action.act, action.id).toBe(action.id in OWNER_ACTIONS ? "owner" : action.id === "members.signOutEverywhere" ? "member" : "admin");
  });

  it("gives every route with a session the level the owner decided", () => {
    const withSession = inventory.routes.filter(r => r.source !== "override");
    expect(Object.fromEntries(withSession.map(r => [r.id, r.act]))).toEqual(ROUTE_LEVELS);
    for (const row of inventory.routes.filter(r => r.source === "override")) expect(row.act, row.id).toBe("public");
  });

  it("never lets an action be more open than the pages that use it need", () => {
    const pageLevel = new Map(pages.map(p => [p.id, p.see]));
    for (const action of inventory.actions) {
      const users = action.usedBy!.map(u => pageLevel.get(u)).filter(Boolean);
      if (action.act === "member" || action.act === "public")
        expect(users.some(l => l === "member" || l === "public"), `${action.id} admits any member but no member page uses it; it probably needs a stricter level`).toBe(true);
      if (action.act === "admin" && users.length)
        expect(users.some(l => l !== "owner"), `${action.id} admits an admin but only owner-only pages use it; it should be owner`).toBe(true);
    }
  });

  it("marks where a page or action an admin or member passes holds something stricter inside", () => {
    // Not a gate by itself: it says where to look. The owner-only parts on admin pages are hidden by the page and refused by the action.
    const withOwnerParts = rows.filter(r => r.ownerExtras).map(r => r.id).sort();
    expect(withOwnerParts).toEqual(["/agents/[name]", "/integrations/[id]", "/outside-tools/[id]", "/reviews", "/sign-in", "/your-accounts", "GET /api/auth/[...route]", "accounts.removeAccount",
      "outside-connect.connectSetTools"].sort()); // an admin sets tools; a new run-without-asking switch inside the same save is refused
    // An agent's picture: an admin sees every agent's; a member only an agent they may chat with, checked inside.
    expect(rows.filter(r => r.adminExtras).map(r => r.id)).toEqual(["GET /api/agents/[name]/avatar"]);
  });

  it("only gates pages, actions and routes through guards this suite has proved, and knows every function lib/auth.ts exports", () => {
    const proved = new Set([...Object.keys(AUTH_GUARDS), ...AUTH_LOOKUPS]);
    for (const row of rows) for (const guard of row.guards) expect(proved.has(guard), `${row.id} relies on ${guard}; add a behaviour check for it below`).toBe(true);
    const exported = Object.entries(auth).filter(([, value]) => typeof value === "function").map(([name]) => name).sort();
    expect(exported, "lib/auth.ts exports a function the generator does not know. Say in generate.ts whether it is a guard, a lookup or neither, and prove it below.")
      .toEqual([...Object.keys(AUTH_GUARDS), ...AUTH_LOOKUPS, ...AUTH_NOT_GUARDS].sort());
  });

  it("reads the level from the word written at the call, and counts a level it cannot read as no guard", () => {
    // Every guard call in the console writes its level out. A call that passed a variable would leave its row unknown,
    // which the "no row whose guard is unknown" test refuses. This checks the source the same way, by text.
    const calls = /\b(requirePage|requireAction|actingAddress)\(([^)]*)\)|\bmayUse\([^,()]+(?:\([^()]*\))?[^,()]*,\s*([^)]*)\)/g;
    let seen = 0;
    for (const folder of ["app", "components", "lib"]) for (const file of sourceFiles(join(consoleRoot, folder))) {
      if (file.endsWith("lib/auth.ts")) continue;
      for (const match of readFileSync(file, "utf8").matchAll(calls)) {
        seen++;
        expect((match[2] ?? match[3] ?? "").trim(), `${file}: ${match[0]}`).toMatch(/^["'](owner|admin|member)["']$/);
      }
    }
    expect(seen).toBeGreaterThan(100);
  });
});

const owner = { id: "owner-1", organisationId: "org", role: "owner", status: "active", automationMode: "draft-and-ask" };
const people = {
  "the named owner": owner,
  "an admin": { ...owner, id: "admin-1", role: "admin" },
  "a member": { ...owner, id: "member-1", role: "member" },
  "a different owner": { ...owner, id: "owner-2" },
  "a person with an unknown role": { ...owner, id: "odd-1", role: "superuser" },
} as const;
/** What each person may use, by level. A second owner and an unknown role are members. */
const MAY: Record<keyof typeof people, readonly string[]> = {
  "the named owner": ["owner", "admin", "member"], "an admin": ["admin", "member"], "a member": ["member"],
  "a different owner": ["member"], "a person with an unknown role": ["member"],
};
beforeEach(() => {
  vi.stubEnv("AGENT_OWNER_USER_ID", "owner-1");
  mocks.lookup.mockReset().mockResolvedValue(owner);
  mocks.query.mockReset().mockResolvedValue({ rows: [{ primary_email: "person@example.test" }] });
  mocks.cookie.mockReset().mockReturnValue({ value: "opaque" });
});
afterEach(() => vi.unstubAllEnvs());

describe("the guards the inventory relies on really refuse a person below the level, for all three levels", () => {
  for (const who of Object.keys(people) as (keyof typeof people)[]) for (const level of ["owner", "admin", "member"] as const) {
    const allowed = MAY[who].includes(level);
    it(`${allowed ? "lets" : "refuses"} ${who} at ${level} level, in each guard as the generator reads it`, async () => {
      const person = people[who];
      mocks.lookup.mockResolvedValue(person);
      // check: mayUse answers yes or no
      expect(AUTH_GUARDS.mayUse).toEqual({ levelArg: 1, kind: "check" });
      expect(mayUse(person as never, level)).toBe(allowed);
      // throws: requirePage redirects, requireAction throws
      expect(AUTH_GUARDS.requirePage).toEqual({ levelArg: 0, kind: "throws" });
      expect(AUTH_GUARDS.requireAction).toEqual({ levelArg: 0, kind: "throws" });
      if (allowed) {
        await expect(requirePage(level)).resolves.toMatchObject({ id: person.id });
        await expect(requireAction(level)).resolves.toMatchObject({ id: person.id });
      } else {
        await expect(requirePage(level)).rejects.toThrow("redirect:/your-membership?refused=1");
        await expect(requireAction(level)).rejects.toThrow(`${level} admission required`);
      }
      // nullable: actingAddress returns the person's own address or null
      expect(AUTH_GUARDS.actingAddress).toEqual({ levelArg: 0, kind: "nullable" });
      expect(await actingAddress(level)).toBe(allowed ? "person@example.test" : null);
    });
  }
  it("sends someone who is signed out to sign in, and refuses their actions, at every level", async () => {
    mocks.lookup.mockResolvedValue(null);
    for (const level of ["owner", "admin", "member"] as const) {
      await expect(requirePage(level)).rejects.toThrow("redirect:/sign-in");
      await expect(requireAction(level)).rejects.toThrow("admission required");
      expect(await actingAddress(level)).toBeNull();
      expect(mayUse(null, level)).toBe(false);
    }
  });
  it("the lookups return the signed-in person or null, so a null check on them is a member-level guard", async () => {
    expect(AUTH_LOOKUPS).toEqual(["sessionMember", "signedInMember"]);
    mocks.lookup.mockResolvedValue(people["a member"]);
    expect(await sessionMember("opaque")).toMatchObject({ id: "member-1" });
    expect(await signedInMember()).toMatchObject({ id: "member-1" });
    mocks.lookup.mockResolvedValue(undefined);
    expect(await sessionMember("opaque")).toBeNull();
    expect(await signedInMember()).toBeNull();
  });
});
