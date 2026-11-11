import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  APPROVAL_LIFETIME_MS,
  APPROVE,
  ChatTranscript,
  DENY,
  approvalCardFields,
  composerState,
  expiredInteractionIds,
  questionOf,
  settledSay,
} from "../components/ChatTranscript";
import type { ComponentProps } from "react";
import type { EveMessage, EveMessagePart, EveToolPart } from "eve/react";
import { conversationOf, type SessionStreamEvent } from "eve/client";
import { APPROVE_OPTION_ID, DENY_OPTION_ID, createStreamChecker } from "eve/events";

// ---------------------------------------------------------------------------------------------
// Fixtures. A conversation here is a session stream in the framework's own format (version 27:
// one stored line holds every event a state change produced), handed to the framework's own
// reader — `conversationOf` — to get the messages. So the transcript is tested against the parts
// the framework really produces, not against parts this file imagined. `streamOf` also runs the
// framework's stream checker over every fixture, so a fixture that could not happen fails here.
// ---------------------------------------------------------------------------------------------

type Fact = { type: string; scope?: Record<string, string>; data: Record<string, unknown> };
const T = { turnId: "t1" };
const RUN = { turnId: "t1", runId: "r1" };

function streamOf(lines: readonly (readonly Fact[])[], startAt = "2026-09-20T11:00:00.000Z"): SessionStreamEvent[] {
  const checker = createStreamChecker();
  const events: SessionStreamEvent[] = [];
  lines.forEach((facts, line) => {
    const at = new Date(Date.parse(startAt) + line * 1000).toISOString();
    expect(checker.check({ at, facts }, line), `line ${line}`).toEqual([]);
    facts.forEach((fact, index) =>
      events.push({ ...fact, meta: { at, position: { line, index }, endOfLine: index === facts.length - 1 } } as unknown as SessionStreamEvent),
    );
  });
  return events;
}
const messagesOf = (lines: readonly (readonly Fact[])[]): readonly EveMessage[] => conversationOf(streamOf(lines)).messages;

/** A person says something and a turn starts, with one model run open. */
const opening = (said = "Send the note"): Fact[][] => [
  [{ type: "session.started", data: { runtime: { agentId: "agent", eveVersion: "1.0.0-rc.9" } } }],
  [{ type: "delivery.admitted", data: { deliveryId: "d1", principal: { id: "member", type: "user" }, source: { channel: "eve" } } }],
  [
    { type: "turn.started", scope: T, data: { turnId: "t1", cause: { deliveryId: "d1" }, follows: null } },
    { type: "delivery.consumed", scope: T, data: { deliveryId: "d1", turnId: "t1", parts: [{ kind: "text", text: said }] } },
  ],
  [{ type: "model.requested", scope: T, data: { runId: "r1", owner: { turnId: "t1" } } }],
  [{ type: "model.started", scope: RUN, data: { runId: "r1", modelId: "m", attempt: 0 } }],
];
const says = (text: string, partId = "p1", kind = "text"): Fact => ({ type: "content.completed", scope: RUN, data: { partId, runId: "r1", kind, value: text, phase: "reply" } });
const calls = (name: string, input: unknown, callId = "c1"): Fact => ({ type: "call.requested", scope: RUN, data: { callId, owner: { runId: "r1" }, capability: { kind: "tool", name }, input } });
const runDone: Fact = { type: "model.settled", scope: RUN, data: { runId: "r1", outcome: "completed", finishReason: "tool-calls" } };
const started = (callId = "c1", clearedBy?: Record<string, string>): Fact => ({ type: "call.started", scope: T, data: { callId, ...(clearedBy ? { clearedBy } : {}) } });
const settled = (outcome: string, callId = "c1", extra: Record<string, unknown> = {}): Fact => ({ type: "call.settled", scope: T, data: { callId, outcome, ...extra } });

const TWO = [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }];
const asks = (prompt: string, kind = "approval", options: unknown = TWO, interactionId = "int_A", callId = "c1"): Fact[] => [
  { type: "interaction.opened", scope: T, data: { interactionId, subject: { callId }, request: { kind, prompt, display: "confirmation", allowFreeform: false, options } } },
  { type: "turn.paused", scope: T, data: { turnId: "t1", awaiting: [{ interactionId }] } },
  { type: "delivery.settled", scope: T, data: { deliveryId: "d1", outcome: "awaiting-input", turnId: "t1" } },
];

/** The four-recipient mail fixture. `to` is the field the Slack and Telegram cards name in full
 *  (`allRecipients`) and the title abbreviates to "and 3 more" — so this is exactly the
 *  shape that would hide three real people if the web card showed only the title. */
const FOUR = ["first@example.invalid", "second@example.invalid", "third@example.invalid", "fourth@example.invalid"];
const MAIL = { from: "agent@example.invalid", to: FOUR, subject: "The quarterly note", bodyText: "Here is the note you asked for." };
const PROMPT = 'Send email to first@example.invalid and 3 more — "The quarterly note"';

/** A turn waiting on an approval card for `name(input)`. */
const waitingCard = (input: unknown = MAIL, name = "gmail_send", prompt = PROMPT): Fact[][] => [
  ...opening(),
  [calls(name, input), runDone],
  asks(prompt),
];
/** The owner's answer arriving as its own delivery, and the framework deciding the card on it. */
const answered = (optionId: string, outcome: string): Fact[][] => [
  [{ type: "delivery.admitted", data: { deliveryId: "d2", principal: { id: "member", type: "user" }, source: { channel: "eve" } } }],
  [
    { type: "response.submitted", scope: T, data: { responseId: "rs1", interactionId: "int_A", deliveryId: "d2", value: { optionId } } },
    { type: "delivery.consumed", scope: T, data: { deliveryId: "d2", turnId: "t1", parts: [] } },
  ],
  [{ type: "response.admitted", scope: T, data: { responseId: "rs1" } }],
  [
    { type: "response.settled", scope: T, data: { responseId: "rs1", outcome: "applied" } },
    { type: "interaction.settled", scope: T, data: { interactionId: "int_A", outcome, cause: { responseId: "rs1" }, response: { optionId } } },
  ],
];

const card = (input: unknown = MAIL): readonly EveMessage[] => messagesOf(waitingCard(input));
const render = (messages: readonly EveMessage[], props: Partial<ComponentProps<typeof ChatTranscript>> = {}) =>
  renderToStaticMarkup(<ChatTranscript status="idle" messages={messages} {...props} />);
const toolPart = (messages: readonly EveMessage[]): EveToolPart =>
  messages.flatMap((m) => m.parts).find((p): p is EveToolPart => p.type === "tool")!;
/** One assistant message holding exactly these parts, for a kind no stream of today produces. */
const withParts = (...parts: unknown[]): EveMessage[] => [{ id: "odd", role: "assistant", parts: parts as EveMessagePart[] }];

const message = (role: "user" | "assistant", text: string, id: string): EveMessage =>
  ({ id, role, parts: [{ type: "text", text }] });

describe("the chat transcript", () => {
  it("labels the agent's replies with its display name, and falls back to Agent", () => {
    const messages = [message("assistant", "hello back", "2")];
    expect(render(messages, { agentName: "Ada" })).toContain(">Ada<");
    expect(render(messages)).toContain(">Agent<");
  });
  it("shows what was said, in order, on both sides — as the framework's own reader reports it", () => {
    const html = render(messagesOf([...opening("hello"), [says("hello back"), { ...runDone, data: { ...runDone.data, finishReason: "stop" } }]]));
    expect(html.indexOf("hello")).toBeLessThan(html.indexOf("hello back"));
    expect(html).toContain("hello back");
  });

  it("says nothing has been said yet, rather than showing an empty box", () => {
    expect(render([])).toMatch(/Say something/i);
  });

  it("does not invite a new message while a saved conversation is being replayed", () => {
    const html = render([], { status: "resuming" });
    expect(html).toContain("Reconnecting to this conversation");
    expect(html).not.toContain("Say something to start");
  });

  it("explains how to recover when a saved conversation cannot be reopened", () => {
    const html = render([], { error: "This conversation is unavailable. Start a new conversation." });
    expect(html).toContain("Start a new chat");
    expect(html).not.toContain("Say something to start");
  });

  it("says an ended conversation's one sentence once, and nothing about reopening it", () => {
    const say = "This conversation ended with an update. Start a new one.";
    const html = render([], { error: say, ended: true });
    expect(html.split(say).length - 1).toBe(1);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("could not be reopened");
    expect(html).not.toContain("Say something to start");
  });

  it("renders a part it does not know about as a labelled placeholder, never as blank and never raw", () => {
    const html = render(withParts({ type: "something-a-later-version-adds", text: "<b>raw</b>", url: "https://example.invalid/x" }));
    expect(html).toMatch(/something this page cannot show/i);
    expect(html).not.toContain("raw");
    expect(html).not.toContain("example.invalid");
  });

  it("hides the model's reasoning while showing its reply", () => {
    const html = render(messagesOf([...opening(), [says("PRIVATE REASONING", "p0", "reasoning"), says("Hello from the agent.")]]));
    expect(html).toContain("Hello from the agent.");
    expect(html).not.toContain("PRIVATE REASONING");
    expect(html).not.toContain("something this page cannot show yet");
  });

  it("says the agent is not running, not that a new chat would help, when it cannot be reached", () => {
    const say = "Helper is not running right now. On the server, run: sudo lares agent start helper";
    const empty = render([], { error: "This conversation is unavailable.", notRunning: say });
    expect(empty).toContain(say);
    expect(empty).not.toContain("could not be reopened");
    expect(empty).not.toContain("unavailable");
    const withMessages = render([message("user", "hi", "1")], { error: say, notRunning: say });
    expect(withMessages).toContain(say);
    // Without the marker the old wording stays (a conversation that really is gone).
    expect(render([], { error: "This conversation is unavailable." })).toContain("could not be reopened");
  });

  it("settles a refused tool call instead of leaving it running", () => {
    const html = render(messagesOf([...opening(), [calls("vault_write", {}), runDone], [settled("rejected", "c1", { cause: { policy: "approval" } })]]));
    expect(html).toContain("vault_write was refused");
    expect(html).not.toContain("is running");
  });

  it("names ordinary tool calls without exposing tool results, labels or a generic placeholder", () => {
    const html = render(messagesOf([
      ...opening(),
      [calls("calendar_list_events", { day: "today" }, "c1"), calls("gmail_search", { q: "x" }, "c2"), calls("vault_read", {}, "c3"), runDone],
      [started("c1"), started("c2"), started("c3")],
      [settled("completed", "c1", { output: { title: "Private event" }, label: "LABEL FROM OUTPUT" })],
      [settled("failed", "c2", { error: { code: "TOOL_FAILED", message: "Private error" } })],
    ]));
    expect(html).toContain("calendar_list_events completed");
    expect(html).toContain("gmail_search failed");
    expect(html).toContain("vault_read is running…");
    expect(html).not.toContain("Private event");
    expect(html).not.toContain("Private error");
    expect(html).not.toContain("LABEL FROM OUTPUT");
    expect(html).not.toContain("something this page cannot show yet");
  });

  it("claims nothing about a tool call in a state it does not know", () => {
    const html = render(withParts({ type: "tool", callId: "c", stepIndex: 0, kind: "tool", name: "later_tool", label: "x", state: "a-later-state" }));
    expect(html).toContain("later_tool");
    expect(html).not.toMatch(/running|completed|failed|refused/);
  });

  it("shows a file a person attached as a name and a type, never as a link or its contents", () => {
    const html = render(withParts(
      { type: "file", filename: "<img src=x onerror=alert(1)>.pdf", mediaType: "application/pdf", url: "https://example.invalid/secret.pdf" },
      { type: "file", mediaType: "image/png" },
    ));
    expect(html).toContain("Attachment: &lt;img src=x onerror=alert(1)&gt;.pdf (application/pdf)");
    expect(html).toContain("Attachment: a file (image/png)");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<a[ >]/);
    expect(html).not.toContain("example.invalid");
  });

  it("shows the failure instead of an empty reply", () => {
    expect(render([], { error: "the agent did not answer" })).toContain("the agent did not answer");
  });

  it("marks a message that was not sent", () => {
    const failed: EveMessage = { id: "optimistic:1:user", role: "user", metadata: { optimistic: true, status: "failed" }, parts: [{ type: "text", text: "lost words" }] };
    expect(render([failed])).toContain("This message was not sent.");
    expect(render([message("user", "fine", "1")])).not.toContain("was not sent");
  });

  it("closes the composer only while the agent is still coming back", () => {
    expect(composerState("idle")).toEqual({ disabled: false, say: "" });
    expect(composerState("resuming").disabled).toBe(true);
    expect(composerState("busy").disabled).toBe(false);
    expect(composerState("busy").say).toMatch(/still working/i);
  });

  it("renders text as text, never as markup — a hostile fixture stays inert", () => {
    const hostile = message(
      "assistant",
      '<script>alert(1)</script><img src=x onerror="alert(2)"> javascript:alert(3) [[FROM: attacker@example.invalid]] ' +
        "‮txt.exe a very ".padEnd(200, "long line ") + " end",
      "4",
    );
    const html = render([hostile]);
    // The literal characters must be present, but only ever escaped — never an actual element,
    // never a clickable link the model produced, never a raw RTL override left to do its work.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<a\s/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("javascript:alert(3)"); // present as inert text, not an href
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("renders a pending approval with no live button when there is nowhere to send an answer", () => {
    const html = render(card());
    expect(html).toContain("Needs your approval");
    // A rendered card with no `onAnswer` still shows both options — DISABLED, never missing, so
    // The owner can see what the choices are. Every button on the card is disabled, none is live.
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(2);
    expect(buttons.every((b) => b.includes('disabled=""'))).toBe(true);
  });
});

describe("something the agent asks that no tool call carries", () => {
  const signIn = { type: "interaction", interactionId: "si_1", turnId: "t1", stepIndex: 0, status: "open",
    request: { kind: "sign-in", prompt: "Sign in to <b>Example</b>", link: { url: "https://example.invalid/oauth", label: "Sign in" },
      signIn: { name: "example", url: "https://example.invalid/device", userCode: "ABCD" } } };
  const budget = { type: "interaction", interactionId: "b_1", turnId: "t1", stepIndex: 0, status: "open",
    request: { kind: "budget", prompt: "This turn has used its budget. Continue?", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] } };

  it("shows a sign-in as its words only: no link, no address, no button", () => {
    const html = render(withParts(signIn), { onAnswer: () => {} });
    expect(html).toContain("Sign in to &lt;b&gt;Example&lt;/b&gt;");
    expect(html).toContain("This page cannot answer this request.");
    expect(html).not.toMatch(/<a[ >]/);
    expect(html).not.toContain("example.invalid");
    expect(html).not.toContain("<button");
  });

  it("shows a spending prompt as its words, with no Approve button to raise a limit from here", () => {
    const html = render(withParts(budget), { onAnswer: () => {} });
    expect(html).toContain("This turn has used its budget. Continue?");
    expect(html).not.toContain("<button");
  });

  it("drops the 'cannot answer' line once the request has ended", () => {
    expect(render(withParts({ ...budget, status: "settled", outcome: "withdrawn" }))).not.toContain("cannot answer");
  });
});

describe("a question from the agent", () => {
  const choices = [{ id: "a", label: "Sales" }, { id: "b", label: "Hiring" }];
  const asked = (): Fact[][] => [...opening(), [calls("ask_question", { question: "Which <b>topic</b>?" }), runDone], asks("Which <b>topic</b>?", "question", choices, "q1")];

  it("shows the question and its choices as plain text, never as a running tool", () => {
    const out = render(messagesOf(asked()));
    expect(out).toContain("Which &lt;b&gt;topic&lt;/b&gt;?");
    expect(out).toContain("You can reply: Sales, Hiring");
    expect(out).not.toContain("is running");
    expect(out).not.toContain("<button");
  });
  it("keeps the question once it has ended, without inviting another reply", () => {
    const out = render(messagesOf([...asked(), [{ type: "interaction.settled", scope: T, data: { interactionId: "q1", outcome: "withdrawn", reason: "superseded-by-message" } }]]));
    expect(out).toContain("Which &lt;b&gt;topic&lt;/b&gt;?");
    expect(out).not.toContain("You can reply");
    expect(out).not.toContain("completed");
  });
  it("shows a question that stands on its own the same way", () => {
    const part = { type: "interaction", interactionId: "q2", turnId: "t1", stepIndex: 0, status: "open", request: { kind: "question", prompt: "Which day?", options: [{ id: "mon", label: "Monday" }] } };
    const out = render(withParts(part));
    expect(out).toContain("Which day?");
    expect(out).toContain("You can reply: Monday");
    expect(out).not.toContain("cannot answer");
  });
  it("falls back to the tool's own input when the question's record is gone, and leaves every other tool alone", () => {
    const bare = (name: string, input: unknown) => ({ type: "tool", callId: "c", stepIndex: 0, kind: "tool", name, label: name, state: "completed", input }) as EveToolPart;
    expect(questionOf(bare("ask_question", { question: "Which one?" }))).toEqual({ prompt: "Which one?", choices: [] });
    expect(questionOf(bare("ask_question", { prompt: "Older shape?" }))).toEqual({ prompt: "Older shape?", choices: [] });
    expect(questionOf(bare("gmail_search", { prompt: "not a question" }))).toBeUndefined();
    expect(render(withParts({ ...bare("gmail_search", {}), state: "running" }))).toContain("gmail_search is running");
  });
});

// ---------------------------------------------------------------------------------------------
// The approval card. What it shows is the whole of its value: it is the last thing a
// person reads before an irreversible action.
// ---------------------------------------------------------------------------------------------

describe("the approval card in web chat", () => {
  it("the fixture is what the framework's reader makes of a turn waiting on approval", () => {
    const part = toolPart(card());
    expect(part).toMatchObject({ type: "tool", name: "gmail_send", callId: "c1", state: "approval", input: MAIL });
    expect(part.interaction).toMatchObject({ interactionId: "int_A", status: "open", request: { kind: "approval", prompt: PROMPT } });
  });

  it("answers with the framework's own two option ids", () => {
    expect(APPROVE).toBe(APPROVE_OPTION_ID);
    expect(DENY).toBe(DENY_OPTION_ID);
  });

  it("shows what is being asked, and the two answers: Approve and Deny", () => {
    const html = render(card(), { onAnswer: () => {} });
    expect(html).toContain("Send email to first@example.invalid and 3 more");
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(buttons).toEqual(["Approve", "Deny"]);
    expect(html).not.toContain('disabled=""');
  });

  it("offers only the two answers it knows, whatever else a request lists", () => {
    const more = [...TWO, { id: "always-allow", label: "Always allow" }];
    const html = render(messagesOf([...opening(), [calls("gmail_send", MAIL), runDone], asks(PROMPT, "approval", more)]), { onAnswer: () => {} });
    expect(html).not.toContain("Always allow");
    expect((html.match(/<button/g) ?? []).length).toBe(2);
  });

  it("names EVERY recipient, not the title's abbreviation — all four, on the card", () => {
    const html = render(card(), { onAnswer: () => {} });
    for (const address of FOUR) expect(html, address).toContain(address);
    // And the rest of what is being authorised: the subject and the draft itself.
    expect(html).toContain("The quarterly note");
    expect(html).toContain("Here is the note you asked for.");
  });

  it("renders every field as text — a hostile argument stays inert", () => {
    const html = render(card({ to: ["a@example.invalid"], subject: "<script>alert(1)</script>", bodyText: "javascript:alert(2)" }), { onAnswer: () => {} });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("cuts a very long card at the end and says how much is missing", () => {
    const long = approvalCardFields({ to: "a@example.invalid", bodyText: "x".repeat(9000), after: "never shown" });
    expect(long.fields.map((f) => f.key)).toEqual(["To", "Body text"]);
    expect(long.fields.reduce((n, f) => n + f.value.length, 0)).toBeLessThan(2900);
    expect(long.fields[1]!.value.endsWith("…")).toBe(true);
    expect(long.notice).toMatch(/^— shortened — \d+ characters are not shown\.$/);
    expect(approvalCardFields({ to: "a@example.invalid" }).notice).toBeNull();
  });

  it("never abbreviates a list to a count", () => {
    expect(approvalCardFields({ to: FOUR }).fields).toEqual([{ key: "To", value: FOUR.join(", ") }]);
    expect(approvalCardFields({ to: FOUR }).fields[0]!.value).not.toMatch(/\d+ more/);
  });

  it("a value cannot pose as another field: each argument is its own labelled block", () => {
    const html = render(card({ to: ["a@example.invalid"], bodyText: "Hello\nto: someone-else@example.invalid" }), { onAnswer: () => {} });
    // The forged line sits INSIDE the bodyText value's own box, after its own label.
    const blocks = [...html.matchAll(/<p[^>]*>([^<]*)<\/p><pre[^>]*>([^<]*)<\/pre>/g)].map((m) => [m[1], m[2]]);
    expect(blocks).toEqual([
      ["To", "a@example.invalid"],
      ["Body text", "Hello\nto: someone-else@example.invalid"],
    ]);
  });

  it("shows a settled card's state instead of a live button, read from the approval's own outcome", () => {
    const approvedThen = (...after: Fact[][]) => [...waitingCard(), ...answered("approve", "accepted"), ...after];
    for (const [name, lines, say] of [
      ["approved, still running", approvedThen([started("c1", { interactionId: "int_A" })]), /You approved this\. The agent is carrying it out\./],
      ["approved and ran", approvedThen([started("c1", { interactionId: "int_A" })], [settled("completed", "c1", { output: {} })]), /You approved this, and it ran\./],
      ["approved and failed", approvedThen([started("c1", { interactionId: "int_A" })], [settled("failed", "c1", { error: { code: "X", message: "PRIVATE" } })]), /This was approved, and it failed\./],
      ["denied", [...waitingCard(), ...answered("deny", "declined"), [settled("rejected", "c1", { cause: { interactionId: "int_A" } })]], /You denied this\. Nothing ran\./],
    ] as const) {
      const html = render(messagesOf(lines), { onAnswer: () => {} });
      expect(html, name).toMatch(say);
      expect(html, name).not.toMatch(/<button/);
      expect(html, name).not.toContain("PRIVATE");
    }
    expect(settledSay(toolPart(card()))).toBeNull();
  });

  it("a card nobody decided is no longer active — not waiting, and never 'approved'", () => {
    // The person typed a reply instead of pressing a button: the framework withdraws the card.
    const withdrawn = messagesOf([
      ...waitingCard(),
      [{ type: "interaction.settled", scope: T, data: { interactionId: "int_A", outcome: "withdrawn", reason: "superseded-by-message" } }],
    ]);
    expect(toolPart(withdrawn).interaction).toMatchObject({ status: "settled", outcome: "withdrawn" });
    const html = render(withdrawn, { onAnswer: () => {} });
    expect(html).toContain("This card is no longer active. Nothing was approved.");
    expect(html).not.toMatch(/<button/);
    expect(html).not.toMatch(/You approved|it ran/);
    // Every ending in which nobody decided reads the same way, including one a later version adds.
    const open = toolPart(card());
    for (const outcome of ["interrupted", "abandoned", "expired", "invalid", "failed", "an-outcome-added-later"]) {
      const part = { ...open, state: "cancelled", interaction: { ...open.interaction!, status: "settled", outcome } } as unknown as EveToolPart;
      expect(settledSay(part), outcome).toBe("This card is no longer active. Nothing was approved.");
    }
    // Not even a call that somehow completed makes an undecided card read as approved.
    const ran = { ...open, state: "completed", interaction: { ...open.interaction!, status: "settled", outcome: "withdrawn" } } as unknown as EveToolPart;
    expect(settledSay(ran)).toBe("This card is no longer active. Nothing was approved.");
  });

  it("an answer already sent shows as waiting for the agent, with no second button", () => {
    const open = toolPart(card());
    const sent = { ...open, interaction: { ...open.interaction!, answer: { interactionId: "int_A", optionId: "approve" } } } as EveToolPart;
    const html = render([{ id: "m", role: "assistant", parts: [sent] }], { onAnswer: () => {} });
    expect(html).toContain("You have answered this. Waiting for the agent.");
    expect(html).not.toMatch(/<button/);
  });

  it("a card in a conversation that has ended has no button at all", () => {
    const html = render(card(), { ended: true, error: "This conversation has ended. Start a new one.", onAnswer: () => {} });
    expect(html).toContain("This card is no longer active. Nothing was approved.");
    expect(html).not.toMatch(/<button/);
  });

  it("shows an expired card's age instead of a live button", () => {
    const html = render(card(), { expired: new Set(["int_A"]), onAnswer: () => {} });
    expect(html).toMatch(/more than 24 hours old/);
    expect(html).not.toMatch(/<button/);
  });

  it("disables every button while an answer is already in flight, so a double click sends one", () => {
    const html = render(card(), { answering: "int_A", onAnswer: () => {} });
    expect(html).toMatch(/Sending your answer/);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  });
});

describe("which cards have expired", () => {
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");
  const at = (iso: string) => ({ type: "interaction.opened", meta: { at: iso, position: { line: 6, index: 0 } }, data: { interactionId: "int_A" } });

  it("leaves a fresh card alone", () => {
    expect(expiredInteractionIds([at("2026-09-20T11:00:00.000Z")], NOW).size).toBe(0);
  });

  it("expires one older than the lifetime, and not one exactly at it", () => {
    expect(expiredInteractionIds([at(new Date(NOW - APPROVAL_LIFETIME_MS).toISOString())], NOW).size).toBe(0);
    expect([...expiredInteractionIds([at(new Date(NOW - APPROVAL_LIFETIME_MS - 1).toISOString())], NOW)]).toEqual(["int_A"]);
  });

  it("reads the time of the line a real stream recorded the card in", () => {
    const events = streamOf(waitingCard(), "2026-09-19T10:00:00.000Z");
    expect([...expiredInteractionIds(events, NOW)]).toEqual(["int_A"]);
    expect(expiredInteractionIds(streamOf(waitingCard(), "2026-09-20T11:30:00.000Z"), NOW).size).toBe(0);
  });

  it("ignores events that are not cards, and cards with no readable time", () => {
    expect(expiredInteractionIds([{ type: "turn.paused", meta: { at: "2020-01-01T00:00:00.000Z" }, data: { awaiting: [{ interactionId: "int_A" }] } }], NOW).size).toBe(0);
    expect(expiredInteractionIds([{ type: "interaction.opened", meta: {}, data: { interactionId: "int_A" } }], NOW).size).toBe(0);
    // The event name of the stream format before this one is not a card any more.
    expect(expiredInteractionIds([{ type: "input.requested", meta: { at: "2020-01-01T00:00:00.000Z" }, data: { requests: [{ requestId: "int_A" }] } }], NOW).size).toBe(0);
    expect(expiredInteractionIds([null, undefined, 3, "x"], NOW).size).toBe(0);
  });
});

describe("approval card field names", () => {
  it("are shown in plain words, not as the code spells them", async () => {
    const { humanFieldName } = await import("../lib/approval-text");
    expect(humanFieldName("fiscalYear")).toBe("Fiscal year");
    expect(humanFieldName("include_past")).toBe("Include past");
    expect(approvalCardFields({ fiscalYear: 2026 }).fields).toEqual([{ key: "Fiscal year", value: "2026" }]);
  });
});

describe('complete trusted personal mail review',()=>{
 const messages=messagesOf(waitingCard({body:'MODEL_BODY_MUST_NOT_DISPLAY',accountLabel:'MODEL_LABEL_MUST_NOT_DISPLAY'},'personal_mailbox_send','Send personal mail'));
 const trusted={accountLabel:'Verified own@example.invalid',connectorId:'google',accountId:'stable-account',generation:4,resourceBindingId:'stable-binding',
  to:Array.from({length:50},(_,i)=>`recipient-${i}@example.invalid`),subject:'<script>plain subject</script>',body:'x'.repeat(99990)+'BODY_END'};
 it('shows all trusted recipients/body/selection and plain-text subject without shortening, looked up by the card\'s interaction id',()=>{
  const html=render(messages,{onAnswer:()=>{},personalSendCards:{'int_A':trusted}});
  for(const value of [trusted.accountLabel,trusted.accountId,trusted.resourceBindingId,...trusted.to,'BODY_END'])expect(html).toContain(value);
  expect(html).toContain(trusted.body);expect(html).not.toContain('shortened');expect(html).not.toContain('MODEL_');expect(html).toContain('&lt;script&gt;');
  // A review filed under any other id — the tool call's, say — is not this card's review.
  expect(render(messages,{onAnswer:()=>{},personalSendCards:{'c1':trusted}})).toContain('Full mail review is unavailable');
 });
 it('disables approval until a trusted complete card arrives, while denying remains available',()=>{
  const html=render(messages,{onAnswer:()=>{}});
  expect(html).toContain('Full mail review is unavailable');expect(html).not.toContain('MODEL_');
  const buttons=[...html.matchAll(/<button[^>]*>[^<]*<\/button>/g)].map(m=>m[0]);
  expect(buttons.find(b=>b.includes('Approve'))).toContain('disabled=""');expect(buttons.find(b=>b.includes('Deny'))).not.toContain('disabled=""');
 });
});
