import { describe, it, expect, afterEach, vi } from "vitest";
import type { SlackInteractionCard, SlackInteractionCardParts } from "eve/channels/slack";

import {
  registerOutsideConnections,
  resetOutsideConnectionsForTests,
  summarizeApproval,
} from "@lares/agent-kit/approval-summary";

// Two eve INTERNALS, reached on purpose and by file path (the package's exports map does not
// offer them, and this suite adds no alias to vitest.config.ts):
//
//  - `renderRequestCard` is how eve runs a door's `interactionCard` renderers: it renders its
//    own default card, runs the renderer chain around it, and THROWS THE RESULT AWAY in favour of
//    its default when the result breaks eve's rules for a card (the controls must be exactly
//    eve's while the request is open, and none once it is answered). Testing through it means
//    "eve accepts this card" is asserted, not assumed.
//  - `composeInteractionCards` builds that chain from a door's `renderers`.
//
// If an eve upgrade moves either file, this suite failing to import is the signal to re-read how
// eve renders an approval card.
import { renderRequestCard } from "../node_modules/eve/dist/src/public/channels/slack/request-card-render.js";
import { composeInteractionCards } from "../node_modules/eve/dist/src/public/channels/slack/renderers.js";

import { approvalCardRenderer, approvalInteractionCard } from "../lib/slack-approval-card.js";

/**
 * What the owner reads on a Slack approval card (`lib/slack-approval-card.ts`).
 *
 * On eve 0.60 this file pinned hunks of a framework patch. eve 1.0 has a supported seam for the
 * same thing, `renderers.interactionCard`, so the card is now Lares's own renderer around eve's
 * default, and this file tests that renderer against the installed eve.
 *
 * The Telegram cases that used to live here are gone: the framework-patch packet tests the
 * Telegram card.
 */

type Block = Record<string, unknown> & { type: string };
type Interaction = SlackInteractionCard["interaction"];

const chain = composeInteractionCards([approvalCardRenderer]);

/** An approval for one tool call, as eve hands it to a renderer. */
function approval(toolName: string, input: unknown, over: Partial<Interaction> = {}): Interaction {
  return {
    interactionId: "interaction-1",
    turnId: "turn-1",
    stepIndex: 0,
    status: "open",
    call: { callId: "call-1", name: toolName, input: input as never },
    request: {
      kind: "approval",
      // The title is the approvals packet's; a card is rendered with whatever title it is given.
      prompt: summarizeApproval(toolName, input) ?? `Approve tool call: ${toolName}`,
      options: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny" },
      ],
    },
    ...over,
  } as Interaction;
}

function cardFor(interaction: Interaction, answeredBy?: string): SlackInteractionCard {
  return {
    interaction,
    destination: "thread",
    audience: "private",
    view: {} as never,
    ...(answeredBy === undefined ? {} : { answeredBy }),
  } as SlackInteractionCard;
}

/** Render the way eve does: `parts` is what gets posted, `fallback` is eve's own default. */
function render(interaction: Interaction, answeredBy?: string): { parts: SlackInteractionCardParts; fallback: SlackInteractionCardParts } {
  return renderRequestCard(chain, cardFor(interaction, answeredBy), undefined) as never;
}

const blocksOf = (parts: SlackInteractionCardParts) => parts.controls.blocks as readonly Block[];
const text = (value: unknown) => JSON.stringify(value);

/** The labels and values of eve's buttons, in the order shown. */
function buttons(parts: SlackInteractionCardParts): { label: string; value: string }[] {
  const card = blocksOf(parts).find((b) => b.type === "card") as { actions?: { text: { text: string }; value: string }[] } | undefined;
  return (card?.actions ?? []).map((a) => ({ label: a.text.text, value: a.value }));
}

const MAIL = {
  to: ["taylor@example.com", "sam@example.com"],
  subject: "Notes from the weekly sync",
  bodyText: "Hello both,\n\nThanks for the meeting today.\n\nBest\nOwner",
};

const settled = (outcome: "accepted" | "declined" | "withdrawn", optionId?: string): Partial<Interaction> => ({
  status: "settled",
  outcome,
  ...(optionId === undefined ? {} : { answer: { interactionId: "interaction-1", optionId } }),
} as Partial<Interaction>);

afterEach(() => {
  resetOutsideConnectionsForTests();
  vi.restoreAllMocks();
});

describe("an email approval card", () => {
  it("shows the subject and body, no raw JSON, and the buttons Deny and Approve", () => {
    const { parts, fallback } = render(approval("gmail_send", MAIL));

    // eve kept our card rather than falling back to its own.
    expect(text(parts)).not.toBe(text(fallback));

    const blocks = blocksOf(parts);
    expect(blocks.map((b) => b.type)).toEqual(["card", "section"]);
    const draft = (blocks[1] as unknown as { text: { type: string; text: string } }).text;
    expect(draft.type).toBe("mrkdwn");
    expect(draft.text).toContain("*To:* taylor@example.com, sam@example.com");
    expect(draft.text).toContain("*Subject:* Notes from the weekly sync");
    expect(draft.text).toContain("Thanks for the meeting today.");

    expect(buttons(parts)).toEqual([
      { label: "Deny", value: "deny" },
      { label: "Approve", value: "approve" },
    ]);

    // The raw arguments are gone: no separate "Tool input" message, no code block, no JSON keys.
    expect(parts.details).toBeUndefined();
    expect(text(parts)).not.toContain("Tool input");
    expect(text(parts)).not.toContain("```");
    expect(text(parts)).not.toContain("bodyText");
    // eve's default, which this replaces, did carry them.
    expect(text(fallback.details)).toContain("bodyText");
  });

  it("leaves eve's buttons exactly as eve rendered them", () => {
    const { parts, fallback } = render(approval("gmail_send", MAIL));
    expect(blocksOf(parts)[0]).toEqual(fallback.controls.blocks[0]);
  });

  it("carries the draft in the notification text too, so a preview is not the title alone", () => {
    const { parts } = render(approval("gmail_send", MAIL));
    expect(parts.controls.text).toContain("Notes from the weekly sync");
    expect(parts.controls.text).toContain("Thanks for the meeting today.");
  });

  it.each([
    ["approved", settled("accepted", "approve"), "Approve"],
    ["denied", settled("declined", "deny"), "Deny"],
    ["ended without an answer", settled("withdrawn"), "No longer needed"],
  ] as const)("still shows the subject and body after it is %s", (_name, ending, label) => {
    const { parts, fallback } = render(approval("gmail_send", MAIL, ending), "U0000000000");

    expect(text(parts)).not.toBe(text(fallback));
    const blocks = blocksOf(parts);
    expect(blocks.map((b) => b.type)).toEqual(["card", "section"]);
    expect(text(blocks[1])).toContain("*Subject:* Notes from the weekly sync");
    expect(text(blocks[1])).toContain("Thanks for the meeting today.");
    // The card says how it ended, and its buttons are gone.
    expect(text(blocks[0])).toContain(label);
    expect(buttons(parts)).toEqual([]);
    expect(text(parts)).not.toContain("eve_input:");
    // Nothing was moved to a message eve would delete.
    expect(parts.details).toBeUndefined();
  });

  it("shows text that looks like Slack markup as it was typed, never as a mention or a link", () => {
    const { parts } = render(approval("gmail_send", {
      ...MAIL,
      subject: "<!channel> urgent",
      bodyText: "Click <https://example.com/x|here> & reply",
    }));
    const draft = text(blocksOf(parts)[1]);
    expect(draft).toContain("&lt;!channel&gt; urgent");
    expect(draft).toContain("&lt;https://example.com/x|here&gt; &amp; reply");
    expect(draft).not.toContain("<!channel>");
  });

  it("cuts a very long body under Slack's limit and says that it did", () => {
    const { parts } = render(approval("gmail_send", { ...MAIL, bodyText: "x".repeat(5_000) }));
    const draft = (blocksOf(parts)[1] as unknown as { text: { text: string } }).text.text;
    expect(draft.length).toBeLessThanOrEqual(3_000);
    expect(draft).toMatch(/shortened — \d+ characters are not shown\.$/);
  });

  it("the other mail tools get the same card", () => {
    for (const tool of ["gmail_draft", "meeting_followup_send"]) {
      const { parts } = render(approval(tool, { ...MAIL, notionPageId: "p1", seriesKey: "s1", meetingTitle: "Weekly sync" }));
      expect(blocksOf(parts).map((b) => b.type), tool).toEqual(["card", "section"]);
      expect(text(blocksOf(parts)[1]), tool).toContain("Thanks for the meeting today.");
      expect(parts.details, tool).toBeUndefined();
    }
  });
});

describe("a summarised tool with nothing more to show", () => {
  it("is the card alone: no draft section and no raw JSON", () => {
    const { parts } = render(approval("calendar_delete_event", { eventId: "evt-example-1", notify: false }));
    expect(blocksOf(parts).map((b) => b.type)).toEqual(["card"]);
    expect(parts.details).toBeUndefined();
    expect(text(parts)).not.toContain("```");
  });

  it("shows the title it was given, reason included, and adds nothing", () => {
    const reason = 'Cancellation mail from the hotel, 18 Aug 2026: "Your reservation has been cancelled".';
    const interaction = approval("calendar_delete_event", { eventId: "e1", reason });
    expect(interaction.request.prompt).toContain(reason);
    const { parts, fallback } = render(interaction);
    expect(blocksOf(parts)).toEqual(fallback.controls.blocks);
    expect(parts.details).toBeUndefined();
  });
});

describe("a tool without a Lares summary keeps eve's own card", () => {
  it("is eve's default, raw input in the collapsed block and all", () => {
    const { parts, fallback } = render(approval("some_tool_nobody_summarised", { target: "x" }));
    expect(parts).toEqual(fallback);

    const container = (parts.details?.blocks as readonly Block[] | undefined)?.find((b) => b.type === "container") as
      { title?: { text: string }; default_collapsed?: boolean } | undefined;
    expect(container?.title?.text).toBe("Tool input");
    expect(container?.default_collapsed).toBe(true);
    expect(text(container)).toContain("target");
    expect(buttons(parts)).toEqual([
      { label: "Deny", value: "deny" },
      { label: "Approve", value: "approve" },
    ]);
  });

  // An outside tool's title shortens values and drops arguments, and the request was built by a
  // model for a server nobody reviewed. The whole input has to stay on the card.
  it("an outside tool keeps every argument and the whole long value", () => {
    registerOutsideConnections(["registry"]);
    const input = { a1: "x".repeat(500) + "TAIL_MARKER", a2: 2, a3: 3, a4: 4, a5: 5, a6: 6, a7: 7, a8: "EIGHTH_ARG" };
    const { parts, fallback } = render(approval("registry__create_note", input));
    expect(parts).toEqual(fallback);
    expect(text(parts.details)).toContain("TAIL_MARKER");
    expect(text(parts.details)).toContain("EIGHTH_ARG");
  });

  it("a question is not an approval: untouched", () => {
    const question = {
      ...approval("gmail_send", MAIL),
      request: { kind: "question", prompt: "Which one?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
    } as Interaction;
    const { parts, fallback } = render(question);
    expect(parts).toEqual(fallback);
  });
});

describe("the renderer never breaks a card", () => {
  it("falls back to eve's card rather than cut a draft silently, if one ever arrives over Slack's limit", async () => {
    vi.resetModules();
    vi.doMock("@lares/agent-kit/approval-summary", () => ({
      coversApproval: () => true,
      detailsForApproval: () => "y".repeat(3_001),
    }));
    try {
      const { approvalInteractionCard: withLongDraft } = await import("../lib/slack-approval-card.js");
      const eveDefault: SlackInteractionCardParts = {
        controls: { blocks: [{ type: "card" }], text: "title" },
        details: { blocks: [{ type: "container" }], text: "raw" },
      };
      expect(withLongDraft(cardFor(approval("gmail_send", MAIL)), () => eveDefault)).toBe(eveDefault);
    } finally {
      vi.doUnmock("@lares/agent-kit/approval-summary");
      vi.resetModules();
    }
  });

  it("calls eve's default exactly once and hands it the card unchanged", () => {
    const card = cardFor(approval("gmail_send", MAIL));
    const next = vi.fn((_card: SlackInteractionCard): SlackInteractionCardParts => ({
      controls: { blocks: [{ type: "card" }], text: "title" },
      details: { blocks: [{ type: "container" }], text: "raw" },
    }));
    approvalInteractionCard(card, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(card);
  });
});
