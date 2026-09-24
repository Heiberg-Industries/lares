import {managedGoogleSelection} from './managed-google.js';
/**
 * Google (Gmail/Calendar) OAuth stack — decrypt existing `oauth_tokens` refresh tokens and
 * build authed googleapis clients from them.
 *
 * AUTH PLUMBING NOW LIVES IN THE KIT (ORB-142 Step D): `decryptSecret`, `readTokenEncKey`,
 * `readSecretFile`, the `oauth_tokens` row reads, the egress-proxy pinning and the
 * `OAuth2Client` construction were byte-identical duplication between this file and
 * `services/travel/lib/google.ts`, and now live once in `@lares/agent-kit/google-auth`.
 * What deliberately did NOT move to the kit: the two-org `ORG_SECRET_ENV`
 * registry (now in ./google-orgs.ts, beside `GoogleUnenrolledError`, since ORB-286 batch 6) (a shared org table would be one config line away from handing another agent
 * zero7's mailbox), the mailbox-SELECTION policy in `resolveGmailApi`/`resolveCalendarApi`
 * (eve-marcel's is the opposite policy — strict org match, fatal on a miss), the
 * `GoogleUnenrolledError` type, every Gmail/Calendar capability function below, and this
 * file's own test-factory seams. The kit hands back an authenticated `OAuth2Client` and stops
 * there; the `google.gmail(...)`/`google.calendar(...)` calls stay here.
 *
 * Ported from three old-runtime sources, kept together in one file (matching the Wave-1
 * plan's file structure — `lib/google.ts` is the ONE new lib module this task adds):
 *   - `services/box/lib/crypto.ts`'s `decryptSecret` — AES-256-GCM, storage format
 *     `base64(IV(12) || ciphertext || authTag(16))`. Ported byte-for-byte: get this wrong
 *     and every stored Google refresh token becomes silently undecryptable or decrypts to
 *     garbage. `encryptSecret` is NOT ported — this stack only ever reads existing tokens.
 *     (Now in the kit, unchanged.)
 *   - `services/box/lib/oauth-tokens.ts`'s `getDecryptedRefreshToken` /
 *     `listDecryptedRefreshTokens` — the exact SQL against `oauth_tokens`, verbatim. (Now in
 *     the kit as `getMostRecentRefreshToken` / `listDecryptedRefreshTokens`, unchanged apart
 *     from taking `provider` as a parameter, which this file already did.)
 *   - `services/agent-runtime/lib/adapters/gmail-oauth.ts` (`wrapGmailApi`,
 *     `buildAuthedGmail`), `gmail-client.ts` (`makeGmailClient`'s search/read/send/draft/
 *     getSignature, PLUS searchThreadIds/readThread — added by Task 12 (the obligation
 *     radar), the first caller in this wave that needs a complete paged scan and a whole
 *     thread's messages. `poll`/`hasDraftForThread` remain unported: they belong to the
 *     separate email-watcher container, untouched by this wave), `gmail-mime.ts` (the MIME
 *     envelope builder), `calendar-oauth.ts`
 *     (`wrapCalendarApi`, `buildAuthedCalendar`) and `calendar-client.ts`
 *     (`makeCalendarClient`) — the client-construction half only; hand-level gating
 *     (approval, `sendUpdates` defaults) is Task 7's job for calendar and this file's
 *     gmail tools' job for gmail, never this module's.
 *
 * DEVIATION FROM THE OLD RUNTIME (deliberate, landed with Task 2): the old adapters read a
 * PLAIN `TOKEN_ENC_KEY` env var (`keyFromEnv`). eve-saga's compose block instead mounts a
 * Docker secret FILE at `TOKEN_ENC_KEY_FILE` (default `/run/secrets/token-enc-key`),
 * matching every other secret in this codebase (`lib/twenty-client.ts`,
 * `lib/orakel-client.ts`). The kit's `readTokenEncKey` reads that file, lazily, on every
 * call — never at module load — so a missing/malformed key surfaces as a typed error the
 * first time a Google tool actually runs, not at container boot.
 *
 * PRINCIPAL: `googleClients()` defaults its principal from `GOOGLE_PRINCIPAL_ID` and uses it
 * AS-IS — this file never canonicalises, never consults the identity register, and never
 * rewrites what it was given. `oauth_tokens.principal` used to be keyed by a channel-style
 * spelling that differed from the register's id; box 085
 * (`services/box/sql/085_oauth_principal_is_the_register_id.sql`, ruling D4) renamed those rows
 * onto the register's id, and the environment value moves with them in the same maintenance
 * window (`docs/runbooks/2026-09-19-oauth-principal-rename.md`). That is deliberately a
 * configuration change and not a code change: whatever string the environment names is the
 * string this file looks under, and a lookup that finds nothing says so once in the log.
 *
 * LAZINESS (the trap this file must not reproduce): `googleClients(principal)` returns
 * immediately — it does no I/O. Only calling `.gmail()` / `.calendar()` touches the
 * secret files, the DB, or googleapis. Old Calendar registry wiring resolved a client
 * EAGERLY at hand-build time and threw synchronously for an unenrolled principal — a
 * documented crash-loop incident. Gmail's old wiring was already lazy; this file follows
 * that precedent for both.
 */
import { google } from "googleapis";

import {
  GoogleConfigError,
  buildOAuth2Client,
  getMostRecentRefreshToken,
  listDecryptedRefreshTokens,
  readSecretFile,
} from "@lares/agent-kit/google-auth";

// GoogleUnenrolledError and the per-org OAuth client registry live in ./google-orgs.ts (ORB-286
// batch 6) so a READ tool can resolve a Drive client without importing this file, which also
// holds Gmail send and Calendar writes — the ORB-199 write-shape lint follows imports.
export { GoogleUnenrolledError, type GoogleOrgConfig } from "./google-orgs.js";
import { GoogleUnenrolledError, orgConfig, type GoogleOrgConfig } from "./google-orgs.js";

// -----------------------------------------------------------------------------------------
// Gmail — client construction (gmail-oauth.ts) + adapter (gmail-client.ts) + MIME
// (gmail-mime.ts), ported. The egress-proxy pinning that used to live here (a verbatim port
// of services/agent-runtime/lib/adapters/google-proxy.ts, duplicated byte-for-byte in
// eve-marcel) now lives inside the kit's `buildOAuth2Client` — eve-saga is sealed, and both
// the token refresh and every API call still tunnel through the same squid proxy via the
// OAuth2 client's own gaxios transporter.
// -----------------------------------------------------------------------------------------

type GmailApi = ReturnType<typeof google.gmail>;

interface RawGmailHeader { name?: string; value?: string }
interface RawGmailPart { mimeType?: string; body?: { data?: string }; parts?: RawGmailPart[] }
interface RawGmailMessage { id?: string; threadId?: string; payload?: RawGmailPart & { headers?: RawGmailHeader[] } }
interface RawGmailThread { id?: string; messages?: RawGmailMessage[] }

/** The structural surface this file's adapter needs from `google.gmail(...)` — narrowed to
 *  what `search`/`read`/`signature`/`draft`/`send` actually call, PLUS `list`'s `pageToken`
 *  and `getThread` — added by Task 12 (the obligation radar), which is the first caller in
 *  this wave that actually needs a complete paged scan and a whole thread's messages. `poll`
 *  remains unported (belongs to the separate email-watcher container this task does not
 *  touch); `hasDraftForThread` is now ported (ORB-76 needs it for per-thread draft dedup). */
export interface GmailMessagesClient {
  /** `pageToken`/`nextPageToken` are what make a COMPLETE scan of a query possible — Gmail
   *  caps a page at 500 and hands back a token whenever more matched. Omitted `pageToken`
   *  and absent `nextPageToken` on the return are both the "single page, no more" case —
   *  existing callers (search/poll) that never pass a pageToken see no shape change. */
  list(params: { q: string; maxResults: number; pageToken?: string }):
    Promise<{ messages?: { id?: string; threadId?: string }[]; nextPageToken?: string }>;
  get(id: string): Promise<RawGmailMessage>;
  /** `sentAt` is Gmail's own `internalDate` when the API returns it, else the moment this
   *  call resolved — either way, closer to the true send time than a caller resolving it
   *  later would get (ORB-93: outreach_track used to timestamp a send at TRACK time, a
   *  separate later tool call, so a very fast reply could arrive before that recorded time
   *  and never match the reply-detection filter). */
  send(raw: string, threadId?: string): Promise<{ id: string; threadId: string; sentAt: string }>;
  createDraft(raw: string, threadId?: string): Promise<{ id: string; messageId: string; threadId: string }>;
  /** A draft's raw RFC 822 message (base64url) and thread — `drafts.get` with `format: "raw"`. */
  getDraft(id: string): Promise<{ id: string; raw: string; threadId: string }>;
  /** Replace a draft's message in place — `drafts.update`; the draft keeps its id. */
  updateDraft(id: string, raw: string, threadId?: string): Promise<{ id: string; messageId: string; threadId: string }>;
  getSignature(sendAsEmail: string): Promise<string>;
  /** The complete thread: every message it contains, regardless of which per-message label
   *  (INBOX, SENT, …) each one individually carries — needed to see a reply he already sent,
   *  which `list`/`get` alone cannot (his own replies carry SENT, never INBOX). Only
   *  `readThread` (below) calls this. */
  getThread(threadId: string): Promise<RawGmailThread>;
  /** True if this mailbox already has a draft on this thread. ORB-92: was a single
   *  unpaginated `drafts.list` page (100 drafts, the API default) checked for a matching
   *  threadId — dedup silently stopped working past ~100 total drafts in the mailbox,
   *  independent of how many were actually relevant. Scoped to THIS thread instead via
   *  `threads.get` + a DRAFT label check — a draft reply is a message in its own thread
   *  carrying the DRAFT label, so this is exact regardless of total mailbox draft count and
   *  costs one call either way. */
  hasDraftForThread(threadId: string): Promise<boolean>;
}

/** Build an auto-refreshing googleapis gmail client from an org config + refresh token.
 *  The OAuth2 client (construction, egress-proxy pinning, credentials) comes from the kit;
 *  the `google.gmail(...)` call stays HERE, so the kit can never build a Gmail API object on
 *  its own — only an authenticated client that an agent still has to turn into one. */
function buildAuthedGmail(cfg: GoogleOrgConfig, refreshToken: string): GmailApi {
  return google.gmail({ version: "v1", auth: buildOAuth2Client(cfg, refreshToken) });
}

/** Injectable for tests only — swaps the real googleapis client factory for a stub so
 *  `tests/tools-gmail.test.ts` can prove the exact request shape each tool issues without
 *  ever reaching Google. Unset (the default) uses `buildAuthedGmail`. */
let testGmailApiFactory: ((cfg: GoogleOrgConfig, refreshToken: string) => GmailApi) | undefined;
export function __setTestGmailApiFactory(factory: typeof testGmailApiFactory): void {
  testGmailApiFactory = factory;
}

/** Adapt the googleapis `gmail.users.messages` surface to the structural
 *  `GmailMessagesClient`. Ported from `gmail-oauth.ts`'s `wrapGmailApi`, narrowed to the
 *  methods `search`/`read`/`signature`/`draft`/`send` use (see `GmailMessagesClient`'s
 *  doc-comment for what's deliberately not ported). Rate-limit backoff
 *  (`gmail-ratelimit.ts`'s per-mailbox 429 handling) is NOT ported — a known gap flagged
 *  in the task report, not silently dropped. */
export function wrapGmailApi(api: GmailApi, mailboxKey = "gmail"): GmailMessagesClient {
  void mailboxKey; // kept for signature parity with the old adapter; no rate-limit gate keys on it here
  return {
    async list(params: { q: string; maxResults: number; pageToken?: string }) {
      const res = await api.users.messages.list({
        userId: "me", q: params.q, maxResults: params.maxResults,
        ...(params.pageToken ? { pageToken: params.pageToken } : {}),
      });
      return {
        messages: (res.data.messages ?? []).map((m) => ({ id: m.id ?? undefined, threadId: m.threadId ?? undefined })),
        ...(res.data.nextPageToken ? { nextPageToken: res.data.nextPageToken } : {}),
      };
    },
    async get(id: string) {
      const res = await api.users.messages.get({ userId: "me", id, format: "full" });
      return res.data as unknown as RawGmailMessage;
    },
    async send(raw: string, threadId?: string) {
      const res = await api.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
      const sentAt = res.data.internalDate ? new Date(Number(res.data.internalDate)).toISOString() : new Date().toISOString();
      return { id: res.data.id ?? "", threadId: res.data.threadId ?? "", sentAt };
    },
    async createDraft(raw: string, threadId?: string) {
      const res = await api.users.drafts.create({ userId: "me", requestBody: { message: { raw, threadId } } });
      return { id: res.data.id ?? "", messageId: res.data.message?.id ?? "", threadId: res.data.message?.threadId ?? "" };
    },
    async getDraft(id: string) {
      const res = await api.users.drafts.get({ userId: "me", id, format: "raw" });
      return { id: res.data.id ?? "", raw: res.data.message?.raw ?? "", threadId: res.data.message?.threadId ?? "" };
    },
    async updateDraft(id: string, raw: string, threadId?: string) {
      const res = await api.users.drafts.update({ userId: "me", id, requestBody: { message: { raw, threadId } } });
      return { id: res.data.id ?? "", messageId: res.data.message?.id ?? "", threadId: res.data.message?.threadId ?? "" };
    },
    async getThread(threadId: string) {
      const res = await api.users.threads.get({ userId: "me", id: threadId, format: "full" });
      return res.data as unknown as RawGmailThread;
    },
    async getSignature(sendAsEmail: string) {
      const res = await api.users.settings.sendAs.get({ userId: "me", sendAsEmail });
      return res.data.signature ?? "";
    },
    async hasDraftForThread(threadId: string) {
      const res = await api.users.threads.get({ userId: "me", id: threadId, format: "minimal" });
      return (res.data.messages ?? []).some((m) => (m.labelIds ?? []).includes("DRAFT"));
    },
  };
}

/** RFC-5322 headers (NOT Gmail's internal id) — needed to build a properly-threaded reply
 *  (In-Reply-To/References). Ported from gmail-client.ts. */
export interface MailMessage {
  id: string; threadId: string; from: string; to: string[]; subject: string; bodyText: string;
  sentAt: string; messageId: string; references: string; isCalendarNotice: boolean;
  /** The original's Cc line — a reply defaults to everyone on it (lib/reply-recipients.ts). */
  cc: string[];
  /**
   * The message's own Bcc line, when Gmail exposes one — it only ever appears on the SENDER's
   * own stored copy of a message they sent (a Bcc recipient's own copy carries no such header,
   * and the header is stripped entirely from every other recipient's copy). Optional, not
   * merely often-empty: most callers never look at it, so this stays untouched everywhere but
   * `lib/contact-history.ts`'s mail-header verification (ORB-278 step 1, fix round 1, C2),
   * which is the one caller reading the SENDER's own Sent copy specifically to see who was on
   * it. `toMailMessage` below always sets it (possibly `[]`), never omits it.
   */
  bcc?: string[];
}

export interface MimeEnvelopeInput {
  from: string; to: string[]; subject: string; bodyText: string;
  /** Carbon copies; omitted or empty → no Cc header. */
  cc?: string[];
  messageId?: string; inReplyTo?: string; references?: string;
  signatureText?: string | null; signatureHtml?: string | null; boundarySeed?: string;
}

export interface MailSendInput extends MimeEnvelopeInput { threadId?: string; account?: string }

/**
 * A message read as part of a whole thread, carrying its raw headers.
 *
 * Headers ride along because the caller already paid for them: `threads.get` returns every
 * message's full payload, headers included. Fetching a message AGAIN just to look at one
 * header (e.g. the obligation radar's automated-sender check) would be a round trip spent
 * re-downloading something already in hand. Ported from gmail-client.ts's `ThreadMessage`.
 */
export interface ThreadMessage extends MailMessage { headers: Record<string, string> }

/**
 * A comma-separated address header into its entries. Splits only on commas OUTSIDE double
 * quotes — a display name like `"Tufte, Kjetil" <k@x.no>` carries a comma of its own. Trims;
 * drops empties. The one place a header becomes a list, shared by `To` and `Cc`.
 */
export function parseAddressHeader(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((e) => e.trim()).filter((e) => e !== "");
}

function header(headers: RawGmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Every header as a flat name→value record, in Gmail's original casing. Ported from
 *  gmail-client.ts's `toHeaderRecord`. */
function toHeaderRecord(headers: RawGmailHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    if (h.name) out[h.name] = h.value ?? "";
  }
  return out;
}

const decodeB64Url = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");

/** Depth-first over the MIME tree — ported from gmail-client.ts's `walkParts`. */
function walkParts(payload: RawGmailPart | undefined): RawGmailPart[] {
  if (!payload) return [];
  return [payload, ...(payload.parts ?? []).flatMap(walkParts)];
}

function extractBody(payload: RawGmailMessage["payload"]): string {
  const all = walkParts(payload);
  const plains = all.filter((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plains.length > 0) return plains.map((p) => decodeB64Url(p.body?.data)).join("\n").trim();
  const htmls = all.filter((p) => p.mimeType === "text/html" && p.body?.data);
  if (htmls.length > 0) {
    return htmls.map((p) => decodeB64Url(p.body?.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).join("\n").trim();
  }
  return decodeB64Url(payload?.body?.data).trim();
}

function hasCalendarPart(payload: RawGmailMessage["payload"]): boolean {
  return walkParts(payload).some((p) => (p.mimeType ?? "").toLowerCase().startsWith("text/calendar"));
}

function toMailMessage(raw: RawGmailMessage): MailMessage {
  const h = raw.payload?.headers;
  return {
    id: raw.id ?? "",
    threadId: raw.threadId ?? "",
    from: header(h, "From"),
    to: parseAddressHeader(header(h, "To")),
    cc: parseAddressHeader(header(h, "Cc")),
    bcc: parseAddressHeader(header(h, "Bcc")),
    subject: header(h, "Subject"),
    bodyText: extractBody(raw.payload),
    sentAt: header(h, "Date"),
    messageId: header(h, "Message-ID"),
    references: header(h, "References"),
    isCalendarNotice: hasCalendarPart(raw.payload),
  };
}

function toThreadMessage(raw: RawGmailMessage): ThreadMessage {
  return { ...toMailMessage(raw), headers: toHeaderRecord(raw.payload?.headers) };
}

const ASCII_ONLY = /^[\x00-\x7F]*$/;

/** RFC-2047 encode a non-ASCII subject. Ported from gmail-mime.ts. */
function encodeSubject(subject: string): string {
  if (ASCII_ONLY.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function plainToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/\n/g, "<br>");
}

const HEADER_INJECTION_RE = /[\r\n]/;

/**
 * Refuses to build a MIME envelope carrying a raw CR or LF in ANY header-bound field.
 * Fix-round-2 review, item 2a (Critical, controller ruling): `encodeSubject` above passes an
 * all-ASCII subject through UNCHANGED — `ASCII_ONLY`'s `\x00-\x7F` range includes CR and LF —
 * so a caller-supplied `subject: "Hi\r\nBcc: stranger@evil.example"` (or the same trick via
 * `from`, a `to`/`cc` entry, `inReplyTo`, `references`, or `boundarySeed`) would write a
 * second, unapproved header straight into the raw RFC-5322 message: a recipient no approval
 * ever considered. This throws BEFORE any header text is assembled, for every caller of
 * `buildMimeEnvelope` (`gmail.send`/`gmail.draft`), not only ones that happen to go through the
 * board's approval policy — `@lares/agent-kit/always-ask`'s `RECIPIENTS_OF.gmail_send` carries
 * the SAME check at the engine layer too (belt and suspenders: that check has no idea this
 * function exists, and this function has no idea the board exists).
 *
 * `bodyText`/`signatureText`/`signatureHtml` are deliberately NOT checked — free-form message
 * CONTENT that legitimately spans multiple lines, written after the header/body blank line
 * separator where a CR/LF cannot inject a header.
 */
function assertNoHeaderInjection(input: MimeEnvelopeInput): void {
  const offenders: string[] = [];
  const check = (name: string, value: string | undefined) => {
    if (value !== undefined && HEADER_INJECTION_RE.test(value)) offenders.push(name);
  };
  check("from", input.from);
  input.to.forEach((addr, i) => check(`to[${i}]`, addr));
  (input.cc ?? []).forEach((addr, i) => check(`cc[${i}]`, addr));
  check("subject", input.subject);
  check("messageId", input.messageId);
  check("inReplyTo", input.inReplyTo);
  check("references", input.references);
  check("boundarySeed", input.boundarySeed);
  if (offenders.length > 0) {
    throw new Error(`buildMimeEnvelope: refusing to build a message — CR/LF found in: ${offenders.join(", ")}`);
  }
}

/** Build the RFC-5322 MIME envelope. Ported verbatim from gmail-mime.ts's
 *  `buildMimeEnvelope`. */
export function buildMimeEnvelope(input: MimeEnvelopeInput): string {
  assertNoHeaderInjection(input);
  const headersBase = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    ...(input.cc && input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${encodeSubject(input.subject)}`,
    ...(input.messageId ? [`Message-ID: ${input.messageId}`] : []),
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    "MIME-Version: 1.0",
  ];

  const textBody = input.signatureText ? `${input.bodyText}\n\n${input.signatureText}` : input.bodyText;

  if (input.signatureHtml) {
    const boundary = `----eve-saga-${input.boundarySeed ?? "gmail"}`;
    const htmlBody = `<html><body>${plainToHtml(input.bodyText)}<br><br>${input.signatureHtml}</body></html>`;
    return [
      ...headersBase,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      textBody,
      "",
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "",
      htmlBody,
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }

  return [...headersBase, 'Content-Type: text/plain; charset="UTF-8"', "", textBody, ""].join("\r\n");
}

/** Encode a MIME string for Gmail's `raw` field: base64url, no padding. Ported verbatim
 *  from gmail-mime.ts's `encodeForGmail`. */
function encodeForGmail(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Hard bound on `list` calls in one paged search, independent of how many messages those
 * pages actually contained — a fault detector, not a working limit (reaching it means the
 * cursor is not advancing). Ported verbatim from gmail-client.ts's `MAX_SEARCH_PAGES`.
 */
const MAX_SEARCH_PAGES = 100;

export interface GmailClient {
  search(query: string, max: number): Promise<string[]>;
  /**
   * EVERY thread id matching `query`, paged to the end (never a silently truncated first
   * page) — Task 12's obligation radar needs this to see weeks-old obligations, not just the
   * newest page. THROWS rather than truncating when `ceiling` messages have been scanned and
   * Gmail still offers another page, or when the page cursor stops making progress. Ported
   * verbatim from gmail-client.ts's `searchThreadIds`.
   */
  searchThreadIds(query: string, ceiling: number): Promise<string[]>;
  read(id: string): Promise<MailMessage | null>;
  /** EVERY message in a thread, both directions — `search`+`read` alone cannot tell whether
   *  he already replied, because his own SENT messages never carry the INBOX label an
   *  `in:inbox` search matches. Ported verbatim from gmail-client.ts's `readThread`. */
  readThread(threadId: string): Promise<ThreadMessage[]>;
  /** `sentAt` — pass straight through to `outreach_track`'s `sentAt` input so a thread's
   *  recorded send time reflects the actual send, not whatever later moment a caller gets
   *  around to tracking it (ORB-93). */
  send(input: MailSendInput): Promise<{ gmailMessageId: string; gmailThreadId: string; sentAt: string }>;
  draft(input: MailSendInput): Promise<{ gmailDraftId: string; gmailMessageId: string; gmailThreadId: string }>;
  getSignature(sendAsEmail: string): Promise<string>;
  hasDraftForThread(threadId: string): Promise<boolean>;
  /** An existing draft's raw RFC 822 text (decoded) and thread — for `gmail_draft_recipients`,
   *  which rewrites only the To/Cc headers and writes the same bytes back. */
  readDraftRaw(draftId: string): Promise<{ raw: string; threadId: string }>;
  updateDraftRaw(draftId: string, raw: string, threadId?: string): Promise<{ gmailDraftId: string }>;
}

/** Ported from gmail-client.ts's `makeGmailClient`, narrowed to what this task's tools use
 *  (search/read/send/draft/getSignature) plus `searchThreadIds`/`readThread`, added for
 *  Task 12's obligation radar (the first caller in this wave that needs a complete paged
 *  scan and a whole thread's messages). */
export function makeGmailClient(messages: GmailMessagesClient): GmailClient {
  return {
    async search(query: string, max: number): Promise<string[]> {
      const res = await messages.list({ q: query, maxResults: Math.min(Math.trunc(max), 500) });
      return (res.messages ?? []).map((m) => m.id ?? "").filter(Boolean);
    },
    async searchThreadIds(query: string, ceiling: number): Promise<string[]> {
      const threadIds = new Set<string>();
      let scanned = 0;
      let pages = 0;
      let pageToken: string | undefined;
      do {
        const res = await messages.list({
          q: query,
          maxResults: Math.min(500, Math.max(1, Math.trunc(ceiling) - scanned)),
          ...(pageToken ? { pageToken } : {}),
        });
        pages++;
        for (const m of res.messages ?? []) {
          scanned++;
          if (m.threadId) threadIds.add(m.threadId);
        }
        pageToken = res.nextPageToken;
        if (pageToken && scanned >= ceiling) {
          throw new Error(
            `gmail search "${query}" exceeded the ${ceiling}-message scan ceiling with more pages remaining — ` +
            `the window is too large to read completely, so no partial answer is returned`,
          );
        }
        if (pageToken && pages >= MAX_SEARCH_PAGES) {
          throw new Error(
            `gmail search "${query}" is still paging after ${pages} pages having seen only ${scanned} messages — ` +
            `the page cursor is not making progress, so the scan is abandoned rather than looped`,
          );
        }
      } while (pageToken);
      return [...threadIds];
    },
    async read(id: string): Promise<MailMessage | null> {
      const raw = await messages.get(id);
      if (!raw?.id) return null;
      return toMailMessage(raw);
    },
    async readThread(threadId: string): Promise<ThreadMessage[]> {
      const raw = await messages.getThread(threadId);
      return (raw.messages ?? []).filter((m) => !!m?.id).map(toThreadMessage);
    },
    async send(input: MailSendInput) {
      const raw = encodeForGmail(buildMimeEnvelope(input));
      const res = await messages.send(raw, input.threadId);
      return { gmailMessageId: res.id, gmailThreadId: res.threadId, sentAt: res.sentAt };
    },
    async draft(input: MailSendInput) {
      const raw = encodeForGmail(buildMimeEnvelope(input));
      const res = await messages.createDraft(raw, input.threadId);
      return { gmailDraftId: res.id, gmailMessageId: res.messageId, gmailThreadId: res.threadId };
    },
    async getSignature(sendAsEmail: string): Promise<string> {
      return messages.getSignature(sendAsEmail).catch(() => "");
    },
    hasDraftForThread: (threadId: string) => messages.hasDraftForThread(threadId),
    async readDraftRaw(draftId: string) {
      const d = await messages.getDraft(draftId);
      return { raw: Buffer.from(d.raw, "base64url").toString("utf8"), threadId: d.threadId };
    },
    async updateDraftRaw(draftId: string, raw: string, threadId?: string) {
      const res = await messages.updateDraft(draftId, encodeForGmail(raw), threadId);
      return { gmailDraftId: res.id };
    },
  };
}

// -----------------------------------------------------------------------------------------
// Calendar — client construction (calendar-oauth.ts) + adapter (calendar-client.ts),
// ported. No calendar TOOLS land in this task (that's Task 7); this half exists so
// `googleClients(principal): { gmail, calendar }` is the complete, lazy interface Task 7
// consumes — never resolved unless a caller actually calls `.calendar()`.
// -----------------------------------------------------------------------------------------

type CalendarApi = ReturnType<typeof google.calendar>;

export interface CalendarAttendee { email: string; displayName?: string }
export interface CalendarSummary { id: string; summary: string; primary: boolean }
/** `allDay` and `location` exist for the brief's inclusion rule (ORB-118): an all-day block and
 *  a located block are both real commitments even with no attendee list, and the night-before
 *  brief missed a 3-hour meeting because neither fact reached it. `start` carries `date` (not
 *  `dateTime`) for an all-day event, which is exactly what `allDay` marks. */
export interface CalendarEvent {
  id: string; summary: string; start: string; end: string;
  attendees?: CalendarAttendee[]; location?: string; allDay?: boolean;
  /**
   * Google's own `eventType` (ORB-165), verbatim — never inferred. The typings
   * (`googleapis/build/src/apis/calendar/v3.d.ts`, `Schema$Event.eventType`) name exactly six
   * values: `birthday`, `default`, `focusTime`, `fromGmail`, `outOfOffice`, `workingLocation`.
   * `fromGmail` is the load-bearing one — it is the ONLY thing that says "Gmail created this
   * from a booking confirmation", which is how a hotel reservation is told apart from a real
   * commitment. Carried as a plain `string` (not a union) because this is a wire value: an
   * unknown seventh value must arrive intact and classify as "nothing special", not crash.
   */
  eventType?: string;
  /**
   * TRUE when the event carries a way to JOIN it rather than attend it — `hangoutLink`, or any
   * `conferenceData.entryPoints[].uri`. A boolean rather than the URL itself: nothing in the
   * brief needs to dial in, only to know that a venue-less call is a call and not a place.
   */
  hasConferenceLink?: boolean;

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // ORB-139 — the four fields the conflict radar branches on (`lib/calendar-conflicts.ts`).
  //
  // Every one is a WIRE VALUE, carried verbatim as a plain `string` rather than a union, for
  // the reason `eventType` above already gives: an unknown value Google adds later must arrive
  // intact and read as "nothing special", never crash a brief. The inferred contract, and what
  // breaks silently if it changes, is stated per field — `googleapis`' own
  // `calendar/v3.d.ts` (`Schema$Event`, `Schema$EventAttendee`) is the source for each
  // enumeration named below, and no live sweep of these has been run: they are documented
  // shapes, not observed ones, and the radar is written to degrade toward NOISE rather than
  // silence if any of them turns out to carry a value not listed here.
  // ─────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Google's `status`, verbatim: `confirmed` | `tentative` | `cancelled`. A cancelled event is
   * not a commitment; a tentative one is only conditionally one (see `commitmentOf`). Note
   * that `events.list` already omits cancelled instances unless `showDeleted` is set, so this
   * carrying `"cancelled"` is the exception rather than the rule — it is read anyway because a
   * radar that trusts the query parameters of a call it does not make is a radar built on an
   * assumption.
   */
  status?: string;
  /**
   * Google's `transparency`, verbatim: `opaque` (busy — the API's default, and usually absent)
   * | `transparent` (free). "Free" means he is not held to it, so it cannot double-book him.
   * ABSENT means busy, which is why the radar tests for the transparent value rather than for
   * the absence of the opaque one.
   */
  transparency?: string;
  /**
   * THE OWNER's own `responseStatus` on this event — the `attendees[]` entry Google marks
   * `self: true` for the calendar being read: `needsAction` | `declined` | `tentative` |
   * `accepted`. Absent whenever there is no attendee list at all, which on his calendar is the
   * common case (ORB-118 — he blocks his own time, and copied invitations arrive bare), and an
   * absent response therefore reads as "his own event", never as "unanswered".
   */
  myResponse?: string;
  /**
   * Google's `iCalUID`. The SAME commitment copied onto a second calendar keeps this while
   * getting a fresh `id`, which is what lets the conflict radar tell one meeting read twice
   * from two meetings that clash. Every occurrence of a recurring series shares one UID
   * (Google documents that as the difference between `id` and `iCalUID`), so a UID is only
   * ever an identity together with the instance's own start.
   */
  iCalUID?: string;
  /**
   * Google's `start.timeZone` (an IANA name) when the event carries one. Absent on plenty of
   * events, where the `dateTime` alone fixes the instant and the calendar's own default zone
   * supplies the wall clock — the conflict radar reads an absent zone as HOME for exactly that
   * reason, and says so where it does.
   */
  startTimeZone?: string;

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // LAR-59-s1 — groundwork for the conflict radar's resolution half: a proposed delete needs
  // to know exactly which account and which calendar an event came from, not a look-alike on
  // another one. Both are set by the fan-out (`lib/calendar-fanout.ts`), never by Google.
  // ─────────────────────────────────────────────────────────────────────────────────────────

  /** Which enrolled Google account this event was read from. Set by the fan-out, never by Google. */
  account?: string;
  /** Which calendar (of that account) this event was read from. Set by the fan-out, never by Google. */
  calendarId?: string;
}

export interface CalendarApiClient {
  listEvents(params: { timeMin: string; timeMax: string; maxResults: number; calendarId?: string }): Promise<{ items: CalendarEvent[] }>;
  freeBusy(params: { timeMin: string; timeMax: string; calendarId?: string }): Promise<{ busy: Array<{ start: string; end: string }> }>;
  insertEvent(params: { summary: string; start: string; end: string; description?: string; attendees?: string[]; notify?: boolean; calendarId?: string }): Promise<CalendarEvent>;
  updateEvent(params: { eventId: string; summary?: string; start?: string; end?: string; description?: string; notify?: boolean; calendarId?: string }): Promise<CalendarEvent>;
  deleteEvent(params: { eventId: string; notify?: boolean; calendarId?: string }): Promise<{ deleted: true }>;
  listCalendars(opts?: { includeReadOnly?: boolean }): Promise<CalendarSummary[]>;
}

/** Same shape as `buildAuthedGmail`: the kit builds the authenticated OAuth2 client, the
 *  `google.calendar(...)` call stays here. */
function buildAuthedCalendar(cfg: GoogleOrgConfig, refreshToken: string): CalendarApi {
  return google.calendar({ version: "v3", auth: buildOAuth2Client(cfg, refreshToken) });
}

let testCalendarApiFactory: ((cfg: GoogleOrgConfig, refreshToken: string) => CalendarApi) | undefined;
export function __setTestCalendarApiFactory(factory: typeof testCalendarApiFactory): void {
  testCalendarApiFactory = factory;
}

/** The API's own default for `sendUpdates` is `"none"` (ORB-46/1: a guest attached to an
 *  event and never told). Ported verbatim from calendar-oauth.ts: notify unless explicitly
 *  told not to. */
const sendUpdatesFor = (notify: boolean | undefined): "all" | "none" => (notify === false ? "none" : "all");
const calFor = (calendarId: string | undefined): string => calendarId || "primary";

/** Ported verbatim from calendar-oauth.ts's `wrapCalendarApi`. */
export function wrapCalendarApi(api: CalendarApi): CalendarApiClient {
  return {
    async listEvents(params) {
      const res = await api.events.list({ calendarId: calFor(params.calendarId), timeMin: params.timeMin, timeMax: params.timeMax, maxResults: params.maxResults, singleEvents: true, orderBy: "startTime" });
      const items = (res.data.items ?? []).map((e) => {
        const attendees = (e.attendees ?? [])
          .filter((a) => a.resource !== true && typeof a.email === "string" && a.email !== "")
          .map((a) => ({ email: a.email as string, ...(a.displayName ? { displayName: a.displayName } : {}) }));
        const allDay = !e.start?.dateTime && typeof e.start?.date === "string" && e.start.date !== "";
        // ORB-165 — both dropped here before, which is why the brief could not tell a hotel
        // reservation from a meeting, or a Meet call from a place. Read off the API, never
        // inferred from the title.
        const hasConferenceLink =
          (typeof e.hangoutLink === "string" && e.hangoutLink !== "") ||
          (e.conferenceData?.entryPoints ?? []).some((p) => typeof p.uri === "string" && p.uri !== "");
        // ORB-139 — off the RAW attendee list, before the resource/blank filter above: `self`
        // marks the entry belonging to the calendar this request read, which is the only place
        // his own accept/decline lives. A room resource can carry a responseStatus too, and
        // reading one of those as HIS answer would silence a real double booking.
        const myResponse = (e.attendees ?? []).find((a) => a.self === true)?.responseStatus;
        return {
          id: e.id ?? "", summary: e.summary ?? "",
          start: e.start?.dateTime ?? e.start?.date ?? "", end: e.end?.dateTime ?? e.end?.date ?? "",
          ...(attendees.length > 0 ? { attendees } : {}),
          ...(e.location ? { location: e.location } : {}),
          ...(allDay ? { allDay: true } : {}),
          ...(e.eventType ? { eventType: e.eventType } : {}),
          ...(hasConferenceLink ? { hasConferenceLink: true } : {}),
          ...(e.status ? { status: e.status } : {}),
          ...(e.transparency ? { transparency: e.transparency } : {}),
          ...(myResponse ? { myResponse } : {}),
          ...(e.iCalUID ? { iCalUID: e.iCalUID } : {}),
          ...(e.start?.timeZone ? { startTimeZone: e.start.timeZone } : {}),
        };
      });
      return { items };
    },
    async freeBusy(params) {
      const res = await api.freebusy.query({ requestBody: { timeMin: params.timeMin, timeMax: params.timeMax, items: [{ id: calFor(params.calendarId) }] } });
      const busy = (res.data.calendars?.[calFor(params.calendarId)]?.busy ?? []).map((b) => ({ start: b.start ?? "", end: b.end ?? "" }));
      return { busy };
    },
    async insertEvent(params) {
      const res = await api.events.insert({
        calendarId: calFor(params.calendarId), sendUpdates: sendUpdatesFor(params.notify),
        requestBody: {
          summary: params.summary,
          ...(params.description ? { description: params.description } : {}),
          start: { dateTime: params.start }, end: { dateTime: params.end },
          ...(params.attendees && params.attendees.length ? { attendees: params.attendees.map((email) => ({ email })) } : {}),
        },
      });
      const e = res.data;
      return { id: e.id ?? "", summary: e.summary ?? "", start: e.start?.dateTime ?? e.start?.date ?? "", end: e.end?.dateTime ?? e.end?.date ?? "" };
    },
    async updateEvent(params) {
      const res = await api.events.patch({
        calendarId: calFor(params.calendarId), eventId: params.eventId, sendUpdates: sendUpdatesFor(params.notify),
        requestBody: {
          ...(params.summary !== undefined ? { summary: params.summary } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(params.start ? { start: { dateTime: params.start } } : {}),
          ...(params.end ? { end: { dateTime: params.end } } : {}),
        },
      });
      const e = res.data;
      return { id: e.id ?? "", summary: e.summary ?? "", start: e.start?.dateTime ?? e.start?.date ?? "", end: e.end?.dateTime ?? e.end?.date ?? "" };
    },
    async deleteEvent(params) {
      await api.events.delete({ calendarId: calFor(params.calendarId), eventId: params.eventId, sendUpdates: sendUpdatesFor(params.notify) });
      return { deleted: true as const };
    },
    async listCalendars(opts) {
      const res = await api.calendarList.list({ maxResults: 250, showHidden: false });
      return (res.data.items ?? [])
        // Owner/writer only by default: a tool that CREATES an event may only offer calendars
        // he can write. Reading is a different question — his Vol de Nuit calendar is
        // subscribed read-only and its meetings are still his day (ORB-118), so the brief's
        // fan-out asks for everything and filters by name instead.
        .filter((c) => opts?.includeReadOnly === true || c.accessRole === "owner" || c.accessRole === "writer" || c.primary === true)
        .map((c) => ({ id: c.id ?? "", summary: c.summary ?? "", primary: c.primary === true }))
        .filter((c) => c.id !== "");
    },
  };
}

export interface CalendarClient {
  listEvents(opts: { timeMin: string; timeMax: string; max: number; calendarId?: string }): Promise<CalendarEvent[]>;
  freeBusy(opts: { timeMin: string; timeMax: string; calendarId?: string }): Promise<Array<{ start: string; end: string }>>;
  insertEvent(opts: { summary: string; start: string; end: string; description?: string; attendees?: string[]; notify?: boolean; calendarId?: string }): Promise<CalendarEvent>;
  updateEvent(opts: { eventId: string; summary?: string; start?: string; end?: string; description?: string; notify?: boolean; calendarId?: string }): Promise<CalendarEvent>;
  deleteEvent(opts: { eventId: string; notify?: boolean; calendarId?: string }): Promise<{ deleted: true }>;
  listCalendars(opts?: { includeReadOnly?: boolean }): Promise<CalendarSummary[]>;
}

/** Ported verbatim from calendar-client.ts's `makeCalendarClient`. */
export function makeCalendarClient(calendar: CalendarApiClient): CalendarClient {
  return {
    async listEvents(opts) {
      const res = await calendar.listEvents({ timeMin: opts.timeMin, timeMax: opts.timeMax, maxResults: Math.min(Math.trunc(opts.max), 250), ...(opts.calendarId ? { calendarId: opts.calendarId } : {}) });
      return res.items ?? [];
    },
    async freeBusy(opts) {
      const res = await calendar.freeBusy({ timeMin: opts.timeMin, timeMax: opts.timeMax, ...(opts.calendarId ? { calendarId: opts.calendarId } : {}) });
      return res.busy ?? [];
    },
    insertEvent: (opts) => calendar.insertEvent(opts),
    updateEvent: (opts) => calendar.updateEvent(opts),
    deleteEvent: (opts) => calendar.deleteEvent(opts),
    listCalendars: (opts) => calendar.listCalendars(opts),
  };
}

// -----------------------------------------------------------------------------------------
// googleClients(principal) — the lazy, per-call entry point. Nothing here runs until a
// tool's execute() actually calls `.gmail()` / `.calendar()`.
// -----------------------------------------------------------------------------------------

const PROVIDER = "google";

/** Token lookup happens BEFORE org-config secret reads, deliberately — matching
 *  gmail-oauth.ts's `resolve()` (which never touches an OAuth client config until it
 *  already has a token row to act on). An unenrolled principal must surface as
 *  `GoogleUnenrolledError` even when this host has no Google client secrets mounted at
 *  all, not as a confusing `GoogleConfigError` about a file that was never going to be
 *  needed for this call. */
async function resolveGmailApi(principal: string, account?: string): Promise<{ api: GmailApi; mailboxKey: string }> {
  // Default mailbox is PINNED by env, not the `updated_at DESC` lottery (2026-08-16 walk-up
  // finding): with two enrolled mailboxes, "most recently updated" silently flipped to
  // owner@project.example — an org whose OAuth client is deliberately not mounted here — and every
  // gmail tool failed. GMAIL_PRIMARY_EMAIL mirrors the old runtime's CALENDAR_PRIMARY_EMAIL
  // precedent ("picks the mailbox when 2 enrolled"); an explicit `account` argument wins.
  const selected=await managedGoogleSelection(principal,account);
  const wanted = selected?.mailbox ?? account ?? process.env["GMAIL_PRIMARY_EMAIL"] ?? undefined;
  const tok = wanted
    ? (await listDecryptedRefreshTokens(principal, PROVIDER, selected??undefined)).find((t) => t.emailAddress === wanted)
    : await getMostRecentRefreshToken(principal, PROVIDER);
  if (!tok || (selected && tok.orgId !== selected.org)) throw new GoogleUnenrolledError(principal, wanted);
  const org = orgConfig(tok.orgId);
  const factory = testGmailApiFactory ?? buildAuthedGmail;
  return { api: factory(org, tok.token), mailboxKey: tok.emailAddress };
}

async function resolveCalendarApi(principal: string, account?: string): Promise<{ api: CalendarApi }> {
  // Same env-pinned default as resolveGmailApi above — CALENDAR_PRIMARY_EMAIL is the OLD
  // runtime's own env for exactly this ("picks the calendar mailbox when 2 enrolled").
  const selected=await managedGoogleSelection(principal,account);
  const wanted = selected?.mailbox ?? account ?? process.env["CALENDAR_PRIMARY_EMAIL"] ?? undefined;
  const tok = wanted
    ? (await listDecryptedRefreshTokens(principal, PROVIDER, selected??undefined)).find((t) => t.emailAddress === wanted)
    : await getMostRecentRefreshToken(principal, PROVIDER);
  if (!tok || (selected && tok.orgId !== selected.org)) throw new GoogleUnenrolledError(principal, wanted);
  const org = orgConfig(tok.orgId);
  const factory = testCalendarApiFactory ?? buildAuthedCalendar;
  return { api: factory(org, tok.token) };
}

export interface GoogleClients {
  /** The primary (most-recently-updated) mailbox's Gmail client, or a specific `account`
   *  (an email address) — mirrors gmail-oauth.ts's `resolve()`/`resolveForEmail()`. Throws
   *  `GoogleUnenrolledError` if the principal (or that specific account) has no token row. */
  gmail(account?: string): Promise<GmailClient>;
  /** Same resolution shape for Calendar. Task 7 owns picking a sensible default account
   *  (e.g. via `CALENDAR_PRIMARY_EMAIL`, mirroring the old registry's calendar hand) — this
   *  layer, like calendar-oauth.ts's resolver, has no opinion beyond "most recently
   *  updated" when `account` is omitted. */
  calendar(account?: string): Promise<CalendarClient>;
}

/**
 * The lazy, per-call Google client builder. `principal` defaults to `GOOGLE_PRINCIPAL_ID`,
 * whatever the environment sets it to, and is used AS-IS — never canonicalised here, and never
 * looked up in the identity register (see this file's header on box 085). Calling this function
 * does no I/O; only calling `.gmail()`/`.calendar()` touches secrets, the DB, or Google.
 */
export function googleClients(principal?: string): GoogleClients {
  return {
    async gmail(account?: string): Promise<GmailClient> {
      const p = principal ?? process.env["GOOGLE_PRINCIPAL_ID"];
      if (!p) throw new GoogleConfigError("GOOGLE_PRINCIPAL_ID is not set and no principal was given");
      const { api, mailboxKey } = await resolveGmailApi(p, account);
      return makeGmailClient(wrapGmailApi(api, mailboxKey));
    },
    async calendar(account?: string): Promise<CalendarClient> {
      const p = principal ?? process.env["GOOGLE_PRINCIPAL_ID"];
      if (!p) throw new GoogleConfigError("GOOGLE_PRINCIPAL_ID is not set and no principal was given");
      const { api } = await resolveCalendarApi(p, account);
      return makeCalendarClient(wrapCalendarApi(api));
    },
  };
}

/** Every Gmail mailbox enrolled for a principal — e.g. so a schedule can poll all of them
 *  (ORB-76: both owner@owner.example and owner@project.example) without hard-coding the list.
 *  Returns email addresses only; resolving a client for one still goes through
 *  `googleClients().gmail(account)` like everywhere else. */
export async function listEnrolledMailboxes(principal?: string): Promise<string[]> {
  const p = principal ?? process.env["GOOGLE_PRINCIPAL_ID"];
  if (!p) throw new GoogleConfigError("GOOGLE_PRINCIPAL_ID is not set and no principal was given");
  const selected=await managedGoogleSelection(p);
  const tokens = await listDecryptedRefreshTokens(p, PROVIDER, selected??undefined);
  return tokens.filter(t=>!selected||(t.emailAddress===selected.mailbox&&t.orgId===selected.org)).map((t) => t.emailAddress);
}
