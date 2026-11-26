/**
 * Who gets in, checked by running the code: every page, every action and every route in the inventory is
 * called with the REAL lib/auth.ts as the named owner, an admin, a member and a person whose role this code
 * does not know. The inventory (tests/actions/action-inventory.json) says which level each one needs; this
 * test proves the running code agrees, in both directions:
 *
 *   - a person below the level is refused BEFORE anything is read or changed (no database query, no keeper
 *     call, no outside request), and a page sends them to Your membership instead of rendering;
 *   - a person at or above the level gets past the guard.
 *
 * Everything behind the guard is a stand-in that only counts calls and then fails, so "got past the guard"
 * shows up as the stand-in being reached or the function ending in something other than a refusal.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class Reached extends Error { constructor(what: string) { super(`reached:${what}`); } }
  const state = { person: null as null | { id: string; role: string; status: string; organisationId: string; automationMode: string }, touched: [] as string[], keeperCalls: [] as { action: string; actor: string }[] };
  const touch = (what: string): never => { state.touched.push(what); throw new Reached(what); };
  return { state, touch, Reached };
});

vi.mock("@lares/agent-kit/member-store", async (original) => ({
  ...(await original<typeof import("@lares/agent-kit/member-store")>()),
  PgMemberStore: class {
    sessionMember = async () => mocks.state.person ?? undefined;
    listMembers = async () => mocks.touch("members.listMembers");
    listInvitations = async () => mocks.touch("members.listInvitations");
    inviteMember = async () => mocks.touch("members.inviteMember");
    revokeInvitation = async () => mocks.touch("members.revokeInvitation");
    signOutAll = async () => mocks.touch("members.signOutAll");
    setRole = async () => mocks.touch("members.setRole");
    currentMember = async () => mocks.touch("members.currentMember");
  },
}));
vi.mock("../lib/db", () => ({
  pool: {
    // The one query lib/auth.ts itself makes is answered: the person's own address. Everything else is data.
    query: async (sql: unknown, values?: unknown[]) => {
      const text = typeof sql === "string" ? sql : (sql as { text?: string })?.text ?? "";
      if (text.startsWith("SELECT primary_email FROM users WHERE id=$1")) return { rows: [{ primary_email: `${String(values?.[0])}@example.test` }] };
      return mocks.touch("database");
    },
    connect: async () => mocks.touch("database"),
  },
}));
vi.mock("../lib/keeper-client", async (original) => ({
  ...(await original<typeof import("../lib/keeper-client")>()),
  keeper: async (action: string, _input: unknown, actor: string) => { mocks.state.keeperCalls.push({ action, actor }); return mocks.touch(`keeper:${action}`); },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "lares_session" && mocks.state.person ? { value: "s".repeat(43) } : undefined), delete: () => undefined, set: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`redirect:${path}`); },
  notFound: () => { throw new Error("not-found"); },
  useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

import type { Inventory, Row } from "./actions/generate";

const inventory = JSON.parse(readFileSync(join(__dirname, "actions/action-inventory.json"), "utf8")) as Inventory;
const base = { organisationId: "org", status: "active", automationMode: "draft-and-ask" };
const PEOPLE = {
  owner: { ...base, id: "owner-1", role: "owner" },
  admin: { ...base, id: "admin-1", role: "admin" },
  member: { ...base, id: "member-1", role: "member" },
  // Fails closed: a role this code does not know is treated as a member.
  "unknown role": { ...base, id: "odd-1", role: "superuser" },
} as const;
type Who = keyof typeof PEOPLE;
const HOLDS: Record<Who, readonly string[]> = { owner: ["owner", "admin", "member"], admin: ["admin", "member"], member: ["member"], "unknown role": ["member"] };
const WHO = Object.keys(PEOPLE) as Who[];
const REFUSAL = /unauthenticated|admission required|Sign in again/i;

const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubEnv("AGENT_OWNER_USER_ID", "owner-1");
  vi.stubEnv("CONSOLE_OAUTH_REDIRECT", "https://console.example.test/api/auth/callback");
  mocks.state.person = null; mocks.state.touched = []; mocks.state.keeperCalls = [];
  globalThis.fetch = (async () => mocks.touch("outside request")) as typeof fetch;
});
afterEach(() => { vi.unstubAllEnvs(); globalThis.fetch = realFetch; });

/** Runs it and says how it ended. Never throws. */
async function outcome(run: () => unknown): Promise<{ threw?: string; value?: unknown }> {
  try { return { value: await run() }; } catch (error) { return { threw: error instanceof Error ? error.message : String(error) }; }
}
const signIn = (who: Who | null) => { mocks.state.person = who ? { ...PEOPLE[who] } : null; mocks.state.touched = []; mocks.state.keeperCalls = []; };

const params = { params: Promise.resolve({ name: "example", id: "00000000-0000-4000-8000-000000000000" }), searchParams: Promise.resolve({}) };

describe("every page: who may open it", () => {
  const pages = inventory.pages.filter((p) => p.kind === "page" && p.see !== "public");
  it("covers every page that needs a session", () => expect(pages.length).toBeGreaterThanOrEqual(27));
  for (const page of pages) {
    describe(`${page.id} (${page.see})`, () => {
      for (const who of WHO) {
        const allowed = HOLDS[who].includes(page.see!);
        it(`${who}: ${allowed ? "allowed" : "refused"}`, async () => {
          const mod = await import(`../${page.file.replace(/\.tsx$/, "")}`) as { default: (props: unknown) => unknown };
          signIn(who);
          const ended = await outcome(() => mod.default(params));
          if (allowed) {
            expect(ended.threw ?? "", "the page sent an allowed person away").not.toMatch(/^redirect:\/(your-membership\?refused|sign-in)/);
          } else {
            // Sent to Your membership, which says why; nothing was read for them.
            expect(ended.threw).toBe("redirect:/your-membership?refused=1");
            expect(mocks.state.touched, "data was read for a refused person").toEqual([]);
          }
        });
      }
      it("signed out: sent to sign in, nothing read", async () => {
        const mod = await import(`../${page.file.replace(/\.tsx$/, "")}`) as { default: (props: unknown) => unknown };
        signIn(null);
        expect((await outcome(() => mod.default(params))).threw).toBe("redirect:/sign-in");
        expect(mocks.state.touched).toEqual([]);
      });
    });
  }
});

describe("every action: who may call it", () => {
  const actions = inventory.actions;
  it("covers every action in every action file", () => {
    expect(actions.length).toBeGreaterThan(100);
    expect(new Set(actions.map((a) => a.file)).size).toBe(19);
  });
  for (const action of actions) {
    const [, name] = action.id.split(".");
    describe(`${action.id} (${action.act})`, () => {
      for (const who of [...WHO, null]) {
        const allowed = who !== null && HOLDS[who].includes(action.act);
        it(`${who ?? "signed out"}: ${allowed ? "allowed" : "refused"}`, async () => {
          const mod = await import(`../${action.file.replace(/\.ts$/, "")}`) as Record<string, (...args: unknown[]) => unknown>;
          signIn(who);
          // The arguments do not matter for the question asked here: an empty form stands for all of them.
          const ended = await outcome(() => mod[name!]!(new FormData(), new FormData()));
          if (allowed) {
            expect(ended.threw ?? "", `${action.id} refused a person it should admit`).not.toMatch(REFUSAL);
          } else {
            expect(mocks.state.touched, `${action.id} read or changed something for a refused person`).toEqual([]);
            expect(mocks.state.keeperCalls).toEqual([]);
            const refusedPlainly = ended.threw !== undefined
              || (typeof ended.value === "object" && ended.value !== null && ("error" in ended.value || (ended.value as { ok?: unknown }).ok === false));
            expect(refusedPlainly, `${action.id} returned as if it had worked: ${JSON.stringify(ended.value)}`).toBe(true);
          }
        });
      }
    });
  }
});

describe("every route with a session: who may call it", () => {
  const routes = inventory.routes.filter((r: Row) => r.act !== "public");
  it("covers every route with a session", () => expect(routes.length).toBe(17));
  const url = (id: string) => `https://console.example.test${id.split(" ")[1]!.replace("[name]", "example").replace("[...path]", "v1/session")}`;
  for (const route of routes) {
    describe(`${route.id} (${route.act})`, () => {
      for (const who of [...WHO, null]) {
        const allowed = who !== null && HOLDS[who].includes(route.act);
        it(`${who ?? "signed out"}: ${allowed ? "allowed" : "refused"}`, async () => {
          const mod = await import(`../${route.file.replace(/\.ts$/, "")}`) as Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
          signIn(who);
          const request = new Request(url(route.id), { method: route.methods!, headers: { origin: "https://console.example.test", "content-type": "application/json" }, ...(route.methods === "POST" ? { body: "{}" } : {}) });
          const ended = await outcome(() => mod[route.methods!]!(request, { params: Promise.resolve({ name: "example", path: ["v1", "session"] }) }));
          const response = ended.value instanceof Response ? ended.value : undefined;
          const body = response ? await response.text() : "";
          const refused = !!response && (response.status === 401 || (response.status === 403 && /owner-required|sign-in-required|administrator-required/.test(body)) || /sign-in-required|owner-required|unauthorized|Not authorised/.test(body));
          if (allowed) {
            expect(refused, `${route.id} refused a person it should admit (${response?.status} ${body.slice(0, 80)})`).toBe(false);
          } else {
            expect(response, `${route.id} did not answer a refused person with a response: ${ended.threw}`).toBeDefined();
            // The two sign-in-with-a-provider callbacks are opened by the browser coming back from the provider: they send a
            // person they cannot place back to a page, with nothing stored. Every other route answers 401 or 403.
            const sentBack = !!response && response.status >= 300 && response.status < 400 && route.id.endsWith("/callback");
            expect(refused || sentBack, `${route.id} answered a refused person with ${response?.status} ${body.slice(0, 80)}`).toBe(true);
            expect(mocks.state.touched, `${route.id} read or changed something for a refused person`).toEqual([]);
            expect(mocks.state.keeperCalls).toEqual([]);
          }
        });
      }
    });
  }
});

describe("who did this is the person who did it", () => {
  const call = async (file: string, name: string, ...args: unknown[]) => {
    const mod = await import(`../app/actions/${file}`) as Record<string, (...a: unknown[]) => unknown>;
    return outcome(() => mod[name]!(...args));
  };
  it("an admin's change to an agent reaches the keeper under the admin's own address, never the owner's", async () => {
    signIn("admin");
    await call("definition", "retireAgent", { name: "example" });
    expect(mocks.state.keeperCalls).toEqual([{ action: "definition.retire", actor: "admin-1@example.test" }]);
  });
  it("the same action by the owner is recorded as the owner", async () => {
    signIn("owner");
    await call("definition", "retireAgent", { name: "example" });
    expect(mocks.state.keeperCalls).toEqual([{ action: "definition.retire", actor: "owner-1@example.test" }]);
  });
  it("an admin's change to an outside tool is recorded as the admin too (the other way an address is fetched)", async () => {
    signIn("admin");
    await call("outside-connectors", "renameConnector", { id: "00000000-0000-4000-8000-000000000000", displayName: "Renamed" });
    expect(mocks.state.keeperCalls.map((c) => c.actor)).toEqual(["admin-1@example.test"]);
    expect(mocks.state.keeperCalls[0]!.action).toBe("outside.connector-rename");
  });
  it("no action an admin can reach ever hands the keeper the owner's address", async () => {
    let reached = 0;
    for (const action of inventory.actions.filter((a) => a.act === "admin")) {
      const [, name] = action.id.split(".");
      const mod = await import(`../${action.file.replace(/\.ts$/, "")}`) as Record<string, (...a: unknown[]) => unknown>;
      signIn("admin");
      // A plain object that answers any field with a plausible name, so the call gets as far as the keeper where it can.
      const input = new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : key === "confirm" ? true : "example") });
      await outcome(() => mod[name!]!(input, new FormData()));
      for (const seen of mocks.state.keeperCalls) expect(seen.actor, `${action.id} -> ${seen.action}`).toBe("admin-1@example.test");
      reached += mocks.state.keeperCalls.length;
    }
    expect(reached, "too few of these calls got as far as the keeper for this to prove anything").toBeGreaterThan(10);
  });
  it("an owner-only action called by an admin never reaches the keeper at all", async () => {
    for (const [file, name, args] of [
      ["definition", "deleteAgent", [{ name: "example", confirm: true }]],
      ["definition", "claimCode", ["example", "slack"]],
      ["definition", "startFreshConversation", [{ name: "example", sessionId: "s", incarnation: "i", confirm: true }]],
      ["definition", "setAgentLimit", [{ ceiling: 99 }]],
      ["delivery", "sendTestBrief", [{ name: "example", door: "slack" }]],
      ["outside-connectors", "removeConnector", ["00000000-0000-4000-8000-000000000000"]],
      ["outside-connect", "connectSetDanger", [{ agent: "example", name: "tool", tool: "t", on: true, typedName: "t" }]],
    ] as const) {
      signIn("admin");
      const ended = await call(file, name, ...args);
      expect(ended.threw, `${file}.${name}`).toMatch(REFUSAL);
      expect(mocks.state.keeperCalls, `${file}.${name}`).toEqual([]);
      expect(mocks.state.touched, `${file}.${name}`).toEqual([]);
    }
  });
});
