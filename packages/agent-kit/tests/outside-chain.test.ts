import type { ApprovalContext } from "eve/tools/approval";
import { afterEach, describe, expect, it } from "vitest";

import { parseDefinition } from "../src/definition.js";
import { registerOutsideConnections, resetOutsideConnectionsForTests } from "../src/approval-summary.js";
import { resetTaintForTests, taintTurn, type TurnKey } from "../src/origin-taint.js";
import { resolveOutsideTools, type AcceptedOutsideTool } from "../src/outside-connections.js";
import { OUTSIDE_DOOR_NEEDS_CARD, type OutsideSurface } from "../src/outside-tools.js";
import { toolPinHash } from "../src/outside-pins.js";

// A trusted lookup may chain after outside text, but only when ALL of that text came from trusted
// lookups of the SAME connection. Everything else keeps the old behaviour.

const lookup = { name: "lookup", description: "Looks up a company.", inputSchema: { type: "object", properties: {} } };
const owners = { name: "owners", description: "Lists owners.", inputSchema: { type: "object", properties: {} } };
const edit = { name: "edit", description: "Changes a record.", inputSchema: { type: "object", properties: {} } };
const trust = (t: { name: string; description: string; inputSchema: unknown }, over: Record<string, unknown> = {}) =>
  ({ tool: t.name, by: "m", at: "2026-11-20T10:00:00Z", pin: toolPinHash(t as AcceptedOutsideTool), ...over });
const conn = (name: string, trusted: unknown[]) => ({
  name, url: `https://${name}.example.org/mcp`, description: "Looks things up.", token: true,
  tools: { allow: ["lookup", "owners", "edit"], read: ["lookup", "owners"], trusted },
});
const def = (...e: Array<Record<string, unknown>>) => parseDefinition({
  name: "bookkeeper", display: "Bookkeeper", model: "lares-utility", persona: "agent/instructions.md", role: "chief-of-staff",
  grants: [{ capability: "outside", scope: "write-with-confirm" }], autonomy: { outside: "gated" }, outsideTools: e,
});
const KEY: TurnKey = { sessionId: "s1", turnId: "t1" };
const ctx = (toolName: string, callId: string, turn = "t1") =>
  ({ abortSignal: new AbortController().signal, callId, toolName, session: { id: "s1", turn: { id: turn, sequence: 0 } } }) as unknown as ApprovalContext;

afterEach(() => { resetTaintForTests(); resetOutsideConnectionsForTests(); });

type Built = Record<string, { approval: { request: (c: unknown) => Promise<unknown> }; execute: (i: unknown, c: unknown) => Promise<unknown> }>;

async function build(surface: OutsideSurface, definition = def(conn("registry", [trust(lookup), trust(owners)]), conn("other", [trust(lookup)]))) {
  registerOutsideConnections(["registry", "other"]);
  const tools = [lookup, owners, edit];
  const built = (await resolveOutsideTools(definition, {
    surface, acceptedTools: async () => tools as AcceptedOutsideTool[],
    approval: () => ({ request: async () => "user-approval" as const, response: async () => ({ status: "allowed" as const }) }),
    executor: () => async () => ({ content: [] }),
  })) as unknown as Built;
  const ask = (name: string, callId: string, turn = "t1") => built[name]!.approval.request(ctx(name, callId, turn));
  /** One whole call: ask, run it, and have the hook write the taint with the source it names. */
  const call = async (name: string, callId: string) => {
    const decision = await ask(name, callId);
    await built[name]!.execute({}, ctx(name, callId));
    taintTurn(KEY, "third_party", { connection: name.split("__")[0]!, callId });
    return decision;
  };
  return { built, ask, call };
}

const refused = { type: "denied", reason: OUTSIDE_DOOR_NEEDS_CARD };

describe.each([["web-chat" as const, "user-approval"], ["private-door-chat" as const, refused]])("on %s", (surface, blocked) => {
  it("lets a trusted lookup chain on the same connection", async () => {
    const { ask, call } = await build(surface);
    expect(await call("registry__lookup", "c1")).toBe("not-applicable");
    expect(await ask("registry__owners", "c2")).toBe("not-applicable");
    expect(await call("registry__owners", "c2")).toBe("not-applicable");
    expect(await ask("registry__lookup", "c3")).toBe("not-applicable");
  });

  it("still blocks a different connection after outside text", async () => {
    const { ask, call } = await build(surface);
    await call("registry__lookup", "c1");
    expect(await ask("other__lookup", "c2")).toEqual(blocked);
  });

  it("blocks once a second connection has also been read", async () => {
    const { ask, call } = await build(surface);
    await call("registry__lookup", "c1");
    await call("other__lookup", "c2");
    expect(await ask("registry__lookup", "c3")).toEqual(blocked);
  });

  it("blocks after mail or a link (taint with no source)", async () => {
    const { ask } = await build(surface);
    taintTurn(KEY, "third_party");
    expect(await ask("registry__lookup", "c1")).toEqual(blocked);
  });

  it("blocks when a mail was read between two lookups of the same connection", async () => {
    const { ask, call } = await build(surface);
    await call("registry__lookup", "c1");
    taintTurn(KEY, "third_party");
    expect(await ask("registry__lookup", "c2")).toEqual(blocked);
  });

  it("blocks when the earlier call was never noted as a trusted lookup (unattributable)", async () => {
    const { ask } = await build(surface);
    taintTurn(KEY, "third_party", { connection: "registry", callId: "never-run" });
    expect(await ask("registry__lookup", "c2")).toEqual(blocked);
  });

  it("blocks when the description changed (pin mismatch) on the later lookup", async () => {
    const stale = def(conn("registry", [trust(lookup, { pin: "f".repeat(64) }), trust(owners)]));
    const { ask, call } = await build(surface, stale);
    await call("registry__owners", "c1");
    // The pin no longer matches, so this tool is not a trusted read at all: a door does not offer it, the web asks.
    if (surface === "web-chat") expect(await ask("registry__lookup", "c2")).toBe("user-approval");
  });

  it("does not let an earlier pin-mismatched call count as a trusted lookup", async () => {
    const stale = def(conn("registry", [trust(lookup, { pin: "f".repeat(64) }), trust(owners)]));
    const { built, ask } = await build(surface, stale);
    if (surface === "web-chat") {
      // Approved by a card, run, result read: not a trusted lookup, so the turn reads as mixed.
      await built["registry__lookup"]!.execute({}, ctx("registry__lookup", "c1"));
      taintTurn(KEY, "third_party", { connection: "registry", callId: "c1" });
      expect(await ask("registry__owners", "c2")).toEqual(blocked);
    }
  });

  it("a different turn starts clean", async () => {
    const { ask, call } = await build(surface);
    await call("registry__lookup", "c1");
    expect(await ask("registry__lookup", "c2", "t2")).toBe("not-applicable");
  });

  it("with no turn key at all it does not skip the card after a lookup", async () => {
    const { built, call } = await build(surface);
    await call("registry__lookup", "c1");
    const noKey = { abortSignal: new AbortController().signal, toolName: "registry__lookup", callId: "c9" };
    expect(await built["registry__lookup"]!.approval.request(noKey)).toEqual(blocked);
  });
});

describe("a tool that is not a trusted read", () => {
  it("still asks on the web after a same-connection lookup", async () => {
    const { ask, call } = await build("web-chat");
    await call("registry__lookup", "c1");
    expect(await ask("registry__edit", "c2")).toBe("user-approval");
  });

  it("is not offered on a door at all", async () => {
    const { built } = await build("private-door-chat");
    expect(built["registry__edit"]).toBeUndefined();
  });

  it("when an untrusted tool of the same connection was read, a later trusted lookup asks", async () => {
    const { built, ask } = await build("web-chat");
    // `edit` runs only after a card; its result is outside text of the same connection but not a trusted lookup.
    await built["registry__edit"]!.execute({}, ctx("registry__edit", "c1"));
    taintTurn(KEY, "third_party", { connection: "registry", callId: "c1" });
    expect(await ask("registry__lookup", "c2")).toBe("user-approval");
  });
});
