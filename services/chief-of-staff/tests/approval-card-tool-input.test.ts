import { describe, it, expect, afterEach, vi } from "vitest";
import type { SlackInteractionCard, SlackInteractionCardParts } from "eve/channels/slack";

import {
  coversApproval,
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

import { approvalCardRenderer, approvalInteractionCard } from "@lares/agent-kit/slack-approval-card";

/**
 * What the owner reads on a Slack approval card (`@lares/agent-kit/slack-approval-card`).
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

type Button = { text: { text: string }; value: string; action_id: string };

/** The labels and values of eve's buttons, in the order shown: on a compact `card` they are its
 *  `actions`, on eve's approval `container` they are the `actions` block among its children. */
function buttons(parts: SlackInteractionCardParts): { label: string; value: string }[] {
  const found: Button[] = [];
  for (const block of blocksOf(parts)) {
    if (block.type === "card") found.push(...((block.actions as Button[] | undefined) ?? []));
    if (block.type === "container") {
      for (const child of (block.child_blocks as Block[] | undefined) ?? []) {
        if (child.type === "actions") found.push(...((child.elements as Button[] | undefined) ?? []));
      }
    }
  }
  return found.map((a) => ({ label: a.text.text, value: a.value }));
}

/** What a click does: each button's action id and value, order aside. */
function controlsOf(parts: SlackInteractionCardParts): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value !== "object" || value === null) return;
    const node = value as Record<string, unknown>;
    if (typeof node.action_id === "string") found.push(`${node.action_id}=${String(node.value)}`);
    Object.values(node).forEach(walk);
  };
  walk(parts.controls.blocks);
  return found.sort();
}

/** eve's own card for the same request with the call's input taken out: the compact card the
 *  renderer asks eve for, for a summarised tool. */
function compactCardFor(interaction: Interaction): SlackInteractionCardParts {
  const { input: _input, ...call } = interaction.call!;
  return renderRequestCard(composeInteractionCards([]), cardFor({ ...interaction, call } as Interaction), undefined).fallback as never;
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

    // The raw arguments are gone: no "Tool input" message, no input preview, no JSON keys.
    expect(parts.details).toBeUndefined();
    expect(text(parts)).not.toContain("Tool input");
    expect(text(parts)).not.toContain("```");
    expect(text(parts)).not.toContain("rich_text");
    expect(text(parts)).not.toContain("bodyText");
    // eve's default, which this replaces, did carry them (since eve 1.0.1 inside the card).
    expect(text(fallback)).toContain("bodyText");
  });

  it("keeps exactly eve's buttons, drawn as eve draws them for the same request without input", () => {
    const interaction = approval("gmail_send", MAIL);
    const { parts, fallback } = render(interaction);
    // A click does what it would have done on eve's own card.
    expect(controlsOf(parts)).toEqual(controlsOf(fallback));
    // The card above the draft is eve's own compact card, untouched.
    expect(blocksOf(parts)[0]).toEqual(compactCardFor(interaction).controls.blocks[0]);
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
    const { parts } = render(interaction);
    expect(blocksOf(parts)).toEqual(compactCardFor(interaction).controls.blocks);
    expect(text(parts)).toContain("Your reservation has been cancelled");
    expect(parts.details).toBeUndefined();
  });
});

// The rule this file exists for: on a card for a tool Lares summarises, the owner reads Lares's
// text and never the call's raw arguments, while the request is open and after it ends.
describe("a summarised tool's card never shows the raw tool input", () => {
  const CASES: [string, Record<string, unknown>][] = [
    ["gmail_send", MAIL],
    ["gmail_draft", MAIL],
    ["meeting_followup_send", { ...MAIL, notionPageId: "page-raw-1", seriesKey: "series-raw-1", meetingTitle: "Weekly sync" }],
    ["calendar_delete_event", { eventId: "evt-raw-1", notify: false }],
    ["remind_set", { message: "Call the bank", dueAt: "2026-09-01T08:00:00Z" }],
  ];
  const endings: [string, Partial<Interaction>][] = [
    ["open", {}],
    ["approved", settled("accepted", "approve")],
    ["denied", settled("declined", "deny")],
    ["ended", settled("withdrawn")],
  ];

  it.each(CASES)("%s", (tool, input) => {
    expect(coversApproval(tool), tool).toBe(true);
    // eve's own card does show the raw input, so this test can see it if it ever comes back.
    expect(text(render(approval(tool, input)).fallback)).toContain(Object.keys(input)[0]);
    for (const [name, ending] of endings) {
      const { parts } = render(approval(tool, input, ending), name === "open" ? undefined : "U0000000000");
      const shown = text(parts);
      for (const key of Object.keys(input)) expect(shown, `${tool} ${name}: key ${key}`).not.toContain(`"${key}"`);
      expect(shown, `${tool} ${name}`).not.toContain("rich_text");
      expect(shown, `${tool} ${name}`).not.toContain("```");
      expect(shown, `${tool} ${name}`).not.toContain("Tool input");
      expect(parts.details, `${tool} ${name}`).toBeUndefined();
      // Lares's own title names the event id; the meeting-note ids are only in the raw input.
      for (const raw of ["page-raw-1", "series-raw-1"]) expect(shown, `${tool} ${name}`).not.toContain(raw);
    }
  });
});

describe("a tool without a Lares summary shows its whole input", () => {
  it("is eve's compact card with the whole input under it, and no eve preview", () => {
    const interaction = approval("some_tool_nobody_summarised", { target: "x" });
    const { parts, fallback } = render(interaction);
    // eve's own card for this request shows only its preview inside the card; this one is ours.
    expect(text(fallback)).toContain("rich_text");
    expect(text(parts)).not.toBe(text(fallback));
    expect(controlsOf(parts)).toEqual(controlsOf(fallback));

    const blocks = blocksOf(parts);
    expect(blocks.map((b) => b.type)).toEqual(["card", "section"]);
    expect(blocks[0]).toEqual(compactCardFor(interaction).controls.blocks[0]);
    const whole = (blocks[1] as unknown as { text: { type: string; text: string } }).text;
    expect(whole.type).toBe("mrkdwn");
    expect(whole.text).toBe('```\n{\n  "target": "x"\n}\n```');
    expect(text(parts)).not.toContain("rich_text");
    expect(parts.details).toBeUndefined();
    expect(buttons(parts)).toEqual([
      { label: "Deny", value: "deny" },
      { label: "Approve", value: "approve" },
    ]);
  });

  // An outside tool's title shortens values and drops arguments ("see the full request below"),
  // and the request was built by a model for a server nobody reviewed. The whole input has to be
  // on the card: eve 1.0.1's own preview would cut this value at 500 characters.
  it("an outside tool keeps every argument and the whole long value", () => {
    registerOutsideConnections(["registry"]);
    const input = { a1: "x".repeat(500) + "TAIL_MARKER", a2: 2, a3: 3, a4: 4, a5: 5, a6: 6, a7: 7, a8: "EIGHTH_ARG" };
    const { parts } = render(approval("registry__create_note", input));
    expect(text(parts)).toContain("TAIL_MARKER");
    expect(text(parts)).toContain("EIGHTH_ARG");
    expect(text(parts)).not.toContain("rich_text");
    expect(buttons(parts).map((b) => b.value)).toEqual(["deny", "approve"]);
  });

  it("keeps the whole input after the request is answered or ends", () => {
    registerOutsideConnections(["registry"]);
    const input = { a1: "x".repeat(600) + "TAIL_MARKER" };
    for (const ending of [settled("accepted", "approve"), settled("declined", "deny"), settled("withdrawn")]) {
      const { parts } = render(approval("registry__create_note", input, ending), "U0000000000");
      expect(text(parts)).toContain("TAIL_MARKER");
      expect(buttons(parts)).toEqual([]);
      expect(text(parts)).not.toContain("eve_input:");
    }
  });

  it("escapes Slack markup in the input, so it is read as typed", () => {
    const { parts } = render(approval("some_tool_nobody_summarised", { note: "<!channel> & <https://example.com|x>" }));
    const shown = text(blocksOf(parts)[1]);
    expect(shown).toContain("&lt;!channel&gt; &amp; &lt;https://example.com|x&gt;");
    expect(shown).not.toContain("<!channel>");
  });

  it("cuts an input longer than one Slack section, says how much is not shown, and stays under the limit", () => {
    const input = { body: "y".repeat(5_000) + "END_MARKER" };
    const { parts } = render(approval("some_tool_nobody_summarised", input));
    const shown = (blocksOf(parts)[1] as unknown as { text: { text: string } }).text.text;
    expect(shown.length).toBeLessThanOrEqual(3_000);
    expect(shown).not.toContain("END_MARKER");
    expect(shown).toMatch(/…\n```\n\n— shortened — \d+ characters are not shown\.$/u);
  });

  it("counts the hidden characters as the input has them, not as Slack escapes them", () => {
    // `&`, `<` and `>` each take 4 or 5 characters once escaped; the hidden part is full of them.
    const input = { body: "y".repeat(3_000) + "&<>".repeat(500) };
    const { parts } = render(approval("some_tool_nobody_summarised", input));
    const shownText = (blocksOf(parts)[1] as unknown as { text: { text: string } }).text.text;
    const match = /^```\n([\s\S]*)…\n```\n\n— shortened — (\d+) characters are not shown\.$/u.exec(shownText);
    expect(match).not.toBeNull();
    const visible = match![1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const json = JSON.stringify(input, null, 2);
    expect(json.startsWith(visible)).toBe(true);
    expect(Number(match![2])).toBe(json.length - visible.length);
  });

  it("a call with no input keeps eve's card as it is", () => {
    const { parts, fallback } = render(approval("some_tool_nobody_summarised", {}));
    expect(parts).toEqual(fallback);
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
  it("shows the whole input rather than cut a draft silently, if one ever arrives over Slack's limit", async () => {
    vi.resetModules();
    vi.doMock("@lares/agent-kit/approval-summary", () => ({
      coversApproval: () => true,
      detailsForApproval: () => "y".repeat(3_001),
      shortenedNotice: (hidden: number) => `\n\n— shortened — ${hidden} characters are not shown.`,
    }));
    try {
      const { approvalInteractionCard: withLongDraft } = await import("@lares/agent-kit/slack-approval-card");
      const eveDefault: SlackInteractionCardParts = { controls: { blocks: [{ type: "card" }], text: "title" } };
      const parts = withLongDraft(cardFor(approval("gmail_send", MAIL)), () => eveDefault);
      expect(text(parts)).not.toContain("yyyy");
      expect(text(parts)).toContain("bodyText");
      expect(text(parts)).toContain("Thanks for the meeting today.");
    } finally {
      vi.doUnmock("@lares/agent-kit/approval-summary");
      vi.resetModules();
    }
  });

  it("calls eve's default exactly once, with the input taken out for a summarised tool and nothing else changed", () => {
    const card = cardFor(approval("gmail_send", MAIL));
    const before = JSON.stringify(card);
    const next = vi.fn((_card: SlackInteractionCard): SlackInteractionCardParts => ({
      controls: { blocks: [{ type: "card" }], text: "title" },
      details: { blocks: [{ type: "container" }], text: "raw" },
    }));
    const parts = approvalInteractionCard(card, next);
    expect(next).toHaveBeenCalledTimes(1);
    const { input: _input, ...call } = card.interaction.call!;
    expect(next).toHaveBeenCalledWith({ ...card, interaction: { ...card.interaction, call } });
    // The card eve answers with is the real one: the renderer's input is left as it was.
    expect(JSON.stringify(card)).toBe(before);
    // A raw-input message, if eve ever sends one again, is dropped.
    expect(parts.details).toBeUndefined();
  });

  it("calls eve's default exactly once for a tool without a Lares summary too, with the input taken out", () => {
    const card = cardFor(approval("some_tool_nobody_summarised", { target: "x" }));
    const next = vi.fn((_card: SlackInteractionCard): SlackInteractionCardParts => ({
      controls: { blocks: [{ type: "card" }], text: "title" },
      details: { blocks: [{ type: "container" }], text: "raw" },
    }));
    const parts = approvalInteractionCard(card, next);
    expect(next).toHaveBeenCalledTimes(1);
    const { input: _input, ...call } = card.interaction.call!;
    expect(next).toHaveBeenCalledWith({ ...card, interaction: { ...card.interaction, call } });
    expect(parts.details).toBeUndefined();
  });
});
