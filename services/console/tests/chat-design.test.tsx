// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientError, ClientSessionStrandedError, SessionNotActiveError, conversationOf, type SessionStreamEvent } from "eve/client";
import { emptySessionView } from "eve/events";
import { chatSessionKey } from "../lib/chat-session";
import { conversationTooLongOf, limitReplyOf } from "../lib/limit-reply";
import { MODEL_CALLS_REFUSED_UNSCOPED, MODEL_COMPACTION_REFUSED } from "@lares/agent-kit/conversation-too-long";
import { Chat } from "../components/Chat";
/**
 * The framework's hook, stood in for: what it returns is the shape its own types give it —
 * `status` is outstanding work only (`idle`, `busy`, `resuming`), a failure is `error` beside it,
 * and the conversation is `messages`, `events`, `view` and `session`. The `view` here is the
 * framework's own (an empty one, or the one its reader folds from a fixture stream).
 */
const mock = vi.hoisted(() => {
  const order: string[] = [];
  return {
    send: vi.fn(async (..._args: unknown[]) => { order.push("send"); }),
    prewarm: vi.fn(async () => { order.push("prewarm"); }),
    respond: vi.fn(async (..._args: unknown[]) => {}),
    readCard: vi.fn(async (..._args: unknown[]): Promise<unknown> => { throw new Error("no review"); }),
    push: vi.fn(),
    end: vi.fn(),
    status: "idle",
    error: undefined as Error | undefined,
    session: undefined as unknown,
    order,
    options: [] as any[],
    events: [] as any[],
    messages: [] as any[],
    view: undefined as unknown,
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("../app/actions/accounts", () => ({ readPersonalSendCard: mock.readCard }));
vi.mock("eve/react", () => ({
  useEveAgent: (options: unknown) => { mock.options.push(options); return ({
    status: mock.status,
    error: mock.error,
    events: mock.events,
    messages: mock.messages,
    agents: {},
    view: mock.view ?? emptySessionView(),
    send: mock.send,
    prewarm: mock.prewarm,
    session: mock.session,
    end: mock.end,
    respond: mock.respond,
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
  mock.send.mockImplementation(async () => { mock.order.push("send"); });
  mock.prewarm.mockImplementation(async () => { mock.order.push("prewarm"); });
  mock.respond.mockImplementation(async () => {});
  mock.readCard.mockImplementation(async () => { throw new Error("no review"); });
  mock.status="idle";
  mock.error=undefined;
  mock.session=undefined;
  mock.view=undefined;
  mock.order.length=0;
  mock.options.length=0;
  mock.events.length=0;
  mock.messages=[];
});
it("points the framework's client at the console's own same-origin route, and nowhere else", async () => {
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await screen.findByRole("textbox", { name: "Message Agent One" });
  const options = mock.options.at(-1);
  expect(options.baseUrl).toBe("/api/chat/agent-one");
  expect("host" in options).toBe(false);
  expect(options.resume).toBe(false);
  expect(options.initialSession).toBeUndefined();
});
it("inserts suggestions without sending and submits multiline text explicitly", async () => {
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await screen.findByRole("textbox", { name: "Message Agent One" });
  await userEvent.click(
    screen.getByRole("button", { name: "Help me plan the week" }),
  );
  expect(mock.send).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  // The message alone: no option travels with it, so the request body is `{ message }`.
  expect(mock.send.mock.calls).toEqual([["Help me plan the week"]]);
  expect(mock.order).toEqual(["prewarm", "send"]);
});
it("keeps an unsent draft when first-session prewarming fails", async () => {
  mock.prewarm.mockImplementationOnce(async () => {
    mock.order.push("prewarm");
    mock.error = new Error("session creation failed");
    throw mock.error;
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
  expect(mock.send.mock.calls[0]).toEqual(["First message"]);
  await waitFor(() => expect(screen.queryByText("Preparing your conversation. Your draft is saved.")).toBeNull());

  mock.session = { sessionId: "prepared-session", streamIndex: 0 };
  mock.status = "busy";
  view.rerender(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect(screen.getByText(/still working/)).toBeDefined();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(mock.send).toHaveBeenCalledTimes(2));
  // A message sent while the agent works joins its turn by the framework's own default: nothing
  // is added to it.
  expect(mock.send.mock.calls[1]).toEqual(["Second draft"]);
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
  mock.error = new Error("session creation failed");
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
  expect(mock.send.mock.calls).toEqual([["Continue the conversation"]]);
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
  expect(mock.options.at(-1).resume).toBe(true);
  mock.error=new ClientError(403,"This conversation is not available to this signed-in member.",{"content-type":"text/plain"});
  rerender(<Chat name="agent-one" memberId="Member-ID" agents={agents}/>);
  await waitFor(()=>expect(sessionStorage.getItem(key)).toBeNull());
  expect(sessionStorage.getItem(`${key}:draft`)).toBeNull();
  mock.options.at(-1).onSessionChange({sessionId:"late-old-session",streamIndex:8});
  expect(sessionStorage.getItem(key)).toBeNull();
  mock.error=undefined;
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
/** How a failed turn is recorded: one `turn.settled` with `outcome: "failed"` and the error. */
const failedTurn = (message: string, line = 9) => ({ type: "turn.settled", scope: { turnId: "t" }, data: { turnId: "t", outcome: "failed", error: { code: "x", message } }, meta: { at: "2026-11-02T10:00:00.000Z", position: { line, index: 0 }, endOfLine: true } });
const KEY = chatSessionKey("Member-ID", "agent-one");
const SESSION = { sessionId: "s1", streamIndex: 3 } as any;
function failWith(message: string) {
  // The framework's store reports a failed turn as an error whose name is the failure's code.
  mock.error = Object.assign(new Error(message), { name: "x" });
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
  mock.events.push(failedTurn("model exploded", 14));
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toContain("This conversation is unavailable");
});

it("reads a limit reply only from the newest ending of a turn, in the framework's own event shape", () => {
  const settled = (outcome: string, error?: { code: string; message: string }) => ({ type: "turn.settled", data: { turnId: "t", outcome, ...(error ? { error } : {}) } });
  expect(limitReplyOf([failedTurn(MEMBER)])).toBe(MEMBER);
  expect(limitReplyOf([failedTurn(INSTALLATION)])).toBe(INSTALLATION);
  // The error is `{ code, message }`; the older shape, with the message beside the code, is not read.
  expect(limitReplyOf([{ type: "turn.settled", data: { turnId: "t", outcome: "failed", code: "x", message: MEMBER } }])).toBeNull();
  // The older event names are not a failure at all any more.
  expect(limitReplyOf([{ type: "turn.failed", data: { code: "x", message: MEMBER } }])).toBeNull();
  expect(limitReplyOf([{ type: "session.failed", data: { message: MEMBER } }])).toBeNull();
  // Only a FAILED turn: the same sentence on a turn that completed or was cancelled is nothing.
  expect(limitReplyOf([settled("completed", { code: "x", message: MEMBER })])).toBeNull();
  expect(limitReplyOf([settled("cancelled", { code: "x", message: MEMBER })])).toBeNull();
  // Newest ending wins: a later turn, however it ended, and a session that ended.
  expect(limitReplyOf([failedTurn(MEMBER), settled("completed")])).toBeNull();
  expect(limitReplyOf([failedTurn(MEMBER), settled("failed", { code: "y", message: "model exploded" })])).toBeNull();
  expect(limitReplyOf([failedTurn(MEMBER), { type: "session.ended", data: { outcome: "failed", error: { code: "session_stranded", message: MEMBER } } }])).toBeNull();
  expect(limitReplyOf([failedTurn("model exploded"), failedTurn(MEMBER)])).toBe(MEMBER);
  // Events that are not an ending in between do not hide it.
  expect(limitReplyOf([failedTurn(MEMBER), { type: "delivery.settled", data: { deliveryId: "d", outcome: "failed" } }, { type: "usage.recorded", data: {} }])).toBe(MEMBER);
  expect(limitReplyOf([failedTurn(`${MEMBER} Click here.`)])).toBeNull();
  expect(limitReplyOf([{ type: "turn.settled", data: { turnId: "t", outcome: "failed" } }])).toBeNull();
  expect(limitReplyOf([])).toBeNull();
});

it("shows the one fixed sentence, never the framework's text, when the reply after an approval answer is refused", () => {
  const sentence = "Your answer was applied, but I could not finish my reply. Ask me what happened.";
  expect(limitReplyOf([failedTurn("DefinitionFailedError: The reply after an approval answer was refused")])).toBe(sentence);
  expect(limitReplyOf([failedTurn("The reply after an approval answer was refused")])).toBe(sentence);
  expect(limitReplyOf([failedTurn("The reply after an approval answer was refused, and more")])).toBeNull();
  expect(limitReplyOf([failedTurn("DefinitionFailedError: Model purpose authority is not available")])).toBeNull();
  // A card that ended without an answer (expired, or withdrawn by a typed message) says so instead.
  expect(limitReplyOf([failedTurn("DefinitionFailedError: The approval in this turn ended without an answer")]))
    .toBe("That request ended without an answer; nothing was done.");
});

const TOO_LONG = "This conversation has grown too long for me to continue. Start a new conversation and send your message again there.";
it("says why when a conversation has grown too long, and keeps the way to a new one", async () => {
  failWith(MODEL_COMPACTION_REFUSED);
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toBe(TOO_LONG);
  expect(screen.queryByText(/unavailable/i)).toBeNull();
  expect(screen.queryByText(MODEL_COMPACTION_REFUSED)).toBeNull();
  // Still a broken conversation: nothing more can be sent into it, and a new one is offered.
  expect((screen.getByRole("textbox", { name: "Message Agent One" }) as HTMLTextAreaElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Start a new conversation" })).toBeDefined();
  await waitFor(() => expect(sessionStorage.getItem(KEY)).toBeNull());
});
it("the guard's degraded refusal is not 'too long': the ordinary unavailable text", async () => {
  failWith(MODEL_CALLS_REFUSED_UNSCOPED);
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toContain("This conversation is unavailable. Start a new conversation.");
  expect(screen.queryByText(TOO_LONG)).toBeNull();
  expect(conversationTooLongOf([failedTurn(`Hook "context.started" failed: ${MODEL_CALLS_REFUSED_UNSCOPED}`)])).toBeNull();
});
it("after a turn that already completed a call, says that part may already be done", async () => {
  const lines: Fact[][] = [
    [{ type: "session.started", data: { runtime: { agentId: "agent", eveVersion: "1.0.0-rc.9" } } }],
    [{ type: "delivery.admitted", data: { deliveryId: "d1", principal: { id: "member", type: "user" }, source: { channel: "eve" } } }],
    [
      { type: "turn.started", scope: T, data: { turnId: "t1", cause: { deliveryId: "d1" }, follows: null } },
      { type: "delivery.consumed", scope: T, data: { deliveryId: "d1", turnId: "t1", parts: [{ kind: "text", text: "Send the note" }] } },
    ],
    [{ type: "model.requested", scope: T, data: { runId: "r1", owner: { turnId: "t1" } } }],
    [{ type: "model.started", scope: RUN, data: { runId: "r1", modelId: "m", attempt: 0 } }],
    [
      { type: "call.requested", scope: RUN, data: { callId: "call_1", owner: { runId: "r1" }, capability: { kind: "tool", name: "gmail_send" }, input: {} } },
      { type: "model.settled", scope: RUN, data: { runId: "r1", outcome: "completed", finishReason: "tool-calls" } },
    ],
    [{ type: "call.started", scope: RUN, data: { callId: "call_1" } }],
    [{ type: "call.settled", scope: RUN, data: { callId: "call_1", outcome: "completed", output: "sent" } }],
    [{ type: "turn.settled", scope: T, data: { turnId: "t1", outcome: "failed", error: { code: "MODEL_CALL_FAILED", message: MODEL_COMPACTION_REFUSED } } }],
  ];
  withConversation(lines);
  mock.error = Object.assign(new Error(MODEL_COMPACTION_REFUSED), { name: "MODEL_CALL_FAILED" });
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toBe(`${TOO_LONG} Part of what you asked may already have been done, so check before asking again.`);
  // The same failure with no completed call in its turn keeps the sentence alone.
  expect(conversationTooLongOf(mock.events, emptySessionView())).toBe(TOO_LONG);
});
it("reads the too-long cause only from the newest ending of a turn, and never for anything else", () => {
  expect(conversationTooLongOf([failedTurn(MODEL_COMPACTION_REFUSED)])).toBe(TOO_LONG);
  expect(conversationTooLongOf([failedTurn(`context.started failed: ${MODEL_COMPACTION_REFUSED}`)])).toBe(TOO_LONG);
  expect(conversationTooLongOf([failedTurn(`${MODEL_COMPACTION_REFUSED}, and more`)])).toBeNull();
  expect(conversationTooLongOf([failedTurn("model exploded")])).toBeNull();
  expect(conversationTooLongOf([failedTurn(MEMBER)])).toBeNull();
  expect(conversationTooLongOf([failedTurn(MODEL_COMPACTION_REFUSED), failedTurn("model exploded", 14)])).toBeNull();
  expect(conversationTooLongOf([failedTurn(MODEL_COMPACTION_REFUSED), { type: "session.ended", data: { outcome: "failed", error: { code: "x", message: MODEL_COMPACTION_REFUSED } } }])).toBeNull();
  expect(conversationTooLongOf([{ type: "turn.settled", data: { turnId: "t", outcome: "completed", error: { code: "x", message: MODEL_COMPACTION_REFUSED } } }])).toBeNull();
  expect(conversationTooLongOf([])).toBeNull();
  // It is not a limit reply: the conversation is broken, not merely paused.
  expect(limitReplyOf([failedTurn(MODEL_COMPACTION_REFUSED)])).toBeNull();
});

// ---------------------------------------------------------------------------------------------
// Cards in the live chat, and a conversation that is over. The messages are what the framework's
// own reader makes of a recorded stream (`conversationOf`), not parts written by hand.
// ---------------------------------------------------------------------------------------------

type Fact = { type: string; scope?: Record<string, string>; data: Record<string, unknown> };
const T = { turnId: "t1" };
const RUN = { turnId: "t1", runId: "r1" };
function streamOf(lines: readonly (readonly Fact[])[]): SessionStreamEvent[] {
  return lines.flatMap((facts, line) => facts.map((fact, index) =>
    ({ ...fact, meta: { at: new Date(Date.now() - 60_000 + line * 1000).toISOString(), position: { line, index }, endOfLine: index === facts.length - 1 } }) as unknown as SessionStreamEvent));
}
/** A turn waiting on one approval card for `name(input)`. */
const waitingCard = (name = "gmail_send", input: unknown = { to: ["a@example.invalid"], subject: "The note" }): Fact[][] => [
  [{ type: "session.started", data: { runtime: { agentId: "agent", eveVersion: "1.0.0-rc.9" } } }],
  [{ type: "delivery.admitted", data: { deliveryId: "d1", principal: { id: "member", type: "user" }, source: { channel: "eve" } } }],
  [
    { type: "turn.started", scope: T, data: { turnId: "t1", cause: { deliveryId: "d1" }, follows: null } },
    { type: "delivery.consumed", scope: T, data: { deliveryId: "d1", turnId: "t1", parts: [{ kind: "text", text: "Send the note" }] } },
  ],
  [{ type: "model.requested", scope: T, data: { runId: "r1", owner: { turnId: "t1" } } }],
  [{ type: "model.started", scope: RUN, data: { runId: "r1", modelId: "m", attempt: 0 } }],
  [
    { type: "call.requested", scope: RUN, data: { callId: "call_1", owner: { runId: "r1" }, capability: { kind: "tool", name }, input } },
    { type: "model.settled", scope: RUN, data: { runId: "r1", outcome: "completed", finishReason: "tool-calls" } },
  ],
  [
    { type: "interaction.opened", scope: T, data: { interactionId: "int_A", subject: { callId: "call_1" }, request: { kind: "approval", prompt: "Send the note?", display: "confirmation", allowFreeform: false, options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] } } },
    { type: "turn.paused", scope: T, data: { turnId: "t1", awaiting: [{ interactionId: "int_A" }] } },
    { type: "delivery.settled", scope: T, data: { deliveryId: "d1", outcome: "awaiting-input", turnId: "t1" } },
  ],
];
function withConversation(lines: Fact[][]) {
  const events = streamOf(lines);
  const state = conversationOf(events);
  mock.events.push(...events);
  mock.messages = [...state.messages];
  mock.view = state.view;
  mock.session = { sessionId: "s1", streamIndex: lines.length };
}
/** What the framework's client throws for the agent's `409 { code: "session_stranded" }`. */
const stranded = () => new ClientSessionStrandedError(409, JSON.stringify({ code: "session_stranded", error: "RAW FRAMEWORK WORDS", ok: false, eveVersion: "0.60.1" }), { "content-type": "application/json" }, { eveVersion: "0.60.1" });
const UPDATE = "This conversation ended with an update. Start a new one.";
const OVER = "This conversation has ended. Start a new one.";

it("Approve answers the card with its interaction id and the framework's 'approve' — one answer", async () => {
  withConversation(waitingCard());
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(mock.respond.mock.calls).toEqual([[[{ interactionId: "int_A", optionId: "approve" }]]]);
  // The card's id, never the tool call's.
  expect(JSON.stringify(mock.respond.mock.calls)).not.toContain("call_1");
});

it("Deny answers the card with the framework's 'deny'", async () => {
  withConversation(waitingCard());
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.click(await screen.findByRole("button", { name: "Deny" }));
  expect(mock.respond.mock.calls).toEqual([[[{ interactionId: "int_A", optionId: "deny" }]]]);
});

it("sends one answer for a double click: every button is closed while the first is in flight", async () => {
  let finish!: () => void;
  mock.respond.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  withConversation(waitingCard());
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(screen.getByText("Sending your answer…")).toBeDefined();
  for (const name of ["Approve", "Deny"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(mock.respond).toHaveBeenCalledOnce();
  finish();
  await waitFor(() => expect(screen.queryByText("Sending your answer…")).toBeNull());
});

it("looks the personal mail's trusted review up by the card's interaction id", async () => {
  mock.readCard.mockResolvedValue({ accountLabel: "Verified own@example.invalid", connectorId: "google", accountId: "acct", generation: 1, resourceBindingId: "bind", to: ["recipient@example.invalid"], subject: "Trusted subject", body: "Trusted body" });
  withConversation(waitingCard("personal_mailbox_send", { body: "MODEL_BODY_MUST_NOT_DISPLAY" }));
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await screen.findByText("Trusted body");
  expect(mock.readCard.mock.calls).toEqual([["int_A"]]);
  expect(screen.queryByText(/MODEL_BODY/)).toBeNull();
  expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
});

it("an ordinary card asks for no personal mail review", async () => {
  withConversation(waitingCard());
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await screen.findByRole("button", { name: "Approve" });
  expect(mock.readCard).not.toHaveBeenCalled();
});

it("a refused answer is said in the console's own words: the proxy's sentence, never the framework's", async () => {
  withConversation(waitingCard());
  mock.respond.mockRejectedValueOnce(new ClientError(503, "Private model authorization is unavailable.", { "content-type": "text/plain", "x-lares-console-refusal": "1" }));
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(await screen.findByText("Your answer did not reach the agent, so nothing has been done: Private model authorization is unavailable.")).toBeDefined();
  // The card is still there, with its buttons: nothing happened, and the owner may try again.
  expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  // A refused approval is never shown as approved, or as answered.
  expect(screen.queryByText(/You approved|it ran|You have answered/)).toBeNull();
  cleanup();
  mock.respond.mockRejectedValueOnce(new ClientError(400, JSON.stringify({ ok: false, error: "Expected every 'answers' entry to match the HITL response schema." }), { "content-type": "application/json" }));
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(await screen.findByText("Your answer did not reach the agent, so nothing has been done.")).toBeDefined();
  expect(screen.queryByText(/HITL|schema|answers/)).toBeNull();
  // Short plain text is not enough: without the proxy's own mark it is the agent's, and stays unseen.
  cleanup();
  mock.respond.mockRejectedValueOnce(new ClientError(400, "Text an agent wrote.", { "content-type": "text/plain" }));
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(await screen.findByText("Your answer did not reach the agent, so nothing has been done.")).toBeDefined();
  expect(screen.queryByText(/Text an agent wrote/)).toBeNull();
});

it("a card in a conversation that has failed for any reason cannot be answered from it", async () => {
  withConversation(waitingCard());
  // Not an ending: an ordinary refusal. The conversation is unavailable all the same.
  mock.error = new ClientError(403, "This conversation is not available to this signed-in member.", { "content-type": "text/plain" });
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toContain("This conversation is unavailable. Start a new conversation.");
  for (const name of ["Approve", "Deny"]) {
    const button = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.click(button);
  }
  expect(mock.respond).not.toHaveBeenCalled();
});

it("a message into a conversation an update ended: the plain sentence, a way to start a new one, no retry, no raw error", async () => {
  mock.session = { sessionId: "s1", streamIndex: 4 };
  sessionStorage.setItem(KEY, JSON.stringify(mock.session));
  // The agent answers 409 `session_stranded`; the framework's client throws, and reports the same
  // error on the hook.
  mock.send.mockImplementationOnce(async () => { mock.order.push("send"); mock.error = stranded(); throw mock.error; });
  const view = render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.type(await screen.findByRole("textbox", { name: "Message Agent One" }), "Are you there?");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  view.rerender(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toBe(UPDATE);
  expect(screen.queryByText(/RAW FRAMEWORK WORDS|session_stranded|409|0\.60\.1/)).toBeNull();
  // Sent once. Never again, however long the page stays open.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(mock.send).toHaveBeenCalledOnce();
  expect(mock.prewarm).not.toHaveBeenCalled();
  // The dead handle is not kept for the next page load, and nothing more can be typed into it.
  await waitFor(() => expect(sessionStorage.getItem(KEY)).toBeNull());
  expect((screen.getByRole("textbox", { name: "Message Agent One" }) as HTMLTextAreaElement).disabled).toBe(true);
  // The way on: a new conversation, with nothing carried over.
  await userEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
  expect(mock.options.at(-1).initialSession).toBeUndefined();
  expect(mock.options.at(-1).resume).toBe(false);
});

it("an answer into a conversation an update ended: the same plain sentence, and the card loses its buttons", async () => {
  withConversation(waitingCard());
  // Only the answer's own rejection says so here: the page must not depend on the hook echoing it.
  mock.respond.mockRejectedValueOnce(stranded());
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect((await screen.findByRole("alert")).textContent).toBe(UPDATE);
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  expect(screen.getByText("This card is no longer active. Nothing was approved.")).toBeDefined();
  expect(screen.queryByText(/RAW FRAMEWORK WORDS|did not reach the agent/)).toBeNull();
  expect(mock.respond).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Start a new conversation" })).toBeDefined();
});

it("a saved conversation that an update ended says so when the page is opened again", async () => {
  sessionStorage.setItem(KEY, JSON.stringify({ sessionId: "old-session", streamIndex: 12, inbox: "opaque-inbox" }));
  mock.error = stranded();
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toBe(UPDATE);
  // The whole saved state went to the framework unchanged, the opaque inbox included.
  expect(mock.options.at(-1).initialSession).toEqual({ sessionId: "old-session", streamIndex: 12, inbox: "opaque-inbox" });
  expect(screen.queryByText(/could not be reopened|unavailable/)).toBeNull();
  expect(screen.getAllByText(UPDATE)).toHaveLength(1);
  expect(mock.send).not.toHaveBeenCalled();
});

it("a conversation that ended for another reason has its own sentence, which does not mention an update", async () => {
  mock.session = { sessionId: "s1", streamIndex: 4 };
  mock.send.mockImplementationOnce(async () => { mock.error = new SessionNotActiveError(); throw mock.error; });
  const view = render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.type(await screen.findByRole("textbox", { name: "Message Agent One" }), "Still there?");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  view.rerender(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toBe(OVER);
  expect(screen.queryByText(/update/i)).toBeNull();
  expect(screen.queryByText(/no longer active\. Start a new session/)).toBeNull(); // the framework's own sentence
  expect(mock.send).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Start a new conversation" })).toBeDefined();
});

it("an answer refused because the conversation has ended says that sentence too", async () => {
  withConversation(waitingCard());
  mock.respond.mockRejectedValueOnce(new SessionNotActiveError());
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  await userEvent.click(await screen.findByRole("button", { name: "Deny" }));
  expect((await screen.findByRole("alert")).textContent).toBe(OVER);
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
});

it("a conversation whose own record shows it ended is closed before anyone types into it", async () => {
  withConversation([...waitingCard(), [{ type: "session.ended", data: { outcome: "completed" } }]]);
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toBe(OVER);
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  expect((screen.getByRole("textbox", { name: "Message Agent One" }) as HTMLTextAreaElement).disabled).toBe(true);
  cleanup();
  mock.events.length = 0;
  withConversation([...waitingCard(), [{ type: "session.ended", data: { outcome: "failed", error: { code: "session_stranded", message: "RAW FRAMEWORK WORDS" } } }]]);
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toBe(UPDATE);
  expect(screen.queryByText(/RAW FRAMEWORK WORDS/)).toBeNull();
});

it("an agent that is asked to wait is not an ended conversation", async () => {
  mock.session = { sessionId: "s1", streamIndex: 4 };
  mock.error = new SessionNotActiveError({ retryable: true });
  render(<Chat name="agent-one" memberId="Member-ID" agents={agents} />);
  expect((await screen.findByRole("alert")).textContent).toContain("This conversation is unavailable. Start a new conversation.");
  expect(screen.queryByText(UPDATE)).toBeNull();
  expect(screen.queryByText(OVER)).toBeNull();
});
