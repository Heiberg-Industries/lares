import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ cookies: vi.fn(), sessionMember: vi.fn(), memberAuditAddress: vi.fn(), keeper: vi.fn(), requireConsoleMember: vi.fn(),
  targets: vi.fn(), removeCredential: vi.fn(), removeDeclaration: vi.fn(), uses: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("../lib/auth", () => ({ sessionMember: mocks.sessionMember, memberAuditAddress: mocks.memberAuditAddress, requireConsoleMember: mocks.requireConsoleMember }));
vi.mock("../lib/keeper-client", () => ({
  keeper: mocks.keeper,
  KeeperRefusedError: class KeeperRefusedError extends Error { constructor(message: string, readonly findings?: { check: string; message: string }[]) { super(message); this.name = "KeeperRefusedError"; } },
}));
vi.mock("../app/actions/outside-discovery", () => ({ listOutsideDiscoveryTargets: mocks.targets, removeOutsideCredential: mocks.removeCredential }));
vi.mock("../lib/outside-connector-view", () => ({ agentUsesByConnector: mocks.uses }));
vi.mock("../app/actions/outside-connect", () => ({ connectRemoveDeclaration: mocks.removeDeclaration }));
import { addConnector, checkConnector, listConnectors, removeConnector, removeFromAgent, renameConnector } from "../app/actions/outside-connectors";
import { KeeperRefusedError } from "../lib/keeper-client";

const order: string[] = [];
const id = "00000000-0000-4000-8000-000000000001";
const row = (over: Record<string, unknown> = {}) => ({ id, slug: "rates", displayName: "Rates", url: "https://tools.example.org/mcp", authKind: "none", description: "", state: "setup",
  createdBy: "owner", createdAt: "2026-11-25T00:00:00.000Z", probedAt: null, toolCount: null, catalogueAt: null, ...over });
const calls = () => mocks.keeper.mock.calls.map(c => c[0] as string);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.uses.mockResolvedValue({ rates: [{ agent: "ada" }] });
  mocks.cookies.mockResolvedValue({ get: () => ({ value: "A".repeat(43) }) });
  mocks.sessionMember.mockResolvedValue({ id: "m" }); mocks.memberAuditAddress.mockResolvedValue("owner@example.test"); mocks.requireConsoleMember.mockResolvedValue({ id: "m" });
});

describe("the connector directory actions", () => {
  it("lists the directory through the keeper", async () => {
    mocks.keeper.mockResolvedValueOnce({ connectors: [row()] });
    expect(await listConnectors()).toMatchObject({ ok: true, value: [{ slug: "rates" }] });
  });
  it("adds a connector in one press: a free name from the address, saved, then checked, with one sentence on what it found", async () => {
    mocks.keeper.mockResolvedValueOnce({ connectors: [row({ slug: "example" })] }).mockResolvedValueOnce({ connector: row({ slug: "example-2" }) }).mockResolvedValueOnce({ authKind: "token" });
    const r = await addConnector({ name: "Rates", url: "https://mcp.example.org/mcp", auth: "automatic" });
    expect(r).toEqual({ ok: true, id, authKind: "token", sentence: "Found the server. It asks for a token." });
    expect(calls()).toEqual(["outside.connector-list", "outside.connector-create", "outside.connector-probe"]);
    expect(mocks.keeper.mock.calls[1]![1]).toMatchObject({ slug: "example-2", displayName: "Rates" });
  });
  it("keeps the saved connector when the check fails, and Try again checks it without creating it twice", async () => {
    mocks.keeper.mockResolvedValueOnce({ connectors: [] }).mockResolvedValueOnce({ connector: row() }).mockRejectedValueOnce(new KeeperRefusedError("That server answered with status 500."));
    const first = await addConnector({ name: "Rates", url: "https://tools.example.org/mcp", auth: "token" });
    expect(first).toEqual({ ok: false, message: "That server answered with status 500.", id });
    mocks.keeper.mockClear(); mocks.keeper.mockResolvedValueOnce({ authKind: "none" });
    expect(await addConnector({ name: "Rates", url: "https://tools.example.org/mcp", auth: "token", existingId: id })).toMatchObject({ ok: true, id, authKind: "none" });
    expect(calls()).toEqual(["outside.connector-probe"]);
  });
  it("says plainly that a sign-in server cannot be used yet", async () => {
    mocks.keeper.mockResolvedValueOnce({ authKind: "signin" });
    const r = await checkConnector(id);
    expect(r).toMatchObject({ ok: true, value: { authKind: "signin" } });
    expect((r as { value: { sentence: string } }).value.sentence).toContain("sign-in comes in a later release");
  });
  it("renames the label only", async () => {
    mocks.keeper.mockResolvedValueOnce({ connector: row({ displayName: "New" }) });
    expect(await renameConnector({ id, displayName: " New " })).toEqual({ ok: true, value: null });
    expect(mocks.keeper.mock.calls[0]![1]).toEqual({ sessionToken: "A".repeat(43), id, displayName: "New" });
  });
  it("removes a connector: off each agent, its held token erased, then the row retired", async () => {
    mocks.keeper.mockResolvedValueOnce({ connectors: [row()] }).mockResolvedValueOnce({ connector: row({ state: "retired" }) });
    mocks.targets.mockResolvedValue([
      { agentName: "ada", connectionName: "rates", credentialStatus: { accountId: id, generation: 3, state: "active" } },
      { agentName: "ben", connectionName: "other", credentialStatus: { accountId: id, generation: 1, state: "active" } }]);
    mocks.removeDeclaration.mockImplementation(async () => { order.push("declaration"); return { ok: true, value: { removed: true } }; });
    mocks.removeCredential.mockImplementation(async () => { order.push("credential"); return { removed: true, generation: 4 }; });
    order.length = 0;
    expect(await removeConnector(id)).toEqual({ ok: true, value: { agents: ["ada"] } });
    expect(order).toEqual(["credential", "declaration"]); // the keeper erases a held token only while the agent still declares it
    expect(mocks.removeDeclaration).toHaveBeenCalledTimes(1);
    expect(mocks.removeCredential).toHaveBeenCalledWith({ accountId: id, agentName: "ada", connectionName: "rates", expectedGeneration: 3 });
    expect(calls()).toEqual(["outside.connector-list", "outside.connector-retire"]);
  });
  it("stops with the agent's own reason, and does not retire the row, when an agent cannot be taken off", async () => {
    mocks.keeper.mockResolvedValueOnce({ connectors: [row()] });
    mocks.targets.mockResolvedValue([{ agentName: "ada", connectionName: "rates", credentialStatus: { accountId: null, generation: null, state: "unavailable" } }]);
    mocks.removeDeclaration.mockResolvedValue({ ok: false, message: "The agent could not be updated." });
    expect(await removeConnector(id)).toEqual({ ok: false, message: "ada: The agent could not be updated." });
    expect(calls()).toEqual(["outside.connector-list"]);
  });
  it("removes a no-login connector from every agent that declares it, though the credential list does not know it", async () => {
    mocks.keeper.mockResolvedValueOnce({ connectors: [row()] }).mockResolvedValueOnce({ connector: row({ state: "retired" }) });
    mocks.uses.mockResolvedValue({ rates: [{ agent: "ada" }, { agent: "ben" }] });
    mocks.targets.mockResolvedValue([]);
    mocks.removeDeclaration.mockResolvedValue({ ok: true, value: { removed: true } });
    expect(await removeConnector(id)).toEqual({ ok: true, value: { agents: ["ada", "ben"] } });
    expect(mocks.removeDeclaration).toHaveBeenCalledTimes(2);
    expect(mocks.removeCredential).not.toHaveBeenCalled();
  });
  it("does not retire the row when it cannot read which agents use the connector", async () => {
    mocks.keeper.mockResolvedValueOnce({ connectors: [row()] }); mocks.uses.mockResolvedValue(null);
    expect(await removeConnector(id)).toMatchObject({ ok: false });
    expect(calls()).toEqual(["outside.connector-list"]);
  });
  it("passes the owner's Token choice to the check, so the unauthenticated answer cannot overrule it", async () => {
    mocks.keeper.mockResolvedValueOnce({ connectors: [] }).mockResolvedValueOnce({ connector: row() }).mockResolvedValueOnce({ authKind: "token" });
    await addConnector({ name: "Rates", url: "https://tools.example.org/mcp", auth: "token" });
    expect(mocks.keeper.mock.calls[2]![1]).toMatchObject({ expectToken: true });
    mocks.keeper.mockClear(); mocks.keeper.mockResolvedValueOnce({ connectors: [] }).mockResolvedValueOnce({ connector: row() }).mockResolvedValueOnce({ authKind: "none" });
    await addConnector({ name: "Rates", url: "https://tools.example.org/mcp", auth: "automatic" });
    expect(mocks.keeper.mock.calls[2]![1]).not.toHaveProperty("expectToken");
  });
  it("a recheck sends no Token override, so a server that stopped needing one is recorded as no login", async () => {
    mocks.keeper.mockResolvedValueOnce({ authKind: "none" });
    expect(await checkConnector(id)).toMatchObject({ ok: true, value: { authKind: "none" } });
    expect(mocks.keeper.mock.calls[0]![1]).not.toHaveProperty("expectToken");
  });
  it("takes a connector off one agent and erases that agent's token only", async () => {
    mocks.targets.mockResolvedValue([{ agentName: "ada", connectionName: "rates", credentialStatus: { accountId: id, generation: 2, state: "active" } }]);
    mocks.removeDeclaration.mockImplementation(async () => { order.push("declaration"); return { ok: true, value: { removed: true } }; });
    mocks.removeCredential.mockImplementation(async () => { order.push("credential"); return { removed: true, generation: 3 }; });
    order.length = 0;
    expect(await removeFromAgent({ agent: "ada", slug: "rates" })).toEqual({ ok: true, value: null });
    expect(order).toEqual(["credential", "declaration"]);
  });
  it("refuses a bad id before asking the keeper", async () => {
    expect(await removeConnector("nope")).toMatchObject({ ok: false });
    expect(mocks.keeper).not.toHaveBeenCalled();
  });
});
