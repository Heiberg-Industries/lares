// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), add: vi.fn(), setTools: vi.fn(), declare: vi.fn(), lookUp: vi.fn(), review: vi.fn(), removeDecl: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));
vi.mock("../app/actions/outside-connectors", () => ({ addConnector: mocks.add, checkConnector: vi.fn(), renameConnector: vi.fn(), removeConnector: vi.fn(), removeFromAgent: vi.fn() }));
vi.mock("../app/actions/outside-connect", () => ({ connectSetTools: mocks.setTools, connectDeclare: mocks.declare, connectLookUpTools: mocks.lookUp, connectReviewAndStage: mocks.review, connectRemoveDeclaration: mocks.removeDecl,
  connectActivateCredential: vi.fn(), connectApplyAgent: vi.fn(), connectSwitchOnTrust: vi.fn() }));
import { AddConnectorForm } from "../components/AddConnectorForm";
import { ConnectorAccess } from "../components/ConnectorAccess";
import { ConnectorActions } from "../components/ConnectorActions";

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const agents = [{ name: "ada", displayName: "Ada" }, { name: "ben", displayName: "Ben" }];
const conn = { slug: "rates", url: "https://tools.example.org/mcp", description: "", authKind: "token" as const };
const uses = [{ agent: "ada", displayName: "Ada", needsKey: true, tools: [{ name: "find_rate", kind: "read" as const, free: true }, { name: "set_rate", kind: "change" as const, free: false }] }];

describe("Add", () => {
  it("asks for name, address and authentication, saves, then opens the connector page with what it found", async () => {
    mocks.add.mockResolvedValue({ ok: true, id: "abc", authKind: "token", sentence: "Found the server. It asks for a token." });
    render(<AddConnectorForm />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Rates" } });
    fireEvent.change(screen.getByLabelText(/^Server URL/), { target: { value: "https://tools.example.org/mcp" } });
    expect(screen.getByLabelText(/^Authentication/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/integrations/outside/abc?found=token"));
    expect(mocks.add).toHaveBeenCalledWith({ name: "Rates", url: "https://tools.example.org/mcp", auth: "automatic" });
  });
  it("shows one message and Try again that continues with the saved connector", async () => {
    mocks.add.mockResolvedValueOnce({ ok: false, message: "That server answered with status 500.", id: "abc" }).mockResolvedValueOnce({ ok: true, id: "abc", authKind: "none", sentence: "x" });
    render(<AddConnectorForm />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Rates" } });
    fireEvent.change(screen.getByLabelText(/^Server URL/), { target: { value: "https://tools.example.org/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("That server answered with status 500.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalled());
    expect(mocks.add).toHaveBeenLastCalledWith(expect.objectContaining({ existingId: "abc" }));
  });
  it("refuses an address that is not https before asking anyone", () => {
    render(<AddConnectorForm />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Rates" } });
    fireEvent.change(screen.getByLabelText(/^Server URL/), { target: { value: "http://tools.example.org/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toContain("https://");
    expect(mocks.add).not.toHaveBeenCalled();
  });
});

describe("the connector page", () => {
  it("lists each agent's tools with kind and run-without-asking, and saves them in one press", async () => {
    mocks.setTools.mockResolvedValue({ ok: true, value: { conflicts: [], droppedTrust: [] } });
    render(<ConnectorAccess conn={conn} uses={uses} allAgents={agents} canWiden keyLines={{ ada: "Needs a key: yes. Key kept in Lares." }} />);
    expect(screen.getByText("Looks things up")).toBeTruthy();
    expect(screen.getByText("Changes something")).toBeTruthy();
    expect(screen.getByLabelText("Run find_rate without asking").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Needs a key: yes. Key kept in Lares.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save tools" }));
    await vi.waitFor(() => expect(mocks.setTools).toHaveBeenCalled());
    expect(mocks.setTools.mock.calls[0]![0]).toMatchObject({ agent: "ada", name: "rates", tools: [
      { name: "find_rate", allowed: true, kind: "read", free: true }, { name: "set_rate", allowed: true, kind: "change", free: false }] });
    await screen.findByText("Saved.");
  });
  it("offers Leave it out and Let Ada ask first when a tool that changes something meets read-only access, and asks again before widening", async () => {
    mocks.setTools.mockResolvedValueOnce({ ok: true, value: { conflicts: ["set_rate"], droppedTrust: [] } }).mockResolvedValueOnce({ ok: true, value: { conflicts: [], droppedTrust: [] } });
    render(<ConnectorAccess conn={conn} uses={uses} allAgents={agents} canWiden keyLines={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Save tools" }));
    await screen.findByRole("button", { name: "Leave it out" });
    fireEvent.click(screen.getByRole("button", { name: "Let Ada ask first" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, let it ask first" }));
    await vi.waitFor(() => expect(mocks.setTools).toHaveBeenCalledTimes(2));
    expect(mocks.setTools.mock.calls[1]![0]).toMatchObject({ widen: true });
  });
  it("hides the widen choice from anyone who is not the owner", async () => {
    mocks.setTools.mockResolvedValue({ ok: true, value: { conflicts: ["set_rate"], droppedTrust: [] } });
    render(<ConnectorAccess conn={conn} uses={uses} allAgents={agents} canWiden={false} keyLines={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Save tools" }));
    await screen.findByRole("button", { name: "Leave it out" });
    expect(screen.queryByRole("button", { name: "Let Ada ask first" })).toBeNull();
  });
  it("offers a token field once, with the agents that do not have the connector yet, and Replace token for those that do", () => {
    render(<ConnectorAccess conn={conn} uses={uses} allAgents={agents} canWiden keyLines={{}} />);
    expect(screen.getByRole("button", { name: "Replace token" })).toBeTruthy();
    expect(screen.getByLabelText(/^Token/)).toBeTruthy();
    expect(screen.getByLabelText("Ben")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find tools" })).toBeTruthy();
  });
  it("says that sign-in comes later and builds no form for a sign-in server", () => {
    render(<ConnectorAccess conn={{ ...conn, authKind: "signin" }} uses={[]} allAgents={agents} canWiden keyLines={{}} />);
    expect(screen.getByText(/Sign-in comes in a later release/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Token/)).toBeNull();
  });
});

const tools = [{ name: "find_rate", description: "Finds a rate.", inputSchema: { type: "object" }, readOnly: true as const }];
const looked = { ok: true, value: { identity: { accountId: "a" }, serverName: "Rates 1", tools } };

describe("tools that no agent may use now", () => {
  it("stay listed, off, so they can be switched on again", () => {
    render(<ConnectorAccess conn={conn} uses={uses} allAgents={agents} canWiden keyLines={{}} known={["find_rate", "set_rate", "gone_rate"]} />);
    const sw = screen.getByLabelText("Ada may use gone_rate");
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });
});

describe("the token flows", () => {
  it("Cancel on the tool list takes back the temporary declaration on the first agent", async () => {
    mocks.declare.mockResolvedValue({ ok: true, value: {} }); mocks.lookUp.mockResolvedValue(looked); mocks.removeDecl.mockResolvedValue({ ok: true, value: { removed: true } });
    render(<ConnectorAccess conn={conn} uses={[]} allAgents={[agents[0]!]} canWiden keyLines={{}} />);
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: "tok" } });
    fireEvent.click(screen.getByLabelText(/I allow Lares to send this token/));
    fireEvent.click(screen.getByRole("button", { name: "Find tools" }));
    await screen.findByText(/offers 1 tool/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(mocks.removeDecl).toHaveBeenCalledWith({ agent: "ada", name: "rates" }));
    await screen.findByRole("button", { name: "Find tools" });
  });
  it("keeps the form and says why when the temporary declaration cannot be taken back", async () => {
    mocks.declare.mockResolvedValue({ ok: true, value: {} }); mocks.lookUp.mockResolvedValue(looked); mocks.removeDecl.mockResolvedValue({ ok: false, message: "The agent is busy." });
    render(<ConnectorAccess conn={conn} uses={[]} allAgents={[agents[0]!]} canWiden keyLines={{}} />);
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: "tok" } });
    fireEvent.click(screen.getByLabelText(/I allow Lares to send this token/));
    fireEvent.click(screen.getByRole("button", { name: "Find tools" }));
    await screen.findByText(/offers 1 tool/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText(/could not be removed: The agent is busy/);
  });
  it("takes the temporary declaration back when the tool list cannot be read, before returning to the form", async () => {
    mocks.declare.mockResolvedValue({ ok: true, value: {} }); mocks.lookUp.mockResolvedValue({ ok: false, message: "The token was refused.", retryable: true }); mocks.removeDecl.mockResolvedValue({ ok: true, value: { removed: true } });
    render(<ConnectorAccess conn={conn} uses={[]} allAgents={[agents[0]!]} canWiden keyLines={{}} />);
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: "tok" } });
    fireEvent.click(screen.getByLabelText(/I allow Lares to send this token/));
    fireEvent.click(screen.getByRole("button", { name: "Find tools" }));
    await screen.findByText("The token was refused.");
    expect(mocks.removeDecl).toHaveBeenCalledWith({ agent: "ada", name: "rates" });
  });
  it("Start over after a failed step returns to the form instead of a blank section", async () => {
    mocks.declare.mockResolvedValueOnce({ ok: true, value: {} }).mockResolvedValueOnce({ ok: false, message: "The agent could not be updated.", retryable: true });
    mocks.lookUp.mockResolvedValue(looked);
    render(<ConnectorAccess conn={conn} uses={[]} allAgents={[agents[0]!]} canWiden keyLines={{}} />);
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: "tok" } });
    fireEvent.click(screen.getByLabelText(/I allow Lares to send this token/));
    fireEvent.click(screen.getByRole("button", { name: "Find tools" }));
    await screen.findByText(/offers 1 tool/);
    fireEvent.click(screen.getByRole("button", { name: "Give access" }));
    await screen.findByText("The agent could not be updated.");
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    await screen.findByRole("button", { name: "Find tools" });
    expect(mocks.refresh).toHaveBeenCalled();
  });
  it("Replace token shows the descriptions first, and records them only against what the owner read", async () => {
    mocks.lookUp.mockResolvedValue(looked); mocks.review.mockResolvedValue({ ok: false, message: "The server now describes find_rate differently.", retryable: false });
    render(<ConnectorAccess conn={conn} uses={uses} allAgents={agents} canWiden keyLines={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));
    fireEvent.change(screen.getByLabelText(/^New token/), { target: { value: "tok2" } });
    fireEvent.click(screen.getByRole("button", { name: "Read the tools" }));
    await screen.findByText("Finds a rate.");
    expect(mocks.review).not.toHaveBeenCalled(); // nothing is accepted before the owner has read the text
    fireEvent.click(screen.getByRole("button", { name: "Accept these descriptions and replace the token" }));
    await screen.findByText(/differently/);
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ seen: tools }));
  });
});

describe("rename, check and remove", () => {
  it("warns once that running agents restart before it removes anything", () => {
    render(<ConnectorActions id="abc" displayName="Rates" />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText(/Running agents restart/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove connector" })).toBeTruthy();
  });
});
