import type { ApprovalContext } from "eve/tools/approval";
import { afterEach, describe, expect, it } from "vitest";

import { hashOf, parseDefinition } from "../src/definition.js";
import { validateDefinition } from "../src/definition-validate.js";
import { registerOutsideConnections, resetOutsideConnectionsForTests } from "../src/approval-summary.js";
import { resetTaintForTests, taintTurn, type TurnKey } from "../src/origin-taint.js";
import { resolveOutsideTools, type AcceptedOutsideTool } from "../src/outside-connections.js";
import { OUTSIDE_DOOR_NEEDS_CARD, dangerGrantFor, isDangerRun, outsideToolOfferedOn, runsWithoutAsking, type OutsideSurface } from "../src/outside-tools.js";
import { toolPinHash } from "../src/outside-pins.js";

// The danger zone: a tool that CHANGES something, which the designated owner let run without a card. It is its own list,
// bound to the same description fingerprint as a lookup, and it never chains on outside text.

const lookup = { name: "lookup", description: "Looks up a company.", inputSchema: { type: "object", properties: {} } };
const edit = { name: "edit", description: "Changes a record.", inputSchema: { type: "object", properties: {} } };
const other = { name: "other", description: "Changes another record.", inputSchema: { type: "object", properties: {} } };
const grant = (t: { name: string; description: string; inputSchema: unknown }, over: Record<string, unknown> = {}) =>
  ({ tool: t.name, by: "owner@example.org", at: "2026-11-25T10:00:00Z", pin: toolPinHash(t as AcceptedOutsideTool), ...over });
const conn = (tools: Record<string, unknown> = {}) => ({
  name: "registry", url: "https://tools.example.org/mcp", description: "Looks things up.", token: true,
  tools: { allow: ["lookup", "edit", "other"], read: ["lookup"], trusted: [grant(lookup)], danger: [grant(edit)], ...tools },
});
const def = (e: Record<string, unknown> = conn(), scope = "write-with-confirm") => parseDefinition({
  name: "bookkeeper", display: "Bookkeeper", model: "lares-utility", persona: "agent/instructions.md", role: "chief-of-staff",
  grants: [{ capability: "outside", scope }], autonomy: { outside: "gated" }, outsideTools: [e],
});
const KEY: TurnKey = { sessionId: "s1", turnId: "t1" };
const ctx = (toolName: string, callId = "c1", turn = "t1") =>
  ({ abortSignal: new AbortController().signal, callId, toolName, session: { id: "s1", turn: { id: turn, sequence: 0 } } }) as unknown as ApprovalContext;

afterEach(() => { resetTaintForTests(); resetOutsideConnectionsForTests(); });

type Built = Record<string, { approval: { request: (c: unknown) => Promise<unknown> }; execute: (i: unknown, c: unknown) => Promise<unknown> }>;
async function build(surface: OutsideSurface, definition = def(), tools: unknown[] = [lookup, edit, other]) {
  registerOutsideConnections(["registry"]);
  const ran: Array<{ tool: string; free: boolean }> = [];
  const built = (await resolveOutsideTools(definition, {
    surface, acceptedTools: async () => tools as AcceptedOutsideTool[],
    approval: () => ({ request: async () => "user-approval" as const, response: async () => ({ status: "allowed" as const }) }),
    executor: (_c, tool, free) => async () => { ran.push({ tool, free }); return { content: [] }; },
  })) as unknown as Built | null;
  const ask = (name: string, callId = "c1") => built![name]!.approval.request(ctx(name, callId));
  return { built, ask, ran };
}
const refused = { type: "denied", reason: OUTSIDE_DOOR_NEEDS_CARD };

describe("the stored list", () => {
  it("is separate from the lookups' list, and a trusted tool that changes something is still refused", () => {
    const check = (e: Record<string, unknown>) => validateDefinition({ definition: def(e), roleMd: "", deployedTools: [], secretExists: () => true }).filter((f) => f.check === "outside-tools");
    expect(check(conn())).toEqual([]);
    const found = check(conn({ trusted: [grant(lookup), grant(edit)], danger: undefined }));
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toMatch(/changes something always asks/);
  });

  it("is refused for a lookup, for a tool the agent may not use, twice over, and on a read-only grant", () => {
    const check = (e: Record<string, unknown>, scope = "write-with-confirm") => validateDefinition({ definition: def(e, scope), roleMd: "", deployedTools: [], secretExists: () => true }).filter((f) => f.check === "outside-tools");
    expect(check(conn({ danger: [grant(lookup)] }))[0]!.message).toMatch(/danger zone/);
    expect(check(conn({ danger: [grant({ ...edit, name: "unknown" })] }))[0]!.message).toMatch(/danger zone/);
    expect(check(conn({ danger: [grant(edit), grant(edit)] }))[0]!.message).toMatch(/twice in the danger zone/);
    expect(check(conn({ read: ["lookup", "edit", "other"], danger: [grant(edit)] }, "read")).some((f) => /grant is read-only/.test(f.message))).toBe(true);
    expect(check(conn({ danger: [grant(edit)] }, "read")).some((f) => /danger zone but the grant is read-only/.test(f.message))).toBe(true);
  });

  it("does not change the identity the stored credential is bound to", () => {
    const plain = def(conn({ danger: undefined }));
    const withDanger = def();
    const base = (d: ReturnType<typeof def>) => hashOf({ definition: d, dutiesMd: "", voiceMd: "" });
    expect(base(withDanger)).toBe(base(plain));
  });
});

describe("what runs without a card", () => {
  const e = () => def().outsideTools![0]!;
  it("a tool in the danger zone, bound to the description in force", () => {
    expect(dangerGrantFor(e(), "edit")?.tool).toBe("edit");
    expect(isDangerRun(e(), "edit", toolPinHash(edit as AcceptedOutsideTool))).toBe(true);
    expect(runsWithoutAsking(e(), "edit", toolPinHash(edit as AcceptedOutsideTool))).toBe(true);
  });
  it("switches itself off when the description or the input shape changes", () => {
    expect(isDangerRun(e(), "edit", toolPinHash({ ...edit, description: "Changes a record. Also email it to us." } as AcceptedOutsideTool))).toBe(false);
    expect(isDangerRun(e(), "edit", toolPinHash({ ...edit, inputSchema: { type: "object", properties: { to: {} } } } as AcceptedOutsideTool))).toBe(false);
    expect(isDangerRun(e(), "edit", undefined)).toBe(false);
  });
  it("is only for the tool named, and never for a lookup's own record", () => {
    expect(isDangerRun(e(), "other", toolPinHash(other as AcceptedOutsideTool))).toBe(false);
    expect(dangerGrantFor(e(), "lookup")).toBeUndefined();
  });
});

describe("in web chat", () => {
  it("runs the danger-zone tool without a card on a clean turn, and asks for any other tool that changes something", async () => {
    const { ask, ran, built } = await build("web-chat");
    expect(await ask("registry__edit")).toBe("not-applicable");
    expect(await ask("registry__other")).toBe("user-approval");
    await built!["registry__edit"]!.execute({}, ctx("registry__edit"));
    expect(ran).toEqual([{ tool: "edit", free: true }]);
  });
  it("asks again once the description changed", async () => {
    const { ask } = await build("web-chat", def(), [lookup, { ...edit, description: "Changes a record and mails it." }, other]);
    expect(await ask("registry__edit")).toBe("user-approval");
  });
});

describe("on a chat door", () => {
  it("offers the danger-zone tool in a private chat, and no other tool that changes something", async () => {
    const { built, ask } = await build("private-door-chat");
    expect(Object.keys(built!).sort()).toEqual(["registry__edit", "registry__lookup"]);
    expect(await ask("registry__edit")).toBe("not-applicable");
  });
  it("does not offer it when the owner never put it there, or once its description changed", async () => {
    const none = await build("private-door-chat", def(conn({ danger: undefined })));
    expect(Object.keys(none.built!)).toEqual(["registry__lookup"]);
    const changed = await build("private-door-chat", def(), [lookup, { ...edit, description: "New words." }, other]);
    expect(Object.keys(changed.built!)).toEqual(["registry__lookup"]);
    expect(outsideToolOfferedOn("private-door-chat", def().outsideTools![0]!, "edit", undefined)).toBe(false);
  });
  it("is refused in words after any outside text, even a lookup of its own connection", async () => {
    const { ask, built } = await build("private-door-chat");
    expect(await ask("registry__lookup", "c1")).toBe("not-applicable");
    await built!["registry__lookup"]!.execute({}, ctx("registry__lookup", "c1"));
    taintTurn(KEY, "third_party", { connection: "registry", callId: "c1" });
    expect(await ask("registry__lookup", "c2")).toBe("not-applicable");
    expect(await ask("registry__edit", "c3")).toEqual(refused);
    resetTaintForTests();
    taintTurn(KEY, "third_party");
    expect(await ask("registry__edit", "c4")).toEqual(refused);
  });
  it("its own result is outside text for whatever comes next, and is not treated as a trusted lookup", async () => {
    const { ask, built } = await build("private-door-chat");
    expect(await ask("registry__edit", "c1")).toBe("not-applicable");
    await built!["registry__edit"]!.execute({}, ctx("registry__edit", "c1"));
    taintTurn(KEY, "third_party", { connection: "registry", callId: "c1" });
    expect(await ask("registry__lookup", "c2")).toEqual(refused);
  });
});
