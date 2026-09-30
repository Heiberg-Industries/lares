// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DefinitionForm } from "../components/DefinitionForm";
import type { AgentDefinition } from "@lares/agent-kit/definition";
const calls = vi.hoisted(() => ({ create: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: calls.push, refresh: vi.fn() }),
}));
vi.mock("../app/actions/definition", () => ({
  createAgent: calls.create,
  saveDefinition: vi.fn(),
  retireAgent: vi.fn(),
  deleteAgent: vi.fn(),
  applyConnections: vi.fn(),
}));
vi.mock("../components/AvatarEditor", () => ({ AvatarEditor: () => null }));
vi.mock("../components/DoorSetup", () => ({ DoorSetup: () => null }));
vi.mock("../components/ConversationControl", () => ({
  ConversationControl: () => null,
}));
const props = {
  startingPoints: [
    {
      id: "creative" as const,
      label: "Thinking partner",
      description: "A little room to think.",
      capabilities: [],
      schedules: [],
      definition: {
        name: "template",
        role: "creative",
        model: "test-brain",
        grants: [],
        autonomy: {},
        skills: [],
        schedules: {},
        channels: [],
        duties: "duties.md",
      } as unknown as AgentDefinition,
    },
  ],
  aliases: [{ alias: "test-brain", label: "Brain", when: "Everyday work" }],
  timing: {},
  capacity: {
    ceiling: 5,
    activeCount: 0,
    approved: true,
    creationAvailable: true,
  },
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("requires the review step before creating and preserves an unknown outcome", async () => {
  calls.create.mockResolvedValue({
    ok: false,
    error: { message: "Connection closed", outcomeMayBeUnknown: true },
  });
  render(<DefinitionForm {...props} />);
  expect(screen.getByText("Choose a purpose")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Continue →" }));
  await userEvent.type(
    screen.getByLabelText("Name (permanent slug)"),
    "helper",
  );
  await userEvent.click(screen.getByRole("button", { name: "Continue →" }));
  expect(screen.getByText("Review your agent")).toBeTruthy();
  expect(calls.create).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
  await waitFor(() => expect(calls.create).toHaveBeenCalledTimes(1));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "some changes may already have taken effect",
  );
  expect(
    screen.getByRole("button", { name: "Create agent" }).matches(":disabled"),
  ).toBe(true);
});
it("keeps edited values until navigation is explicitly discarded", async () => {
  render(<DefinitionForm {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Continue →" }));
  await userEvent.type(
    screen.getByLabelText("Name (permanent slug)"),
    "helper",
  );
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByText("Leave unsaved changes?")).toBeTruthy();
  expect(calls.push).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(
    (screen.getByLabelText("Name (permanent slug)") as HTMLInputElement).value,
  ).toBe("helper");
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Discard changes and leave" }),
  );
  expect(calls.push).toHaveBeenCalledWith("/agents");
});
