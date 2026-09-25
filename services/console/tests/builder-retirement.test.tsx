// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const mocks = vi.hoisted(() => ({
  retire: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}));
vi.mock("../app/actions/definition", () => ({
  retireAgent: mocks.retire,
  deleteAgent: mocks.remove,
}));
vi.mock("../components/AvatarEditor", () => ({ AvatarEditor: () => null }));
vi.mock("../components/DoorSetup", () => ({ DoorSetup: () => null }));
vi.mock("../components/ConversationControl", () => ({
  ConversationControl: () => null,
}));
import { DefinitionForm } from "../components/DefinitionForm";
import { modelAliases, startingPoints } from "../lib/builder";
function setup() {
  const points = startingPoints();
  render(
    <DefinitionForm
      startingPoints={points}
      aliases={modelAliases("example")}
      timing={{}}
      capacity={{
        ceiling: 3,
        activeCount: 1,
        approved: true,
        creationAvailable: true,
      }}
      initial={{
        definition: {
          ...points[0].definition,
          name: "example",
          model: "example-brain",
        },
        duties: "",
        voice: "",
        hash: "a".repeat(64),
        status: "valid",
      }}
    />,
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it.each([
  [
    {
      ok: false,
      message:
        "Definition retained on disk; git backup failed. Check backup configuration and retry backup.",
    },
    "Agent retired. Definition retained on disk; git backup failed. Check backup configuration and retry backup.",
  ],
  [{ ok: true }, "Agent retired."],
])(
  "confirms retirement and shows its separate backup outcome: %j",
  async (backup, expected) => {
    mocks.retire.mockResolvedValue({
      ok: true,
      result: {
        name: "example",
        status: "retired",
        archive: "example-archive",
        backup,
      },
    });
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Retire agent" }));
    expect(mocks.retire).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Retire agent",
      }),
    );
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(mocks.retire).toHaveBeenCalledExactlyOnceWith({ name: "example" });
    expect(screen.getByText(expected)).toBeTruthy();
  },
);
it("requires the exact name before permanent deletion", async () => {
  mocks.remove.mockResolvedValue({ ok: true });
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Delete agent…" }));
  const dialog = within(screen.getByRole("dialog"));
  await userEvent.click(
    dialog.getByRole("button", { name: "Delete permanently" }),
  );
  expect(mocks.remove).not.toHaveBeenCalled();
  await userEvent.type(
    dialog.getByLabelText("Type example to confirm"),
    "example",
  );
  await userEvent.click(
    dialog.getByRole("button", { name: "Delete permanently" }),
  );
  await waitFor(() =>
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith({
      name: "example",
      confirm: true,
    }),
  );
  expect(mocks.push).toHaveBeenCalledWith("/agents");
});
