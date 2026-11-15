// A Telegram approval card shows how it ended and loses its buttons once it is settled.
//
// Who does what on eve 1.0.0-rc.9:
//   - eve renders the card, posts it and registers its buttons, in its own `interaction.opened`
//     handler. This door no longer overrides that. (The card's text and button order, and the
//     rule that a card whose text was cut shows no Approve button, belong to the Lares framework
//     patch and its own test.)
//   - this door words the card once the request is settled, in `interaction.settled`.
//
// Three halves:
//   1. eve posts the card, through the real door object — and leaves the message on record where
//      this door's handler looks for it. That record is a field eve keeps for itself, so this is
//      the test that fails if a later eve renames it.
//   2. `onInteractionSettled` words each outcome. Only `accepted` ever reads as approved.
//   3. From card to outcome through the real door: the edit goes out as one `editMessageText`,
//      and it is the only thing the handler does.
//   4. A card eve posted WITHOUT an Approve button (its text was cut) gets a note under it: it
//      cannot be approved here, and here is the console's Waiting on you page for it. The note
//      goes when the request is decided.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionView, foldEvents, INTERACTION_OUTCOMES, type SessionView } from "eve/events";

const calls = vi.hoisted(() => [] as Array<{ method: string; body: Record<string, unknown> }>);
/** Methods Telegram refuses in a test (it answers them 400). */
const refused = vi.hoisted(() => new Set<string>());
vi.mock("@lares/agent-kit/telegram-fetch", () => ({
  telegramFetch: async (url: string, init?: { body?: string }) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
    if (refused.has(method)) {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: refused in this test" }), { status: 400 });
    }
    // Each message sent gets the next id: the first is 41 (a card), the one after it 42 (a note).
    const message_id = 40 + calls.filter((c) => c.method === "sendMessage").length;
    return new Response(JSON.stringify({ ok: true, result: { message_id, chat: { id: 123456789, type: "private" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

const ledger = vi.hoisted(() => ({ answeredVia: async (_id: string): Promise<string | null> => null }));
vi.mock("@lares/agent-kit/approval-ledger", () => ({ answeredVia: (id: string) => ledger.answeredVia(id) }));

import * as doorModule from "../agent/channels/telegram.js";
import {
  APPROVAL_OUTCOME_TEXT,
  APPROVAL_REVISED_TEXT,
  onInteractionSettled,
  onLineCommitted,
  PROMPT_OUTCOME_TEXT,
  SHORTENED_NOTE_CLOSED_TEXT,
  shortenedCardNote,
  waitingPageLink,
} from "../agent/channels/telegram.js";

const OWNER = "123456789";
const ID = "interaction-1";
const PROMPT = 'Dismiss deadline 42 — "already handled"';

const APPROVAL_OPTIONS = [
  { id: "deny", label: "Deny" },
  { id: "approve", label: "Approve" },
];

// ── A session's recorded state, built with eve's own public fold ─────────────────────────
type Event = Record<string, unknown>;
const at = (line: number, event: Event): Event => ({ ...event, meta: { position: { line, index: 0 }, at: "2026-11-11T10:00:00.000Z" } });

const openedEvent = (request: Record<string, unknown>, interactionId = ID): Event =>
  at(3, { type: "interaction.opened", scope: { turnId: "t1" }, data: { interactionId, subject: { callId: "c1" }, request } });

const settledEvent = (outcome: string, extra: Record<string, unknown> = {}, interactionId = ID) =>
  at(4, { type: "interaction.settled", scope: { turnId: "t1" }, data: { interactionId, outcome, ...extra } }) as {
    type: string;
    data: { interactionId: string; outcome: string };
  };

function fold(view: SessionView, events: Event[]): SessionView {
  return foldEvents(view, events as never);
}

/** A session in which the agent asked for one thing and the request is still open. */
function viewAsking(request: Record<string, unknown>, interactionId = ID): { view: SessionView; opened: Event } {
  const opened = openedEvent(request, interactionId);
  const view = fold(emptySessionView(), [
    at(0, { type: "session.started", data: {} }),
    at(1, { type: "turn.started", scope: { turnId: "t1" }, data: { turnId: "t1", cause: { deliveryId: "d1" }, follows: null } }),
    at(2, { type: "call.requested", scope: { turnId: "t1" }, data: { callId: "c1", owner: { turnId: "t1" }, capability: { kind: "tool", name: "deadline_dismiss" }, input: { id: 42 } } }),
    opened,
  ]);
  return { view, opened };
}

const approvalRequest = { kind: "approval", prompt: PROMPT, options: APPROVAL_OPTIONS };

let dir: string;
beforeEach(() => {
  calls.length = 0;
  refused.clear();
  ledger.answeredVia = async () => null;
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

// ── The real door object, driven the way eve drives it ───────────────────────────────────
/** eve's dist, for the internals its exports map does not expose. */
const EVE_DIST = pathToFileURL(fileURLToPath(new URL("../node_modules/eve/dist/src", import.meta.url))).href;

type AdapterHandler = (event: unknown, ctx: unknown) => Promise<void>;
interface RealDoor {
  adapter: Record<string, AdapterHandler | undefined> & {
    state: Record<string, unknown>;
    createAdapterContext(i: { state: unknown; ctx: unknown; session: unknown }): Record<string, unknown>;
  };
}

/**
 * Runs one of the door's event handlers the way eve's runtime does: inside eve's context, on the
 * channel context eve builds from the chat's state (credentials and the proxied fetch included),
 * with the session's tables as of the event.
 */
async function emit(door: RealDoor, state: Record<string, unknown>, event: { type: string }, view: SessionView): Promise<void> {
  const { ContextContainer, contextStorage } = (await import(`${EVE_DIST}/context/container.js`)) as {
    ContextContainer: new () => { set(key: unknown, value: unknown): void };
    contextStorage: { run<R>(store: unknown, fn: () => R): R };
  };
  const { SessionKey } = (await import(`${EVE_DIST}/context/keys.js`)) as { SessionKey: unknown };
  const { sessionTables } = (await import(`${EVE_DIST}/protocol/session-projection/session-view.js`)) as {
    sessionTables(view: SessionView): unknown;
  };
  const container = new ContextContainer();
  container.set(SessionKey, { sessionId: "sess-1", auth: { current: null, initiator: null }, turn: { id: "t1", sequence: 0 } });
  const ctx = door.adapter.createAdapterContext({ state, ctx: undefined, session: undefined });
  const handler = door.adapter[event.type];
  if (handler === undefined) throw new Error(`the door handles no ${event.type}`);
  await contextStorage.run(container, () => handler(event, { ...ctx, view: sessionTables(view), position: { line: 0, index: 0 } }));
}

async function realDoor(): Promise<{ door: RealDoor; state: Record<string, unknown> }> {
  const door = doorModule.default as unknown as RealDoor;
  return { door, state: { ...door.adapter.state, chatId: OWNER, chatType: "private" } };
}

interface PostedPrompts {
  [interactionId: string]: { messageId: string; text: string; options: Array<{ id: string; label: string }> };
}

describe("1. eve posts the card; this door does not", () => {
  it("the door no longer carries a card renderer of its own", () => {
    const exported = doorModule as Record<string, unknown>;
    for (const gone of ["onInputRequested", "onApprovalSettled", "isShortenedCard"]) {
      expect(exported[gone], gone).toBeUndefined();
    }
  });

  it("the door handles eve 1.0's events and none of the removed ones", async () => {
    const { door } = await realDoor();
    for (const name of ["interaction.opened", "interaction.settled", "content.completed", "turn.settled", "session.ended", "committed"]) {
      expect(typeof door.adapter[name], name).toBe("function");
    }
    for (const removed of ["input.requested", "approval.settled", "message.completed", "turn.failed", "session.failed"]) {
      expect(door.adapter[removed], removed).toBeUndefined();
    }
  });

  it("eve posts the card with a button per choice, each carrying eve's own callback data", async () => {
    const { door, state } = await realDoor();
    const { view, opened } = viewAsking(approvalRequest);

    await emit(door, state, opened as { type: string }, view);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("sendMessage");
    expect(calls[0]!.body).toMatchObject({ chat_id: OWNER, text: PROMPT });
    const keyboard = (calls[0]!.body["reply_markup"] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    expect(keyboard.flat().map((b) => b.text).sort()).toEqual(["Approve", "Deny"]);
    expect(keyboard.flat().every((b) => /^eve:[0-9a-z]+$/.test(b.callback_data))).toBe(true);
  });

  it("eve leaves the card on record under the request's id — the record this door's handler reads", async () => {
    // `hitlPrompts` is eve's own field, not part of its public state type. If this fails after an
    // eve bump, `takePostedCard` in agent/channels/telegram.ts no longer finds a card, and decided
    // cards keep their buttons.
    const { door, state } = await realDoor();
    const { view, opened } = viewAsking(approvalRequest);

    await emit(door, state, opened as { type: string }, view);

    expect(state["hitlPrompts"]).toEqual({ [ID]: { messageId: "41", text: PROMPT, options: APPROVAL_OPTIONS } } satisfies PostedPrompts);
  });
});

// ── 2. The handler, on its own ───────────────────────────────────────────────────────────
type Edit = { messageId: string; replyMarkup?: Readonly<Record<string, unknown>>; text: string };

/** A chat in which eve has posted one card, as eve records it. */
function chatWithCard(
  edit: (input: Edit) => Promise<{ ok: boolean; status: number; body?: unknown }> = async () => ({ ok: true, status: 200 }),
  card: Record<string, unknown> = { messageId: "100", text: PROMPT, options: APPROVAL_OPTIONS },
  interactionId = ID,
) {
  const edits: Edit[] = [];
  const state: Record<string, unknown> & { chatId: string | null } = { chatId: OWNER, hitlPrompts: { [interactionId]: card } };
  const channel = {
    state,
    telegram: {
      editMessageText: async (input: Edit) => {
        edits.push(input);
        return edit(input);
      },
      // Only a card with a note under it makes a raw Bot API call (section 4).
      request: async () => ({ ok: true, status: 200 }),
    },
  };
  return { channel, edits, state };
}

/** Settles an approval with `outcome` and runs the handler on a chat holding its card. */
async function settleApproval(outcome: string, extra: Record<string, unknown> = {}) {
  const { view } = viewAsking(approvalRequest);
  const event = settledEvent(outcome, extra);
  const fake = chatWithCard();
  await onInteractionSettled(event, { channel: fake.channel, view: fold(view, [event]) });
  return fake;
}

describe("2. interaction.settled words the card", () => {
  it("accepted: the text stays, ✅ Approved is added, the buttons go", async () => {
    const { edits, state } = await settleApproval("accepted", { response: { optionId: "approve" } });
    expect(edits).toEqual([
      { messageId: "100", replyMarkup: { inline_keyboard: [] }, text: `${PROMPT}\n\n${APPROVAL_OUTCOME_TEXT.approved}` },
    ]);
    expect(APPROVAL_OUTCOME_TEXT.approved).toBe("✅ Approved");
    // The card is forgotten once edited, as eve's own handler forgets it.
    expect(state["hitlPrompts"]).toEqual({});
  });

  it("declined: ✖ Denied is added — the word is Denied, not Cancelled", async () => {
    const { edits } = await settleApproval("declined", { response: { optionId: "deny" } });
    expect(edits[0]!.text).toBe(`${PROMPT}\n\n${APPROVAL_OUTCOME_TEXT.denied}`);
    expect(APPROVAL_OUTCOME_TEXT.denied).toBe("✖ Denied");
    expect(edits[0]!.text).not.toContain("Cancel");
    expect(edits[0]!.replyMarkup).toEqual({ inline_keyboard: [] });
  });

  it.each(["withdrawn", "interrupted"])("%s: nobody decided, so the card says plainly that it was not approved", async (outcome) => {
    const { edits } = await settleApproval(outcome, outcome === "withdrawn" ? { reason: "superseded-by-message" } : {});
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toBe(`${PROMPT}\n\n${APPROVAL_OUTCOME_TEXT.notApproved}`);
    expect(edits[0]!.text).toContain("Not approved");
    expect(edits[0]!.text).not.toContain("✅");
    expect(edits[0]!.replyMarkup).toEqual({ inline_keyboard: [] });
  });

  it("ONLY accepted ever reads as approved — every outcome eve knows, and one it does not", async () => {
    for (const outcome of [...INTERACTION_OUTCOMES, "an-outcome-a-later-eve-adds"]) {
      const { edits } = await settleApproval(outcome);
      expect(edits, outcome).toHaveLength(1);
      const approved = edits[0]!.text.endsWith(APPROVAL_OUTCOME_TEXT.approved);
      expect(approved, outcome).toBe(outcome === "accepted");
      if (outcome !== "accepted") expect(edits[0]!.text, outcome).not.toMatch(/✅|\bApproved\b/);
    }
  });

  it("a card closed because the agent proposed a revised one says so, whichever way eve closed it", async () => {
    ledger.answeredVia = async () => "revised";
    for (const [outcome, line] of [
      ["declined", APPROVAL_OUTCOME_TEXT.denied],
      ["withdrawn", APPROVAL_OUTCOME_TEXT.notApproved],
      ["interrupted", APPROVAL_OUTCOME_TEXT.notApproved],
    ] as const) {
      const { edits } = await settleApproval(outcome);
      expect(edits[0]!.text, outcome).toBe(`${PROMPT}\n\n${line}\n${APPROVAL_REVISED_TEXT}`);
    }
    expect(APPROVAL_REVISED_TEXT).toBe("Revised — see the new card");
  });

  it("the ledger is asked about the request by its id", async () => {
    const asked: string[] = [];
    ledger.answeredVia = async (id) => {
      asked.push(id);
      return null;
    };
    await settleApproval("declined");
    expect(asked).toEqual([ID]);
  });

  it("a denial the owner tapped (not revised) and a failed lookup both keep the plain outcome", async () => {
    ledger.answeredVia = async () => "telegram";
    expect((await settleApproval("declined")).edits[0]!.text.endsWith(APPROVAL_OUTCOME_TEXT.denied)).toBe(true);
    ledger.answeredVia = async () => {
      throw new Error("db down");
    };
    expect((await settleApproval("declined")).edits[0]!.text.endsWith(APPROVAL_OUTCOME_TEXT.denied)).toBe(true);
  });

  it("an approval is never reworded, whatever the ledger says", async () => {
    ledger.answeredVia = async () => "revised";
    const { edits } = await settleApproval("accepted");
    expect(edits[0]!.text.endsWith(APPROVAL_OUTCOME_TEXT.approved)).toBe(true);
  });

  it("a card already settled is not edited again, and a request this chat holds no card for is left alone", async () => {
    const { view } = viewAsking(approvalRequest);
    const event = settledEvent("accepted");
    const settledView = fold(view, [event]);
    const { channel, edits } = chatWithCard();

    await onInteractionSettled(event, { channel, view: settledView });
    await onInteractionSettled(settledEvent("declined"), { channel, view: settledView });
    await onInteractionSettled(settledEvent("accepted", {}, "someone-elses"), { channel, view: settledView });

    expect(edits).toHaveLength(1);
  });

  it("a card at Telegram's limit still gets its outcome: the text is shortened to make room, never refused", async () => {
    const long = "x".repeat(4096);
    const { view } = viewAsking({ ...approvalRequest, prompt: long });
    const event = settledEvent("declined");
    const { channel, edits } = chatWithCard(undefined, { messageId: "100", text: long, options: APPROVAL_OPTIONS });

    await onInteractionSettled(event, { channel, view: fold(view, [event]) });

    expect(edits[0]!.text.length).toBeLessThanOrEqual(4096);
    expect(edits[0]!.text.endsWith(`…\n\n${APPROVAL_OUTCOME_TEXT.denied}`)).toBe(true);
  });

  it("Telegram refusing the edit is logged, never thrown (a throwing handler parks the session)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { view } = viewAsking(approvalRequest);
    const event = settledEvent("accepted");
    const { channel } = chatWithCard(async () => ({ ok: false, status: 400, body: { ok: false, description: "Bad Request: message to edit not found" } }));

    await expect(onInteractionSettled(event, { channel, view: fold(view, [event]) })).resolves.toBeUndefined();

    expect(String(error.mock.calls[0]?.[0])).toContain("HTTP 400: Bad Request: message to edit not found");
    expect(String(error.mock.calls[0]?.[0])).not.toContain("Dismiss deadline");
  });

  it("an edit that throws (network) is logged, never thrown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { view } = viewAsking(approvalRequest);
    const event = settledEvent("accepted");
    const { channel } = chatWithCard(async () => {
      throw new Error("proxy down");
    });
    await expect(onInteractionSettled(event, { channel, view: fold(view, [event]) })).resolves.toBeUndefined();
  });

  it("a record that is missing or not shaped as expected means no card: nothing is edited, nothing throws, and it is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { view } = viewAsking(approvalRequest);
    const event = settledEvent("accepted");
    const settledView = fold(view, [event]);
    const shapes: unknown[] = [undefined, null, "cards", [], { [ID]: null }, { [ID]: { text: PROMPT } }, { [ID]: { messageId: 100, text: PROMPT } }, { [ID]: { messageId: "", text: PROMPT } }, { [ID]: { messageId: "100" } }];
    for (const hitlPrompts of shapes) {
      const edits: Edit[] = [];
      const channel = {
        state: { chatId: OWNER, hitlPrompts } as { chatId: string | null },
        telegram: {
          editMessageText: async (input: Edit) => { edits.push(input); return { ok: true, status: 200 }; },
          request: async () => ({ ok: true, status: 200 }),
        },
      };
      await expect(onInteractionSettled(event, { channel, view: settledView })).resolves.toBeUndefined();
      expect(edits, JSON.stringify(hitlPrompts)).toEqual([]);
    }
    expect(warn).toHaveBeenCalledTimes(shapes.length);
    expect(String(warn.mock.calls[0]![0])).toContain("no posted card on record");
  });

  describe("a card that is not an approval", () => {
    const question = {
      kind: "question",
      prompt: "Which day?",
      options: [
        { id: "mon", label: "Monday" },
        { id: "tue", label: "Tuesday" },
      ],
    };
    const questionCard = { messageId: "100", text: "Which day?", options: question.options };

    it("answered: says which button, and never 'Approved'", async () => {
      const { view } = viewAsking(question);
      const event = settledEvent("accepted", { response: { optionId: "tue" } });
      const { channel, edits } = chatWithCard(undefined, questionCard);
      await onInteractionSettled(event, { channel, view: fold(view, [event]) });
      expect(edits[0]!.text).toBe(`Which day?\n\n${PROMPT_OUTCOME_TEXT.answered}: Tuesday`);
      expect(edits[0]!.replyMarkup).toEqual({ inline_keyboard: [] });
    });

    it("closed without an answer: 'No longer needed', and the ledger is not consulted", async () => {
      const asked: string[] = [];
      ledger.answeredVia = async (id) => {
        asked.push(id);
        return "revised";
      };
      const { view } = viewAsking(question);
      const event = settledEvent("withdrawn");
      const { channel, edits } = chatWithCard(undefined, questionCard);
      await onInteractionSettled(event, { channel, view: fold(view, [event]) });
      expect(edits[0]!.text).toBe(`Which day?\n\n${PROMPT_OUTCOME_TEXT.closed}`);
      expect(asked).toEqual([]);
    });

    it("a card whose request the session no longer holds is closed without calling it approved", async () => {
      // The view knows nothing about this id, so the kind cannot be told. `accepted` must still
      // not read as an approval.
      const event = settledEvent("accepted", {}, "unknown-to-the-view");
      const { channel, edits } = chatWithCard(undefined, { messageId: "100", text: PROMPT, options: APPROVAL_OPTIONS }, "unknown-to-the-view");
      await onInteractionSettled(event, { channel, view: emptySessionView() });
      expect(edits[0]!.text).toBe(`${PROMPT}\n\n${PROMPT_OUTCOME_TEXT.answered}`);
      expect(edits[0]!.text).not.toMatch(/✅|\bApproved\b/);
    });
  });
});

describe("3. from card to outcome, through the real door", () => {
  async function cardThenSettle(outcome: string, extra: Record<string, unknown> = {}) {
    const { door, state } = await realDoor();
    const { view, opened } = viewAsking(approvalRequest);
    await emit(door, state, opened as { type: string }, view);
    const event = settledEvent(outcome, extra);
    await emit(door, state, event, fold(view, [event]));
    return { state };
  }

  it("Approve: the card eve posted is edited in place, in the card's chat, with an empty keyboard", async () => {
    const { state } = await cardThenSettle("accepted", { response: { optionId: "approve" } });

    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(calls[1]!.body).toEqual({
      chat_id: OWNER,
      message_id: 41,
      reply_markup: { inline_keyboard: [] },
      text: `${PROMPT}\n\n${APPROVAL_OUTCOME_TEXT.approved}`,
    });
    expect(state["hitlPrompts"]).toEqual({});
  });

  it("Deny: the same edit, with ✖ Denied", async () => {
    await cardThenSettle("declined", { response: { optionId: "deny" } });
    expect(calls[1]!.body["text"]).toBe(`${PROMPT}\n\n${APPROVAL_OUTCOME_TEXT.denied}`);
  });

  it.each(["withdrawn", "interrupted"])("%s: the handler edits the card and does nothing else", async (outcome) => {
    await cardThenSettle(outcome);
    // One Bot API call after the card itself: the edit. No message sent, no tap answered, nothing
    // resumed — the handler has no way to run anything, and it does not say "Approved".
    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText"]);
    expect(calls[1]!.body["text"]).toBe(`${PROMPT}\n\n${APPROVAL_OUTCOME_TEXT.notApproved}`);
    expect(calls[1]!.body["reply_markup"]).toEqual({ inline_keyboard: [] });
  });
});

// ── 4. A card that could not show everything points to the console ───────────────────────
//
// The framework patch leaves Approve off a card whose text was cut: nobody approves what they
// cannot read. On its own that leaves a card with only Deny and no word about where it CAN be
// approved. The door adds that word under the card, once eve has posted it: the console's Waiting
// on you page for this request, from `LARES_CONSOLE_URL`.
describe("4. a card that could not show everything points to the console", () => {
  const CONSOLE = "https://console.example.com";
  const LINK = `${CONSOLE}/waiting?request=${ID}`;

  // Three ways a card ends up without Approve, each rendered by the installed, patched eve.
  const overTheLimit = { ...approvalRequest, prompt: `Send this reply: ${"word ".repeat(1200)}` };
  const summaryShortened = { ...approvalRequest, prompt: "Send mail to someone@example.com\n\nBody: …\n\n— shortened — 1234 characters are not shown." };
  const titleShortened = { ...approvalRequest, prompt: 'Send email to a@x.example and 2 more — "Hi" (shortened)' };

  /** eve's own dispatcher, which picks the per-line handler for a committed line. */
  async function commitLine(door: RealDoor, state: Record<string, unknown>, facts: Event[], view: SessionView): Promise<void> {
    const { callAdapterEventHandler } = (await import(`${EVE_DIST}/channel/adapter.js`)) as {
      callAdapterEventHandler(adapter: unknown, event: unknown, ctx: unknown): Promise<void>;
    };
    const { ContextContainer, contextStorage } = (await import(`${EVE_DIST}/context/container.js`)) as {
      ContextContainer: new () => { set(key: unknown, value: unknown): void };
      contextStorage: { run<R>(store: unknown, fn: () => R): R };
    };
    const { SessionKey } = (await import(`${EVE_DIST}/context/keys.js`)) as { SessionKey: unknown };
    const { sessionTables } = (await import(`${EVE_DIST}/protocol/session-projection/session-view.js`)) as {
      sessionTables(view: SessionView): unknown;
    };
    const container = new ContextContainer();
    container.set(SessionKey, { sessionId: "sess-1", auth: { current: null, initiator: null }, turn: { id: "t1", sequence: 0 } });
    const ctx = door.adapter.createAdapterContext({ state, ctx: undefined, session: undefined });
    await contextStorage.run(container, () =>
      callAdapterEventHandler(door.adapter, { facts, position: 3 }, { ...ctx, view: sessionTables(view), position: { line: 3, index: 0 }, scope: undefined }),
    );
  }

  /** One stored line, delivered the way eve delivers it: each fact's handler, then the line's. */
  async function deliverOpened(request: Record<string, unknown>) {
    const { door, state } = await realDoor();
    const { view, opened } = viewAsking(request);
    await emit(door, state, opened as { type: string }, view);
    await commitLine(door, state, [opened], view);
    return { door, state, view, opened };
  }

  const sends = () => calls.filter((c) => c.method === "sendMessage");
  const buttons = (call: { body: Record<string, unknown> }) =>
    (call.body["reply_markup"] as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard.flat().map((b) => b.text);

  describe("the link", () => {
    it("goes to the Waiting on you page for this request, and only from an http(s) address", () => {
      expect(waitingPageLink("req-1", { LARES_CONSOLE_URL: "https://console.example.com" })).toBe("https://console.example.com/waiting?request=req-1");
      expect(waitingPageLink("req 1", { LARES_CONSOLE_URL: "https://console.example.com/lares/" })).toBe("https://console.example.com/lares/waiting?request=req+1");
      expect(waitingPageLink("req-1", { LARES_CONSOLE_URL: "  https://console.example.com  " })).toBe("https://console.example.com/waiting?request=req-1");
      expect(waitingPageLink("req-1", {})).toBeNull();
      expect(waitingPageLink("req-1", { LARES_CONSOLE_URL: "   " })).toBeNull();
      expect(waitingPageLink("req-1", { LARES_CONSOLE_URL: "javascript:alert(1)" })).toBeNull();
      expect(waitingPageLink("req-1", { LARES_CONSOLE_URL: "not a url" })).toBeNull();
    });

    it("the note says it cannot be approved here, where it can, and that Deny still works", () => {
      const withLink = shortenedCardNote(LINK);
      expect(withLink).toContain("cannot be approved here");
      expect(withLink).toContain(`approve it in the console: ${LINK}`);
      expect(withLink).toContain("Deny still works here.");
      const without = shortenedCardNote(null);
      expect(without).toContain("Open the console to read the whole of it and approve it there.");
      expect(without).not.toContain("http");
      expect(without).toContain("Deny still works here.");
    });
  });

  describe("through the real door, on the card the patched eve posts", () => {
    it.each([
      ["a draft over Telegram's limit", overTheLimit],
      ["a draft the approval summary shortened itself", summaryShortened],
      ["a title that left something out", titleShortened],
    ])("%s: Deny only on the card, and under it the note with the link to this request", async (_name, request) => {
      process.env["LARES_CONSOLE_URL"] = CONSOLE;
      const { state } = await deliverOpened(request);

      expect(sends()).toHaveLength(2);
      // The card, as eve posted it: no Approve.
      expect(buttons(sends()[0]!)).toEqual(["Deny"]);
      // The note: a plain message of its own in the same chat, with no buttons.
      expect(sends()[1]!.body).toEqual({ chat_id: OWNER, text: shortenedCardNote(LINK) });
      expect(String(sends()[1]!.body["text"])).toContain(LINK);
      // Remembered under the door's own key, by request.
      expect(state["laresShortenedCardNotes"]).toEqual({ [ID]: "42" });
    });

    it("with no console address set it says to open the console, and carries no link", async () => {
      await deliverOpened(overTheLimit);
      expect(sends()).toHaveLength(2);
      expect(sends()[1]!.body["text"]).toBe(shortenedCardNote(null));
      expect(String(sends()[1]!.body["text"])).not.toContain("http");
    });

    it("a card that shows everything keeps both buttons and gets no note", async () => {
      process.env["LARES_CONSOLE_URL"] = CONSOLE;
      const { state } = await deliverOpened(approvalRequest);
      expect(sends()).toHaveLength(1);
      expect(buttons(sends()[0]!).sort()).toEqual(["Approve", "Deny"]);
      expect(state["laresShortenedCardNotes"]).toBeUndefined();
    });

    it("the note is posted once, however many times the line is delivered", async () => {
      process.env["LARES_CONSOLE_URL"] = CONSOLE;
      const { door, state, view, opened } = await deliverOpened(overTheLimit);
      await commitLine(door, state, [opened], view);
      await commitLine(door, state, [opened], view);
      expect(sends()).toHaveLength(2);
    });

    it("a question with buttons is not an approval: no note, whatever its text says", async () => {
      process.env["LARES_CONSOLE_URL"] = CONSOLE;
      await deliverOpened({ kind: "question", prompt: "Which day? — shortened —", options: [{ id: "mon", label: "Monday" }, { id: "tue", label: "Tuesday" }] });
      expect(sends()).toHaveLength(1);
    });

    it("a line that opened nothing posts nothing", async () => {
      const { door, state } = await realDoor();
      const { view } = viewAsking(approvalRequest);
      await commitLine(door, state, [at(5, { type: "turn.started", data: { turnId: "t2", cause: { deliveryId: "d2" }, follows: "t1" } })], view);
      expect(calls).toEqual([]);
    });

    it("decided: the card gets its outcome and the note is taken away", async () => {
      process.env["LARES_CONSOLE_URL"] = CONSOLE;
      const { door, state, view } = await deliverOpened(overTheLimit);
      const event = settledEvent("declined", { response: { optionId: "deny" } });
      calls.length = 0;

      await emit(door, state, event, fold(view, [event]));

      expect(calls.map((c) => c.method)).toEqual(["deleteMessage", "editMessageText"]);
      expect(calls[0]!.body).toEqual({ chat_id: OWNER, message_id: 42 });
      // The card keeps its own text (never the note's) and gains the outcome.
      expect(calls[1]!.body).toMatchObject({ chat_id: OWNER, message_id: 41, reply_markup: { inline_keyboard: [] } });
      expect(String(calls[1]!.body["text"]).endsWith(`\n\n${APPROVAL_OUTCOME_TEXT.denied}`)).toBe(true);
      expect(String(calls[1]!.body["text"])).not.toContain("console");
      expect(state["laresShortenedCardNotes"]).toEqual({});
    });

    it("decided in the console: approved there, the card says so and the note goes", async () => {
      process.env["LARES_CONSOLE_URL"] = CONSOLE;
      const { door, state, view } = await deliverOpened(summaryShortened);
      const event = settledEvent("accepted", { response: { optionId: "approve" } });
      calls.length = 0;

      await emit(door, state, event, fold(view, [event]));

      expect(calls.map((c) => c.method)).toEqual(["deleteMessage", "editMessageText"]);
      expect(String(calls[1]!.body["text"]).endsWith(`\n\n${APPROVAL_OUTCOME_TEXT.approved}`)).toBe(true);
    });

    it("a note Telegram will no longer delete is changed to say the request is closed", async () => {
      process.env["LARES_CONSOLE_URL"] = CONSOLE;
      const { door, state, view } = await deliverOpened(overTheLimit);
      const event = settledEvent("withdrawn");
      calls.length = 0;
      refused.add("deleteMessage");

      await emit(door, state, event, fold(view, [event]));

      expect(calls.map((c) => c.method)).toEqual(["deleteMessage", "editMessageText", "editMessageText"]);
      expect(calls[1]!.body).toEqual({ chat_id: OWNER, message_id: 42, text: SHORTENED_NOTE_CLOSED_TEXT });
      expect(String(calls[2]!.body["text"]).endsWith(APPROVAL_OUTCOME_TEXT.notApproved)).toBe(true);
    });

    it("a note that cannot be sent costs one log line: the card is up, and nothing throws", async () => {
      process.env["LARES_CONSOLE_URL"] = CONSOLE;
      const { door, state } = await realDoor();
      const { view, opened } = viewAsking(overTheLimit);
      await emit(door, state, opened as { type: string }, view);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      refused.add("sendMessage");

      await expect(commitLine(door, state, [opened], view)).resolves.toBeUndefined();

      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]![0])).toContain("could not say where a shortened request can be approved");
      expect(state["laresShortenedCardNotes"]).toBeUndefined();
    });
  });

  describe("the handler on its own: when it cannot tell, it says nothing", () => {
    type Fact = { readonly type: string; readonly data?: unknown };
    const openedFact = openedEvent(overTheLimit) as Fact;
    const posts: string[] = [];
    const channelWith = (state: Record<string, unknown>) => ({
      state: { chatId: OWNER, ...state } as { chatId: string | null },
      telegram: { post: async (m: string) => { posts.push(m); return { id: "900" }; } },
    });
    const card = { [ID]: { messageId: "100", text: "cut…(truncated)", options: APPROVAL_OPTIONS } };
    beforeEach(() => {
      posts.length = 0;
    });

    it("posts the note when the card is on record and only Deny was registered for it", async () => {
      await onLineCommitted({ facts: [openedFact] }, { channel: channelWith({ hitlPrompts: card, hitlCallbacks: { "eve:0": { interactionId: ID, optionId: "deny" } } }) });
      expect(posts).toEqual([shortenedCardNote(null)]);
    });

    it.each([
      ["Approve was registered: the card is whole", { hitlPrompts: card, hitlCallbacks: { "eve:0": { interactionId: ID, optionId: "deny" }, "eve:1": { interactionId: ID, optionId: "approve" } } }],
      ["no card on record: eve did not post one here", { hitlCallbacks: { "eve:0": { interactionId: ID, optionId: "deny" } } }],
      ["no buttons on record for this request", { hitlPrompts: card, hitlCallbacks: { "eve:0": { interactionId: "another", optionId: "deny" } } }],
      ["no button record at all", { hitlPrompts: card }],
      ["a button record of another shape", { hitlPrompts: card, hitlCallbacks: ["eve:0"] }],
      ["nothing in the state", {}],
    ])("%s — no note", async (_name, state) => {
      await onLineCommitted({ facts: [openedFact] }, { channel: channelWith(state as Record<string, unknown>) });
      expect(posts).toEqual([]);
    });

    it("an approval that never offered Approve is not 'shortened'", async () => {
      const denyOnly = openedEvent({ kind: "approval", prompt: PROMPT, options: [{ id: "deny", label: "Deny" }] }) as Fact;
      await onLineCommitted({ facts: [denyOnly] }, { channel: channelWith({ hitlPrompts: card, hitlCallbacks: { "eve:0": { interactionId: ID, optionId: "deny" } } }) });
      expect(posts).toEqual([]);
    });

    it("facts of other kinds, and facts it cannot read, are passed over without throwing", async () => {
      const facts = [{ type: "turn.started" }, { type: "interaction.opened" }, { type: "interaction.opened", data: null }, { type: "interaction.opened", data: { interactionId: 7 } }];
      await expect(onLineCommitted({ facts }, { channel: channelWith({ hitlPrompts: card, hitlCallbacks: { "eve:0": { interactionId: ID, optionId: "deny" } } }) })).resolves.toBeUndefined();
      expect(posts).toEqual([]);
    });
  });
});
