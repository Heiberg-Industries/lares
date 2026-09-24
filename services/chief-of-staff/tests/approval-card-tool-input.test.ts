import { describe, it, expect, afterEach } from "vitest";

import { registerApprovalSummary } from "@lares/agent-kit/approval-summary";

// Deep imports into eve's dist — INTERNALS, reached on purpose, the convention of
// tests/approval-summary.test.ts. This file pins the ORB-140 hunk of patches/eve.patch: an eve
// upgrade that moves either module fails these imports, and THAT is the signal to re-derive.
// @ts-expect-error — no types shipped for eve internals
import { extractToolApprovalInputRequests } from "eve-internals/input-extraction";
// @ts-expect-error — no types shipped for eve internals
import { renderInputRequestBlocks, renderInputRequestPostParts } from "eve-internals/slack-hitl";
// @ts-expect-error — no types shipped for eve internals
import { renderTelegramInputRequest } from "eve-internals/telegram-hitl";
// @ts-expect-error — no types shipped for eve internals
import { handleInteractionPost } from "eve-internals/slack-interactions";

/** The shape eve's harness parses out of a turn's content: the tool call plus the approval
 *  request that references it — so the request under test is the REAL one, action shape and
 *  all, not a hand-built lookalike. */
const content = (toolName: string, input: unknown) => [
  { type: "tool-call", toolCallId: "call_1", toolName, input },
  { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" },
];

type Block = { type: string; title?: { text: string }; default_collapsed?: boolean };

const toolInputBlock = (blocks: Block[]) => blocks.find((b) => b.type === "container" && b.title?.text === "Tool input");

// ORB-140 — Bendik, 2026-08-20: "the tool input STILL shows up for most tools, we need to
// remove it." eve renders a raw-JSON "Tool input" container on EVERY Slack approval card, in
// addition to the title, and the 0.32 channel has no knob for it. The patch drops it whenever
// the title came from one of our DEDICATED formatters — the summary is then the whole card —
// and keeps it, collapsed, for anything else: the generic fallback names three fields at most,
// which is a title, not the last thing a human should read before authorising a write.
describe("the eve patch — the raw Tool input block on Slack approval cards (ORB-140)", () => {
  afterEach(() => {
    delete globalThis.__eveApprovalSummary;
    delete globalThis.__eveApprovalCovers;
  });

  it("is gone when the card title came from a dedicated formatter", () => {
    registerApprovalSummary();
    const [request] = extractToolApprovalInputRequests({
      content: content("calendar_delete_event", { eventId: "dqmphcuuo6roef1g7isptqnep4", notify: false }),
    });
    expect(request.prompt).not.toMatch(/^Approve tool call/);

    const blocks = renderInputRequestBlocks(request) as Block[];
    expect(toolInputBlock(blocks)).toBeUndefined();
    expect(JSON.stringify(blocks)).not.toContain("```");
    // The approve/cancel card itself is untouched.
    expect(blocks.map((b) => b.type)).toEqual(["card"]);

    const parts = renderInputRequestPostParts(request) as { controls: { text: string }; details?: unknown };
    expect(parts.details).toBeUndefined();
    expect(parts.controls.text).toBe(request.prompt);
  });

  it("stays, collapsed, for a tool that only has the generic title", () => {
    registerApprovalSummary();
    const [request] = extractToolApprovalInputRequests({
      content: content("some_tool_nobody_summarised", { target: "x" }),
    });
    expect(request.prompt).toBe("some_tool_nobody_summarised — target: x");

    const container = toolInputBlock(renderInputRequestBlocks(request) as Block[]);
    expect(container?.default_collapsed).toBe(true);
    // The JSON survives inside the collapsed block (escaped once more by the stringify here).
    expect(JSON.stringify(container)).toContain("target");
  });

  it("stays, collapsed, when no summariser is registered at all — eve-marcel never registers one", () => {
    const [request] = extractToolApprovalInputRequests({ content: content("gmail_send", { body: "hei" }) });
    expect(request.prompt).toBe("Approve tool call: gmail_send");

    const container = toolInputBlock(renderInputRequestBlocks(request) as Block[]);
    expect(container?.default_collapsed).toBe(true);
  });
});

// 2026-09-07: the Folkepuls follow-up card named the meeting and two recipients and not one word
// of the email. ORB-140 had removed the raw block, which for a mail send was the only place the
// subject and body ever appeared. A mail card now carries the draft as a section directly under
// the approve/cancel card — the seventh hunk of patches/eve.patch consults
// `globalThis.__eveApprovalDetails`, published beside the title hook. A covered tool with no
// draft to show keeps ORB-140's shape exactly.
describe("the eve patch — a mail card shows the draft under the card", () => {
  afterEach(() => {
    delete globalThis.__eveApprovalSummary;
    delete globalThis.__eveApprovalCovers;
    delete globalThis.__eveApprovalDetails;
  });

  type TextBlock = Block & { text?: { type: string; text: string } };

  const input = {
    notionPageId: "p1",
    seriesKey: "s1",
    to: ["taylor@example.com", "sam@example.com"],
    subject: "Oppsummering Folkepuls 7. september",
    bodyText: "Hei begge,\n\nTakk for møtet i dag.\n\nBendik",
    meetingTitle: "Folkepuls",
    meetingWhen: "2026-09-07T10:00:00.000+02:00",
    from: "owner@example.invalid",
  };

  it("renders the subject and body as a section beneath the approve/cancel card", () => {
    registerApprovalSummary();
    const [request] = extractToolApprovalInputRequests({ content: content("meeting_followup_send", input) });

    const blocks = renderInputRequestBlocks(request) as TextBlock[];
    expect(blocks.map((b) => b.type)).toEqual(["card", "section"]);
    expect(blocks[1]!.text!.type).toBe("mrkdwn");
    expect(blocks[1]!.text!.text).toContain("*Subject:* Oppsummering Folkepuls 7. september");
    expect(blocks[1]!.text!.text).toContain("Takk for møtet i dag.");
    // The raw JSON stays gone — this is the draft, not the arguments.
    expect(toolInputBlock(blocks)).toBeUndefined();
    expect(JSON.stringify(blocks)).not.toContain("```");
  });

  it("keeps the subject and body when Slack repaints the answered card", async () => {
    registerApprovalSummary();
    const [request] = extractToolApprovalInputRequests({ content: content("meeting_followup_send", input) });
    const blocks = renderInputRequestBlocks(request);
    const payload = {
      type: "block_actions", team: { id: "T1" }, user: { id: "U1", username: "bendik" },
      channel: { id: "D1" }, message: { ts: "1.2", blocks },
      actions: [{ action_id: `eve_input:${request.requestId}:button:1`, block_id: "b1", value: "approve", text: { text: "Approve" } }],
    };
    let updateBody: { blocks?: unknown[] } | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      updateBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const pending: Promise<unknown>[] = [];
    try {
      await handleInteractionPost(`payload=${encodeURIComponent(JSON.stringify(payload))}`, {
        from: () => ({ respond: async () => undefined }), resolveSession: async () => undefined,
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      }, {
        config: { credentials: { botToken: async () => "xoxb-test" } },
        // eve 0.60 authorises every HITL click through `deps.onInputResponse` first; this is
        // eve's own `defaultOnInputResponse`, the one `slackChannel()` installs by default.
        onInputResponse: ({ defaultAuth }: { defaultAuth: unknown }) => ({ auth: defaultAuth }),
      });
      await Promise.all(pending);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(JSON.stringify(updateBody?.blocks)).toContain("Takk for møtet i dag.");
    expect(JSON.stringify(updateBody?.blocks)).toContain("Approve");
  });

  it("carries the draft in the plain-text fallback too, so a notification preview is not blind", () => {
    registerApprovalSummary();
    const [request] = extractToolApprovalInputRequests({ content: content("meeting_followup_send", input) });

    const parts = renderInputRequestPostParts(request) as { controls: { text: string }; details?: { text: string } };
    expect(parts.controls.text).toBe(request.prompt);
    expect(parts.details?.text).toContain("Takk for møtet i dag.");
  });

  it("a covered tool with nothing to show keeps ORB-140's shape: the card alone", () => {
    registerApprovalSummary();
    const [request] = extractToolApprovalInputRequests({
      content: content("calendar_delete_event", { eventId: "e1", notify: false }),
    });
    expect((renderInputRequestBlocks(request) as Block[]).map((b) => b.type)).toEqual(["card"]);
  });
});

// LAR-59-s4 — the delete-event card names the reason a stale booking is being removed. It is
// carried entirely in the TITLE (summarizeApproval), so it reaches Slack and Telegram through
// the exact same pipeline every other dedicated-formatter title already does — no new details
// hook, no change to ORB-140's "card alone" shape for a tool with nothing more to show.
describe("the eve patch — the delete-event card shows the reason, on Slack and Telegram alike (LAR-59-s4)", () => {
  afterEach(() => {
    delete globalThis.__eveApprovalSummary;
    delete globalThis.__eveApprovalCovers;
    delete globalThis.__eveApprovalDetails;
  });

  const REASON = 'Cancellation mail from The Standard, 18 Aug 2026: "Your reservation has been cancelled".';

  it("Slack: the reason is in the prompt, and the card stays a single card (no new details block)", () => {
    registerApprovalSummary();
    const [request] = extractToolApprovalInputRequests({
      content: content("calendar_delete_event", { eventId: "e1", reason: REASON }),
    });
    expect(request.prompt).toContain("reason given by the agent");
    expect(request.prompt).toContain(REASON);

    const blocks = renderInputRequestBlocks(request) as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["card"]);
    expect(toolInputBlock(blocks)).toBeUndefined();
  });

  it("Telegram: the same reason shows in the card text", () => {
    registerApprovalSummary();
    const [request] = extractToolApprovalInputRequests({
      content: content("calendar_delete_event", { eventId: "e1", reason: REASON }),
    });
    const card = renderTelegramInputRequest(request, {}) as { text: string };
    expect(card.text).toContain("reason given by the agent");
    expect(card.text).toContain(REASON);
  });

  it("a card with no reason is byte-identical to today's on both channels", () => {
    registerApprovalSummary();
    const [request] = extractToolApprovalInputRequests({
      content: content("calendar_delete_event", { eventId: "e1", notify: false }),
    });
    expect(request.prompt).toBe("Calendar: DELETE event e1");
    expect((renderInputRequestBlocks(request) as Block[]).map((b) => b.type)).toEqual(["card"]);
    const card = renderTelegramInputRequest(request, {}) as { text: string };
    expect(card.text).not.toContain("reason given by the agent");
  });
});

describe("the eve patch — Telegram approval cards show the same details", () => {
  afterEach(() => {
    delete globalThis.__eveApprovalSummary;
    delete globalThis.__eveApprovalCovers;
    delete globalThis.__eveApprovalDetails;
  });

  const telegramCard = (bodyText: string) => {
    registerApprovalSummary();
    const [request] = extractToolApprovalInputRequests({
      content: content("gmail_send", { to: ["test@example.com"], subject: "Test", bodyText }),
    });
    return renderTelegramInputRequest(request, {});
  };

  it("puts subject and body above buttons labelled Cancel and Approve", () => {
    const card = telegramCard("The complete email body");
    expect(card.text).toContain("*Subject:* Test");
    expect(card.text).toContain("The complete email body");
    expect(card.replyMarkup.inline_keyboard[0].map((button: { text: string }) => button.text)).toEqual(["Cancel", "Approve"]);
  });

  it("fits Telegram's 4,000-character text limit and marks truncation clearly", () => {
    // W7A-s1: `mailDetails` now ends its own text with a sentence ("— shortened — N characters
    // are not shown."), not a bare ellipsis. eve's patched `laresApprovalText`
    // (patches/eve.patch, telegram-hitl hunk) only appends ITS "…(truncated)" marker when the
    // details text it was handed ends in "…"/"..." — that was a hook for our OLD bare-ellipsis
    // truncation, not a truncation signal of its own. Our sentence already says what was cut,
    // so eve's generic marker no longer applies, and none is added.
    const card = telegramCard("x".repeat(5_000));
    expect(card.text.length).toBeLessThanOrEqual(4_000);
    expect(card.text).toMatch(/shortened — \d+ characters are not shown\.$/);
  });
});
