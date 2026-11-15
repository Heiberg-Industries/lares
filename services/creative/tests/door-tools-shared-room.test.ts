// WHICH TOOLS A CONVERSATION STARTED IN A SHARED SLACK ROOM IS GIVEN, AND WHICH IT MAY CALL.
//
// Everyone in a shared room reads the agent's answers, so a conversation started there is offered
// only what the kit's room rule lists (`@lares/agent-kit/shared-room`), and every other tool is
// refused before any card or execution, in the room's own words. A direct message is unchanged.
//
// Real here: the tool resolver (`agent/tools/catalogue.ts`), the own-resolver public-docs tool, the
// public help skill, and the approval policy and execution guard (`lib/approvals.ts`). Stand-ins:
// the loaded definition is the neutral `agent.json` this service ships, and no tool body runs.
// The Slack identities are the shape eve's Slack channel builds (`authenticator: "slack-webhook"`,
// the channel id in `attributes`).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ definition: undefined as unknown }));
vi.mock("../lib/definition.js", async (original) => ({
  ...(await original<typeof import("../lib/definition.js")>()),
  thisAgent: async () => ({ loaded: { definition: fake.definition } }),
}));

import { parseDefinition } from "@lares/agent-kit/definition";
import { SHARED_ROOM_REFUSED, sharedRoomAllows } from "@lares/agent-kit/shared-room";
import catalogueResolver from "../agent/tools/catalogue.js";
import publicDocResolver from "../agent/tools/public_doc.js";
import laresDocsSkill from "../agent/skills/lares-docs.js";
import { CATALOGUE } from "../catalogue/index.js";
import { catalogueApprovalRequest, catalogueApprovalResponse, guardCatalogueExecution } from "../lib/approvals.js";
import { runDynamic, type MemoStore } from "../../../packages/agent-kit/tests/helpers/eve-dynamic.js";

fake.definition = parseDefinition(JSON.parse(readFileSync(new URL("../agent.json", import.meta.url), "utf8")));

const SHOWN = "shown";
const HIDDEN = "hidden";
type Cell = typeof SHOWN | typeof HIDDEN;

// One row per catalogue tool: what a direct message and a shared room are given. A tool added to
// the catalogue fails "has a row for every catalogue tool" until it is decided here.
//                                        Slack DM   Slack room
const TABLE: ReadonlyArray<readonly [tool: string, dm: Cell, room: Cell]> = [
  ["set_language",                        SHOWN,     SHOWN],
  ["studio_ideate",                       SHOWN,     HIDDEN],
  ["vault_list",                          SHOWN,     HIDDEN],
  ["vault_read",                          SHOWN,     HIDDEN],
  ["vault_search",                        SHOWN,     HIDDEN],
  ["vault_write",                         SHOWN,     HIDDEN],
  // The neutral definition grants neither `signals` nor `transit`.
  ["agent-kit__signals_recent",           HIDDEN,    HIDDEN],
  ["agent-kit__transit_plan",             HIDDEN,    HIDDEN],
];

const slack = (channel_id: string) => ({ authenticator: "slack-webhook", principalType: "user", principalId: "U0OWNER",
  attributes: { user_id: "U0OWNER", channel_id } });
const DM = slack("D0DIRECT");
const ROOM = slack("C0SHAREDROOM");
type Session = { session: { id: string; turn: { id: string; sequence: number }; auth: { current: unknown; initiator: unknown } } };
const sessionWith = (id: string, initiator: unknown, current: unknown = initiator): Session =>
  ({ session: { id, turn: { id: "turn-1", sequence: 0 }, auth: { current, initiator } } });
const shownIn = async (session: Session, store: MemoStore = new Map()): Promise<string[]> =>
  Object.keys(await runDynamic(catalogueResolver, session as never, store)).sort();
const expected = (column: 1 | 2): string[] => TABLE.filter((row) => row[column] === SHOWN).map((row) => row[0]).sort();

afterEach(() => { vi.restoreAllMocks(); });

describe("the table", () => {
  it("has a row for every catalogue tool, and none for a tool that is gone", () => {
    expect(TABLE.map((row) => row[0]).sort()).toEqual(Object.keys(CATALOGUE).sort());
  });

  it("the shared room column is the room rule", () => {
    for (const [tool, dm, room] of TABLE) expect(room, tool).toBe(sharedRoomAllows(tool) ? dm : HIDDEN);
  });

  it("no tool shown in a shared room can raise an approval card", () => {
    for (const [tool, , room] of TABLE) {
      if (room === SHOWN) expect((CATALOGUE[tool]!.tool as { approval?: unknown }).approval, tool).toBeUndefined();
    }
  });
});

describe("a direct message", () => {
  it("is given exactly the tools its column says, unchanged", async () => {
    expect(await shownIn(sessionWith("dm", DM))).toEqual(expected(1));
  });

  it("calls go through the guard and the authored policy as before", async () => {
    const ctx = { ...sessionWith("dm", DM), toolName: "vault_write", toolInput: {}, callId: "call-dm" };
    const authored = vi.fn(async () => "user-approval");
    await expect(catalogueApprovalRequest("vault_write", ctx, authored)).resolves.toBe("user-approval");
    expect(authored).toHaveBeenCalledOnce();
    for (const [tool] of TABLE) await expect(guardCatalogueExecution(ctx, tool, {}), tool).resolves.toBeUndefined();
  });

  it("is given the public docs tool and the public help skill", async () => {
    expect(Object.keys(await runDynamic(publicDocResolver, sessionWith("dm-docs", DM) as never))).toEqual(["lares_read_public_doc"]);
    expect(await runDynamic(laresDocsSkill, sessionWith("dm-skill", DM) as never)).not.toBeNull();
  });
});

describe("a conversation started in a shared room", () => {
  it("is given exactly the tools its column says", async () => {
    expect(await shownIn(sessionWith("room", ROOM))).toEqual(expected(2));
  });

  it("the note tools and the studio are hidden, and every call is refused before any card or execution", async () => {
    const ctx = { ...sessionWith("room", ROOM), toolInput: {}, callId: "call-room" };
    const shown = await shownIn(sessionWith("room", ROOM));
    for (const tool of ["vault_list", "vault_read", "vault_search", "vault_write", "studio_ideate"]) {
      expect(shown, tool).not.toContain(tool);
      const authored = vi.fn(async () => "user-approval");
      await expect(catalogueApprovalRequest(tool, { ...ctx, toolName: tool }, authored), tool).rejects.toThrow(SHARED_ROOM_REFUSED);
      expect(authored, tool).not.toHaveBeenCalled();
      await expect(guardCatalogueExecution({ ...ctx, toolName: tool }, tool, {}), tool).rejects.toThrow(SHARED_ROOM_REFUSED);
    }
    // The answer to a card for the note write (raised elsewhere, or replayed) is refused too.
    const answer = { session: { id: "room", initiator: ROOM }, response: { decision: "approve", principal: ROOM },
      request: { interactionId: "interaction-1", toolInput: {} } };
    await expect(catalogueApprovalResponse("vault_write", answer)).rejects.toThrow(SHARED_ROOM_REFUSED);
  });

  it("a tool handle from a direct message's list does not run its body for a room conversation", async () => {
    const handle = (await runDynamic(catalogueResolver, sessionWith("dm-handle", DM) as never))["vault_read"] as
      { execute(input: unknown, ctx: unknown): Promise<unknown> };
    const body = vi.spyOn(CATALOGUE["vault_read"]!.tool as unknown as { execute: (...args: unknown[]) => unknown }, "execute");
    await expect(handle.execute({}, { ...sessionWith("room", ROOM), toolName: "vault_read", toolInput: {} })).rejects.toThrow(SHARED_ROOM_REFUSED);
    expect(body).not.toHaveBeenCalled();
  });

  it("is read from the initiator: a card answered from a direct message does not bring the tools back", async () => {
    const store: MemoStore = new Map();
    const before = await shownIn(sessionWith("room-card", ROOM), store);
    expect(await shownIn(sessionWith("room-card", ROOM, DM), store)).toEqual(before);
    expect(await shownIn(sessionWith("room-card", ROOM, DM), new Map())).toEqual(before);
    expect(before).toEqual(expected(2));
  });

  it("a list saved for the same session id without the room rule is not reused", async () => {
    const store: MemoStore = new Map();
    expect(await shownIn(sessionWith("same-id", DM), store)).toEqual(expected(1));
    expect(await shownIn(sessionWith("same-id", ROOM), store)).toEqual(expected(2));
  });

  it("fails closed: a Slack conversation with no initiator, or a private channel, is a room", async () => {
    expect(await shownIn(sessionWith("no-initiator", null, DM))).toEqual(expected(2));
    expect(await shownIn(sessionWith("private-channel", slack("G0PRIVATEROOM")))).toEqual(expected(2));
  });

  it("is given the public docs tool and the public help skill", async () => {
    expect(Object.keys(await runDynamic(publicDocResolver, sessionWith("room-docs", ROOM) as never))).toEqual(["lares_read_public_doc"]);
    expect(JSON.stringify(await runDynamic(laresDocsSkill, sessionWith("room-skill", ROOM) as never))).toContain("Public Lares documentation");
    expect(sharedRoomAllows("lares_read_public_doc")).toBe(true);
    expect(sharedRoomAllows("lares-docs")).toBe(true);
  });
});
