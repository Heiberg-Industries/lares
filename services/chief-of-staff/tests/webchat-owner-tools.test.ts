// Web chat: the agent's owner (and only the owner) gets reply drafts, Google Docs links and the
// chosen mailbox's calendar reads. Every other member keeps the bounded private surface.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const fake = vi.hoisted(() => ({ definition: {} as unknown, owner: vi.fn(), google: vi.fn() }));
vi.mock("@lares/agent-kit/console-turn-authority", async (original) => ({
  ...(await original<typeof import("@lares/agent-kit/console-turn-authority")>()),
  requireConsoleSessionBinding: async () => ({}),
  guardConsoleToolContext: async () => undefined,
}));
vi.mock("@lares/agent-kit/db", async (original) => ({ ...(await original<typeof import("@lares/agent-kit/db")>()), getPool: () => ({}) }));
vi.mock("../lib/definition.js", () => ({ thisAgent: async () => ({ loaded: { definition: fake.definition } }) }));
vi.mock("../lib/agent-mailbox.js", () => ({ loadOwner: (...a: unknown[]) => fake.owner(...a) }));
vi.mock("../lib/google.js", async (original) => ({ ...(await original<object>()), googleClients: (...a: unknown[]) => fake.google(...a) }));
import { parseDefinition } from "@lares/agent-kit/definition";
import resolver from "../agent/tools/catalogue.js";
import { guardCatalogueExecution, catalogueApprovalRequest } from "../lib/approvals.js";
import { callerIsAgentOwner } from "../lib/webchat-owner.js";

const OWNER_TOOLS = ["gmail_draft", "gmail_draft_recipients", "read_url", "calendar_list_events", "calendar_list_calendars", "calendar_free_busy", "calendar_conflicts"];
const EVENT_WRITES = ["calendar_create_event", "calendar_update_event", "calendar_delete_event"];
const mk = (member: string) => ({ authenticator: "lares-console", principalType: "user", principalId: member,
  attributes: { lares_member_id: member, lares_admission_nonce: "a".repeat(43), lares_purpose: "human" } });
const ctxFor = (member: string) => ({ session: { id: "console-x", turn: { id: "t1", sequence: 1 }, auth: { current: mk(member), initiator: mk(member) } } });
const nativeCtx = { session: { id: "native-x", auth: { current: null, initiator: null } } };
const template = JSON.parse(readFileSync(new URL("../../../packages/agent-kit/templates/chief-of-staff/agent.json", import.meta.url), "utf8"));
const defn = (change: (d: any) => any = (d) => d) => parseDefinition(change({ ...template, name: "helper", display: "Helper" }));
const resolve = async (ctx: unknown) => (await resolver.events["session.started"]!({} as never, ctx as never)) as Record<string, any>;

beforeEach(() => {
  vi.stubEnv("LARES_AGENT_NAME", "helper");
  vi.stubEnv("LARES_AGENT_INCARNATION", "11111111-1111-4111-8111-111111111111");
  fake.definition = defn();
  fake.owner.mockReset().mockResolvedValue("member-owner");
  fake.google.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("which tools web chat offers", () => {
  it("lists the owner tools the definition grants, for the owner only, and never an event write", async () => {
    const native = Object.keys(await resolve(nativeCtx));
    const granted = OWNER_TOOLS.filter((n) => native.includes(n));
    expect(granted.length).toBeGreaterThan(0);
    const tools = await resolve(ctxFor("member-owner"));
    for (const n of granted) expect(tools, n).toHaveProperty(n);
    for (const n of EVENT_WRITES) expect(tools, n).not.toHaveProperty(n);
    expect(tools).not.toHaveProperty("gmail_send");
  });

  it("offers a non-owner member none of them", async () => {
    const tools = await resolve(ctxFor("member-other"));
    for (const n of [...OWNER_TOOLS, ...EVENT_WRITES]) expect(tools, n).not.toHaveProperty(n);
  });

  it("offers nothing when the owner cannot be read", async () => {
    fake.owner.mockRejectedValue(new Error("db down"));
    const tools = await resolve(ctxFor("member-owner"));
    for (const n of OWNER_TOOLS) expect(tools, n).not.toHaveProperty(n);
    fake.owner.mockResolvedValue(null);
    for (const n of OWNER_TOOLS) expect(await resolve(ctxFor("member-owner")), n).not.toHaveProperty(n);
  });

  it("leaves a tool the definition does not grant absent, even for the owner", async () => {
    fake.definition = defn((d) => ({ ...d, grants: d.grants.filter((g: any) => g.capability !== "calendar") }));
    const tools = await resolve(ctxFor("member-owner"));
    for (const n of ["calendar_list_events", "calendar_free_busy", "calendar_list_calendars", "calendar_conflicts"]) expect(tools, n).not.toHaveProperty(n);
  });

  it("leaves a native session unchanged", async () => {
    const tools = await resolve(nativeCtx);
    expect(fake.owner).not.toHaveBeenCalled();
    expect(tools).toHaveProperty("gmail_draft");
  });
});

describe("the execution guard", () => {
  it("refuses a non-owner's call (also a replayed one) before any Google call", async () => {
    for (const n of [...OWNER_TOOLS, ...EVENT_WRITES]) {
      await expect(guardCatalogueExecution(ctxFor("member-other"), n, {}), n).rejects.toThrow("Conversation authority");
      await expect(catalogueApprovalRequest(n, ctxFor("member-other"), () => "user-approval"), n).rejects.toThrow("Conversation authority");
    }
    expect(fake.google).not.toHaveBeenCalled();
  });

  it("asks again at the call: ownership that changed after the session began is refused", async () => {
    await expect(guardCatalogueExecution(ctxFor("member-owner"), "gmail_draft", {})).resolves.toBeUndefined();
    fake.owner.mockResolvedValue("member-new-owner");
    await expect(guardCatalogueExecution(ctxFor("member-owner"), "gmail_draft", {})).rejects.toThrow("Conversation authority");
  });

  it("refuses an event write even from the owner", async () => {
    for (const n of EVENT_WRITES) await expect(guardCatalogueExecution(ctxFor("member-owner"), n, {}), n).rejects.toThrow("Conversation authority");
  });

  it("does not touch a native call", async () => {
    await expect(guardCatalogueExecution(nativeCtx, "gmail_draft", {})).resolves.toBeUndefined();
    expect(fake.owner).not.toHaveBeenCalled();
  });
});

describe("callerIsAgentOwner", () => {
  const lookup = (owner: string | null) => async () => owner;
  it("is true only for the human who opened the session and owns the agent", async () => {
    expect(await callerIsAgentOwner(ctxFor("m1"), lookup("m1"))).toBe(true);
    expect(await callerIsAgentOwner(ctxFor("m1"), lookup("m2"))).toBe(false);
    expect(await callerIsAgentOwner(ctxFor("m1"), lookup(null))).toBe(false);
    expect(await callerIsAgentOwner(nativeCtx, lookup("m1"))).toBe(false);
    expect(await callerIsAgentOwner({}, lookup("m1"))).toBe(false);
  });
  it("is false when this turn is another member, a non-human turn, or the lookup fails", async () => {
    expect(await callerIsAgentOwner({ session: { auth: { initiator: mk("m1"), current: mk("m2") } } }, lookup("m1"))).toBe(false);
    const read = { ...mk("m1"), attributes: { ...mk("m1").attributes, lares_purpose: "read" } };
    expect(await callerIsAgentOwner({ session: { auth: { initiator: mk("m1"), current: read } } }, lookup("m1"))).toBe(false);
    expect(await callerIsAgentOwner(ctxFor("m1"), async () => { throw new Error("boom"); })).toBe(false);
  });
  it("is false for an unmanaged process", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("LARES_AGENT_NAME", "");
    vi.stubEnv("LARES_AGENT_INCARNATION", "");
    expect(await callerIsAgentOwner(ctxFor("m1"), lookup("m1"))).toBe(false);
  });
});
