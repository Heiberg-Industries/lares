// A tap on a card whose session can no longer answer — what the person sees.
//
// Until eve 1.0 this was a Lares framework patch: eve gave a dead button no feedback at all, and
// the patch answered the tap with a notice. eve 1.0.0-rc.9 handles the dead card itself, so the
// patch is dropped and this file pins what eve does instead, through the chief of staff's real
// Telegram door:
//
//   - THE SESSION IS GONE (it ended, or its owner is stranded): eve replaces the card's keyboard
//     with nothing, adds "No longer active" under the card's text, and tells the tapper to send a
//     new message.
//   - THE ANSWER ARRIVED: the tap is acknowledged with "Answer received."
//
// THE ACCEPTED GAP, written down so nobody takes the toast at its word:
//   - A PASSING FAILURE (the database is down, the call timed out): eve logs the failure, leaves
//     the card as it is, and STILL answers the tap with "Answer received." — although the answer
//     was not received. Nothing ran; the card's buttons still work, so tapping again once the
//     fault has passed does deliver the answer. The dropped patch quoted the real reason to the
//     tapper. That loss was accepted for the upgrade; the last test below pins the behaviour so a
//     later eve that fixes (or worsens) it is noticed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ method: string; body: Record<string, unknown> }>);
vi.mock("@lares/agent-kit/telegram-fetch", () => ({
  telegramFetch: async (url: string, init?: { body?: string }) => {
    calls.push({ method: String(url).split("/").pop()!, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { "content-type": "application/json" } });
  },
}));
vi.mock("@lares/agent-kit/db", () => ({
  getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));

const OWNER = "123456789";
const SECRET = "hook-secret";
const CARD_TEXT = 'Dismiss deadline 42 — "already handled"';

/** eve's dist, for the internals its exports map does not expose. */
const EVE_DIST = pathToFileURL(fileURLToPath(new URL("../node_modules/eve/dist/src", import.meta.url))).href;

/** The owner taps Approve on a card. `message.text` is the card as Telegram shows it. */
const tap = (message: Record<string, unknown> = { text: CARD_TEXT }) =>
  JSON.stringify({
    update_id: 1,
    callback_query: {
      id: "cb1",
      from: { id: Number(OWNER), is_bot: false, first_name: "X" },
      message: { message_id: 7, date: 1, chat: { id: Number(OWNER), type: "private" }, ...message },
      chat_instance: "ci",
      data: "eve:1",
    },
  });

let dir: string;
beforeEach(() => {
  calls.length = 0;
  dir = mkdtempSync(join(tmpdir(), "inactive-tap-"));
  process.env["TELEGRAM_PRINCIPAL_ID"] = OWNER;
  writeFileSync(join(dir, "token"), "1:abc\n");
  writeFileSync(join(dir, "secret"), `${SECRET}\n`);
  process.env["TELEGRAM_BOT_TOKEN_FILE"] = join(dir, "token");
  process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"] = join(dir, "secret");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ["TELEGRAM_PRINCIPAL_ID", "TELEGRAM_BOT_TOKEN_FILE", "TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"]) delete process.env[k];
  vi.restoreAllMocks();
});

type RouteHandler = (request: Request, ctx: unknown) => Promise<Response>;

/** POSTs the tap to the door's own route. `respond` stands for the session the answer goes to. */
async function tapWith(respond: () => Promise<unknown>, body: string = tap()) {
  const door = (await import("../agent/channels/telegram.js")).default as unknown as {
    routes: Array<{ method: string; handler: RouteHandler }>;
  };
  const pending: Promise<unknown>[] = [];
  const res = await door.routes.find((r) => r.method === "POST")!.handler(
    new Request("http://x/inner", { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET, "content-type": "application/json" }, body }),
    { from: () => ({ respond }), resolveSession: async () => undefined, waitUntil: (p: Promise<unknown>) => pending.push(p), attachSession: undefined },
  );
  await Promise.all(pending);
  return res;
}

async function sessionNotActive(): Promise<Error> {
  const { SessionNotActiveError } = (await import(`${EVE_DIST}/channel/session-not-active-error.js`)) as {
    SessionNotActiveError: new () => Error;
  };
  return new SessionNotActiveError();
}

const answer = () => calls.find((c) => c.method === "answerCallbackQuery");

describe("a tap on an approval card, as eve 1.0 answers it", () => {
  it("the answer arrived: the tap is acknowledged and the card is left for interaction.settled to word", async () => {
    const res = await tapWith(async () => ({ sessionId: "s", deliveryId: "d" }));
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: "Answer received." } }]);
  });

  it("the session is gone: the card loses its buttons and says 'No longer active'", async () => {
    const gone = await sessionNotActive();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await tapWith(async () => {
      throw gone;
    });

    const edit = calls.find((c) => c.method === "editMessageText");
    expect(edit?.body).toEqual({
      chat_id: OWNER,
      message_id: 7,
      reply_markup: { inline_keyboard: [] },
      text: `${CARD_TEXT}\n\nNo longer active`,
    });
  });

  it("the session is gone: the tapper is told to send a new message, not that the answer was received", async () => {
    const gone = await sessionNotActive();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await tapWith(async () => {
      throw gone;
    });

    expect(answer()?.body).toEqual({
      callback_query_id: "cb1",
      text: "This request is no longer active. Send a new message to start again.",
    });
    expect(calls.map((c) => c.method).sort()).toEqual(["answerCallbackQuery", "editMessageText"]);
  });

  it("the session is gone and the card has no text Telegram sent back: only the keyboard is removed", async () => {
    const gone = await sessionNotActive();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await tapWith(async () => {
      throw gone;
    }, tap({}));

    expect(calls.find((c) => c.method === "editMessageReplyMarkup")?.body).toEqual({
      chat_id: OWNER,
      message_id: 7,
      reply_markup: { inline_keyboard: [] },
    });
    expect(calls.some((c) => c.method === "editMessageText")).toBe(false);
  });
});

describe("the accepted gap: a passing failure still toasts 'Answer received.'", () => {
  it.each([
    ["the database is down", new Error("connect ECONNREFUSED 10.0.0.5:5432")],
    ["the call timed out", new Error("operation timed out after 10000ms")],
  ])("%s: eve logs it, leaves the card alone, and tells the tapper the answer was received", async (_name, fault) => {
    await tapWith(async () => {
      throw fault;
    });

    // KNOWN GAP. The answer was NOT received: `respond` threw. eve's toast says otherwise.
    expect(answer()?.body).toEqual({ callback_query_id: "cb1", text: "Answer received." });
    // The card is untouched — its buttons still work, so a second tap can still deliver.
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
  });
});
