// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ declare: vi.fn(), lookUp: vi.fn(), review: vi.fn(), activate: vi.fn(), apply: vi.fn(), remove: vi.fn() }));
vi.mock("../app/actions/outside-connect", () => ({ connectDeclare: mocks.declare, connectLookUpTools: mocks.lookUp, connectReviewAndStage: mocks.review,
  connectActivateCredential: mocks.activate, connectApplyAgent: mocks.apply, connectRemoveDeclaration: mocks.remove, connectListAgents: vi.fn() }));
import { ConnectOutsideTool } from "../components/ConnectOutsideTool";

const agents = [{ name: "saga", displayName: "Saga" }, { name: "worker", displayName: "Worker" }];
const tools = [{ name: "find_company", description: "Looks up a company", inputSchema: { type: "object" }, readOnly: true as const }, { name: "push_lead", description: "Sends a lead to a CRM", inputSchema: { type: "object" } }];
const identity = { accountId: "a", agentName: "saga", connectionName: "example", requestId: "r", claimOperationId: "c" };
const ok = <T,>(value: T) => ({ ok: true as const, value });
const address = () => screen.getByLabelText(/^Server address/) as HTMLInputElement;
const tokenField = () => document.querySelector('input[type="password"]') as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.declare.mockResolvedValue(ok({ definitionHash: "a".repeat(64), accessRevision: 2, applied: true }));
  mocks.lookUp.mockResolvedValue(ok({ identity, serverName: "Example 1.0", tools }));
  mocks.review.mockResolvedValue(ok({ candidateRevision: 1 }));
  mocks.activate.mockResolvedValue(ok({ credentialRevision: 1 }));
  mocks.apply.mockResolvedValue(ok({ applied: true }));
  mocks.remove.mockResolvedValue(ok({ removed: true }));
});
afterEach(cleanup);

async function fillToken() {
  fireEvent.change(address(), { target: { value: "https://mcp.example.org/api" } });
  fireEvent.change(tokenField(), { target: { value: "tok-SECRET" } });
  fireEvent.click(screen.getByLabelText(/I allow Lares to send this token/));
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText(/Example 1.0 offers 2 tools/);
}

describe("ConnectOutsideTool", () => {
  it("ticks the agent the owner came from", () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="worker" />);
    expect((screen.getByLabelText("Worker") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Saga") as HTMLInputElement).checked).toBe(false);
  });

  it("connects a token server in two presses with safe defaults and one confirmation", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="saga" />);
    await fillToken();
    // Press one: a placeholder declaration and one look at the server's tools. Nothing is accepted or activated yet.
    expect(mocks.declare.mock.calls[0]![0]).toMatchObject({ agent: "saga", provisional: true, connection: { name: "example", token: true, trusted: false } });
    expect(mocks.lookUp).toHaveBeenCalledWith({ agent: "saga", name: "example", credential: "tok-SECRET" });
    expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.activate).not.toHaveBeenCalled();
    // The confirmation shows each tool, defaulting to "changes something", used, and nothing trusted.
    const kinds = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(kinds.map(k => k.value)).toEqual(["read", "change"]);
    expect((screen.getByLabelText(/Let look-ups run without asking/) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText("push_lead"));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Connected\./);
    expect(mocks.declare.mock.calls[1]![0]).toMatchObject({ agent: "saga", provisional: false, applyNow: false,
      connection: { name: "example", token: true, trusted: false, allow: ["find_company"], read: ["find_company"] } });
    expect(mocks.lookUp).toHaveBeenCalledTimes(2);
    expect(mocks.review).toHaveBeenCalledWith({ identity, seen: tools });
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledWith({ agent: "saga" });
    expect(screen.getByText(/Every call still asks you first/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("tok-SECRET");
  });

  it("says which step failed and why, and a retry continues from that step", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="saga" />);
    await fillToken();
    mocks.activate.mockResolvedValueOnce({ ok: false, message: "The keeper refused to activate the credential.", retryable: true });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Not connected yet\. The keeper refused to activate the credential\./);
    expect(screen.getByText(/Lock the token away for saga/).closest("li")?.getAttribute("data-status")).toBe("failed");
    expect(mocks.review).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/Connected\./);
    expect(mocks.activate).toHaveBeenCalledTimes(2);
    expect(mocks.review).toHaveBeenCalledTimes(1);
    expect(mocks.lookUp).toHaveBeenCalledTimes(2);
  });

  it("offers no retry when sending again would be wrong, and can take the half-set-up connection back", async () => {
    mocks.lookUp.mockResolvedValueOnce({ ok: false, message: "The saved request shows no result.", retryable: false });
    render(<ConnectOutsideTool agents={agents} initialAgent="saga" />);
    fireEvent.change(address(), { target: { value: "https://mcp.example.org/api" } });
    fireEvent.change(tokenField(), { target: { value: "tok-SECRET" } });
    fireEvent.click(screen.getByLabelText(/I allow Lares to send this token/));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Not connected yet\. The saved request shows no result\./);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove the half-set-up connection" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith({ agent: "saga", name: "example" }));
    await screen.findByText(/the half-set-up connection is removed/);
  });

  it("cancelling the confirmation takes back the temporary declaration and forgets the token", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="saga" />);
    await fillToken();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith({ agent: "saga", name: "example" }));
    await waitFor(() => expect(tokenField().value).toBe(""));
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("asks for tool names when the server needs no token, and saves and applies in one step", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="saga" />);
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
    expect(mocks.declare.mock.calls[0]![0]).toMatchObject({ agent: "saga", provisional: false, connection: { token: false, allow: ["find_rate", "list_rates"], read: [] } });
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("requires the owner's consent before a token is sent", async () => {
    render(<ConnectOutsideTool agents={agents} initialAgent="saga" />);
    fireEvent.change(address(), { target: { value: "https://mcp.example.org/api" } });
    fireEvent.change(tokenField(), { target: { value: "tok-SECRET" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Tick the box to allow sending the token/);
    expect(mocks.declare).not.toHaveBeenCalled();
  });
});
