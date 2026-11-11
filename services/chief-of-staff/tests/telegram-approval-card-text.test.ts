/**
 * The Telegram approval card: what it says, which buttons it has, and when Approve is missing.
 *
 * eve 1.0 renders a Telegram request as its prompt alone, with the options in their own order:
 * [Approve][Deny]. `patches/eve.patch` changes `renderTelegramInteraction`
 * (eve/dist/src/public/channels/telegram/hitl.js) for APPROVAL requests only:
 *
 *   - the text is the prompt, a blank line, then the draft being approved, from
 *     `globalThis.__eveApprovalDetails(toolName, input)` (installed by `registerApprovalSummary`);
 *   - the buttons are Deny, then Approve: the safe answer sits where a thumb lands first;
 *   - a card that does not show the whole draft has NO Approve button, and no Approve callback is
 *     stored for it. Nobody approves what they could not read; Deny still works. "Does not show
 *     the whole draft" means either of: the text passed Telegram's limit and was cut here (it then
 *     ends with `…(truncated)`), or the title or the details already say they were shortened
 *     (`@lares/agent-kit/approval-summary` cuts a long draft itself, well under Telegram's limit,
 *     and says so);
 *   - a details function that throws, or returns nothing usable, leaves eve's own prompt and both
 *     buttons. A broken formatter must not take the card with it.
 *
 * Questions and budget prompts are rendered exactly as eve renders them.
 *
 * This is the only place the Telegram card is shaped: the door posts what this returns.
 */
import { describe, it, expect, afterEach } from "vitest";

// Direct file imports (bypassing the package exports map): eve INTERNALS, reached on purpose
// through the aliases in vitest.config.ts. A failing import after an eve upgrade is the signal to
// re-derive the patch.
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { renderTelegramInteraction, resolveTelegramAnswers, telegramCallbackAnswer } from "eve-internals/telegram-hitl";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { approvalOpened } from "eve-internals/interaction-facts";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { callRequested } from "eve-internals/call-facts";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { emptySessionView, foldLine } from "eve-internals/session-fold";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { interaction } from "eve-internals/session-reader";

import {
  DETAILS_MAX_LENGTH,
  DETAILS_VALUES_SHORTENED,
  SUMMARY_SHORTENED,
  detailsForApproval,
  registerApprovalSummary,
  shortenedNotice,
  summarizeApproval,
} from "@lares/agent-kit/approval-summary";

const TELEGRAM_LIMIT = 4000;
const TRUNCATED = "…(truncated)";

type Button = { callback_data: string; text: string };
type Card = { text: string; replyMarkup: { inline_keyboard: Button[][] }; freeformRequestId?: string };
type State = { hitlCallbacks?: Record<string, { interactionId: string; optionId: string }>; nextHitlCallbackId?: number };

/**
 * The request as the Telegram door receives it: eve's own `interaction(view, id)` over a session
 * folded from eve's own facts, so the place the tool name and input live is eve's, not a guess.
 */
function approvalCard(toolName: string, input: Record<string, unknown>, prompt = "Approve Send email?") {
  const view = emptySessionView();
  let position = 0;
  const fold = (...facts: unknown[]) => foldLine(view, { at: "2026-10-14T09:00:00.000Z", facts }, position++);
  fold({ type: "session.started", data: {} });
  fold({ type: "delivery.admitted", data: { deliveryId: "d0" } }, { type: "turn.started", data: { turnId: "turn_0", cause: { deliveryId: "d0" } } });
  fold(callRequested({ action: { callId: "call_1", input, kind: "tool-call", toolName }, owner: { turnId: "turn_0" } }));
  fold(
    approvalOpened({
      call: { callId: "call_1", input, toolName },
      interactionId: "ix_1",
      request: {
        allowFreeform: false,
        display: "confirmation",
        kind: "approval",
        options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }],
        prompt,
      },
    }),
  );
  return interaction(view, "ix_1");
}

const render = (request: unknown, state: State = {}): { card: Card; state: State } => ({ card: renderTelegramInteraction(request, state), state });
const buttons = (card: Card) => card.replyMarkup.inline_keyboard.flat();
/** The option each button answers with, resolved the way the door resolves a tap. */
const optionIds = (card: Card, state: State) =>
  buttons(card).map((b) => resolveTelegramAnswers(state, [telegramCallbackAnswer(b.callback_data)])[0]?.optionId);

const saved = globalThis.__eveApprovalDetails;
afterEach(() => {
  globalThis.__eveApprovalDetails = saved;
});

const mail = (bodyText: string) => ({ to: "a@example.com", subject: "The offer", bodyText });

describe("the Telegram approval card", () => {
  it("is handed the tool name and input by eve where the patch reads them", () => {
    const request = approvalCard("gmail_send", mail("Hello."));
    expect(request.call).toEqual({ callId: "call_1", input: mail("Hello."), name: "gmail_send" });
    expect(request.request.kind).toBe("approval");
  });

  it("holds the title, then the draft: subject and body", () => {
    registerApprovalSummary();
    const request = approvalCard("gmail_send", mail("Hello,\nthe price is 4 200."));
    const details = detailsForApproval("gmail_send", mail("Hello,\nthe price is 4 200."));
    expect(details).toContain("The offer");
    expect(details).toContain("the price is 4 200.");

    const { card } = render(request);
    expect(card.text).toBe(`Approve Send email?\n\n${details}`);
    expect(card.freeformRequestId).toBeUndefined();
  });

  it("has two buttons, Deny then Approve, answering deny and approve", () => {
    registerApprovalSummary();
    const { card, state } = render(approvalCard("gmail_send", mail("Hello.")));
    expect(card.replyMarkup.inline_keyboard).toHaveLength(1);
    expect(buttons(card).map((b) => b.text)).toEqual(["Deny", "Approve"]);
    expect(optionIds(card, state)).toEqual(["deny", "approve"]);
    expect(Object.values(state.hitlCallbacks ?? {}).map((c) => c.interactionId)).toEqual(["ix_1", "ix_1"]);
  });

  it("passes the tool's name and input to the details function", () => {
    const seen: unknown[][] = [];
    globalThis.__eveApprovalDetails = (toolName, input) => (seen.push([toolName, input]), "DETAILS");
    const { card } = render(approvalCard("gmail_send", mail("Hello.")));
    expect(seen).toEqual([["gmail_send", mail("Hello.")]]);
    expect(card.text).toBe("Approve Send email?\n\nDETAILS");
  });
});

describe("a card that was cut cannot be approved", () => {
  it("a draft over Telegram's limit ends with …(truncated) and has no Approve button", () => {
    const draft = `${"A long paragraph of the draft. ".repeat(200)}THE LAST LINE`;
    expect(draft.length).toBeGreaterThan(TELEGRAM_LIMIT);
    globalThis.__eveApprovalDetails = () => draft;

    const { card, state } = render(approvalCard("gmail_send", mail("x")));
    expect(card.text.endsWith(TRUNCATED)).toBe(true);
    expect(card.text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(card.text.startsWith("Approve Send email?\n\nA long paragraph")).toBe(true);
    expect(card.text).not.toContain("THE LAST LINE");

    expect(buttons(card).map((b) => b.text)).toEqual(["Deny"]);
    expect(optionIds(card, state)).toEqual(["deny"]);
    // No Approve callback exists for this card at all: an old keyboard or a forged tap has nothing to resolve to.
    expect(Object.values(state.hitlCallbacks ?? {}).some((c) => c.optionId === "approve")).toBe(false);
  });

  it("a text of exactly the limit is whole and keeps Approve; one character more is cut", () => {
    const title = "Approve Send email?";
    const fits = "x".repeat(TELEGRAM_LIMIT - title.length - 2);
    globalThis.__eveApprovalDetails = () => fits;
    const whole = render(approvalCard("gmail_send", mail("x")));
    expect(whole.card.text).toBe(`${title}\n\n${fits}`);
    expect(whole.card.text).toHaveLength(TELEGRAM_LIMIT);
    expect(buttons(whole.card).map((b) => b.text)).toEqual(["Deny", "Approve"]);

    globalThis.__eveApprovalDetails = () => `${fits}y`;
    const cut = render(approvalCard("gmail_send", mail("x")));
    expect(cut.card.text.endsWith(TRUNCATED)).toBe(true);
    expect(cut.card.text).toHaveLength(TELEGRAM_LIMIT);
    expect(buttons(cut.card).map((b) => b.text)).toEqual(["Deny"]);
  });

  it("a title alone over the limit is cut the same way, with no details at all", () => {
    globalThis.__eveApprovalDetails = () => undefined;
    const { card } = render(approvalCard("gmail_send", mail("x"), `Approve ${"very ".repeat(1000)}long title?`));
    expect(card.text.endsWith(TRUNCATED)).toBe(true);
    expect(buttons(card).map((b) => b.text)).toEqual(["Deny"]);
  });

  it("a draft the approval summary shortened itself has no Approve button, though it fits Telegram", () => {
    registerApprovalSummary();
    const body = `${"A sentence of the letter. ".repeat(200)}THE LAST LINE`;
    const details = detailsForApproval("gmail_send", mail(body)) ?? "";
    // The summary's own cut, far below Telegram's limit, admitted in its own words.
    expect(details.length).toBeLessThanOrEqual(DETAILS_MAX_LENGTH);
    expect(details).toContain("— shortened —");
    expect(details).not.toContain("THE LAST LINE");

    const { card, state } = render(approvalCard("gmail_send", mail(body)));
    expect(card.text).toBe(`Approve Send email?\n\n${details}`);
    expect(card.text.length).toBeLessThan(TELEGRAM_LIMIT);
    expect(buttons(card).map((b) => b.text)).toEqual(["Deny"]);
    expect(optionIds(card, state)).toEqual(["deny"]);
  });

  it("every wording the summary uses for \"shortened\" removes Approve", () => {
    for (const details of [`Subject: x${shortenedNotice(1200)}`, `To: a very long address…${DETAILS_VALUES_SHORTENED}`]) {
      globalThis.__eveApprovalDetails = () => details;
      const { card } = render(approvalCard("gmail_send", mail("x")));
      expect(buttons(card).map((b) => b.text), details).toEqual(["Deny"]);
    }
    // A title that left something out says so too (`SUMMARY_SHORTENED`, and the outside-tool title's "(shortened, …").
    globalThis.__eveApprovalDetails = () => undefined;
    for (const title of [`Send email to 14 people${SUMMARY_SHORTENED}`, "Run crm__update (shortened, 3 more fields)"]) {
      const { card } = render(approvalCard("gmail_send", mail("x"), title));
      expect(card.text).toBe(title);
      expect(buttons(card).map((b) => b.text), title).toEqual(["Deny"]);
    }
  });

  it("the summary's real shortened title for a long recipient list removes Approve", () => {
    const input = { to: Array.from({ length: 30 }, (_, i) => `person-${i}@example.com`), subject: "s", bodyText: "b" };
    const title = summarizeApproval("gmail_send", input) ?? "";
    // Only meaningful while the summary shortens this title; if it stops, this case proves nothing.
    expect(title).toContain("(shortened");
    globalThis.__eveApprovalDetails = () => undefined;
    const { card } = render(approvalCard("gmail_send", input, title));
    expect(buttons(card).map((b) => b.text)).toEqual(["Deny"]);
  });
});

describe("a broken or absent details function never breaks the card", () => {
  it("a throwing details function gives the title alone, with both buttons", () => {
    globalThis.__eveApprovalDetails = () => {
      throw new Error("formatter crashed");
    };
    const { card } = render(approvalCard("gmail_send", mail("Hello.")));
    expect(card.text).toBe("Approve Send email?");
    expect(buttons(card).map((b) => b.text)).toEqual(["Deny", "Approve"]);
  });

  it.each([[undefined], [null], [""], ["   "], [42], [{ text: "x" }]])("a details result of %j gives the title alone, with both buttons", (result) => {
    globalThis.__eveApprovalDetails = (() => result) as never;
    const { card } = render(approvalCard("gmail_send", mail("Hello.")));
    expect(card.text).toBe("Approve Send email?");
    expect(buttons(card).map((b) => b.text)).toEqual(["Deny", "Approve"]);
  });

  it("with no details function installed, the card is eve's prompt with both buttons", () => {
    globalThis.__eveApprovalDetails = undefined;
    const { card } = render(approvalCard("gmail_send", mail("Hello.")));
    expect(card.text).toBe("Approve Send email?");
    expect(buttons(card).map((b) => b.text)).toEqual(["Deny", "Approve"]);
  });

  it("a tool the summary has no details for gives eve's prompt and both buttons", () => {
    registerApprovalSummary();
    expect(detailsForApproval("reminder_cancel", { id: "r1" })).toBeUndefined();
    const { card, state } = render(approvalCard("reminder_cancel", { id: "r1" }, "Approve Cancel reminder?"));
    expect(card.text).toBe("Approve Cancel reminder?");
    expect(buttons(card).map((b) => b.text)).toEqual(["Deny", "Approve"]);
    expect(optionIds(card, state)).toEqual(["deny", "approve"]);
  });
});

describe("requests that are not approvals are rendered as eve renders them", () => {
  const question = (kind: string) => ({
    interactionId: "ix_q",
    request: { kind, options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Stop" }], prompt: "Keep going?" },
  });

  it.each(["budget", "question"])("a %s prompt keeps its own order and never reads the details function", (kind) => {
    let called = false;
    globalThis.__eveApprovalDetails = () => ((called = true), "DETAILS — shortened —");
    const { card, state } = render(question(kind));
    expect(card.text).toBe("Keep going?");
    expect(buttons(card).map((b) => b.text)).toEqual(["Approve", "Stop"]);
    expect(optionIds(card, state)).toEqual(["approve", "deny"]);
    expect(called).toBe(false);
  });

  it("a question without options is still a typed reply", () => {
    const card = renderTelegramInteraction({ interactionId: "ix_f", request: { kind: "question", prompt: "Which city?" } }, {});
    expect(card.freeformRequestId).toBe("ix_f");
    expect(card.text).toBe("Which city?");
  });
});
