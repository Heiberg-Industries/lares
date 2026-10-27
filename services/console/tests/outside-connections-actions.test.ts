import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cookies: vi.fn(), sessionMember: vi.fn(), memberAuditAddress: vi.fn(), keeper: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("../lib/auth", () => ({ sessionMember: mocks.sessionMember, memberAuditAddress: mocks.memberAuditAddress }));
vi.mock("../lib/keeper-client", () => ({
  keeper: mocks.keeper,
  KeeperRefusedError: class KeeperRefusedError extends Error {},
}));
import { applyOutsideConnections, getOutsideConnections, saveOutsideConnections } from "../app/actions/outside-connections";

const token = "A".repeat(43);
const connection = { name: "rates", url: "https://tools.example.org/mcp", description: "Look up rates", token: false,
  tools: { allow: ["find_rate"], read: ["find_rate"] }, trusted: false };
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
    expect(mocks.keeper).toHaveBeenCalledWith("outside.connections.save", expect.objectContaining({ sessionToken: token, connections: [connection] }), "member@example.test");
    await expect(saveOutsideConnections({ name: "bookkeeper", expectedDefinitionHash: "a".repeat(64), expectedAccessRevision: 2,
      connections: [{ ...connection, credential: "forbidden" }] })).rejects.toThrow("Connection details are invalid.");
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
});
