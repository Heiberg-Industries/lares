// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { chatSessionKey } from "../lib/chat-session";
import { Chat } from "../components/Chat";
const mock = vi.hoisted(() => ({
  send: vi.fn(),
  push: vi.fn(),
  reset: vi.fn(),
  status: "ready",
  options: [] as any[],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("eve/react", () => ({
  useEveAgent: (options: unknown) => { mock.options.push(options); return ({
    status: mock.status,
    events: [],
    data: { messages: [] },
    send: mock.send,
    reset: mock.reset,
    respond: vi.fn(),
  });},
}));
const agents = [
  { name: "agent-one", displayName: "Agent One", role: "Chief of Staff" },
  { name: "agent-two", displayName: "Agent Two", role: "Research" },
];
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
  mock.status="ready";
  mock.options.length=0;
});
it("inserts suggestions without sending and submits multiline text explicitly", async () => {
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
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
    <Chat name="agent-one" memberId="Member-ID" agents={agents} />,
  );
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Message Agent One" }),
    "Unsent Agent One draft",
  );
  rerender(<Chat name="agent-two" memberId="Member-ID" agents={agents} />);
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Message Agent Two",
      })) as HTMLTextAreaElement
    ).value,
  ).toBe("");
  rerender(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Message Agent One",
      })) as HTMLTextAreaElement
    ).value,
  ).toBe("Unsent Agent One draft");
  expect(mock.send).not.toHaveBeenCalled();
});

it("clears a refused saved handle and starts fresh without copying its transcript or draft", async () => {
  const key=chatSessionKey("Member-ID","agent-one");
  sessionStorage.setItem(key,JSON.stringify({sessionId:"old-private-session",streamIndex:7}));
  sessionStorage.setItem(`${key}:draft`,"Old private draft");
  const {rerender}=render(<Chat name="agent-one" memberId="Member-ID" agents={agents}/>);
  await screen.findByRole("textbox",{name:"Message Agent One"});
  expect(mock.options.at(-1).initialSession.sessionId).toBe("old-private-session");
  mock.status="error";
  rerender(<Chat name="agent-one" memberId="Member-ID" agents={agents}/>);
  await waitFor(()=>expect(sessionStorage.getItem(key)).toBeNull());
  expect(sessionStorage.getItem(`${key}:draft`)).toBeNull();
  mock.options.at(-1).onSessionChange({sessionId:"late-old-session",streamIndex:8});
  expect(sessionStorage.getItem(key)).toBeNull();
  mock.status="ready";
  rerender(<Chat name="agent-one" memberId="Member-ID" agents={agents}/>);
  mock.options.at(-1).onSessionChange({sessionId:"late-old-session",streamIndex:9});
  expect(sessionStorage.getItem(key)).toBeNull();
  expect((screen.getByRole("textbox",{name:"Message Agent One"}) as HTMLTextAreaElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole("button",{name:"New conversation"}));
  expect(mock.options.at(-1).initialSession).toBeUndefined();
  expect(mock.options.at(-1).resume).toBe(false);
  expect((screen.getByRole("textbox",{name:"Message Agent One"}) as HTMLTextAreaElement).value).toBe("");
  expect(mock.send).not.toHaveBeenCalled();
});
