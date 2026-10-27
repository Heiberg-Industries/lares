// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../app/actions/outside-connections", () => ({ saveOutsideConnections: mocks.save }));
import { OutsideConnectionsEditor } from "../components/OutsideConnectionsEditor";

const initial = { name: "bookkeeper", definitionHash: "a".repeat(64), accessRevision: 2, connections: [] };
beforeEach(() => { vi.clearAllMocks(); mocks.save.mockImplementation(async input => ({ ok: true, result: { ...initial, ...input, definitionHash: "b".repeat(64), accessRevision: 3 } })); });
afterEach(cleanup);

describe("OutsideConnectionsEditor", () => {
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
