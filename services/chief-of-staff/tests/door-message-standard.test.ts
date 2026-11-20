/**
 * The door message standard (docs/door-messages.md), run against both doors.
 *
 * The same fixture goes into the Slack card renderer (the kit's, run through eve's own card
 * pipeline) and into the Telegram card (eve's channel, patched), and the facts the standard
 * requires must come out of both. A door that drops one fails here. The widgets may differ; the
 * facts, the wording of the fixed sentences and the buttons may not.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { SlackInteractionCard, SlackInteractionCardParts } from "eve/channels/slack";

import {
  approvalCardShape,
  mrkdwnToPlain,
  registerApprovalSummary,
  summarizeApproval,
} from "@lares/agent-kit/approval-summary";
import { CARD_OUTCOME_TEXT } from "@lares/agent-kit/card-sentences";
import { respondToTurnFailed, SPENDING_CAP_REFUSED_TEXT } from "@lares/agent-kit/gateway-budget";
import { mdToTelegramHtml, splitTelegramHtml } from "@lares/agent-kit/telegram-markdown";
import { approvalCardRenderer, installSlackCardHook } from "@lares/agent-kit/slack-approval-card";

import { renderRequestCard } from "../node_modules/eve/dist/src/public/channels/slack/request-card-render.js";
import { composeInteractionCards } from "../node_modules/eve/dist/src/public/channels/slack/renderers.js";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { renderTelegramInteraction } from "eve-internals/telegram-hitl";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { approvalOpened } from "eve-internals/interaction-facts";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { callRequested } from "eve-internals/call-facts";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { emptySessionView, foldLine } from "eve-internals/session-fold";
// @ts-expect-error — deep import into eve's dist, no types shipped for internals
import { interaction as interactionOf } from "eve-internals/session-reader";

installSlackCardHook();
registerApprovalSummary();
const chain = composeInteractionCards([approvalCardRenderer]);

type Interaction = SlackInteractionCard["interaction"];

// ── The two doors, given one request ────────────────────────────────────────────────────

const OPTIONS = [
  { id: "approve", label: "Approve", style: "primary" },
  { id: "deny", label: "Deny" },
];

function slackCard(toolName: string, input: unknown, over: Record<string, unknown> = {}, answeredBy?: string) {
  const i = {
    interactionId: "ix_1", turnId: "turn_0", stepIndex: 0, status: "open",
    call: { callId: "call_1", name: toolName, input },
    request: { kind: "approval", prompt: summarizeApproval(toolName, input) ?? `Approve ${toolName}`, options: OPTIONS },
    ...over,
  } as unknown as Interaction;
  const card = { interaction: i, destination: "thread", audience: "private", view: {}, ...(answeredBy ? { answeredBy } : {}) } as unknown as SlackInteractionCard;
  const { parts } = renderRequestCard(chain, card, undefined) as { parts: SlackInteractionCardParts };
  const blocks = parts.controls.blocks as unknown as Array<Record<string, any>>;
  const cardBlock = blocks.find((b) => b.type === "card");
  return {
    title: String(cardBlock?.body?.text ?? ""),
    // What Slack shows once mrkdwn is read back to the characters typed.
    body: blocks.filter((b) => b.type === "section").map((b) => mrkdwnToPlain(String(b.text.text))).join("\n"),
    outcomeLine: String(cardBlock?.subtext?.text ?? ""),
    buttons: ((cardBlock?.actions ?? []) as Array<{ value: string }>).map((a) => a.value),
  };
}

function telegramCard(toolName: string, input: unknown) {
  const view = emptySessionView();
  let position = 0;
  const fold = (...facts: unknown[]) => foldLine(view, { at: "2026-11-20T09:00:00.000Z", facts }, position++);
  fold({ type: "session.started", data: {} });
  fold({ type: "delivery.admitted", data: { deliveryId: "d0" } }, { type: "turn.started", data: { turnId: "turn_0", cause: { deliveryId: "d0" } } });
  fold(callRequested({ action: { callId: "call_1", input, kind: "tool-call", toolName }, owner: { turnId: "turn_0" } }));
  fold(approvalOpened({
    call: { callId: "call_1", input, toolName }, interactionId: "ix_1",
    request: { allowFreeform: false, display: "confirmation", kind: "approval", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }], prompt: summarizeApproval(toolName, input) ?? `Approve ${toolName}` },
  }));
  const state: { hitlCallbacks?: Record<string, { optionId: string }> } = {};
  const card = renderTelegramInteraction(interactionOf(view, "ix_1"), state) as { text: string; replyMarkup: { inline_keyboard: Array<Array<{ callback_data: string; text: string }>> } };
  return {
    text: card.text,
    buttons: card.replyMarkup.inline_keyboard.flat().map((b) => state.hitlCallbacks![b.callback_data]!.optionId),
  };
}

afterEach(() => undefined);

// ── Fixtures: one per kind of card ──────────────────────────────────────────────────────

const DRAFT = { to: ["sam@example.com"], subject: "Smith & Sons: the offer", bodyText: "Hello Sam,\n\nThe price is 4 200 <net>.\n\nBest" };
const SEND = { to: ["sam@example.com"], subject: "Notes from today", bodyText: "Thanks for the meeting." };
const CALENDAR = { summary: "Planning", start: "2026-12-01T09:00:00+01:00", end: "2026-12-01T10:00:00+01:00", attendees: ["sam@example.com"], notify: true };

/** Every fact a card must carry, whatever the door. */
const FACTS: Array<{ kind: string; tool: string; input: unknown; facts: string[] }> = [
  { kind: "draft", tool: "gmail_draft", input: DRAFT, facts: ["sam@example.com", "Smith & Sons: the offer", "The price is 4 200 <net>.", "Best"] },
  { kind: "send", tool: "gmail_send", input: SEND, facts: ["sam@example.com", "Notes from today", "Thanks for the meeting."] },
  { kind: "calendar change", tool: "calendar_create_event", input: CALENDAR, facts: ["Planning", "sam@example.com"] },
];

describe("an approval card carries the same facts and decisions on every door", () => {
  for (const { kind, tool, input, facts } of FACTS) {
    it(`${kind}: title, every detail, and the buttons Deny then Approve`, () => {
      const slack = slackCard(tool, input);
      const telegram = telegramCard(tool, input);
      const title = summarizeApproval(tool, input)!;
      expect(title).toBeTruthy();

      // The title is the kit's, word for word, on both.
      expect(telegram.text.startsWith(title)).toBe(true);
      expect(mrkdwnToPlain(slack.title).replace(/^\*|\*$/g, "")).toBe(title);

      // The exact change: every fact is on both doors.
      for (const fact of facts) {
        expect(mrkdwnToPlain(slack.title) + "\n" + slack.body, `Slack drops "${fact}"`).toContain(fact);
        expect(telegram.text, `Telegram drops "${fact}"`).toContain(fact);
      }

      // The same decisions, in the same order.
      expect(slack.buttons).toEqual(["deny", "approve"]);
      expect(telegram.buttons).toEqual(["deny", "approve"]);
    });
  }

  // KNOWN GAP (docs/door-messages.md, "Gaps"). The mail title says "and 1 more (shortened)" for two
  // recipients, and Telegram takes Approve off any card whose text says "shortened", although the
  // details under the title name every recipient. Slack offers Approve. When this is fixed this
  // test starts failing: delete `.fails` and the gap entry.
  it.fails("a mail to two people can be approved on Telegram, as it can on Slack", () => {
    const two = { ...SEND, to: ["sam@example.com", "kim@example.com"] };
    expect(slackCard("gmail_send", two).buttons).toEqual(["deny", "approve"]);
    expect(telegramCard("gmail_send", two).buttons).toEqual(["deny", "approve"]);
  });

  it("neither door shows markup characters as typed: no label asterisks, no entities", () => {
    const telegram = telegramCard("gmail_draft", DRAFT);
    expect(telegram.text).not.toMatch(/\*[A-Za-z ]+:\*/);
    expect(telegram.text).not.toMatch(/&(amp|lt|gt);/);
  });
});

describe("a card too long for a door never offers Approve on that door", () => {
  const LONG = { to: ["sam@example.com"], subject: "Long", bodyText: `${"A long paragraph of the draft. ".repeat(250)}THE LAST LINE` };

  it("Telegram cuts it, says so, and offers only Deny", () => {
    const telegram = telegramCard("gmail_draft", LONG);
    expect(telegram.text).toMatch(/shortened|truncated/);
    expect(telegram.buttons).toEqual(["deny"]);
  });

  it("Slack shows it whole, to the last line, with Approve", () => {
    const slack = slackCard("gmail_draft", LONG);
    expect(slack.body).toContain("THE LAST LINE");
    expect(slack.buttons).toEqual(["deny", "approve"]);
  });

  it("the shape the doors share says the body is whole, and the short form admits the cut", () => {
    const shape = approvalCardShape("gmail_draft", LONG);
    expect(shape.body.map((p) => p.text).join("")).toContain("THE LAST LINE");
    expect(shape.shortDetails).toMatch(/shortened/);
  });
});

describe("a settled card says how it ended in the same words on every door", () => {
  const outcomes = [
    ["accepted", CARD_OUTCOME_TEXT.approved],
    ["declined", CARD_OUTCOME_TEXT.denied],
    ["withdrawn", CARD_OUTCOME_TEXT.notApproved],
    ["interrupted", CARD_OUTCOME_TEXT.notApproved],
  ] as const;
  for (const [outcome, line] of outcomes) {
    it(`${outcome}: "${line}", no buttons, the change still on screen`, () => {
      const slack = slackCard("gmail_draft", DRAFT, { status: "settled", outcome }, "U-EXAMPLE");
      expect(slack.outcomeLine.startsWith(line)).toBe(true);
      expect(slack.buttons).toEqual([]);
      expect(slack.body).toContain("The price is 4 200 <net>.");
    });
  }

  it("Slack names who answered, and not when nobody did", () => {
    expect(slackCard("gmail_draft", DRAFT, { status: "settled", outcome: "accepted" }, "U-EXAMPLE").outcomeLine).toBe(`${CARD_OUTCOME_TEXT.approved} by <@U-EXAMPLE>`);
    expect(slackCard("gmail_draft", DRAFT, { status: "settled", outcome: "withdrawn" }, "U-EXAMPLE").outcomeLine).toBe(CARD_OUTCOME_TEXT.notApproved);
  });

  it("Telegram's line is the same constant (its own handler is tested in telegram-approval-card.test.ts)", () => {
    expect(CARD_OUTCOME_TEXT.approved).toBe("✅ Approved");
    expect(CARD_OUTCOME_TEXT.denied).toBe("✖ Denied");
  });
});

describe("an error or refusal is the same sentence on every door", () => {
  const capped = { outcome: "failed", error: { code: "model_call_failed", message: "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01" } };
  it("the spending cap is one sentence", () => {
    const slack = respondToTurnFailed(capped as never, { refusalText: SPENDING_CAP_REFUSED_TEXT, dialect: "slack" });
    const telegram = respondToTurnFailed(capped as never, { refusalText: SPENDING_CAP_REFUSED_TEXT, dialect: "telegram" });
    expect(slack).toEqual(telegram);
    expect(slack.kind).toBe("budget-refusal");
    expect(slack.text).toContain("nothing was done");
  });

  it("a failure with no special sentence names what happened and offers a retry, on both", () => {
    const failed = { outcome: "failed", error: { code: "unknown", message: "boom" } };
    for (const dialect of ["slack", "telegram"] as const) {
      const r = respondToTurnFailed(failed as never, { refusalText: SPENDING_CAP_REFUSED_TEXT, dialect });
      expect(r.kind).toBe("default");
      expect(r.text.length).toBeGreaterThan(10);
    }
  });
});

describe("a plain reply keeps its words on Telegram, whatever it is split into", () => {
  it("bold, links and bullets render; a long answer is split on lines and loses nothing", () => {
    const long = Array.from({ length: 400 }, (_, i) => `- **Item ${i}** is [here](https://example.com/${i})`).join("\n");
    const chunks = splitTelegramHtml(mdToTelegramHtml(long));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3800);
      expect(c).not.toContain("**");
    }
    const joined = chunks.join("\n");
    for (const i of [0, 199, 399]) expect(joined).toContain(`<b>Item ${i}</b>`);
  });
});
