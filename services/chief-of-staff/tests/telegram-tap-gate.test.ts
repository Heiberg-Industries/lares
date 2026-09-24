/**
 * Who may answer an approval card on Telegram (W7A-s3).
 *
 * The framework throws the tapper away: eve's Telegram channel resumes a HITL tap with
 * `.respond([...], { auth: null })`, so by the time a tap reaches the approval machinery there is
 * no identity left to check. The front door is the last place our own code sees the raw update —
 * `callback_query.from.id` and all — so the check lives there.
 *
 * Two opposite obligations meet in one file, and both are pinned here:
 *
 *   - FAIL-CLOSED for a card tap. Anything the gate cannot attribute to an allowed approver is
 *     refused and never forwarded — a wrong sender, a bot, a tap with no sender at all.
 *   - FAIL-OPEN for everything else. A message, a tap on the proposal-button lane (which does its
 *     own identity check, in `lib/proposal-buttons.ts`), an unreadable body: forwarded exactly as
 *     it arrived, byte for byte, as before this gate existed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The front door's day-boundary half reaches its pool through agent-kit's lazy singleton, which
// needs a live DATABASE_URL. Replacing it lets the ROUTE be exercised end to end.
vi.mock("@lares/agent-kit/db", () => ({
  getPool: () => ({ query: async () => ({ rows: [] }) }),
}));

// The one Bot API call this slice makes. Mocked at the module boundary so no credential is ever
// resolved in a test: the assertion is that the door answers the tap, with which words, and
// through which fetch — not what eve's own request builder emits.
const bot = vi.hoisted(() => ({ answered: [] as Record<string, unknown>[], fails: false }));
vi.mock("eve/channels/telegram", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    answerTelegramCallbackQuery: async (input: Record<string, unknown>) => {
      bot.answered.push(input);
      if (bot.fails) throw new Error("bot api unreachable");
      return { ok: true };
    },
  };
});

import { refusedApprovalTap, secretMatches, HITL_CALLBACK_PREFIX, TAP_REFUSAL } from "../lib/telegram-tap-gate.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import webhook from "../agent/channels/telegram-webhook.js";

// The front door only ACTS on an update Telegram really sent: it compares the request's secret
// header with the installation's webhook secret, read from a file. A throwaway file stands in.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
const FIXTURE_SECRET = "fixture-secret";
const secretDir = mkdtempSync(joinPath(tmpdir(), "webhook-secret-"));
writeFileSync(joinPath(secretDir, "secret"), FIXTURE_SECRET);
process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"] = joinPath(secretDir, "secret");


const env = { TELEGRAM_PRINCIPAL_ID: "111" } as NodeJS.ProcessEnv;
const tap = (fromId: number, data: string) =>
  JSON.stringify({
    update_id: 1,
    callback_query: { id: "cb1", from: { id: fromId, is_bot: false }, message: { chat: { id: 111 } }, data },
  });

describe("who may answer an approval card on Telegram", () => {
  it("refuses a card tap from someone who is not an allowed principal", () => {
    expect(refusedApprovalTap(tap(222, `${HITL_CALLBACK_PREFIX}0`), env))
      .toEqual({ callbackQueryId: "cb1", chatId: "111" });
  });

  it("lets the owner's own tap through", () => {
    expect(refusedApprovalTap(tap(111, `${HITL_CALLBACK_PREFIX}0`), env)).toBeNull();
  });

  it("never touches the proposal-button lane, which checks identity itself", () => {
    expect(refusedApprovalTap(tap(222, "np:a:61"), env)).toBeNull();
  });

  it("never touches a message, and never throws on a body it cannot read", () => {
    expect(refusedApprovalTap(JSON.stringify({ message: { chat: { id: 111 }, text: "hei" } }), env)).toBeNull();
    expect(refusedApprovalTap("{not json", env)).toBeNull();
    expect(refusedApprovalTap("", env)).toBeNull();
  });

  it("refuses a tap it cannot attribute at all — a card tap with no sender", () => {
    const raw = JSON.stringify({ callback_query: { id: "cb2", message: { chat: { id: 111 } }, data: "eve:0" } });
    expect(refusedApprovalTap(raw, env)).toEqual({ callbackQueryId: "cb2", chatId: "111" });
  });

  it("refuses a bot's tap even when its id is on the list", () => {
    const raw = JSON.stringify({
      callback_query: { id: "cb3", from: { id: 111, is_bot: true }, message: { chat: { id: 111 } }, data: "eve:1" },
    });
    expect(refusedApprovalTap(raw, env)).toEqual({ callbackQueryId: "cb3", chatId: "111" });
  });

  it("is the HITL lane only — eve's authorization lane (`eve_auth:`) is not a tool approval", () => {
    expect(refusedApprovalTap(tap(222, "eve_auth:abc"), env)).toBeNull();
  });

  it("reads a string id and a base-36 callback id, and survives a tap with no chat", () => {
    const raw = JSON.stringify({
      callback_query: { id: "cb4", from: { id: "222" }, data: `${HITL_CALLBACK_PREFIX}1a` },
    });
    expect(refusedApprovalTap(raw, env)).toEqual({ callbackQueryId: "cb4", chatId: null });
  });

  it("admits nobody when the allowlist is unset — fail-closed, like every other principal read", () => {
    expect(refusedApprovalTap(tap(111, `${HITL_CALLBACK_PREFIX}0`), {} as NodeJS.ProcessEnv))
      .toEqual({ callbackQueryId: "cb1", chatId: "111" });
  });
});

describe("the webhook front door, with the tap gate in it", () => {
  const route = webhook.routes.find((r) => r.method === "POST")!;
  const handler = route.handler as unknown as (
    request: Request,
    args: { attachSession: (id: string) => { reset: (o: { reason: string }) => Promise<unknown> } },
  ) => Promise<Response>;
  const attachSession = () => ({ reset: async () => ({ status: "reset" }) });

  function post(body: string): Request {
    return new Request("http://127.0.0.1/eve/v1/telegram", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "fixture-secret" },
      body,
    });
  }

  /** Captures what the door forwarded to eve's inner route. */
  function captureForward() {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response("ok");
    });
    return calls;
  }

  beforeEach(() => {
    bot.answered.length = 0;
    bot.fails = false;
    process.env["TELEGRAM_PRINCIPAL_ID"] = "111";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["TELEGRAM_PRINCIPAL_ID"];
  });

  // ── Only Telegram may make this door ACT ─────────────────────────────────────────────────────
  // The framework's inner route checks the secret header, but it runs AFTER this one. Before this
  // fix the gate answered through the Bot API, and the day-boundary reset ran, on a body nobody
  // had authenticated (found by the commit security review, 2026-09-20).
  function forged(body: string, secret?: string): Request {
    return new Request("http://127.0.0.1/eve/v1/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret === undefined ? {} : { "x-telegram-bot-api-secret-token": secret }),
      },
      body,
    });
  }

  it("does NOT act on a stranger's tap that lacks Telegram's secret: no Bot API call, no reset — only a forward the framework will reject", async () => {
    const calls = captureForward();
    const resets: string[] = [];
    const attach = (id: string) => ({ reset: async () => { resets.push(id); return { status: "reset" }; } });

    const response = await handler(forged(tap(222, `${HITL_CALLBACK_PREFIX}0`)), { attachSession: attach });

    expect(bot.answered).toEqual([]);
    expect(resets).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(response.status).toBe(200);
  });

  it("treats a WRONG secret exactly like a missing one", async () => {
    const calls = captureForward();
    await handler(forged(tap(222, `${HITL_CALLBACK_PREFIX}0`), "not-the-secret"), { attachSession });
    expect(bot.answered).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("compares the secret without caring about length, and never matches an empty one", () => {
    expect(secretMatches("fixture-secret", "fixture-secret")).toBe(true);
    expect(secretMatches("fixture-secre", "fixture-secret")).toBe(false);
    expect(secretMatches("fixture-secret-and-more", "fixture-secret")).toBe(false);
    expect(secretMatches("", "fixture-secret")).toBe(false);
    expect(secretMatches(null, "fixture-secret")).toBe(false);
    expect(secretMatches("x", "")).toBe(false);
  });

  it("forwards an allowed approver's tap to eve byte for byte, and answers nothing itself", async () => {
    const forwarded = captureForward();
    const raw = tap(111, `${HITL_CALLBACK_PREFIX}0`);

    const response = await handler(post(raw), { attachSession });

    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    // The pin: the same body, the same headers, the same inner URL as before this gate existed.
    expect(forwarded[0]!.init.body).toBe(raw);
    expect(forwarded[0]!.init.method).toBe("POST");
    expect(forwarded[0]!.init.headers).toEqual({
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "fixture-secret",
    });
    expect(bot.answered).toEqual([]);
  });

  it("refuses a stranger's tap: nothing reaches eve, and the tap is told so", async () => {
    const forwarded = captureForward();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await handler(post(tap(222, `${HITL_CALLBACK_PREFIX}0`)), { attachSession });

    expect(response.status).toBe(200); // Telegram must not retry a refused tap.
    expect(forwarded).toEqual([]);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(bot.answered).toHaveLength(1);
    expect(bot.answered[0]).toMatchObject({
      callbackQueryId: "cb1",
      text: TAP_REFUSAL,
      showAlert: true,
      fetch: telegramFetch, // the proxied Bot API fetch, never Node's bare one — egress is sealed
    });
  });

  it("still forwards an ordinary message from an unknown sender — the gate never blocks a message", async () => {
    const forwarded = captureForward();
    const raw = JSON.stringify({
      update_id: 9,
      message: { message_id: 2, from: { id: 222 }, chat: { id: 222, type: "private" }, text: "hei" },
    });

    const response = await handler(post(raw), { attachSession });

    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.init.body).toBe(raw);
    expect(bot.answered).toEqual([]);
  });

  it("still answers the tap when the Bot API call fails, and still refuses to forward", async () => {
    const forwarded = captureForward();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    bot.fails = true;

    const response = await handler(post(tap(222, `${HITL_CALLBACK_PREFIX}0`)), { attachSession });

    expect(response.status).toBe(200);
    expect(forwarded).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
