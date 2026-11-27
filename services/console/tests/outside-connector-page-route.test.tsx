import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const m = vi.hoisted(() => ({ uses: vi.fn(), list: vi.fn() }));
vi.mock("../lib/auth", () => ({ requirePage: async () => ({ id: "m" }), mayUse: (member: unknown, _level: string) => !!member }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); }, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("../app/actions/outside-connectors", () => ({ listConnectors: m.list, addConnector: vi.fn(), checkConnector: vi.fn(), renameConnector: vi.fn(), removeConnector: vi.fn(), removeFromAgent: vi.fn() }));
vi.mock("../app/actions/outside-connect", () => ({}));
vi.mock("../lib/agents", () => ({ listAgents: async () => [{ name: "ada", displayName: "Ada" }] }));
vi.mock("../lib/outside-tools", () => ({ getOutsideToolEvidence: async () => ({ keys: { available: false }, locks: { available: false } }) }));
vi.mock("../lib/outside-connector-view", () => ({ agentUsesByConnector: m.uses, knownToolNames: async () => ({}) }));
import ConnectorPage from "../app/outside-tools/[id]/page";

const id = "00000000-0000-4000-8000-000000000001";
const row = { id, slug: "rates", displayName: "Rates", url: "https://tools.example.org/mcp", authKind: "token", description: "", state: "setup", createdBy: "owner", createdAt: "", probedAt: null, toolCount: null, catalogueAt: null };

describe("the connector page", () => {
  it("does not treat an unread usage list as empty: it says so and offers no way to change access", async () => {
    m.list.mockResolvedValue({ ok: true, value: [row] }); m.uses.mockResolvedValue(null);
    const html = renderToStaticMarkup(await ConnectorPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
    expect(html).toContain("Could not read which agents use this connector");
    expect(html).not.toContain("Give an agent access");
    expect(html).not.toContain("Find tools");
  });
  it("shows the access editor when the usage list was read", async () => {
    m.list.mockResolvedValue({ ok: true, value: [row] }); m.uses.mockResolvedValue({});
    const html = renderToStaticMarkup(await ConnectorPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
    expect(html).toContain("Give an agent access");
  });
});
