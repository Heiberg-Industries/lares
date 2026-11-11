/**
 * Which button taps may reach the agent on Telegram.
 *
 * A tap on an approval card executes a real action. The webhook front door is the first code of
 * ours that sees it, so the check lives there (`lib/telegram-tap-gate.ts`): a tap from anyone who
 * is not an allowed approver is refused BEFORE it is forwarded to the framework.
 *
 * The gate recognises an approval tap by its callback data, so everything here that stands for
 * "an approval tap" is built by the INSTALLED eve's own renderer, not typed in: if eve changes
 * how it encodes a tap, the fixtures change with it and these tests say whether the gate still
 * knows one when it sees one.
 *
 * Two opposite obligations meet in one file, and both are pinned here:
 *
 *   - FAIL CLOSED for a tap. A tap is forwarded only when the gate positively recognises it and
 *     the tapper may make it. A wrong sender, a bot, no sender at all, callback data in no known
 *     lane, a `callback_query` that is not even an object: refused, never forwarded.
 *   - FAIL OPEN for everything that is not a tap. A message, an unreadable body: forwarded
 *     exactly as it arrived, byte for byte.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// The front door's day-boundary half reaches its pool through agent-kit's lazy singleton, which
// needs a live DATABASE_URL. Replacing it lets the ROUTE be exercised end to end.
vi.mock("@lares/agent-kit/db", () => ({
  getPool: () => ({ query: async () => ({ rows: [] }) }),
}));

// The Bot API, at the one seam every Telegram call of ours goes through: the proxied fetch. The
// assertion is which method the door called, with which body — and that it went through THIS
// fetch and no other (egress is sealed; a bare global fetch would never arrive).
const bot = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; body: Record<string, unknown> }>,
  fails: false,
  refuses: false,
}));
vi.mock("@lares/agent-kit/telegram-fetch", () => ({
  telegramFetch: async (url: string | URL, init?: { body?: string }) => {
    bot.calls.push({
      method: String(url).split("/").pop()!,
      body: JSON.parse(init?.body ?? "{}") as Record<string, unknown>,
    });
    if (bot.fails) throw new Error("bot api unreachable");
    if (bot.refuses) {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: query is too old" }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  },
}));

import {
  HITL_CALLBACK_PREFIX,
  refusedApprovalTap,
  refusedTap,
  secretMatches,
  SIGN_IN_CALLBACK_PREFIX,
  TAP_REFUSAL,
  TAP_UNRECOGNISED,
  tapLane,
} from "../lib/telegram-tap-gate.js";
import webhook from "../agent/channels/telegram-webhook.js";

// The front door only ACTS on an update Telegram really sent: it compares the request's secret
// header with the installation's webhook secret, read from a file. Throwaway files stand in.
const FIXTURE_SECRET = "fixture-secret";
const secretDir = mkdtempSync(joinPath(tmpdir(), "webhook-secret-"));
writeFileSync(joinPath(secretDir, "secret"), FIXTURE_SECRET);
writeFileSync(joinPath(secretDir, "token"), "1:abc");
process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"] = joinPath(secretDir, "secret");
process.env["TELEGRAM_BOT_TOKEN_FILE"] = joinPath(secretDir, "token");

const OWNER = 111;
const STRANGER = 222;
const env = { TELEGRAM_PRINCIPAL_ID: String(OWNER) } as NodeJS.ProcessEnv;

// ── An approval card, as the installed eve renders it ────────────────────────────────────
// eve's exports map does not expose these, so they are loaded by file path.
const EVE_TELEGRAM = pathToFileURL(
  fileURLToPath(new URL("../node_modules/eve/dist/src/public/channels/telegram", import.meta.url)),
).href;

interface Button {
  text: string;
  callback_data: string;
}
interface EveHitl {
  TELEGRAM_HITL_CALLBACK_PREFIX: string;
  renderTelegramInteraction(
    request: unknown,
    state: Record<string, unknown>,
  ): { text: string; replyMarkup?: { inline_keyboard: Button[][] } };
}
interface EveState {
  initialTelegramState(botUsername?: string): Record<string, unknown>;
}
interface EveInbound {
  parseTelegramUpdate(update: unknown): { kind: string; callbackQuery?: { data?: string; from: { id: string } } } | null;
}
interface EveAuthorization {
  TELEGRAM_AUTHORIZATION_CALLBACK_PREFIX: string;
}

let hitl: EveHitl;
let eveState: EveState;
let inbound: EveInbound;
let authorization: EveAuthorization;
beforeAll(async () => {
  hitl = (await import(`${EVE_TELEGRAM}/hitl.js`)) as EveHitl;
  eveState = (await import(`${EVE_TELEGRAM}/state.js`)) as EveState;
  inbound = (await import(`${EVE_TELEGRAM}/inbound.js`)) as EveInbound;
  authorization = (await import(`${EVE_TELEGRAM}/authorization.js`)) as EveAuthorization;
});

/** An approval, in the shape eve hands its Telegram renderer: Deny and Approve. */
const approval = (interactionId: string) => ({
  interactionId,
  request: {
    kind: "approval",
    prompt: "Dismiss deadline 42",
    options: [
      { id: "deny", label: "Deny" },
      { id: "approve", label: "Approve" },
    ],
  },
});

/** Posts `cards` approval cards into one chat's state and returns every button eve put on them. */
function eveButtons(cards = 1): { buttons: Button[]; state: Record<string, unknown> } {
  const state = eveState.initialTelegramState("example_bot");
  const buttons: Button[] = [];
  for (let i = 0; i < cards; i += 1) {
    const rendered = hitl.renderTelegramInteraction(approval(`interaction-${i}`), state);
    buttons.push(...rendered.replyMarkup!.inline_keyboard.flat());
  }
  return { buttons, state };
}

/** The update Telegram posts when `fromId` taps a button carrying `data` in the owner's chat. */
const tap = (fromId: number, data: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    update_id: 1,
    callback_query: {
      id: "cb1",
      from: { id: fromId, is_bot: false, first_name: "X" },
      message: { message_id: 7, date: 1, chat: { id: OWNER, type: "private" }, text: "Dismiss deadline 42" },
      chat_instance: "ci",
      ...(data === undefined ? {} : { data }),
      ...over,
    },
  });

describe("an approval tap, in the installed eve's own format", () => {
  it("eve still prefixes a card's callback data the way the gate expects", () => {
    expect(hitl.TELEGRAM_HITL_CALLBACK_PREFIX).toBe(HITL_CALLBACK_PREFIX);
    expect(authorization.TELEGRAM_AUTHORIZATION_CALLBACK_PREFIX).toBe(SIGN_IN_CALLBACK_PREFIX);
  });

  it("every button eve puts on an approval card is recognised as an approval tap", () => {
    // Twenty cards: forty buttons, so the base-36 counter runs past 9 into letters and into two
    // characters (eve:0 … eve:z, eve:10 …). A gate that only knew digits would wave those through.
    const { buttons, state } = eveButtons(20);
    expect(buttons).toHaveLength(40);
    expect(buttons.map((b) => b.callback_data)).toContain("eve:a");
    expect(buttons.map((b) => b.callback_data)).toContain("eve:13");
    for (const button of buttons) {
      expect(tapLane(button.callback_data), button.callback_data).toBe("approval");
    }
    // …and each one really is the key eve resolves an answer from.
    const callbacks = state["hitlCallbacks"] as Record<string, { optionId: string; interactionId: string }>;
    expect(Object.keys(callbacks).sort()).toEqual(buttons.map((b) => b.callback_data).sort());
    expect(callbacks[buttons[1]!.callback_data]).toEqual({ optionId: "approve", interactionId: "interaction-0" });
  });

  it("eve reads the fixture as a button tap carrying that same data", () => {
    const approve = eveButtons().buttons.find((b) => b.text === "Approve")!;
    const parsed = inbound.parseTelegramUpdate(JSON.parse(tap(STRANGER, approve.callback_data)));
    expect(parsed?.kind).toBe("callback_query");
    expect(parsed?.callbackQuery?.data).toBe(approve.callback_data);
    expect(parsed?.callbackQuery?.from.id).toBe(String(STRANGER));
  });

  it("refuses a non-owner's tap on Approve, and on Deny", () => {
    for (const button of eveButtons().buttons) {
      expect(refusedTap(tap(STRANGER, button.callback_data), env), button.text).toEqual({
        callbackQueryId: "cb1",
        chatId: String(OWNER),
        reason: "not-allowed",
      });
    }
  });

  it("lets the owner's own tap through", () => {
    for (const button of eveButtons().buttons) {
      expect(refusedTap(tap(OWNER, button.callback_data), env), button.text).toBeNull();
    }
  });

  it("refusedApprovalTap gives the same verdict in the shape it has always had, without the reason", () => {
    const approve = eveButtons().buttons[1]!.callback_data;
    expect(refusedApprovalTap(tap(STRANGER, approve), env)).toEqual({ callbackQueryId: "cb1", chatId: String(OWNER) });
    expect(refusedApprovalTap(tap(OWNER, "eve2:0"), env)).toEqual({ callbackQueryId: "cb1", chatId: String(OWNER) });
    expect(refusedApprovalTap(tap(OWNER, approve), env)).toBeNull();
    expect(refusedApprovalTap("{not json", env)).toBeNull();
  });
});

describe("who may tap, and what counts as a tap the gate knows", () => {
  const card = () => eveButtons().buttons[1]!.callback_data;

  it("refuses a tap it cannot attribute at all — a card tap with no sender", () => {
    expect(refusedTap(tap(OWNER, card(), { from: undefined }), env)).toMatchObject({ reason: "not-allowed" });
    expect(refusedTap(tap(OWNER, card(), { from: "111" }), env)).toMatchObject({ reason: "not-allowed" });
    expect(refusedTap(tap(OWNER, card(), { from: { is_bot: false } }), env)).toMatchObject({ reason: "not-allowed" });
  });

  it("refuses a bot's tap even when its id is on the list", () => {
    expect(refusedTap(tap(OWNER, card(), { from: { id: OWNER, is_bot: true } }), env)).toMatchObject({ reason: "not-allowed" });
  });

  it("reads a string id, and survives a tap with no chat", () => {
    const raw = JSON.stringify({ callback_query: { id: "cb4", from: { id: String(STRANGER) }, data: card() } });
    expect(refusedTap(raw, env)).toEqual({ callbackQueryId: "cb4", chatId: null, reason: "not-allowed" });
    const owners = JSON.stringify({ callback_query: { id: "cb5", from: { id: String(OWNER) }, data: card() } });
    expect(refusedTap(owners, env)).toBeNull();
  });

  it("admits nobody when the allowlist is unset — fail closed, like every other principal read", () => {
    expect(refusedTap(tap(OWNER, card()), {} as NodeJS.ProcessEnv)).toMatchObject({ reason: "not-allowed" });
    expect(refusedTap(tap(OWNER, card()), { TELEGRAM_PRINCIPAL_ID: "  " } as NodeJS.ProcessEnv)).toMatchObject({ reason: "not-allowed" });
  });

  it("gates eve's sign-in button like a card: an allowed approver only", () => {
    expect(tapLane(`${SIGN_IN_CALLBACK_PREFIX}${OWNER}`)).toBe("sign-in");
    expect(refusedTap(tap(OWNER, `${SIGN_IN_CALLBACK_PREFIX}${OWNER}`), env)).toBeNull();
    expect(refusedTap(tap(STRANGER, `${SIGN_IN_CALLBACK_PREFIX}${OWNER}`), env)).toMatchObject({ reason: "not-allowed" });
  });

  it("never touches the proposal-button lane, which checks identity itself", () => {
    for (const data of ["np:a:61", "np:r:61", "ap:a:7", "ap:r:7"]) {
      expect(tapLane(data)).toBe("proposal");
      expect(refusedTap(tap(STRANGER, data), env), data).toBeNull();
      expect(refusedTap(tap(OWNER, data), env), data).toBeNull();
    }
  });

  it("never touches a message, and never throws on a body it cannot read", () => {
    expect(refusedTap(JSON.stringify({ message: { chat: { id: OWNER }, text: "hei" } }), env)).toBeNull();
    expect(refusedTap(JSON.stringify({ edited_message: { chat: { id: OWNER }, text: "hei" } }), env)).toBeNull();
    expect(refusedTap("{not json", env)).toBeNull();
    expect(refusedTap("", env)).toBeNull();
    expect(refusedTap("null", env)).toBeNull();
    expect(refusedTap("[]", env)).toBeNull();
  });
});

describe("a tap the gate does not recognise is refused, whoever tapped (fail closed)", () => {
  // Callback data in no lane this door knows. If a later eve encoded an approval tap as any of
  // these, the tap must stop here rather than pass unchecked.
  const UNRECOGNISED: Array<[string, unknown]> = [
    ["another prefix", "veto:1"],
    ["a new eve format", "eve2:0"],
    ["eve's prefix with nothing after it", "eve:"],
    ["eve's prefix with something that is not a base-36 number", "eve:0:approve"],
    ["upper case, which eve's counter never produces", "eve:1A"],
    ["a payload instead of an id", 'eve:{"optionId":"approve"}'],
    ["eve's prefix after leading space", " eve:0"],
    ["a sign-in button for something that is not a user id", "eve_auth:abc"],
    ["a proposal button with an unknown action", "np:x:61"],
    ["an empty string", ""],
    ["no data at all", undefined],
    ["data that is not a string", 0],
    ["data that is an object", { optionId: "approve" }],
  ];

  it.each(UNRECOGNISED)("%s: refused for a stranger", (_name, data) => {
    expect(tapLane(data)).toBe("unrecognised");
    expect(refusedTap(tap(STRANGER, data), env)).toMatchObject({ callbackQueryId: "cb1", reason: "not-allowed" });
  });

  it.each(UNRECOGNISED)("%s: refused for the owner too", (_name, data) => {
    expect(refusedTap(tap(OWNER, data), env)).toEqual({
      callbackQueryId: "cb1",
      chatId: String(OWNER),
      reason: "unrecognised",
    });
  });

  it("a callback_query that is not an object is a tap nobody can attribute: refused", () => {
    for (const shape of ['"eve:0"', "42", "true", "[1]"]) {
      const raw = `{"update_id":1,"callback_query":${shape}}`;
      expect(refusedTap(raw, env), shape).toEqual({ callbackQueryId: "", chatId: null, reason: "unrecognised" });
    }
  });

  it("an update carrying BOTH a message and a tap is judged as the tap", () => {
    // eve reads `message` first and would ignore the tap; the gate must not let the one hide the
    // other from it, in case that order ever changes.
    const raw = JSON.stringify({
      message: { message_id: 2, chat: { id: OWNER, type: "private" }, text: "hei" },
      callback_query: { id: "cb9", from: { id: STRANGER }, data: eveButtons().buttons[1]!.callback_data },
    });
    expect(refusedTap(raw, env)).toMatchObject({ callbackQueryId: "cb9", reason: "not-allowed" });
  });
});

describe("the webhook front door, with the tap gate in it", () => {
  const route = webhook.routes.find((r) => r.method === "POST")!;
  const handler = route.handler as unknown as (
    request: Request,
    args: { attachSession: (id: string) => { end: (o?: { reason?: string }) => Promise<unknown> } },
  ) => Promise<Response>;
  const attachSession = () => ({ end: async () => ({ sessionId: "s", deliveryId: "d" }) });
  const approveData = () => eveButtons().buttons.find((b) => b.text === "Approve")!.callback_data;

  function post(body: string): Request {
    return new Request("http://127.0.0.1/eve/v1/telegram", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": FIXTURE_SECRET },
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
    bot.calls.length = 0;
    bot.fails = false;
    bot.refuses = false;
    process.env["TELEGRAM_PRINCIPAL_ID"] = String(OWNER);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["TELEGRAM_PRINCIPAL_ID"];
  });

  it("forwards an allowed approver's tap to eve byte for byte, and answers nothing itself", async () => {
    const forwarded = captureForward();
    const raw = tap(OWNER, approveData());

    const response = await handler(post(raw), { attachSession });

    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    // The pin: the same body, the same headers, the same inner URL as before this gate existed.
    expect(forwarded[0]!.init.body).toBe(raw);
    expect(forwarded[0]!.init.method).toBe("POST");
    expect(forwarded[0]!.init.headers).toEqual({
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": FIXTURE_SECRET,
    });
    expect(bot.calls).toEqual([]);
  });

  it("refuses a stranger's tap on Approve: nothing reaches eve, and the tapper is told so", async () => {
    const forwarded = captureForward();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await handler(post(tap(STRANGER, approveData())), { attachSession });

    expect(response.status).toBe(200); // Telegram must not retry a refused tap.
    expect(forwarded).toEqual([]);
    expect(warned).toHaveBeenCalledTimes(1);
    // One direct Bot API call, through the proxied fetch: the answer to the tap.
    expect(bot.calls).toEqual([
      { method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: TAP_REFUSAL, show_alert: true } },
    ]);
  });

  it("refuses a tap it does not recognise, the owner's included, and says a different thing", async () => {
    const forwarded = captureForward();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await handler(post(tap(OWNER, "eve2:0")), { attachSession });

    expect(response.status).toBe(200);
    expect(forwarded).toEqual([]);
    expect(bot.calls).toEqual([
      { method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: TAP_UNRECOGNISED, show_alert: true } },
    ]);
    // The owner is never told they are not the owner.
    expect(TAP_UNRECOGNISED).not.toBe(TAP_REFUSAL);
  });

  it("leaves a proposal button to its own lane: forwarded untouched, whoever tapped", async () => {
    const forwarded = captureForward();
    const raw = tap(STRANGER, "np:a:61");

    await handler(post(raw), { attachSession });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.init.body).toBe(raw);
    expect(bot.calls).toEqual([]);
  });

  it("still forwards an ordinary message from an unknown sender — the gate never blocks a message", async () => {
    const forwarded = captureForward();
    const raw = JSON.stringify({
      update_id: 9,
      message: { message_id: 2, from: { id: STRANGER }, chat: { id: STRANGER, type: "private" }, text: "hei" },
    });

    const response = await handler(post(raw), { attachSession });

    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.init.body).toBe(raw);
    expect(bot.calls).toEqual([]);
  });

  it("typed text is never a tap: the owner typing 'approve' or '1' is forwarded as the message it is", async () => {
    for (const text of ["approve", "Approve", "1", "yes"]) {
      const forwarded = captureForward();
      const raw = JSON.stringify({
        update_id: 9,
        message: { message_id: 3, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: "private" }, text },
      });
      await handler(post(raw), { attachSession });
      // Forwarded as a `message` update, with no `callback_query` anywhere in it: the door has
      // nothing that could turn it into an answer. (What eve then does with a message while a
      // card waits is the framework's, and the framework patch's.)
      expect(forwarded).toHaveLength(1);
      expect(JSON.parse(String(forwarded[0]!.init.body))).toEqual(JSON.parse(raw));
      expect(String(forwarded[0]!.init.body)).not.toContain("callback_query");
      vi.restoreAllMocks();
    }
  });

  it("still refuses to forward when the Bot API call fails", async () => {
    const forwarded = captureForward();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    bot.fails = true;

    const response = await handler(post(tap(STRANGER, approveData())), { attachSession });

    expect(response.status).toBe(200);
    expect(forwarded).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("logs Telegram's refusal of the answer (an expired tap) and still does not forward", async () => {
    const forwarded = captureForward();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    bot.refuses = true;

    const response = await handler(post(tap(STRANGER, approveData())), { attachSession });

    expect(response.status).toBe(200);
    expect(forwarded).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]![0])).toContain("HTTP 400");
  });

  // ── Only Telegram may make this door ACT ─────────────────────────────────────────────────────
  // The framework's inner route checks the secret header, but it runs AFTER this one. The answer
  // to a refused tap (a Bot API call) and the day-boundary retirement (ending a session) must
  // never happen for a body nobody has authenticated.
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

  it("a stranger's tap that lacks Telegram's secret: no Bot API call, no retirement, and NOT forwarded either", async () => {
    const calls = captureForward();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ended: string[] = [];
    const attach = (id: string) => ({ end: async () => { ended.push(id); return {}; } });

    const response = await handler(forged(tap(STRANGER, approveData())), { attachSession: attach });

    expect(bot.calls).toEqual([]);
    expect(ended).toEqual([]);
    // Fail closed: a tap the gate refuses is not handed on even to be rejected. 401 is what the
    // framework's own route answers a request it cannot verify.
    expect(calls).toEqual([]);
    expect(response.status).toBe(401);
  });

  it("treats a WRONG secret exactly like a missing one", async () => {
    const calls = captureForward();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await handler(forged(tap(STRANGER, approveData()), "not-the-secret"), { attachSession });
    expect(bot.calls).toEqual([]);
    expect(calls).toEqual([]);
    expect(response.status).toBe(401);
  });

  it("an unverified update the gate has nothing against is forwarded, for the framework to reject", async () => {
    const calls = captureForward();
    const ended: string[] = [];
    const attach = (id: string) => ({ end: async () => { ended.push(id); return {}; } });
    const message = JSON.stringify({ update_id: 9, message: { message_id: 2, chat: { id: OWNER, type: "private" }, text: "hei" } });

    await handler(forged(message), { attachSession: attach });
    await handler(forged(tap(OWNER, approveData()), "not-the-secret"), { attachSession: attach });

    expect(calls).toHaveLength(2);
    expect(bot.calls).toEqual([]);
    expect(ended).toEqual([]);
  });

  it("compares the secret without caring about length, and never matches an empty one", () => {
    expect(secretMatches("fixture-secret", "fixture-secret")).toBe(true);
    expect(secretMatches("fixture-secre", "fixture-secret")).toBe(false);
    expect(secretMatches("fixture-secret-and-more", "fixture-secret")).toBe(false);
    expect(secretMatches("", "fixture-secret")).toBe(false);
    expect(secretMatches(null, "fixture-secret")).toBe(false);
    expect(secretMatches("x", "")).toBe(false);
  });
});
