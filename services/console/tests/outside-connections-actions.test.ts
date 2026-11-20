import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cookies: vi.fn(), sessionMember: vi.fn(), memberAuditAddress: vi.fn(), keeper: vi.fn(), pinned: vi.fn() }));
vi.mock("../lib/outside-tools", () => ({ pinnedToolsFor: (...a: unknown[]) => mocks.pinned(...a) }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("../lib/auth", () => ({ sessionMember: mocks.sessionMember, memberAuditAddress: mocks.memberAuditAddress }));
vi.mock("../lib/keeper-client", () => ({
  keeper: mocks.keeper,
  KeeperRefusedError: class KeeperRefusedError extends Error {
    constructor(message: string, readonly findings?: { check: string; message: string }[]) { super(message); }
  },
}));
import { toolPinHash } from "@lares/agent-kit/outside-pins";
import { applyOutsideConnections, getOutsideConnections, saveOutsideConnections } from "../app/actions/outside-connections";

const token = "A".repeat(43);
const connection = { name: "rates", url: "https://tools.example.org/mcp", description: "Look up rates", token: false,
  tools: { allow: ["find_rate"], read: ["find_rate"] } };
const saved = { name: "bookkeeper", definitionHash: "a".repeat(64), accessRevision: 2, connections: [connection],
  applicationStatus: "pending" as const, appliedConnections: [] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue({ get: () => ({ value: token }) });
  mocks.sessionMember.mockResolvedValue({ id: "member-id" });
  mocks.memberAuditAddress.mockResolvedValue("member@example.test");
  mocks.keeper.mockResolvedValue(saved);
});

describe("outside connection console actions", () => {
  it("uses the current signed-in cookie and asks Keeper for edit authorization", async () => {
    expect(await getOutsideConnections("bookkeeper")).toEqual({ ok: true, result: saved });
    expect(mocks.keeper).toHaveBeenCalledWith("outside.connections.get", { name: "bookkeeper", sessionToken: token }, "member@example.test");
  });

  it("sends only validated declaration metadata, never credential fields", async () => {
    expect(await saveOutsideConnections({ name: "bookkeeper", expectedDefinitionHash: "a".repeat(64), expectedAccessRevision: 2, connections: [connection] }))
      .toEqual({ ok: true, result: saved });
    expect(mocks.keeper).toHaveBeenCalledWith("outside.connections.save", expect.objectContaining({ sessionToken: token, connections: [connection] }), "member@example.test", { timeoutMs: 90_000 });
    await expect(saveOutsideConnections({ name: "bookkeeper", expectedDefinitionHash: "a".repeat(64), expectedAccessRevision: 2,
      connections: [{ ...connection, credential: "forbidden" }] })).rejects.toThrow("Connection details are invalid.");
  });

  it("binds a newly switched-on lookup to the description the agent has pinned, and refuses one nobody has seen", async () => {
    const wanted = { ...connection, tools: { ...connection.tools, trusted: [{ tool: "find_rate", pin: "0".repeat(64), by: "pending", at: "1970-01-01T00:00:00.000Z" }] } };
    const input = { name: "bookkeeper", expectedDefinitionHash: "a".repeat(64), expectedAccessRevision: 2, connections: [wanted] };
    mocks.pinned.mockResolvedValueOnce(null);
    const refused = await saveOutsideConnections(input);
    expect(refused.ok).toBe(false);
    expect(mocks.keeper).not.toHaveBeenCalled();
    mocks.pinned.mockResolvedValueOnce([{ name: "find_rate", description: "Looks up a rate", inputSchema: { type: "object" } }]);
    await saveOutsideConnections(input);
    const sent = mocks.keeper.mock.calls[0]![1].connections[0].tools.trusted[0];
    expect(sent.pin).toBe(toolPinHash({ name: "find_rate", description: "Looks up a rate", inputSchema: { type: "object" } }));
    expect(sent.pin).not.toBe("0".repeat(64));
  });

  it("uses the current session and bounded timeout for Apply, and rejects malformed selectors", async () => {
    expect(await applyOutsideConnections({ name: "bookkeeper", expectedDefinitionHash: "a".repeat(64), expectedAccessRevision: 2 }))
      .toEqual({ ok: true, result: saved });
    expect(mocks.keeper).toHaveBeenCalledWith("outside.connections.apply",
      { name: "bookkeeper", expectedDefinitionHash: "a".repeat(64), expectedAccessRevision: 2, sessionToken: token },
      "member@example.test", { timeoutMs: 90_000 });
    await expect(applyOutsideConnections({ name: "bookkeeper", expectedDefinitionHash: "bad", expectedAccessRevision: 2 }))
      .rejects.toThrow("Connection details are invalid.");
  });

  it("reports a confirmed apply after an interrupted response, and unavailable when refresh fails", async () => {
    const applied = { ...saved, applicationStatus: "applied" as const, appliedConnections: [connection] };
    mocks.keeper.mockRejectedValueOnce(new Error("socket response lost")).mockResolvedValueOnce(applied);
    await expect(applyOutsideConnections({ name: "bookkeeper", expectedDefinitionHash: "a".repeat(64), expectedAccessRevision: 2 }))
      .resolves.toEqual({ ok: false, message: "The refreshed state confirms these declarations are applied, although the Apply request did not return normally.", current: applied });
    mocks.keeper.mockRejectedValueOnce(new Error("socket response lost")).mockRejectedValueOnce(new Error("refresh unavailable"));
    await expect(applyOutsideConnections({ name: "bookkeeper", expectedDefinitionHash: "a".repeat(64), expectedAccessRevision: 2 }))
      .resolves.toEqual({ ok: false, message: "Apply did not return normally and its application state could not be confirmed. Refresh before trying again." });
  });
  it("shows Keeper's own sentence when it refused an Apply, never \"applied\" from the refreshed declarations", async () => {
    // A busy spending-key store: Keeper recorded the declarations as applied but left the agent stopped and waiting.
    const applied = { ...saved, applicationStatus: "applied" as const, appliedConnections: [connection] };
    const { KeeperRefusedError } = await import("../lib/keeper-client");
    const sentence = "The spending-key store was busy, so the agent was not started. Your changes are kept; reload the page, then press Apply connection changes to start it.";
    mocks.keeper.mockRejectedValueOnce(new KeeperRefusedError(sentence)).mockResolvedValueOnce(applied);
    await expect(applyOutsideConnections({ name: "bookkeeper", expectedDefinitionHash: "a".repeat(64), expectedAccessRevision: 2 }))
      .resolves.toEqual({ ok: false, message: sentence, current: applied });
  });
  it("shows the keeper's own reason when a save is refused, not a generic line", async () => {
    const { KeeperRefusedError } = await import("../lib/keeper-client");
    const reason = 'outside tool "registry" needs a token but no credential is held for it';
    mocks.keeper.mockRejectedValueOnce(new KeeperRefusedError(`[outside-tools] ${reason}`, [{ check: "outside-tools", message: reason }]));
    await expect(saveOutsideConnections({ name: "bookkeeper", expectedDefinitionHash: "a".repeat(64), expectedAccessRevision: 2, connections: [connection] }))
      .resolves.toEqual({ ok: false, message: reason });
    mocks.keeper.mockRejectedValueOnce(new KeeperRefusedError("Current agent edit access is required to manage connections."));
    await expect(getOutsideConnections("bookkeeper")).resolves.toEqual({ ok: false, message: "Current agent edit access is required to manage connections." });
  });
  it("keeps the fallback text for a failure that carries no reason from the keeper", async () => {
    mocks.keeper.mockRejectedValueOnce(new Error("socket response lost"));
    await expect(saveOutsideConnections({ name: "bookkeeper", expectedDefinitionHash: "a".repeat(64), expectedAccessRevision: 2, connections: [connection] }))
      .resolves.toEqual({ ok: false, message: "The connection change could not be confirmed. Refresh before trying again." });
  });
});
