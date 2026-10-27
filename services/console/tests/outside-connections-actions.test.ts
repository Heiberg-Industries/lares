import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cookies: vi.fn(), sessionMember: vi.fn(), memberAuditAddress: vi.fn(), keeper: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("../lib/auth", () => ({ sessionMember: mocks.sessionMember, memberAuditAddress: mocks.memberAuditAddress }));
vi.mock("../lib/keeper-client", () => ({
  keeper: mocks.keeper,
  KeeperRefusedError: class KeeperRefusedError extends Error {},
}));
import { getOutsideConnections, saveOutsideConnections } from "../app/actions/outside-connections";

const token = "A".repeat(43);
const connection = { name: "rates", url: "https://tools.example.org/mcp", description: "Look up rates", token: false,
  tools: { allow: ["find_rate"], read: ["find_rate"] }, trusted: false };
const saved = { name: "bookkeeper", definitionHash: "a".repeat(64), accessRevision: 2, connections: [connection] };
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
});
