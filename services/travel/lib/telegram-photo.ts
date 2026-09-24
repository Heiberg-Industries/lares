// lib/telegram-photo.ts — real multipart photo upload to Telegram's sendPhoto method.
//
// Fix Wave B, Finding 3. `agent/tools/predeparture_pack.ts` originally claimed eve has no
// send-side photo primitive at all — not quite right: `callTelegramApi` (eve's own JSON-body
// Bot API call) genuinely can't do MULTIPART BYTE UPLOAD, which is the actual blocker for
// sending Google Places' own photo bytes (their media URL must never leave this process — see
// `lib/google-places.ts`'s own doc comment on `.photo()`). This file fills that specific gap,
// mirroring old Marcel's `services/marcel/lib/telegram.ts:126-149` (`sendPhoto`): a real
// `FormData`/`Blob` multipart upload, HTML caption with a plain-text fallback on rejection.
//
// Uses `undici`'s own `FormData` (matches the plan's explicit instruction; both this repo and
// `lib/telegram-fetch.ts` already depend on `undici`) — `undici` does NOT export a `Blob`
// (verified against its actual module exports: only `FormData`/`fetch`/etc.), so the blob part
// is built from the platform's global `Blob`, which is exactly what `undici`'s `FormData` is
// designed to accept (both implement the same web-standard interfaces). Takes a `fetch`
// implementation as an explicit parameter so callers route it through `telegramFetch` (the
// squid-proxied seam every other outbound Telegram/Google call in this codebase uses) — this
// file does no proxying/credential-reading of its own.
import { FormData as UndiciFormData } from "undici";
import { resolveTelegramBotToken, type TelegramBotToken } from "eve/channels/telegram";

// --- markdown -> Telegram HTML, duplicated deliberately -----------------------------------
// Same logic as agent/schedules/trip-lifecycle.ts's own toTelegramHtml/toPlain (itself ported
// from services/marcel/lib/text.ts) — duplicated here rather than imported, matching this
// codebase's own established convention of keeping small per-file helpers self-contained
// rather than crossing the channel/schedule/lib module boundaries for a few lines of text
// formatting (e.g. `dataRoot()` is duplicated the same way across nearly every tool file).
//
// The inline-code placeholder below uses the TEXT ESCAPE SEQUENCE "\u0000" (six source
// characters — a real NUL character at runtime), never a literal raw NUL byte in the source —
// the same fix the review already applied elsewhere in this codebase (a raw byte makes a file
// opaque to `git diff`).

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const CODE_PLACEHOLDER = "\u0000";

function toPlainCaption(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`{1,3}/g, "")
    .trim();
}

function toTelegramHtmlCaption(md: string): string {
  let s = md.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]!);
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    codes.push(body);
    return `${CODE_PLACEHOLDER}${codes.length - 1}${CODE_PLACEHOLDER}`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/"/g, "%22")}">${label}</a>`);
  s = s.replace(/(\*\*|__)(.+?)\1/g, "<b>$2</b>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>");
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(new RegExp(`${CODE_PLACEHOLDER}(\\d+)${CODE_PLACEHOLDER}`, "g"), (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
  return s.trim();
}

export interface SendTelegramPhotoInput {
  readonly chatId: number | string;
  /** Raw image bytes — never a URL (see this file's own top-of-file doc comment on why). */
  readonly photo: Uint8Array;
  readonly filename?: string;
  /** Markdown caption, converted to Telegram HTML with a plain-text fallback on rejection —
   *  same behavior as old Marcel's `sendPhoto`. Omit for no caption. Ignored when
   *  `captionHtml` is also given. */
  readonly caption?: string;
  /** Pre-rendered Telegram HTML caption (e.g. from a caller that already builds HTML directly,
   *  like `agent/tools/predeparture_pack.ts`'s `composeStopMessage`) — sent as-is with
   *  `parse_mode: "HTML"`, never re-escaped/re-converted (that would double-encode already
   *  real `<b>`/`<a href>` tags). Falls back to a tag-stripped plain-text retry on rejection,
   *  same as the markdown path. Takes precedence over `caption` when both are given. */
  readonly captionHtml?: string;
  readonly apiBaseUrl?: string;
  readonly botToken?: TelegramBotToken;
  /** REQUIRED, deliberately no default (review fix, Minor-bundled-as-safety-bug): a probe
   *  against Node's global `fetch` showed the SAME multipart-construction code silently
   *  serializes `undici`'s `FormData` as the literal string `"[object FormData]"` with
   *  `content-type: text/plain` — no multipart, no thrown error, silent wire corruption
   *  Telegram would simply reject (or worse, half-accept) with no signal pointing back here.
   *  Every real call site in this codebase already passes `telegramFetch` (the squid-proxied
   *  seam every other outbound Telegram/Google call uses), so today this was safe by
   *  coincidence, not by contract — a future call site that forgets to pass it would fail
   *  silently in production. Making this required turns that into a compile-time error
   *  instead. */
  readonly fetch: typeof fetch;
}

export interface SendTelegramPhotoResult {
  readonly id: string;
  readonly raw: unknown;
}

/** One `sendPhoto` HTTP attempt — `FormData` is single-use across some fetch implementations,
 *  so a fresh one is built per attempt, matching old Marcel's own doc comment
 *  (`services/marcel/lib/telegram.ts:127`). */
async function attempt(
  input: SendTelegramPhotoInput,
  token: string,
  caption: { text: string; html: boolean } | undefined,
): Promise<SendTelegramPhotoResult> {
  const fetchFn = input.fetch;
  const form = new UndiciFormData();
  form.append("chat_id", String(input.chatId));
  // `Uint8Array<ArrayBufferLike>` (a Buffer, or any view over a possibly-shared buffer) isn't
  // directly assignable to `BlobPart` under TS's current lib types (`ArrayBufferView<ArrayBuffer>`
  // specifically) — `new Uint8Array(input.photo)` copies into a fresh, plain `ArrayBuffer`-backed
  // view, which is.
  form.append("photo", new Blob([new Uint8Array(input.photo)], { type: "image/jpeg" }), input.filename ?? "photo.jpg");
  if (caption) {
    form.append("caption", caption.text);
    if (caption.html) form.append("parse_mode", "HTML");
  }

  const base = input.apiBaseUrl ?? "https://api.telegram.org";
  const res = await fetchFn(`${base}/bot${token}/sendPhoto`, {
    method: "POST",
    body: form as unknown as BodyInit,
  });
  const json = (await res.json()) as { ok: boolean; description?: string; result?: { message_id?: number | string } };
  if (!json.ok) {
    throw new Error(`telegram sendPhoto: ${json.description ?? res.status}`);
  }
  return { id: json.result?.message_id !== undefined ? String(json.result.message_id) : "", raw: json };
}

/** Strips a pre-rendered HTML caption down to plain text for the fallback retry — the
 *  `captionHtml` path has no markdown source to re-derive a plain rendering from, so this just
 *  drops tags and unescapes the handful of entities `escapeHtml`-style helpers ever produce. */
function stripHtmlCaption(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

/** Sends a real photo via Telegram's multipart `sendPhoto` method. HTML caption with a
 *  plain-text retry on rejection — malformed caption HTML (or a Telegram-side parse error)
 *  must never cost the photo, matching old Marcel's own `sendPhoto`
 *  (`services/marcel/lib/telegram.ts:140-148`). */
export async function sendTelegramPhoto(input: SendTelegramPhotoInput): Promise<SendTelegramPhotoResult> {
  const token = await resolveTelegramBotToken(input.botToken);

  if (input.captionHtml !== undefined) {
    try {
      return await attempt(input, token, { text: input.captionHtml, html: true });
    } catch (err) {
      console.error("eve-marcel: sendPhoto HTML caption rejected, retrying plain —", (err as Error).message);
      return attempt(input, token, { text: stripHtmlCaption(input.captionHtml), html: false });
    }
  }

  if (!input.caption) return attempt(input, token, undefined);

  try {
    return await attempt(input, token, { text: toTelegramHtmlCaption(input.caption), html: true });
  } catch (err) {
    console.error("eve-marcel: sendPhoto HTML caption rejected, retrying plain —", (err as Error).message);
    return attempt(input, token, { text: toPlainCaption(input.caption), html: false });
  }
}
