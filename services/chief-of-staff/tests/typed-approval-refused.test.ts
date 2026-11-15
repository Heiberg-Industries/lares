/**
 * Typing "approve" never approves a card, at any door.
 *
 * eve 1.0 accepts typed approvals on purpose: a message whose text is an option's id ("approve"),
 * its label ("Approve") or its number ("1") answers the open approval. Lares does not: a card is
 * approved by its button, in the door or in the console, and by nothing else. A typed word is too
 * easy to produce by accident, by habit, or by text somebody else wrote.
 *
 * The decision is made in ONE place for every door (Slack, Telegram and web chat all hand the
 * typed text to the harness): `resolveTypedApproval` in eve's `harness/hitl/delivery.js`.
 * `patches/eve.patch` makes it return its input unchanged. The same file's `resolveTextInput`
 * serves budget prompts and is left working; the patch adds one guard to it, so that it can never
 * pick an APPROVAL as the request a typed word answers (it could, while a budget prompt had an
 * answer that was not settled yet: the last test in "budget prompts" pins that).
 *
 * WHAT HAPPENS TO THE CARD. On eve 1.0 a follow-up message that answers nothing steers the turn,
 * and steering withdraws every unanswered approval: the card closes as "withdrawn", the call ends
 * "rejected" without running, and the agent reads the typed word as an ordinary message. Under
 * the patch on the previous eve the card stayed live. These tests pin the new behaviour.
 *
 * WHAT IS EXECUTED AND WHAT IS READ. Executed, against the installed (patched) eve:
 * `resolveTypedApproval`, `resolveTextInput`, `admitHumanInput` (the whole intake of one
 * delivery, with a stand-in for the step that only records what is applied), `admitAnswers` and
 * `settleApprovals`. The session view is built by eve's own `askApprovals` and folded from eve's
 * own facts. Read from source, not executed: that `settleHumanInput` hands intake's `steer` to
 * `settleApprovals`, and that the kernel hands intake's result to `settleHumanInput`. Running
 * those needs a compiled agent; the two lines are asserted as text below.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Direct file imports (bypassing the package exports map): these are eve INTERNALS, reached on
// purpose through the aliases in vitest.config.ts. If an eve upgrade moves these files, this
// suite failing to import is the signal to re-derive the patch against the new version.
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { resolveTextInput, resolveTypedApproval } from "eve-internals/hitl-delivery";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { admitHumanInput } from "eve-internals/hitl-intake";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { askApprovals, settleApprovals } from "eve-internals/hitl-approvals";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { approvalOpened, interactionOpened, responseAdmitted, responseSubmitted } from "eve-internals/interaction-facts";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { callRequested } from "eve-internals/call-facts";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { emptySessionView, foldLine } from "eve-internals/session-fold";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { initialSessionProjection } from "eve-internals/session-projection";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { openRequests, promptQueueHead } from "eve-internals/session-reader";

// ── a session with one approval card open, built by eve's own code ──────────────────────────
type Fact = { type: string; data: Record<string, unknown> };
type Answer = { interactionId: string; optionId?: string; text?: string; responseId?: string; deliveryId?: string };
type StepInput = { message?: unknown; answers?: Answer[]; deliveries?: { deliveryId: string }[]; messageConsumed?: boolean } & Record<string, unknown>;

const TURN = "turn_0";
const CARD = "ix_send_mail";
const BUDGET = "session_1:1:limit:usage:0";

/** The request eve builds for a gated call (`approvalRequest` in harness/call-executor.js). */
const approval = {
  call: { callId: "call_1", input: { to: "a@example.com", subject: "Offer", bodyText: "Hello." }, toolName: "gmail_send" },
  interactionId: CARD,
  request: {
    allowFreeform: false,
    display: "confirmation",
    kind: "approval",
    options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
    prompt: "Approve Send email?",
  },
};

/** The budget prompt eve opens at a usage limit (`createSessionLimitContinuationRequest`). */
const budget = {
  interactionId: BUDGET,
  request: {
    allowFreeform: false,
    display: "confirmation",
    kind: "budget",
    options: [
      { description: "Start a new usage window", id: "approve", label: "Approve", style: "primary" },
      { description: "Stop now", id: "deny", label: "Stop", style: "danger" },
    ],
    prompt: "This session has hit its usage limit.",
  },
  subject: { turnId: TURN },
};

interface Harness {
  /** What eve calls the session view: the public tables plus the turn's private state. */
  view(): Record<string, any>;
  /** A stand-in for the running step: applies each transition to the view and records its facts. */
  step: Record<string, any>;
  applied: Fact[];
  fold(...facts: Fact[]): void;
}

function session(opts: { card?: boolean; budget?: boolean } = { card: true }): Harness {
  const table = emptySessionView();
  let position = 0;
  const fold = (...facts: Fact[]) => foldLine(table, { at: "2026-10-14T09:00:00.000Z", facts }, position++);
  fold({ type: "session.started", data: {} });
  fold({ type: "delivery.admitted", data: { deliveryId: "d0" } }, { type: "turn.started", data: { turnId: TURN, cause: { deliveryId: "d0" } } });

  let state: Record<string, any> = {
    projection: { ...initialSessionProjection(), view: table },
    relayedRequestIds: new Set<string>(),
    responders: {},
    signIns: [],
    turn: { remembered: {}, suspended: [] },
  };
  const applied: Fact[] = [];
  const apply = async (t: { events: Fact[]; turn: unknown; responders?: Record<string, unknown> }) => {
    if (t.events.length > 0) fold(...t.events);
    applied.push(...t.events);
    state = { ...state, turn: t.turn, ...(t.responders !== undefined && { responders: { ...state.responders, ...t.responders } }) };
  };

  if (opts.card) {
    fold(callRequested({ action: { callId: "call_1", input: approval.call.input, kind: "tool-call", toolName: "gmail_send" }, owner: { turnId: TURN } }));
    // eve's own transition for "this step asks for approval": it suspends the step and opens the card.
    const asked = askApprovals(state, {
      event: { turnId: TURN },
      messages: [{ content: [{ input: approval.call.input, toolCallId: "call_1", toolName: "gmail_send", type: "tool-call" }], role: "assistant" }],
      requester: null,
      requests: [approval],
      tasks: [],
    });
    fold(...asked.events);
    state = { ...state, turn: asked.turn };
  }
  if (opts.budget) fold(interactionOpened(budget));

  const step = { apply, config: {}, runStep: {}, session: {}, view: () => state };
  return { applied, fold, step, view: () => state };
}

/** A typed message as a door delivers it. Slack sends the bare typed text beside the formatted
 *  turn message (`__eveInputText`); Telegram and web chat send the text as the message. */
const typed = (text: string): StepInput => ({ deliveries: [{ deliveryId: "d1" }], message: text });
const typedThroughSlack = (text: string): StepInput => ({
  __eveInputText: text,
  deliveries: [{ deliveryId: "d1" }],
  message: `<slack_message ts="1.2">${text}</slack_message>`,
});
/** A button press, as a door delivers it once it has resolved its callback. */
const tapped = (optionId: string, interactionId = CARD): StepInput => ({
  answers: [{ deliveryId: "d1", interactionId, optionId, responseId: "response_d1_tap" }],
  deliveries: [{ deliveryId: "d1" }],
});

const settledAs = (facts: Fact[], interactionId: string) =>
  facts.find((f) => f.type === "interaction.settled" && f.data["interactionId"] === interactionId)?.data;

const WORDS = ["approve", "Approve", "APPROVE", " approve ", "yes", "1", "deny", "Deny", "2", "cancel"];

// ── the tests ───────────────────────────────────────────────────────────────────────────────
describe("typed text never answers an approval", () => {
  it("starts from a card that is open and is the request a typed reply would have answered", () => {
    const s = session();
    expect(openRequests(s.view().projection.view).map((r: any) => [r.interactionId, r.request.kind])).toEqual([[CARD, "approval"]]);
    expect(promptQueueHead(s.view().projection.view)?.interactionId).toBe(CARD);
    expect(s.view().turn.suspended).toHaveLength(1);
  });

  it.each(WORDS)("resolveTypedApproval returns %j unchanged: no answer, the message intact", (word) => {
    const s = session();
    for (const input of [typed(word), typedThroughSlack(word)]) {
      const out = resolveTypedApproval(s.view(), input);
      expect(out).toBe(input);
      expect(out.answers).toBeUndefined();
      expect(out.messageConsumed).toBeUndefined();
    }
  });

  it.each(WORDS)("a whole delivery of %j submits no answer and steers the turn", async (word) => {
    for (const input of [typed(word), typedThroughSlack(word)]) {
      const s = session();
      const admitted = await admitHumanInput(s.step, input, { takeQueued: true });
      expect(admitted.kind).toBe("run");
      expect(admitted.consumedMessage).toBe(false);
      expect(admitted.steer).toBe(true);
      expect(admitted.message).toBe(input.message);
      expect(admitted.input?.answers).toBeUndefined();
      expect(s.applied.filter((f) => f.type.startsWith("response."))).toEqual([]);
      // The card is still open after intake: nothing approved it and nothing has withdrawn it yet.
      expect(openRequests(s.view().projection.view).map((r: any) => r.interactionId)).toEqual([CARD]);
    }
  });

  it("the typed word then WITHDRAWS the card: the call is rejected without running", async () => {
    const s = session();
    const admitted = await admitHumanInput(s.step, typed("approve"), { takeQueued: true });
    const settled = settleApprovals(s.view(), { steer: admitted.steer });

    expect(settled.approved).toEqual([]);
    expect(settledAs(settled.events, CARD)).toMatchObject({ outcome: "withdrawn", reason: "superseded-by-message" });
    const call = settled.events.find((f: Fact) => f.type === "call.settled")?.data;
    expect(call).toMatchObject({ callId: "call_1", outcome: "rejected" });
    expect(JSON.stringify(call)).toContain("TOOL_EXECUTION_DENIED");
    // The agent is told the call did not run, in the suspended step's own messages.
    const result = settled.turn.suspended[0].messages.at(-1);
    expect(result.role).toBe("tool");
    expect(result.content[0].output).toEqual({ reason: "Ignored because the user continued without responding.", type: "execution-denied" });
  });

  it("without a steering message the card stays open (nothing settles on its own)", () => {
    const s = session();
    const settled = settleApprovals(s.view(), { steer: false });
    expect(settled.events).toEqual([]);
    expect(settled.approved).toEqual([]);
  });

  it("reads from source: intake's steer reaches settleApprovals, and the kernel runs them in that order", () => {
    const harness = fileURLToPath(new URL("../node_modules/eve/dist/src/harness/", import.meta.url));
    expect(readFileSync(`${harness}hitl/intake.js`, "utf8")).toContain("settleApprovals(e.view(),{steer:t.steer})");
    expect(readFileSync(`${harness}kernel.js`, "utf8")).toMatch(
      /let n=await admitHumanInput\(e,t\.input,\{takeQueued:!t\.waited\}\);if\(n\.kind===`stop`\)return\{ended:n\.result\};let r=await settleHumanInput\(e,n\)/,
    );
  });
});

describe("a button still answers the card", () => {
  it("Approve on the card approves the call", async () => {
    const s = session();
    const admitted = await admitHumanInput(s.step, tapped("approve"), { takeQueued: true });
    expect(admitted.steer).toBe(false);
    expect(s.applied.map((f) => f.type)).toEqual(["response.submitted", "response.admitted"]);

    const settled = settleApprovals(s.view(), { steer: admitted.steer });
    expect(settled.approved.map((a: any) => a.approval.call.callId)).toEqual(["call_1"]);
    expect(settledAs(settled.events, CARD)).toMatchObject({ outcome: "accepted", response: { optionId: "approve" } });
  });

  it("Deny on the card declines it", async () => {
    const s = session();
    const admitted = await admitHumanInput(s.step, tapped("deny"), { takeQueued: true });
    const settled = settleApprovals(s.view(), { steer: admitted.steer });
    expect(settled.approved).toEqual([]);
    expect(settledAs(settled.events, CARD)).toMatchObject({ outcome: "declined" });
  });
});

describe("budget prompts still take typed text", () => {
  it.each([
    ["approve", "approve"],
    ["Approve", "approve"],
    ["1", "approve"],
    ["stop", "deny"],
    ["deny", "deny"],
    ["2", "deny"],
  ])("typed %j answers the budget prompt with %j", (word, optionId) => {
    const s = session({ budget: true });
    const out = resolveTextInput(s.view().projection.view, typed(word));
    expect(out.answers).toEqual([{ deliveryId: "d1", interactionId: BUDGET, optionId, responseId: "response_d1_typed_0" }]);
    expect(out.messageConsumed).toBe(true);
    expect(out.message).toBeUndefined();
  });

  it("a whole delivery of typed \"approve\" answers the budget prompt and consumes the message", async () => {
    const s = session({ budget: true });
    const admitted = await admitHumanInput(s.step, typed("approve"), { takeQueued: true });
    expect(admitted.consumedMessage).toBe(true);
    expect(admitted.steer).toBe(false);
    const submitted = s.applied.find((f) => f.type === "response.submitted")?.data;
    expect(submitted).toMatchObject({ interactionId: BUDGET, value: { optionId: "approve" } });
  });

  it("text that matches no budget option is left as an ordinary message", () => {
    const s = session({ budget: true });
    const input = typed("what happened?");
    expect(resolveTextInput(s.view().projection.view, input)).toBe(input);
  });

  it("with a card AND a budget prompt open, typed \"approve\" answers the budget prompt only", async () => {
    const s = session({ budget: true, card: true });
    const admitted = await admitHumanInput(s.step, typed("approve"), { takeQueued: true });
    const submitted = s.applied.filter((f) => f.type === "response.submitted").map((f) => f.data["interactionId"]);
    expect(submitted).toEqual([BUDGET]);
    // The budget prompt took the message, so nothing steers: the card is neither approved nor withdrawn.
    expect(admitted.steer).toBe(false);
    const settled = settleApprovals(s.view(), { steer: admitted.steer });
    expect(settled.approved).toEqual([]);
    expect(settledAs(settled.events, CARD)).toBeUndefined();
  });

  it("never falls through to the card while the budget prompt's own answer is not settled yet", () => {
    // Unpatched, eve's "first open request" skips a budget prompt that already has an admitted
    // answer, so the next typed word was matched against the card behind it and "approve"
    // approved it. The patch's guard in resolveTextInput refuses an approval there.
    const s = session({ budget: true, card: true });
    s.fold(responseSubmitted({ deliveryId: "d0", interactionId: BUDGET, responseId: "response_d0_tap", value: { optionId: "approve" } }));
    s.fold(responseAdmitted("response_d0_tap"));
    expect(promptQueueHead(s.view().projection.view)?.interactionId).toBe(CARD);

    for (const word of WORDS) {
      const input = typed(word);
      expect(resolveTextInput(s.view().projection.view, input)).toBe(input);
    }
  });
});

describe("the patch is installed, and its one known gap is not reachable", () => {
  it("the installed eve carries both edits of the typed-approval hunk", () => {
    const delivery = readFileSync(fileURLToPath(new URL("../node_modules/eve/dist/src/harness/hitl/delivery.js", import.meta.url)), "utf8");
    expect(delivery).toContain("function resolveTypedApproval(e,t){return t;/* lares: typed text never answers an approval */");
    expect(delivery).toContain("if(i?.request.kind===`approval`)return t;/* lares: typed text never answers an approval */");
  });

  it("no agent declares a subagent (eve answers a SUBAGENT's card from typed text in another file)", () => {
    // eve/dist/src/subagents/hitl-proxy.js matches a typed message against the first request a
    // subagent passed up to its parent, approvals included. patches/eve.patch does not touch that
    // file: no Lares agent has subagents, so nothing is ever passed up. The day an agent or a role
    // template gains `agent/subagents/`, this fails, and the patch needs a fourth edit first.
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const roots = [
      ...readdirSync(`${repo}services`).map((name) => `${repo}services/${name}/agent/subagents`),
      ...readdirSync(`${repo}packages/agent-kit/templates`).map((name) => `${repo}packages/agent-kit/templates/${name}/agent/subagents`),
    ];
    expect(roots.filter((dir) => existsSync(dir))).toEqual([]);
  });
});
