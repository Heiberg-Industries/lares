/**
 * lib/telegram-send.ts — the Bot API, for code that has no channel handle.
 *
 * Inside a channel handler the framework hands out `ctx.channel.telegram` (send, edit, answer a
 * tap). Three kinds of code run outside one and still have to reach Telegram: a schedule that
 * already holds its final text (a reminder, a proposal announcement, a routed notice), the
 * webhook front door answering a tap it refuses, and the one fixed line sent before an owner's
 * claim is applied. eve 1.0 no longer exports a sender for them, so this is ours: one POST to
 * the Bot API, through the egress proxy.
 *
 * Every call goes through `@lares/agent-kit/telegram-fetch`. The box's network lets nothing else
 * out, so a bare global `fetch` here would simply never arrive.
 *
 * THE TOKEN NEVER LEAVES THIS FILE'S URL. It is part of the request path, so nothing here puts a
 * URL into an error or a log line: a failure reports the method, the HTTP status and Telegram's
 * own `description`, and nothing else.
 */
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Where the bot token comes from. Read on every call, never cached: the door's own credentials
 *  check the door's authority each time they are asked. */
export interface TelegramSendCredentials {
  readonly botToken: string | (() => string | Promise<string>);
}

/** A decoded Bot API answer. `ok` is the HTTP status, as the framework's own handle reports it. */
export interface TelegramApiResult {
  readonly ok: boolean;
  readonly status: number;
  /** The parsed JSON body, the raw text when it is not JSON, or null when there is none. */
  readonly body: unknown;
}

/** The message Telegram is asked to send. `text` is required; anything else Telegram's
 *  `sendMessage` takes (`parse_mode`, `reply_markup`, …) is passed through as it is. */
export interface TelegramSendBody {
  readonly text: string;
  readonly [field: string]: unknown;
}

async function resolveToken(credentials: TelegramSendCredentials): Promise<string> {
  const token = typeof credentials.botToken === "function" ? await credentials.botToken() : credentials.botToken;
  if (typeof token !== "string" || token.length === 0) throw new Error("telegram: the bot token is empty");
  return token;
}

/** Telegram's own words for a failure, or a description of the body when it gave none. */
function describeFailure(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const description = (body as { description?: unknown }).description;
    if (typeof description === "string" && description.length > 0) return description;
    return "no description in the response";
  }
  if (typeof body === "string" && body.length > 0) return body.slice(0, 200);
  return "empty response body";
}

/**
 * One Bot API call by method name. Returns Telegram's answer whatever it was: a refusal is a
 * returned `{ ok: false }`, not an exception. Throws only when the token cannot be read or the
 * request never completes.
 */
export async function callTelegramApi(input: {
  readonly credentials: TelegramSendCredentials;
  readonly method: string;
  readonly body?: Readonly<Record<string, unknown>>;
}): Promise<TelegramApiResult> {
  const token = await resolveToken(input.credentials);
  const response = await telegramFetch(`${TELEGRAM_API_BASE}/bot${token}/${encodeURIComponent(input.method)}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  // Telegram answers a refusal with a non-2xx status AND `ok: false` in the body. Both are read,
  // so a proxy that turned one into the other still cannot make a refusal look like a success.
  const refusedInBody = typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === false;
  return { ok: response.ok && !refusedInBody, status: response.status, body };
}

/**
 * Sends one message and returns its id (empty only if Telegram accepted the send without naming
 * one). Throws when Telegram refuses it, with Telegram's own description, so a schedule's "not
 * sent" path sees why.
 *
 * No splitting: the callers send short, finished text. A text over Telegram's 4096 characters is
 * refused by Telegram and surfaces here as that refusal.
 */
export async function sendTelegramMessage(input: {
  readonly credentials: TelegramSendCredentials;
  readonly chatId: string | number;
  readonly body: TelegramSendBody;
}): Promise<{ id: string }> {
  const result = await callTelegramApi({
    credentials: input.credentials,
    method: "sendMessage",
    body: { ...input.body, chat_id: input.chatId },
  });
  if (!result.ok) {
    throw new Error(`Telegram sendMessage failed with HTTP ${result.status}: ${describeFailure(result.body)}`);
  }
  // A success that names no message is reported as an empty id, not thrown: Telegram accepted
  // the send, and a caller that treated a throw as "not sent" would send it a second time.
  const id = (result.body as { result?: { message_id?: unknown } } | null)?.result?.message_id;
  return { id: typeof id === "number" || typeof id === "string" ? String(id) : "" };
}
