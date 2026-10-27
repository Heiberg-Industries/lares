// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ save: vi.fn(), apply: vi.fn() }));
vi.mock("../app/actions/outside-connections", () => ({ saveOutsideConnections: mocks.save, applyOutsideConnections: mocks.apply }));
import { OutsideConnectionsEditor } from "../components/OutsideConnectionsEditor";

const initial = { name: "bookkeeper", definitionHash: "a".repeat(64), accessRevision: 2, connections: [],
  applicationStatus: "pending" as const, appliedConnections: [] };
beforeEach(() => { vi.clearAllMocks(); mocks.save.mockImplementation(async input => ({ ok: true, result: { ...initial, ...input, definitionHash: "b".repeat(64), accessRevision: 3 } }));
  mocks.apply.mockResolvedValue({ ok: true, result: { ...initial, applicationStatus: "applied", appliedConnections: [] } }); });
afterEach(cleanup);

describe("OutsideConnectionsEditor", () => {
  it("shows pending state, preserves the last applied declarations after a failed attempt, then reflects Apply", async () => {
    const active = { name: "previous", url: "https://tools.example.org/mcp", description: "Last working", token: false,
      tools: { allow: ["read"], read: ["read"] }, trusted: false };
    const pending = { ...initial, connections: [{ ...active, name: "replacement" }], appliedConnections: [active] };
    render(<OutsideConnectionsEditor initial={pending} />);
    expect(screen.getByText(/pending Apply/)).toBeTruthy();
    expect(screen.getByText("previous — Last working")).toBeTruthy();
    mocks.apply.mockResolvedValueOnce({ ok: false, message: "Apply failed safely.", current: pending });
    fireEvent.click(screen.getByRole("button", { name: "Apply saved declarations" }));
    await screen.findByText("Apply failed safely.");
    expect(screen.getByText("previous — Last working")).toBeTruthy();
    mocks.apply.mockResolvedValueOnce({ ok: true, result: { ...pending, applicationStatus: "applied", appliedConnections: pending.connections } });
    fireEvent.click(screen.getByRole("button", { name: "Apply saved declarations" }));
    await screen.findByText("Applied. The saved declarations match the last applied runtime definition.");
    expect(screen.getByText("The last applied runtime definition matches these saved declarations.")).toBeTruthy();
  });

  it("does not retain stale application details or offer Apply when a failure cannot be refreshed", async () => {
    const active = { name: "previous", url: "https://tools.example.org/mcp", description: "Last working", token: false,
      tools: { allow: ["read"], read: ["read"] }, trusted: false };
    const pending = { ...initial, connections: [{ ...active, name: "replacement" }], appliedConnections: [active] };
    mocks.apply.mockResolvedValueOnce({ ok: false, message: "Apply state could not be confirmed." });
    render(<OutsideConnectionsEditor initial={pending} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply saved declarations" }));
    await screen.findByText("Apply state could not be confirmed.");
    expect(screen.getByText("Applied declaration status is unavailable. Refresh before applying changes.")).toBeTruthy();
    expect(screen.queryByText("previous — Last working")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply saved declarations" })).toBeNull();
  });

  it("invalidates application details if the Apply action itself throws", async () => {
    const active = { name: "previous", url: "https://tools.example.org/mcp", description: "Last working", token: false,
      tools: { allow: ["read"], read: ["read"] }, trusted: false };
    const pending = { ...initial, connections: [{ ...active, name: "replacement" }], appliedConnections: [active] };
    mocks.apply.mockRejectedValueOnce(new Error("response lost"));
    render(<OutsideConnectionsEditor initial={pending} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply saved declarations" }));
    await screen.findByText("Apply did not complete. Refresh to confirm which declarations are applied before trying again.");
    expect(screen.getByText("Applied declaration status is unavailable. Refresh before applying changes.")).toBeTruthy();
    expect(screen.queryByText("previous — Last working")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply saved declarations" })).toBeNull();
  });

  it("adds a declaration without offering a credential value input", async () => {
    const { container } = render(<OutsideConnectionsEditor initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "rates" } });
    fireEvent.change(screen.getByLabelText("Server address"), { target: { value: "https://tools.example.org/mcp" } });
    fireEvent.change(screen.getByLabelText("What this server is for"), { target: { value: "Look up rates" } });
    fireEvent.change(screen.getByLabelText(/Tools this agent may use/), { target: { value: "find_rate" } });
    fireEvent.change(screen.getByLabelText(/Read-only tools/), { target: { value: "" } });
    expect(container.querySelector('input[type="password"],input[name="credential"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      name: "bookkeeper", expectedDefinitionHash: initial.definitionHash, expectedAccessRevision: 2,
      connections: [expect.objectContaining({ name: "rates", tools: { allow: ["find_rate"], read: [] } })],
    })));
    await waitFor(() => expect(screen.getByText(/Saved\./)).toBeTruthy());
  });

  it("supports editing and removing a declaration through the same saved lifecycle", async () => {
    const connection = { name: "rates", url: "https://tools.example.org/mcp", description: "Rates", token: false,
      tools: { allow: ["find_rate"], read: ["find_rate"] }, trusted: false };
    render(<OutsideConnectionsEditor initial={{ ...initial, connections: [connection] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("What this server is for"), { target: { value: "Latest rates" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connections" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Remove declaration" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save.mock.calls[1][0].connections).toEqual([]);
  });
});
