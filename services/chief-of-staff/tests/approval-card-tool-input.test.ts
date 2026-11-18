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

import {
  approvalCardRenderer,
  approvalInteractionCard,
  installSlackCardHook,
  slackCardShownWhole,
  slackCardPostedWhole,
  layoutSlackCard,
  COMPACT_CARD_BLOCKS,
} from "@lares/agent-kit/slack-approval-card";
import { approvalCardShape } from "@lares/agent-kit/approval-summary";

// The framework patch asks this whether a card was cut (the door installs it when it starts).
installSlackCardHook();

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

  it("shows a body of about 10,000 characters whole, across sections, with Approve", () => {
    const body = Array.from({ length: 250 }, (_, i) => `Line ${i} of the draft, all of it to be read.`).join("\n");
    expect(body.length).toBeGreaterThan(9_000);
    const { parts, fallback } = render(approval("gmail_send", { ...MAIL, bodyText: body }));
    expect(text(parts)).not.toBe(text(fallback)); // eve kept our card

    const blocks = blocksOf(parts);
    expect(blocks[0]!.type).toBe("card");
    const sections = blocks.slice(1).map((b) => (b as unknown as { type: string; text: { text: string } }));
    expect(sections.length).toBeGreaterThanOrEqual(4);
    for (const section of sections) {
      expect(section.type).toBe("section");
      expect(section.text.text.length).toBeLessThanOrEqual(3_000);
    }
    // Every line is there, once, in order, and nothing says it was cut.
    const shown = sections.map((s) => s.text.text).join("");
    for (let i = 0; i < 250; i++) expect(shown).toContain(`Line ${i} of the draft`);
    expect(shown.indexOf("Line 0 of")).toBeLessThan(shown.indexOf("Line 249 of"));
    expect(shown).not.toContain("shortened");
    expect(buttons(parts)).toEqual([
      { label: "Deny", value: "deny" },
      { label: "Approve", value: "approve" },
    ]);
    expect(slackCardShownWhole("gmail_send", { ...MAIL, bodyText: body })).toBe(true);
    expect(parts.controls.text.length).toBeLessThanOrEqual(3_000);
  });

  it("a card over what one Slack message holds is cut, says so, offers no Approve, and keeps Deny", () => {
    const input = { ...MAIL, bodyText: "x".repeat(200_000) };
    const { parts, fallback } = render(approval("gmail_send", input));
    expect(text(parts)).not.toBe(text(fallback)); // eve kept our card

    const blocks = blocksOf(parts);
    expect(blocks.length).toBe(50);
    expect(blocks[0]!.type).toBe("card");
    expect(buttons(parts)).toEqual([{ label: "Deny", value: "deny" }]);
    expect(text(parts)).not.toContain('"approve"');

    const sections = blocks.slice(1).map((b) => (b as unknown as { text: { text: string } }).text.text);
    const notice = sections.at(-1)!;
    expect(notice).toMatch(/^— shortened — \d+ characters are not shown\.\n/u);
    expect(notice).toContain("The request above is shortened, so it cannot be approved here.");
    expect(notice).toContain("Deny still works here.");
    expect(notice).toContain("the Waiting on you page in the console");
    // Slack is not named as a place to read it: the request is not on Slack's side of anything else.
    expect(notice).not.toContain("Open it in Slack");

    // The count is exact: what is shown plus what is not shown is the whole details text.
    const total = approvalCardShape("gmail_send", input).body.map((p) => p.text.length).reduce((a, b) => a + b, 0);
    const shownChars = sections.slice(0, -1).reduce((n, t) => n + t.length, 0);
    expect(shownChars + Number(/(\d+) characters/u.exec(notice)![1])).toBe(total);
    expect(slackCardShownWhole("gmail_send", input)).toBe(false);
  });

  it("a card cut for size, once denied, keeps the count and drops the sentence about opening it", () => {
    const input = { ...MAIL, bodyText: "x".repeat(200_000) };
    const { parts } = render(approval("gmail_send", input, settled("declined", "deny")), "U0000000000");
    const notice = (blocksOf(parts).at(-1) as unknown as { text: { text: string } }).text.text;
    expect(notice).toMatch(/^— shortened — \d+ characters are not shown\.$/u);
    expect(buttons(parts)).toEqual([]);
  });

  it("shows the whole of a title longer than eve's card shows, in the body", () => {
    const message = "m".repeat(150);
    const input = { message, dueAt: "2026-09-01T08:00:00Z", recurrence: "weekly on Monday at nine", door: "telegram" };
    const { parts } = render(approval("remind_set", input));
    expect(text(parts)).toContain(message);
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

  it("shows an input longer than one Slack section whole, each section its own fenced block", () => {
    const input = { body: "y".repeat(5_000) + "END_MARKER" };
    const { parts } = render(approval("some_tool_nobody_summarised", input));
    const sections = blocksOf(parts).slice(1).map((b) => (b as unknown as { text: { text: string } }).text.text);
    expect(sections.length).toBe(2);
    for (const shown of sections) {
      expect(shown.length).toBeLessThanOrEqual(3_000);
      expect(shown.startsWith("```\n")).toBe(true);
      expect(shown.endsWith("\n```")).toBe(true);
    }
    const json = sections.map((s) => s.slice(4, -4)).join("");
    expect(json).toBe(JSON.stringify(input, null, 2));
    expect(json).toContain("END_MARKER");
    expect(sections.join("")).not.toContain("shortened");
    expect(buttons(parts).map((b) => b.value)).toEqual(["deny", "approve"]);
  });

  it("keeps Slack's escapes whole when it splits an input full of them", () => {
    const input = { body: "&<>".repeat(1_500) };
    const { parts } = render(approval("some_tool_nobody_summarised", input));
    const sections = blocksOf(parts).slice(1).map((b) => (b as unknown as { text: { text: string } }).text.text)
      .filter((t) => t.startsWith("```")); // the title, repeated whole because it is long, is the section before
    const json = sections.map((s) => s.slice(4, -4)).join("");
    expect(json.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).toBe(JSON.stringify(input, null, 2));
    for (const shown of sections) expect(shown).not.toMatch(/&[a-z]{0,4}\n```$/u);
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
  it("calls eve's default exactly once, with the input taken out for a summarised tool and nothing else changed", () => {
    const card = cardFor(approval("gmail_send", MAIL));
    const before = JSON.stringify(card);
    const next = vi.fn((_card: SlackInteractionCard): SlackInteractionCardParts => ({
      controls: { blocks: [{ type: "card" }], text: "title" },
      details: { blocks: [{ type: "container" }], text: "raw" },
    }));
    const parts = approvalInteractionCard(card, next);
    expect(next).toHaveBeenCalledTimes(1);
    const { input, ...call } = card.interaction.call!;
    // The input rides along under another name, so the framework patch sees the same request.
    expect(next).toHaveBeenCalledWith({ ...card, interaction: { ...card.interaction, call: { ...call, laresInput: input } } });
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
    const { input, ...call } = card.interaction.call!;
    // The input rides along under another name, so the framework patch sees the same request.
    expect(next).toHaveBeenCalledWith({ ...card, interaction: { ...card.interaction, call: { ...call, laresInput: input } } });
    expect(parts.details).toBeUndefined();
  });
});

describe("a card eve draws itself is never counted whole, and the hook fails closed", () => {
  const BIG_MAIL = { ...MAIL, bodyText: Array.from({ length: 250 }, (_, i) => `Line ${i} of the draft, all of it to be read.`).join("\n") };

  it("when a renderer throws, eve's own card is posted and the record does not call it whole", () => {
    const throwing = composeInteractionCards([{ interactionCard: () => { throw new Error("renderer broke"); } } as never]);
    const interaction = approval("gmail_send", BIG_MAIL);
    const { parts } = renderRequestCard(throwing, cardFor(interaction), undefined) as never as { parts: SlackInteractionCardParts };
    expect(text(parts)).toContain("bodyText"); // eve's own preview of the raw input
    expect(slackCardPostedWhole("gmail_send", BIG_MAIL, parts.controls.blocks)).toBe(false);
    // The card the renderer draws is whole.
    const ours = render(interaction).parts;
    expect(slackCardPostedWhole("gmail_send", BIG_MAIL, ours.controls.blocks)).toBe(true);
  });

  it("a short card with nothing under its title is whole either way", () => {
    expect(slackCardPostedWhole("calendar_delete_event", { eventId: "e1" }, [{ type: "card" }])).toBe(true);
  });

  it("a hook that throws takes Approve off: Deny only, and eve still accepts our card", () => {
    const real = globalThis.__eveSlackCardCut;
    globalThis.__eveSlackCardCut = () => { throw new Error("hook broke"); };
    try {
      const { parts, fallback } = render(approval("gmail_send", MAIL));
      expect(buttons(fallback)).toEqual([{ label: "Deny", value: "deny" }]);
      expect(buttons(parts)).toEqual([{ label: "Deny", value: "deny" }]);
    } finally {
      globalThis.__eveSlackCardCut = real;
    }
  });

  it("without the hook a card that does not fit is eve's own, with no notice that Approve is gone", () => {
    const real = globalThis.__eveSlackCardCut;
    globalThis.__eveSlackCardCut = undefined;
    try {
      const { parts, fallback } = render(approval("gmail_send", { ...MAIL, bodyText: "x".repeat(200_000) }));
      expect(text(parts)).toBe(text(fallback));
      expect(text(parts)).not.toContain("cannot be approved here");
      // A card that fits is unaffected.
      expect(buttons(render(approval("gmail_send", MAIL)).parts).map((b) => b.value)).toEqual(["deny", "approve"]);
    } finally {
      globalThis.__eveSlackCardCut = real;
    }
  });
});

describe("the 49 and 50 section boundary", () => {
  const part = { kind: "text", text: "a".repeat(3_000) } as const;
  const parts = (n: number) => Array.from({ length: n }, () => part);

  it("49 sections plus the card are 50 blocks and whole; 50 sections are cut, with the notice as the 50th block", () => {
    const whole = layoutSlackCard(parts(49), COMPACT_CARD_BLOCKS);
    expect(whole.whole).toBe(true);
    expect(whole.sections).toHaveLength(49);
    const cut = layoutSlackCard(parts(50), COMPACT_CARD_BLOCKS);
    expect(cut.whole).toBe(false);
    expect(cut.sections).toHaveLength(48); // + the notice + the card = 50
    expect(cut.hidden).toBe(2 * 3_000);
  });

  it("a settled card of 49 sections stays at 50 blocks", () => {
    const body = "word ".repeat(147_000 / 5).slice(0, 49 * 3_000 - 10);
    const input = { ...MAIL, bodyText: body };
    const n = approvalCardShape("gmail_send", input).body.length;
    expect(n).toBe(1);
    const open = render(approval("gmail_send", input)).parts;
    expect(blocksOf(open).length).toBeLessThanOrEqual(50);
    const done = render(approval("gmail_send", input, settled("accepted", "approve")), "U0000000000").parts;
    expect(blocksOf(done).length).toBe(blocksOf(open).length);
    expect(blocksOf(done).length).toBeLessThanOrEqual(50);
  });
});
