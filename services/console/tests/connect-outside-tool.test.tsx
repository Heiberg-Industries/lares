// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ declare: vi.fn(), lookUp: vi.fn(), review: vi.fn(), activate: vi.fn(), apply: vi.fn(), remove: vi.fn(), switchOn: vi.fn() }));
vi.mock("../app/actions/outside-connect", () => ({ connectDeclare: mocks.declare, connectLookUpTools: mocks.lookUp, connectReviewAndStage: mocks.review,
  connectActivateCredential: mocks.activate, connectApplyAgent: mocks.apply, connectRemoveDeclaration: mocks.remove, connectListAgents: vi.fn(), connectSwitchOnTrust: mocks.switchOn }));
import { ConnectOutsideTool } from "../components/ConnectOutsideTool";

const agents = [{ name: "alpha", displayName: "Alpha" }, { name: "worker", displayName: "Worker" }];
const tools = [{ name: "find_company", description: "Looks up a company", inputSchema: { type: "object" }, readOnly: true as const }, { name: "push_lead", description: "Sends a lead to a CRM", inputSchema: { type: "object" } }];
const identity = { accountId: "a", agentName: "alpha", connectionName: "example", requestId: "r", claimOperationId: "c" };
const ok = <T,>(value: T) => ({ ok: true as const, value });
const address = () => screen.getByLabelText(/^Server address/) as HTMLInputElement;
const tokenField = () => document.querySelector('input[type="password"]') as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.declare.mockResolvedValue(ok({ definitionHash: "a".repeat(64), accessRevision: 2, applied: true, currentTrusted: [], previousTools: [], droppedTrust: [], conflicts: [] }));
  mocks.lookUp.mockResolvedValue(ok({ identity, serverName: "Example 1.0", tools }));
  mocks.review.mockResolvedValue(ok({ candidateRevision: 1 }));
  mocks.activate.mockResolvedValue(ok({ credentialRevision: 1 }));
  mocks.apply.mockResolvedValue(ok({ applied: true }));
  mocks.remove.mockResolvedValue(ok({ removed: true }));
  mocks.switchOn.mockResolvedValue(ok({ switchedOn: ["find_company"], switchedOff: [] }));
});
afterEach(cleanup);

async function fillToken() {
  fireEvent.change(address(), { target: { value: "https://mcp.example.org/api" } });
  fireEvent.change(tokenField(), { target: { value: "tok-SECRET" } });
  fireEvent.click(screen.getByLabelText(/I allow Lares to send this token/));
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText(/Example 1.0 offers 2 tools/);
}

describe("ConnectOutsideTool form", () => {
  it("shows only address, token, agents and Connect at first; name and purpose sit under More options", () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    expect(screen.getByLabelText(/^Server address/)).toBeTruthy();
    expect(tokenField()).toBeTruthy();
    const more = document.querySelector("details") as HTMLDetailsElement;
    expect(more.textContent).toContain("More options");
    expect(more.open).toBe(false);
    expect(more.contains(screen.getByLabelText(/^Name/))).toBe(true);
    expect(more.contains(screen.getByLabelText(/^What it is for/))).toBe(true);
    expect(more.contains(address())).toBe(false);
    expect(more.contains(tokenField())).toBe(false);
  });

  it("asks for tool names only while the token field is empty", () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    expect(screen.queryByLabelText(/^Tools the agent may use/)).toBeTruthy();
    fireEvent.change(tokenField(), { target: { value: "tok" } });
    expect(screen.queryByLabelText(/^Tools the agent may use/)).toBeNull();
    fireEvent.change(tokenField(), { target: { value: "" } });
    expect(screen.queryByLabelText(/^Tools the agent may use/)).toBeTruthy();
  });

  it("refuses a key pasted into the tool names field, tells the owner where it belongs, and never shows it back", () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    const pasted = "q7Zx1Lm9Tr4Vb8Nc2Wd5Ye3Hf6Jg0Ks";
    fireEvent.change(address(), { target: { value: "https://mcp.example.org/api" } });
    fireEvent.change(screen.getByLabelText(/^Tools the agent may use/), { target: { value: `find_rate, ${pasted}` } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Token field/);
    expect(document.body.textContent).not.toContain(pasted);
    expect(mocks.declare).not.toHaveBeenCalled();
  });

  it("fills the name from the address, keeps it unique, and lets the owner change it", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" takenNames={["example"]} />);
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    fireEvent.change(address(), { target: { value: "https://mcp.example.org/api" } });
    expect(name.placeholder).toBe("example-2");
    fireEvent.change(tokenField(), { target: { value: "tok-SECRET" } });
    fireEvent.click(screen.getByLabelText(/I allow Lares to send this token/));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Example 1.0 offers 2 tools/);
    expect(mocks.declare.mock.calls[0]![0]).toMatchObject({ connection: { name: "example-2" } });
  });

  it("uses a name typed under More options instead", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "mine" } });
    await fillToken();
    expect(mocks.declare.mock.calls[0]![0]).toMatchObject({ connection: { name: "mine" } });
  });
});

describe("ConnectOutsideTool", () => {
  it("ticks the agent the owner came from", () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="worker" />);
    expect((screen.getByLabelText("Worker") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Alpha") as HTMLInputElement).checked).toBe(false);
  });

  it("connects a token server in two presses with safe defaults and one confirmation", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    await fillToken();
    // Press one: a placeholder declaration and one look at the server's tools. Nothing is accepted or activated yet.
    expect(mocks.declare.mock.calls[0]![0]).toMatchObject({ agent: "alpha", provisional: true, connection: { name: "example", token: true } });
    expect(mocks.lookUp).toHaveBeenCalledWith({ agent: "alpha", name: "example", credential: "tok-SECRET" });
    expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.activate).not.toHaveBeenCalled();
    // The confirmation shows each tool, used. Only a tool the server marks as read-only starts with "Run without asking" ticked.
    const kinds = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(kinds.map(k => k.value)).toEqual(["read", "change"]);
    const switches = screen.getAllByLabelText(/Run without asking/) as HTMLInputElement[];
    expect(switches.map(sw => sw.checked)).toEqual([true, false]);
    expect(switches[1]!.disabled).toBe(true);
    expect(screen.getByText(/the server says this only looks things up/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("push_lead"));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Connected\./);
    expect(mocks.declare.mock.calls[1]![0]).toMatchObject({ agent: "alpha", provisional: false, applyNow: false,
      connection: { name: "example", token: true, allow: ["find_company"], read: ["find_company"] } });
    expect(mocks.lookUp).toHaveBeenCalledTimes(2);
    expect(mocks.review).toHaveBeenCalledWith({ identity, seen: tools });
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledWith({ agent: "alpha" });
    expect(screen.getByText(/Tools you did not switch on to run without asking still ask you first/)).toBeTruthy();
    // The lookups were switched on in this same connect, before the apply, with no separate step for the owner.
    expect(mocks.switchOn).toHaveBeenCalledWith({ agent: "alpha", name: "example", tools: ["find_company"] });
    expect(mocks.switchOn.mock.invocationCallOrder[0]!).toBeLessThan(mocks.apply.mock.invocationCallOrder[0]!);
    expect(screen.queryByRole("button", { name: "Switch on Run without asking" })).toBeNull();
    expect(screen.getByText(/Slack and Telegram private chats: only tools that run without asking \(1 of 1\)/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("tok-SECRET");
  });

  it("shows each offered tool as a row with a kind badge and a switch, and each message in its own tone", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    await fillToken();
    const list = screen.getByRole("list", { name: "Tools to connect" });
    expect([...list.querySelectorAll(".lares-kind-badge")].map(b => b.textContent)).toEqual(["Looks things up", "Changes something"]);
    expect(screen.getAllByRole("switch").map(sw => sw.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Connected\./);
    const tones = [...document.querySelectorAll(".lares-notice")].map(n => n.getAttribute("data-tone"));
    expect(tones.filter(t => t === "success").length).toBeGreaterThan(1);
    expect(tones).not.toContain("error");
  });

  it("switches on only the lookups the owner left ticked, in the same connect", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    await fillToken();
    // The owner unticks the one lookup before connecting: nothing runs without asking.
    fireEvent.click(screen.getAllByLabelText(/Run without asking/)[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Connected\./);
    expect(mocks.switchOn).toHaveBeenCalledWith({ agent: "alpha", name: "example", tools: [] });
  });

  it("still connects when the lookups cannot be switched on, says why, and offers to try again", async () => {
    mocks.switchOn.mockResolvedValueOnce({ ok: false, message: "Only a member who can approve this agent's outside calls may switch a tool on.", retryable: true });
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    await fillToken();
    fireEvent.click(screen.getByLabelText("push_lead"));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Connected\./);
    expect(mocks.apply).toHaveBeenCalledWith({ agent: "alpha" });
    await screen.findByText(/Only a member who can approve/);
    fireEvent.click(screen.getByRole("button", { name: "Switch on Run without asking" }));
    await waitFor(() => expect(mocks.switchOn).toHaveBeenCalledTimes(2));
    await screen.findByText(/alpha: switched on find_company/);
  });

  it("a read-only agent: the rest is saved and the owner chooses per tool, leaving it out", async () => {
    mocks.declare.mockResolvedValueOnce(ok({ definitionHash: "a".repeat(64), accessRevision: 2, applied: true, currentTrusted: [], previousTools: [], droppedTrust: [], conflicts: [] }));
    mocks.declare.mockResolvedValueOnce(ok({ definitionHash: "a".repeat(64), accessRevision: 2, applied: false, currentTrusted: [], previousTools: [], droppedTrust: [], conflicts: ["push_lead"] }));
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    await fillToken();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/outside access is read-only, and push_lead changes something/);
    expect(mocks.lookUp).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Leave it out" }));
    await screen.findByText(/Connected\./);
    expect(mocks.declare).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Left out because the agent's outside access is read-only: push_lead \(alpha\)/)).toBeTruthy();
  });

  it("a read-only agent: \"Let it ask first\" needs a second, explicit confirm and then saves with the widening", async () => {
    mocks.declare.mockResolvedValueOnce(ok({ definitionHash: "a".repeat(64), accessRevision: 2, applied: true, currentTrusted: [], previousTools: [], droppedTrust: [], conflicts: [] }));
    mocks.declare.mockResolvedValueOnce(ok({ definitionHash: "a".repeat(64), accessRevision: 2, applied: false, currentTrusted: [], previousTools: [], droppedTrust: [], conflicts: ["push_lead"] }));
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    await fillToken();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Let Alpha ask first" }));
    expect(mocks.declare).toHaveBeenCalledTimes(2);
    fireEvent.click(await screen.findByRole("button", { name: "Yes, let it ask first" }));
    await screen.findByText(/Connected\./);
    expect(mocks.declare).toHaveBeenCalledTimes(3);
    expect(mocks.declare.mock.calls[2]![0]).toMatchObject({ agent: "alpha", widen: true, connection: { allow: ["find_company", "push_lead"] } });
    expect(screen.getByText(/always after asking you first: push_lead \(alpha\)/)).toBeTruthy();
  });

  it("on a reconnect shows the switches as they already are: kept ones ticked, known ones the owner left off stay off", async () => {
    mocks.declare.mockResolvedValueOnce(ok({ definitionHash: "a".repeat(64), accessRevision: 2, applied: true, currentTrusted: [], previousTools: ["find_company"], droppedTrust: [], conflicts: [] }));
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    await fillToken();
    // find_company is read-only but was already on the agent and left off: it stays off. (A brand-new read-only tool would start on.)
    const switches = screen.getAllByLabelText(/Run without asking/) as HTMLInputElement[];
    expect(switches.map(sw => sw.checked)).toEqual([false, false]);
  });

  it("says out loud which switches the keeper ended", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    await fillToken();
    mocks.declare.mockResolvedValueOnce(ok({ definitionHash: "a".repeat(64), accessRevision: 2, applied: false, currentTrusted: ["find_company"], previousTools: ["find_company"], droppedTrust: ["find_company"], conflicts: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Run without asking was switched off for find_company \(alpha\) because the tool changed/);
  });

  it("says which step failed and why, and a retry continues from that step", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    await fillToken();
    mocks.activate.mockResolvedValueOnce({ ok: false, message: "The keeper refused to activate the credential.", retryable: true });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Not connected yet\. The keeper refused to activate the credential\./);
    expect(screen.getByText(/Lock the token away for alpha/).closest("li")?.getAttribute("data-status")).toBe("failed");
    expect(mocks.review).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/Connected\./);
    expect(mocks.activate).toHaveBeenCalledTimes(2);
    expect(mocks.review).toHaveBeenCalledTimes(1);
    expect(mocks.lookUp).toHaveBeenCalledTimes(2);
  });

  it("offers no retry when sending again would be wrong, and can take the half-set-up connection back", async () => {
    mocks.lookUp.mockResolvedValueOnce({ ok: false, message: "The saved request shows no result.", retryable: false });
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    fireEvent.change(address(), { target: { value: "https://mcp.example.org/api" } });
    fireEvent.change(tokenField(), { target: { value: "tok-SECRET" } });
    fireEvent.click(screen.getByLabelText(/I allow Lares to send this token/));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Not connected yet\. The saved request shows no result\./);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove the half-set-up connection" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith({ agent: "alpha", name: "example" }));
    await screen.findByText(/the half-set-up connection is removed/);
  });

  it("cancelling the confirmation takes back the temporary declaration and forgets the token", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    await fillToken();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith({ agent: "alpha", name: "example" }));
    await waitFor(() => expect(tokenField().value).toBe(""));
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("asks for tool names when the server needs no token, and saves and applies in one step", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    fireEvent.change(address(), { target: { value: "https://tools.example.org/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Type the names of the tools/);
    fireEvent.change(screen.getByLabelText(/^Tools the agent may use/), { target: { value: "find_rate, list_rates" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Tools you chose");
    expect(mocks.lookUp).not.toHaveBeenCalled(); expect(mocks.declare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Connected\./);
    expect(mocks.declare).toHaveBeenCalledTimes(1);
    expect(mocks.declare.mock.calls[0]![0]).toMatchObject({ agent: "alpha", provisional: false, connection: { token: false, allow: ["find_rate", "list_rates"], read: [] } });
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("requires the owner's consent before a token is sent", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="alpha" />);
    fireEvent.change(address(), { target: { value: "https://mcp.example.org/api" } });
    fireEvent.change(tokenField(), { target: { value: "tok-SECRET" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Tick the box to allow sending the token/);
    expect(mocks.declare).not.toHaveBeenCalled();
  });
});
