import { describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../lib/db", () => ({ pool: { query } }));
import { listSavedAgentsNotStarted, savedAgentFolder } from "../lib/agents";

describe("an agent saved but not started", () => {
  it("is shown from its saved definition, marked as never started", () => {
    expect(savedAgentFolder("helper", {
      display: "Helper", role: "chief-of-staff", grants: [{ capability: "vault", scope: "read" }],
      autonomy: { vault: "gated" }, skills: [{ name: "lares-docs" }], doors: [{ kind: "telegram", enabled: false }],
    })).toEqual({
      name: "helper", displayName: "Helper", role: "Chief of Staff", grants: [{ capability: "vault", scope: "read" }],
      autonomy: { vault: "gated" }, skills: ["lares-docs"], doors: [{ kind: "telegram", enabled: false }], tools: null, startedAt: "",
    });
  });
  it("survives a definition with missing fields", () => {
    expect(savedAgentFolder("helper", {})).toMatchObject({ displayName: "helper", role: "Agent", grants: [], skills: [], doors: [], startedAt: "" });
  });
  it("lists only valid definitions with no registry row, and an unreadable table lists none", async () => {
    query.mockResolvedValueOnce({ rows: [{ name: "helper", definition: { display: "Helper" } }] });
    expect((await listSavedAgentsNotStarted()).map((a) => a.displayName)).toEqual(["Helper"]);
    expect(String(query.mock.calls[0]![0])).toMatch(/g\.name IS NULL AND d\.status='valid'/);
    query.mockRejectedValueOnce(new Error("unavailable"));
    await expect(listSavedAgentsNotStarted()).resolves.toEqual([]);
  });
});
