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
  { name: "agent-one", displayName: "Agent One", role: "Chief of Staff" },
  { name: "agent-two", displayName: "Agent Two", role: "Research" },
];
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});
it("inserts suggestions without sending and submits multiline text explicitly", async () => {
  render(<Chat name="agent-one" owner="test@example.test" agents={agents} />);
  await screen.findByRole("textbox", { name: "Message Agent One" });
  await userEvent.click(
    screen.getByRole("button", { name: "Help me plan the week" }),
  );
  expect(mock.send).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(mock.send).toHaveBeenCalledWith("Help me plan the week", undefined);
});
it("keeps drafts separate while switching agents", async () => {
  const { rerender } = render(
    <Chat name="agent-one" owner="test@example.test" agents={agents} />,
  );
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Message Agent One" }),
    "Unsent Agent One draft",
  );
  rerender(<Chat name="agent-two" owner="test@example.test" agents={agents} />);
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Message Agent Two",
      })) as HTMLTextAreaElement
    ).value,
  ).toBe("");
  rerender(<Chat name="agent-one" owner="test@example.test" agents={agents} />);
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Message Agent One",
      })) as HTMLTextAreaElement
    ).value,
  ).toBe("Unsent Agent One draft");
  expect(mock.send).not.toHaveBeenCalled();
});
