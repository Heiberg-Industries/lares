// A Telegram approval card shows its outcome and loses its buttons once it is decided.
//
// The bug: the owner tapped Approve, the action ran, and the card stayed exactly as it was —
// both buttons, no outcome. eve's Telegram channel answers the tap ("Answer received.") and
// resumes the session, but nothing ever edits the card; Slack's channel does, on
// `approval.settled`. The chief of staff's door now does the same on Telegram.
//
// Three halves, from the tap to the edit:
//   1. eve's own approval coordinator, run for real: the owner's tap (with the identity
//      `withOwnerTapAuth` gives it) settles the request — the settlement eve turns into
//      `approval.settled`.
//   2. the door's `input.requested` remembers which message each card is, posting exactly what
//      eve's default posts.
//   3. the door's `approval.settled` edits that card: text kept, outcome added, buttons gone —
//      through the real channel object and its Bot API calls, and never twice.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ownerTapAuth } from "../lib/telegram-tap-auth.js";

const calls = vi.hoisted(() => [] as Array<{ method: string; body: Record<string, unknown> }>);
vi.mock("@lares/agent-kit/telegram-fetch", () => ({
  telegramFetch: async (url: string, init?: { body?: string }) => {
    calls.push({ method: String(url).split("/").pop()!, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 41, chat: { id: 123456789, type: "private" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

const ledger = vi.hoisted(() => ({ answeredVia: async (_id: string): Promise<string | null> => null }));
vi.mock("@lares/agent-kit/approval-ledger", () => ({ answeredVia: (id: string) => ledger.answeredVia(id) }));

import {
  APPROVAL_REVISED_TEXT,
  APPROVAL_OUTCOME_TEXT,
  isShortenedCard,
  onApprovalSettled,
  onInputRequested,
  shortenedCardNote,
  waitingPageLink,
} from "../agent/channels/telegram.js";

const OWNER = "123456789";
const REQUEST_ID = "req-1";

const approvalRequest = {
  requestId: REQUEST_ID,
  kind: "tool-approval",
  prompt: 'Dismiss deadline 42 — "already handled"',
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  action: { kind: "tool-call", callId: "call-1", toolName: "deadline_dismiss", input: { id: 42 } },
} as never;

const freeTextRequest = { requestId: "req-2", kind: "question", prompt: "Which day?", options: [] } as never;

let dir: string;
beforeEach(() => {
  calls.length = 0;
  dir = mkdtempSync(join(tmpdir(), "approval-card-"));
  writeFileSync(join(dir, "token"), "1:abc\n");
  process.env["TELEGRAM_BOT_TOKEN_FILE"] = join(dir, "token");
  process.env["TELEGRAM_PRINCIPAL_ID"] = OWNER;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ["TELEGRAM_BOT_TOKEN_FILE", "TELEGRAM_PRINCIPAL_ID", "LARES_CONSOLE_URL"]) delete process.env[k];
  vi.restoreAllMocks();
});

type Edit = { messageId: string; replyMarkup?: Readonly<Record<string, unknown>>; text: string };

function fakeChat(edit: (input: Edit) => Promise<{ ok: boolean; status: number; body?: unknown }> = async () => ({ ok: true, status: 200 })) {
  const posted: Array<{ reply_markup?: Readonly<Record<string, unknown>>; text: string }> = [];
  const edits: Edit[] = [];
  let nextId = 100;
  const chat = {
    state: { hitlCallbacks: {}, nextHitlCallbackId: 0, pendingFreeformReplies: {} } as Record<string, unknown> as never,
    telegram: {
      post: async (m: { reply_markup?: Readonly<Record<string, unknown>>; text: string }) => {
        posted.push(m);
        return { id: String(nextId++) };
      },
      editMessageText: async (input: Edit) => {
        edits.push(input);
        return edit(input);
      },
    },
  };
  return { chat, posted, edits, state: chat.state as unknown as Record<string, unknown> };
}

/** eve's dist, for the internals its exports map does not expose. */
const EVE_DIST = pathToFileURL(fileURLToPath(new URL("../node_modules/eve/dist/src", import.meta.url))).href;

/** Runs `fn` inside the runtime context eve gives tools and channel event handlers. */
async function inEveContext<T>(fn: () => Promise<T>): Promise<T> {
  const { ContextContainer, contextStorage } = (await import(`${EVE_DIST}/context/container.js`)) as {
    ContextContainer: new () => { set(key: { name: string }, value: unknown): void };
    contextStorage: { run<R>(store: unknown, fn: () => R): R };
  };
  const container = new ContextContainer();
  container.set({ name: "eve.session" }, { sessionId: "sess-1", auth: { current: null, initiator: null }, turn: { id: "t1", sequence: 0 } });
  return contextStorage.run(container, fn);
}

describe("1. the owner's tap settles the request (eve's coordinator, run for real)", () => {
  async function settle(optionId: "approve" | "cancel") {
    const { coordinateApprovalDelivery } = (await import(`${EVE_DIST}/harness/approval-delivery-coordinator.js`)) as {
      coordinateApprovalDelivery: (i: unknown) => Promise<{ session: { state: unknown } }>;
    };
    const { getApprovalAuditState } = (await import(`${EVE_DIST}/harness/approval-candidates.js`)) as {
      getApprovalAuditState: (s: unknown) => { settlements: Array<{ requestId: string; outcome: string }> };
    };
    // An ordinary gated tool: no `response` policy, so eve settles the tap directly.
    const state = { "eve.runtime.pendingInputBatches": [{ requests: [approvalRequest], responseMessages: [] }] };
    const tap = JSON.stringify({
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: Number(OWNER), is_bot: false, first_name: "X" },
        message: { message_id: 100, date: 1, chat: { id: Number(OWNER), type: "private" }, text: "card" },
        chat_instance: "ci",
        data: "eve:0",
      },
    });
    const result = await inEveContext(() =>
      coordinateApprovalDelivery({
        session: { state },
        stepInput: { attributedInputResponses: [{ auth: ownerTapAuth(tap), response: { requestId: REQUEST_ID, optionId } }] },
        tools: new Map([["deadline_dismiss", { approval: {} }]]),
      }),
    );
    return getApprovalAuditState(result.session.state).settlements;
  }

  it("Approve settles as allowed — what eve emits as approval.settled { outcome: approved }", async () => {
    expect(await settle("approve")).toMatchObject([{ requestId: REQUEST_ID, outcome: "allowed" }]);
  });

  it("Cancel settles as cancelled", async () => {
    expect(await settle("cancel")).toMatchObject([{ requestId: REQUEST_ID, outcome: "cancelled" }]);
  });
});

describe("2. input.requested remembers each approval card", () => {
  it("posts what eve's default posts — the text and Cancel / Approve — and keeps the card's id and text", async () => {
    const { chat, posted, state } = fakeChat();
    await onInputRequested({ requests: [approvalRequest] }, chat);

    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toBe('Dismiss deadline 42 — "already handled"');
    const keyboard = (posted[0]!.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    expect(keyboard.flat().map((b) => b.text)).toEqual(["Cancel", "Approve"]);
    expect(keyboard.flat().every((b) => b.callback_data.startsWith("eve:"))).toBe(true);
    expect(state["approvalCards"]).toEqual({ [REQUEST_ID]: { messageId: "100", text: 'Dismiss deadline 42 — "already handled"' } });
  });

  it("a free-text question is registered for its reply, as before, and is not an approval card", async () => {
    const { chat, state } = fakeChat();
    await onInputRequested({ requests: [freeTextRequest] }, chat);
    expect(state["pendingFreeformReplies"]).toEqual({ "100": "req-2" });
    expect(state["approvalCards"]).toBeUndefined();
  });
});

describe("3. approval.settled edits the card", () => {
  async function cardPosted(edit?: Parameters<typeof fakeChat>[0]) {
    const fake = fakeChat(edit);
    await onInputRequested({ requests: [approvalRequest] }, fake.chat);
    return fake;
  }

  it("Approve: the text stays, ✅ Approved is added, the buttons go", async () => {
    const { chat, edits, state } = await cardPosted();
    await onApprovalSettled({ outcome: "approved", requestId: REQUEST_ID }, chat);
    expect(edits).toEqual([
      { messageId: "100", replyMarkup: { inline_keyboard: [] }, text: `Dismiss deadline 42 — "already handled"\n\n${APPROVAL_OUTCOME_TEXT.approved}` },
    ]);
    expect(state["approvalCards"]).toEqual({});
  });

  it("Cancel: ✖ Cancelled is added", async () => {
    const { chat, edits } = await cardPosted();
    await onApprovalSettled({ outcome: "cancelled", requestId: REQUEST_ID }, chat);
    expect(edits[0]!.text.endsWith(`\n\n${APPROVAL_OUTCOME_TEXT.cancelled}`)).toBe(true);
  });

  it("Cancel on a card the agent revised: one extra line says so", async () => {
    ledger.answeredVia = async () => "revised";
    const { chat, edits } = await cardPosted();
    await onApprovalSettled({ outcome: "cancelled", requestId: REQUEST_ID }, chat);
    expect(edits[0]!.text.endsWith(`\n\n${APPROVAL_OUTCOME_TEXT.cancelled}\n${APPROVAL_REVISED_TEXT}`)).toBe(true);
    expect(APPROVAL_REVISED_TEXT).toBe("Revised — see the new card");
  });

  it("a cancel the owner tapped (not revised) and a failed lookup both keep today's text", async () => {
    ledger.answeredVia = async () => "telegram";
    let fake = await cardPosted();
    await onApprovalSettled({ outcome: "cancelled", requestId: REQUEST_ID }, fake.chat);
    expect(fake.edits[0]!.text.endsWith(APPROVAL_OUTCOME_TEXT.cancelled)).toBe(true);
    ledger.answeredVia = async () => {
      throw new Error("db down");
    };
    fake = await cardPosted();
    await onApprovalSettled({ outcome: "cancelled", requestId: REQUEST_ID }, fake.chat);
    expect(fake.edits[0]!.text.endsWith(APPROVAL_OUTCOME_TEXT.cancelled)).toBe(true);
  });

  it("an approval is never reworded, whatever the ledger says", async () => {
    ledger.answeredVia = async () => "revised";
    const { chat, edits } = await cardPosted();
    await onApprovalSettled({ outcome: "approved", requestId: REQUEST_ID }, chat);
    expect(edits[0]!.text.endsWith(APPROVAL_OUTCOME_TEXT.approved)).toBe(true);
  });

  it("a card already decided is not edited again, and a card this chat never posted is left alone", async () => {
    const { chat, edits } = await cardPosted();
    await onApprovalSettled({ outcome: "approved", requestId: REQUEST_ID }, chat);
    await onApprovalSettled({ outcome: "cancelled", requestId: REQUEST_ID }, chat);
    await onApprovalSettled({ outcome: "approved", requestId: "someone-elses" }, chat);
    expect(edits).toHaveLength(1);
  });

  it("Telegram refusing the edit is logged, never thrown (a throwing handler parks the session)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { chat } = await cardPosted(async () => ({ ok: false, status: 400, body: { ok: false, description: "Bad Request: message to edit not found" } }));
    await expect(onApprovalSettled({ outcome: "approved", requestId: REQUEST_ID }, chat)).resolves.toBeUndefined();
    expect(String(error.mock.calls[0]?.[0])).toContain("HTTP 400: Bad Request: message to edit not found");
    expect(String(error.mock.calls[0]?.[0])).not.toContain("Dismiss deadline");
  });

  it("an edit that throws (network) is logged, never thrown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { chat } = await cardPosted(async () => {
      throw new Error("proxy down");
    });
    await expect(onApprovalSettled({ outcome: "approved", requestId: REQUEST_ID }, chat)).resolves.toBeUndefined();
  });

  it("the real door wires both handlers, and the edit goes out as editMessageText to the card's chat", async () => {
    vi.resetModules();
    const door = (await import("../agent/channels/telegram.js")).default as unknown as {
      adapter: {
        createAdapterContext(i: { state: unknown; ctx: unknown; session: unknown }): unknown;
        "input.requested"?: (data: unknown, ctx: unknown) => Promise<void>;
        "approval.settled"?: (data: unknown, ctx: unknown) => Promise<void>;
      };
    };
    expect(typeof door.adapter["input.requested"]).toBe("function");
    expect(typeof door.adapter["approval.settled"]).toBe("function");

    // The handlers themselves, on the context eve builds for the real channel (credentials and
    // the proxied fetch included). The fetch is the mock above.
    const state = { botUsername: null, chatId: OWNER, chatType: "private", conversationId: null, messageThreadId: null, hitlCallbacks: {}, nextHitlCallbackId: 0, pendingFreeformReplies: {} };
    const ctx = door.adapter.createAdapterContext({ state, ctx: undefined, session: undefined });
    // eve calls channel event handlers inside its runtime context; give them one.
    await inEveContext(async () => {
      await door.adapter["input.requested"]!({ requests: [approvalRequest] }, ctx);
      await door.adapter["approval.settled"]!({ outcome: "approved", requestId: REQUEST_ID, responderPrincipalId: `telegram:${OWNER}` }, ctx);
    });

    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(calls[1]!.body).toMatchObject({
      chat_id: OWNER,
      message_id: 41,
      reply_markup: { inline_keyboard: [] },
      text: `Dismiss deadline 42 — "already handled"\n\n${APPROVAL_OUTCOME_TEXT.approved}`,
    });
  });
});

describe("4. a card too long for one message points to the console and cannot be approved here", () => {
  // eve's renderer cuts a prompt over 4000 characters with a bare "..." (no marker of its own).
  const longRequest = {
    ...(approvalRequest as Record<string, unknown>),
    requestId: "req-long",
    prompt: `Send this reply: ${"word ".repeat(1200)}`,
  } as never;
  // A mail card's details end with the approval summary's own notice when they were cut at 2800.
  const summarisedRequest = {
    ...(approvalRequest as Record<string, unknown>),
    requestId: "req-sum",
    prompt: "Send mail to someone@example.com\n\nBody: …\n\n— shortened — 1234 characters are not shown.",
  } as never;

  function buttons(markup: Readonly<Record<string, unknown>> | undefined) {
    return (markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard.flat();
  }

  it("knows a cut card from a whole one", () => {
    expect(isShortenedCard("Dismiss deadline 42", "Dismiss deadline 42")).toBe(false);
    expect(isShortenedCard("Send this…(truncated)", "Send this")).toBe(true);
    const summary = "Body: …\n\n— shortened — 12 characters are not shown.";
    expect(isShortenedCard(summary, summary)).toBe(true);
    expect(isShortenedCard("Send this rep...", "Send this reply in full")).toBe(true);
    // A title that left something out says so (`SUMMARY_SHORTENED` in the approval summary)…
    const counted = 'Send email to a@x.com and 2 more — "Hi" (shortened)';
    expect(isShortenedCard(counted, counted)).toBe(true);
    // …as does an outside tool's title, and details where one value was cut.
    const outside = 'Ask outside tool files: write — path: "a" (shortened, see the full request below)';
    expect(isShortenedCard(outside, outside)).toBe(true);
    const value = "To: a…\n\n— shortened — some values are not shown in full.";
    expect(isShortenedCard(value, value)).toBe(true);
  });

  it("the real summary's cuts reach the card: 'and 2 more' recipients loses Approve", async () => {
    const { summarizeApproval } = await import("@lares/agent-kit/approval-summary");
    const prompt = summarizeApproval("gmail_send", { to: ["a@x.com", "b@x.com", "c@x.com"], subject: "Hi" })!;
    const { chat, posted } = fakeChat();
    await onInputRequested({ requests: [{ ...(approvalRequest as Record<string, unknown>), requestId: "req-many", prompt } as never] }, chat);
    expect(buttons(posted[0]!.reply_markup).map((b) => b.text)).toEqual(["Cancel"]);
    expect(posted[0]!.text).toContain("cannot be approved here");
  });

  it("the link goes to the Waiting on you page for this request, and only from an http(s) address", () => {
    expect(waitingPageLink("req-1", { LARES_CONSOLE_URL: "https://console.example.com" })).toBe("https://console.example.com/waiting?request=req-1");
    expect(waitingPageLink("req 1", { LARES_CONSOLE_URL: "https://console.example.com/lares/" })).toBe("https://console.example.com/lares/waiting?request=req+1");
    expect(waitingPageLink("req-1", {})).toBeNull();
    expect(waitingPageLink("req-1", { LARES_CONSOLE_URL: "javascript:alert(1)" })).toBeNull();
    expect(waitingPageLink("req-1", { LARES_CONSOLE_URL: "not a url" })).toBeNull();
  });

  it("over the limit: honest note, the link, Cancel only, and the Approve callback gone from state", async () => {
    process.env["LARES_CONSOLE_URL"] = "https://console.example.com";
    const { chat, posted, state } = fakeChat();
    await onInputRequested({ requests: [longRequest] }, chat);

    expect(posted).toHaveLength(1);
    const text = posted[0]!.text;
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text.endsWith(shortenedCardNote("https://console.example.com/waiting?request=req-long"))).toBe(true);
    expect(text).toContain("cannot be approved here");
    expect(buttons(posted[0]!.reply_markup).map((b) => b.text)).toEqual(["Cancel"]);
    const callbacks = state["hitlCallbacks"] as Record<string, { optionId: string }>;
    expect(Object.values(callbacks).map((c) => c.optionId)).toEqual(["cancel"]);
    expect(Object.keys(callbacks)).toEqual([buttons(posted[0]!.reply_markup)[0]!.callback_data]);
    // The card is still remembered, without the note, so a decision made in the console edits it.
    const card = (state["approvalCards"] as Record<string, { messageId: string; text: string }>)["req-long"]!;
    expect(card.messageId).toBe("100");
    expect(text.startsWith(card.text)).toBe(true);
    expect(card.text).not.toContain("console");
  });

  it("a mail card cut at 2800 is treated the same; with no console address set it says to open the console", async () => {
    const { chat, posted } = fakeChat();
    await onInputRequested({ requests: [summarisedRequest] }, chat);
    expect(posted[0]!.text.endsWith(shortenedCardNote(null))).toBe(true);
    expect(posted[0]!.text).toContain("Open the console to read the whole of it");
    expect(posted[0]!.text).not.toContain("http");
    expect(buttons(posted[0]!.reply_markup).map((b) => b.text)).toEqual(["Cancel"]);
  });

  it("under the limit nothing changes: both buttons, no note", async () => {
    process.env["LARES_CONSOLE_URL"] = "https://console.example.com";
    const { chat, posted } = fakeChat();
    await onInputRequested({ requests: [approvalRequest] }, chat);
    expect(posted[0]!.text).toBe('Dismiss deadline 42 — "already handled"');
    expect(buttons(posted[0]!.reply_markup).map((b) => b.text)).toEqual(["Cancel", "Approve"]);
  });

  it("decided in the console: the card keeps its shortened text, gains the outcome and loses Cancel", async () => {
    const { chat, edits, state } = fakeChat();
    await onInputRequested({ requests: [longRequest] }, chat);
    const card = (state["approvalCards"] as Record<string, { text: string }>)["req-long"]!;
    await onApprovalSettled({ outcome: "approved", requestId: "req-long" }, chat);
    expect(edits).toEqual([{ messageId: "100", replyMarkup: { inline_keyboard: [] }, text: `${card.text}\n\n${APPROVAL_OUTCOME_TEXT.approved}` }]);
  });
});
