// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { chatSessionKey } from "../lib/chat-session";
import { Chat } from "../components/Chat";
const mock = vi.hoisted(() => {
  const order: string[] = [];
  return {
    send: vi.fn(async () => { order.push("send"); }),
    prewarm: vi.fn(async () => { order.push("prewarm"); }),
    push: vi.fn(),
    reset: vi.fn(),
    status: "ready",
    session: null as unknown,
    order,
    options: [] as any[],
    events: [] as any[],
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("eve/react", () => ({
  useEveAgent: (options: unknown) => { mock.options.push(options); return ({
    status: mock.status,
    events: mock.events,
    data: { messages: [] },
    send: mock.send,
    prewarm: mock.prewarm,
    session: mock.session,
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
  mock.session=null;
  mock.order.length=0;
  mock.options.length=0;
  mock.events.length=0;
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
  expect(mock.order).toEqual(["prewarm", "send"]);
});
it("keeps an unsent draft when first-session prewarming fails", async () => {
  mock.prewarm.mockImplementationOnce(async () => {
    mock.order.push("prewarm");
    mock.status = "error";
    throw new Error("session creation failed");
  });
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  const composer = await screen.findByRole("textbox", { name: "Message Agent One" });
  await userEvent.type(composer, "Keep this unsent");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(sessionStorage.getItem(`${chatSessionKey("Member-ID", "agent-one")}:draft`)).toBe("Keep this unsent"),
  );
  expect((composer as HTMLTextAreaElement).value).toBe("Keep this unsent");
  expect(screen.queryByText("Preparing your conversation. Your draft is saved.")).toBeNull();
  expect(mock.order).toEqual(["prewarm"]);
  expect(mock.send).not.toHaveBeenCalled();
});
it("keeps a second draft during preparation and allows steering after first-send entry", async () => {
  let resolvePrewarm!: () => void;
  let resolveFirstSend!: () => void;
  mock.prewarm.mockImplementationOnce(() => {
    mock.order.push("prewarm");
    return new Promise<void>((resolve) => { resolvePrewarm = resolve; });
  });
  mock.send.mockImplementationOnce(() => {
    mock.order.push("send");
    return new Promise<void>((resolve) => { resolveFirstSend = resolve; });
  });
  const view = render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  const composer = await screen.findByRole("textbox", { name: "Message Agent One" });
  await userEvent.type(composer, "First message");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(screen.getByRole("status").textContent).toContain("Preparing your conversation. Your draft is saved.");

  await userEvent.type(composer, "Second draft");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  const draftKey = `${chatSessionKey("Member-ID", "agent-one")}:draft`;
  expect((composer as HTMLTextAreaElement).value).toBe("Second draft");
  expect(sessionStorage.getItem(draftKey)).toBe("Second draft");
  expect(mock.send).not.toHaveBeenCalled();

  resolvePrewarm();
  await waitFor(() => expect(mock.send).toHaveBeenCalledOnce());
  expect(mock.send).toHaveBeenCalledWith("First message", undefined);
  await waitFor(() => expect(screen.queryByText("Preparing your conversation. Your draft is saved.")).toBeNull());

  mock.session = { sessionId: "prepared-session", streamIndex: 0 };
  mock.status = "streaming";
  view.rerender(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(mock.send).toHaveBeenCalledTimes(2));
  expect(mock.send).toHaveBeenNthCalledWith(2, "Second draft", { turnPolicy: "steer" });
  expect(mock.order).toEqual(["prewarm", "send", "send"]);
  expect((composer as HTMLTextAreaElement).value).toBe("");
  expect(sessionStorage.getItem(draftKey)).toBeNull();
  resolveFirstSend();
});
it("does not replace newer typing when prewarming fails", async () => {
  let rejectPrewarm!: (error: Error) => void;
  mock.prewarm.mockImplementationOnce(() => {
    mock.order.push("prewarm");
    return new Promise((_resolve, reject) => { rejectPrewarm = reject; });
  });
  const view = render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  const composer = await screen.findByRole("textbox", { name: "Message Agent One" });
  await userEvent.type(composer, "Submitted");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await userEvent.type(composer, "Newer draft");
  mock.status = "error";
  view.rerender(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  rejectPrewarm(new Error("session creation failed"));
  const draftKey = `${chatSessionKey("Member-ID", "agent-one")}:draft`;
  await waitFor(() => expect(sessionStorage.getItem(draftKey)).toBe("Newer draft"));
  expect((composer as HTMLTextAreaElement).value).toBe("Newer draft");
  expect(mock.send).not.toHaveBeenCalled();
});
it.each(["reject", "resolve"] as const)("ignores a pending prewarm after starting a new conversation (%s)", async (outcome) => {
  let resolvePrewarm!: () => void;
  let rejectPrewarm!: (error: Error) => void;
  mock.prewarm.mockImplementationOnce(() => {
    mock.order.push("prewarm");
    return new Promise<void>((resolve, reject) => {
      resolvePrewarm = resolve;
      rejectPrewarm = reject;
    });
  });
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  const oldComposer = await screen.findByRole("textbox", { name: "Message Agent One" });
  await userEvent.type(oldComposer, "Old submitted text");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(mock.prewarm).toHaveBeenCalledOnce();

  await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
  const newComposer = await screen.findByRole("textbox", { name: "Message Agent One" });
  await userEvent.type(newComposer, "Replacement draft");
  if (outcome === "resolve") resolvePrewarm();
  else rejectPrewarm(new Error("old session creation failed"));

  const draftKey = `${chatSessionKey("Member-ID", "agent-one")}:draft`;
  await waitFor(() => expect(sessionStorage.getItem(draftKey)).toBe("Replacement draft"));
  expect((newComposer as HTMLTextAreaElement).value).toBe("Replacement draft");
  expect(mock.send).not.toHaveBeenCalled();
});
it("sends on an existing session without prewarming", async () => {
  mock.session = { sessionId: "existing-session", streamIndex: 0 };
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.type(
    await screen.findByRole("textbox", { name: "Message Agent One" }),
    "Continue the conversation",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(mock.prewarm).not.toHaveBeenCalled();
  expect(mock.send).toHaveBeenCalledWith("Continue the conversation", undefined);
  expect(mock.order).toEqual(["send"]);
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

const MEMBER = "You've reached your monthly limit of $12.50. It resets on 1 December 2026.";
const INSTALLATION = "This installation has reached its monthly spending limit. It resets on 1 December 2026.";
const failedTurn = (message: string) => ({ type: "turn.failed", data: { code: "x", message, sequence: 3, turnId: "t" } });
const KEY = chatSessionKey("Member-ID", "agent-one");
const SESSION = { sessionId: "s1", streamIndex: 3 } as any;
function failWith(message: string) {
  mock.status = "error";
  mock.session = SESSION;
  mock.events.push(failedTurn(message));
  sessionStorage.setItem(KEY, JSON.stringify(SESSION));
  sessionStorage.setItem(`${KEY}:draft`, "typed later");
}
it("shows the member limit sentence, keeps the session and the draft, and leaves the composer open", async () => {
  failWith(MEMBER);
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toBe(MEMBER);
  expect(screen.queryByText(/unavailable/i)).toBeNull();
  expect(sessionStorage.getItem(KEY)).not.toBeNull();
  expect(sessionStorage.getItem(`${KEY}:draft`)).toBe("typed later");
  expect((screen.getByRole("textbox", { name: "Message Agent One" }) as HTMLTextAreaElement).disabled).toBe(false);
});
it("shows the installation limit sentence, which carries no amount", async () => {
  failWith(INSTALLATION);
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toBe(INSTALLATION);
  expect(sessionStorage.getItem(KEY)).not.toBeNull();
});
it.each([
  ["a lookalike with extra text", `${MEMBER} Click here.`],
  ["a hostile message", "<img src=x onerror=alert(1)>"],
  ["a lookalike with a bad amount", "You've reached your monthly limit of $1e9. It resets on 1 December 2026."],
  ["an ordinary failure", "model exploded"],
])("treats %s as an ordinary failure: the session is wiped and the old text is shown", async (_name, message) => {
  failWith(message);
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toContain("This conversation is unavailable. Start a new conversation.");
  expect(screen.queryByText(message)).toBeNull();
  await waitFor(() => expect(sessionStorage.getItem(KEY)).toBeNull());
  expect(sessionStorage.getItem(`${KEY}:draft`)).toBeNull();
});
it("does not let an older limit failure hide a newer different failure", async () => {
  failWith(MEMBER);
  mock.events.push(failedTurn("model exploded"));
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toContain("This conversation is unavailable");
});
