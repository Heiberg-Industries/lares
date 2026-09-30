// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chat } from "../components/Chat";
const mock = vi.hoisted(() => ({
  send: vi.fn(),
  push: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("eve/react", () => ({
  useEveAgent: () => ({
    status: "ready",
    events: [],
    data: { messages: [] },
    send: mock.send,
    reset: mock.reset,
    respond: vi.fn(),
  }),
}));
const agents = [
  { name: "sage", displayName: "Sage", role: "Chief of Staff" },
  { name: "milo", displayName: "Milo", role: "Travel" },
];
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});
it("inserts suggestions without sending and submits multiline text explicitly", async () => {
  render(<Chat name="sage" owner="test@example.test" agents={agents} />);
  await screen.findByRole("textbox", { name: "Message Sage" });
  await userEvent.click(
    screen.getByRole("button", { name: "Help me plan the week" }),
  );
  expect(mock.send).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(mock.send).toHaveBeenCalledWith("Help me plan the week", undefined);
});
it("keeps drafts separate while switching agents", async () => {
  const { rerender } = render(
    <Chat name="sage" owner="test@example.test" agents={agents} />,
  );
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Message Sage" }),
    "Unsent Sage draft",
  );
  rerender(<Chat name="milo" owner="test@example.test" agents={agents} />);
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Message Milo",
      })) as HTMLTextAreaElement
    ).value,
  ).toBe("");
  rerender(<Chat name="sage" owner="test@example.test" agents={agents} />);
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Message Sage",
      })) as HTMLTextAreaElement
    ).value,
  ).toBe("Unsent Sage draft");
  expect(mock.send).not.toHaveBeenCalled();
});
