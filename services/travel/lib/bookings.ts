// lib/bookings.ts — turns "Reise"-labelled mail into bookings.md entries.
//
// Ported from services/marcel/lib/bookings.ts (the dedupe/veto/merge pipeline) AND
// services/marcel/lib/gmail.ts:41-113 (the dual-MIME body read + PDF/ICS attachment
// extraction) — old Marcel splits those across two files, but Task 5's brief only creates
// lib/trip-store.ts and lib/bookings.ts for eve-marcel, so the MIME-walking helpers live here
// too. They stay pure (no network calls of their own — attachment bytes are injected via
// `AttachmentFetch`), so `agent/tools/sveip.ts` is the only place that actually touches
// gmailClient()/withGmailRateLimit; this file never imports either.
//
// All pipeline logic here is pure against injected deps (extract/store/tg/adminId/now) — old
// Marcel's own design comment, kept verbatim below on `BookingDeps` — so it's fully
// unit-testable without touching Gmail, the LLM gateway, or Telegram.
import fs from "node:fs";
import path from "node:path";
import { generateObject, type LanguageModel } from "ai";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";
import type { Trip, TripStore } from "./trip-store.js";
import type { Budget } from "./budget.js";
import { EXTRACTOR_VERSION, isStaleVerdict } from "./extraction-cache.js";
import { HEADER_RE, bookingHeaders } from "./booking-header.js";
import { venueLine, type BookingVenue } from "./booking-venue.js";

// -----------------------------------------------------------------------------------------
// Gmail MIME reading — ported from services/marcel/lib/gmail.ts:1-113. Pure functions only:
// everything I/O-shaped (fetching the message, fetching attachment bytes) is injected.
// -----------------------------------------------------------------------------------------

export interface ReiseMail {
  id: string;
  subject: string;
  from: string;
  bodyText: string;
  receivedAt: string; // ISO 8601
}

interface RawGmailHeader {
  name?: string;
  value?: string;
}
export interface RawGmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: RawGmailPart[];
}
export interface RawGmailMessage {
  id?: string;
  internalDate?: string;
  payload?: RawGmailPart & { headers?: RawGmailHeader[] };
}

function header(headers: RawGmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
}

const decode = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");

// Gap found in Task 5 Step 8 (fixture-mail verification against a real hotel-confirmation
// shape): real HTML confirmation templates routinely use named/numeric entities (&amp;,
// &nbsp;, &#39;, &mdash;, …) that plain tag-stripping leaves untouched, so the extraction
// model would see literal "&amp;"/"&#39;" noise instead of the real characters. General fix
// (applies to every provider's html, not one vendor) — same category as the dual-MIME/
// attachment handling already in this file, not a vendor-specific branch.
const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rarr: "→",
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const codePoint = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    const key = entity.toLowerCase();
    return key in HTML_NAMED_ENTITIES ? HTML_NAMED_ENTITIES[key] : match;
  });
}

/** Depth-first over the MIME tree — real mail nests (multipart/mixed → multipart/related →
 *  text/html), so a single-level scan misses whole mail classes. */
export function walkParts(payload: RawGmailPart | undefined): RawGmailPart[] {
  if (!payload) return [];
  return [payload, ...(payload.parts ?? []).flatMap(walkParts)];
}

/** Body text from anywhere in the tree: every text/plain part AND every text/html part
 *  (tag-stripped). Multiple parts concatenate — receipts often split across parts. Both
 *  halves are read because they can disagree: Avis shipped a stale plaintext template for a
 *  different rental than the html showed (old Marcel, live 2026-07-21) — plaintext-only
 *  extraction filed nothing and silently dropped the real booking content. */
export function extractBody(payload: RawGmailMessage["payload"]): string {
  const all = walkParts(payload);
  const plain = all
    .filter((p) => p.mimeType === "text/plain" && p.body?.data)
    .map((p) => decode(p.body?.data))
    .join("\n")
    .trim();
  const html = all
    .filter((p) => p.mimeType === "text/html" && p.body?.data)
    .map((p) => decodeHtmlEntities(decode(p.body?.data).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " "))
    .join("\n")
    .trim();
  if (plain && html) return `${plain}\n\n[HTML-versjonen av e-posten]\n${html}`;
  return plain || html || decode(payload?.body?.data).trim();
}

/** Attachment parts worth reading for booking data: PDFs (e-tickets, vouchers) and
 *  calendar invites (.ics — plain text, free structured itinerary data). */
export function readableAttachments(payload: RawGmailPart | undefined): RawGmailPart[] {
  return walkParts(payload).filter((p) => {
    if (!p.body?.attachmentId) return false;
    const name = (p.filename ?? "").toLowerCase();
    return p.mimeType === "application/pdf" || name.endsWith(".pdf") ||
      p.mimeType === "text/calendar" || name.endsWith(".ics");
  });
}

const ATTACHMENT_TEXT_CAP = 8_000; // chars per attachment appended to bodyText

export type AttachmentFetch = (messageId: string, attachmentId: string) => Promise<Buffer>;
export type PdfTextExtract = (bytes: Buffer) => Promise<string>;

async function defaultPdfText(bytes: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: true });
  return typeof text === "string" ? text : String(text ?? "");
}

/** Body + readable attachments rendered to one text blob for the extraction model.
 *  Attachment failures degrade to a note — a broken PDF must never sink the mail. */
export async function renderMailText(
  raw: RawGmailMessage,
  fetchAttachment: AttachmentFetch,
  pdfText: PdfTextExtract = defaultPdfText,
): Promise<string> {
  let out = extractBody(raw.payload);
  for (const part of readableAttachments(raw.payload)) {
    const name = part.filename || "vedlegg";
    try {
      const bytes = await fetchAttachment(raw.id ?? "", part.body!.attachmentId!);
      const text = part.mimeType === "application/pdf" || name.toLowerCase().endsWith(".pdf")
        ? await pdfText(bytes)
        : bytes.toString("utf8");
      out += `\n\n[Vedlegg: ${name}]\n${text.slice(0, ATTACHMENT_TEXT_CAP)}`;
    } catch (err) {
      console.error(`eve-marcel: failed to read attachment ${name} on ${raw.id}:`, err);
      out += `\n\n[Vedlegg: ${name} — kunne ikke leses]`;
    }
  }
  return out.trim();
}

export function toReiseMailHeaderFields(raw: RawGmailMessage): Omit<ReiseMail, "bodyText"> {
  const h = raw.payload?.headers;
  const dateHeader = header(h, "Date");
  const receivedAt = dateHeader
    ? new Date(dateHeader).toISOString()
    : new Date(Number(raw.internalDate ?? 0)).toISOString();
  return { id: raw.id ?? "", subject: header(h, "Subject"), from: header(h, "From"), receivedAt };
}

// -----------------------------------------------------------------------------------------
// Booking extraction — anchoring the LLM to "today" + known trip windows so it resolves
// year-less dates ("Wed 29 Jul", "om 15 dager") the same way old Marcel's did.
// -----------------------------------------------------------------------------------------

/** Screenshots and mails often show dates WITHOUT a year — anchor the extraction model to
 *  today and the active trip windows so it resolves them (never in the past). */
export function extractionDateContext(todayISO: string, trips: { name: string; start: string; end: string }[]): string {
  const windows = trips.map((t) => `${t.name}: ${t.start}..${t.end}`).join("; ");
  return `I dag er ${todayISO}.${windows ? ` Kjente turer: ${windows}.` : ""} Datoer uten årstall skal tolkes relativt til i dag (aldri i fortiden).`;
}

const BookingStaySchema = z.object({
  wifi: z.string().optional(),
  doorCode: z.string().optional(),
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  rules: z.array(z.string()).optional(),
  leavingTasks: z.array(z.string()).optional(),
});

const BookingSchema = z.object({
  // ORB-173: `train` and `ferry` exist because a Vy ticket filed as `other` can never be
  // presented as movement — Saga's reader renders `other` as "a filed reservation, NOT a
  // confirmed departure" by design, and her TRANSPORT_KINDS already contained both names
  // "for the day his enum grows". Her drift alarm (eve-saga tests/travel-store.test.ts)
  // pins this exact list — the two must change together.
  kind: z.enum(["flight", "stay", "car", "train", "ferry", "restaurant", "other"]),
  /** ORB-105: what this mail DOES to the reservation it describes. "cancel" for a cancellation
   *  confirmation; "book" (the default, and what the model may omit) for everything else,
   *  including a CHANGED reservation — a modification is a booking that supersedes an earlier
   *  one, not a third kind of thing. Cancellations were the classifier's blind spot: it read
   *  "Your reservation has been cancelled" as a perfectly good booking and filed the stay. */
  action: z.enum(["book", "cancel"]).optional(),
  provider: z.string(),
  ref: z.string().optional(),
  startISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  place: z.string().optional(),
  details: z.string(),
  stay: BookingStaySchema.optional(),
});

/** Builds the `BookingDeps.extract` function: one `generateObject` call per mail against the
 *  given model. `dateContext` is a closure so the caller can recompute "today" + the current
 *  trip list on every call (mirrors old Marcel's `bin/marcel.ts` wiring) rather than freezing
 *  it at construction. Contract: null = "this is not a booking" (silent skip); a THROW = hard
 *  extraction failure ("unclear", admin gets a DM/summary line) — enforced by
 *  `BookingPipeline.processMailInner`, not here.
 *
 *  `budget` is optional but should always be passed in production (review fix, finding 8): old
 *  Marcel's own `makeExtractBooking(model, budget, dateContext)` called `budget.add(usage)`
 *  after every call (`services/marcel/bin/marcel.ts:852`) — `/sveip`'s extraction loop can run
 *  up to 100 sequential calls, so without this the daily token budget silently only ever
 *  tracked the gatekeeper's own tiny gate-decision calls, never the far larger extraction
 *  spend. Matches `lib/gatekeeper.ts`'s `makeGateDecide` exactly (`budget.add(result.usage?.totalTokens ?? 0)`). */
export function makeExtractBooking(model: LanguageModel, dateContext: () => string, budget?: Budget) {
  return async (mail: ReiseMail): Promise<Booking | null> => {
    const result = await generateObject({
      model,
      schema: z.object({ isBooking: z.boolean(), booking: BookingSchema.optional() }),
      system:
        "Du vurderer en e-post. Er det en reisebooking (fly, tog, ferge, hotell, leiebil, restaurant, aktivitet)? " +
        "Bruk kind=\"train\" for tog (Vy, Go-Ahead, SJ) og kind=\"ferry\" for ferge (Bastø Fosen, Color Line, Fjord Line). " +
        "Sett isBooking=false for nyhetsbrev, ordrebekreftelser på varer, og alt annet som ikke er en reise-reservasjon. " +
        "En AVBESTILLING eller kansellering av en reservasjon ER en booking-e-post: sett isBooking=true og " +
        "action=\"cancel\", og fyll ut feltene for reservasjonen som avbestilles (samme referanse og datoer som " +
        "den opprinnelige, så langt e-posten oppgir dem). En ENDRET reservasjon (ny dato, nytt klokkeslett, nytt " +
        "rom) er action=\"book\" med de NYE opplysningene og den SAMME referansen som før. " +
        `Hvis ja: trekk ut feltene. Bruk reisedatoer, ikke mottaksdato. ${dateContext()}`,
      prompt: `Emne: ${mail.subject}\nFra: ${mail.from}\nMottatt: ${mail.receivedAt}\n\n${mail.bodyText}`,
    });
    budget?.add(result.usage?.totalTokens ?? 0);
    const obj = result.object as unknown as { isBooking: boolean; booking?: Booking };
    return obj.isBooking && obj.booking ? { ...obj.booking } : null;
  };
}

// -----------------------------------------------------------------------------------------
// Booking pipeline — ported verbatim from services/marcel/lib/bookings.ts. `adminId`/chat ids
// are `string` throughout (eve-marcel's convention — see lib/trip-store.ts's doc comment),
// where old Marcel used `number`.
// -----------------------------------------------------------------------------------------

export interface Booking {
  id: string; // gmail message id (dedupe key)
  kind: string; // "flight" | "stay" | "car" | "restaurant" | "other"
  /** ORB-105 — "cancel" removes/suppresses the reservation this mail is about; "book"
   *  (default, and what older cached entries have) files or supersedes it. */
  action?: "book" | "cancel";
  provider: string;
  ref?: string;
  startISO: string; // travel date, not received date
  endISO?: string;
  startTime?: string; // "06:35" if known
  place?: string;
  /** ORB-109 — the venue's coordinates, resolved once at filing time (lib/venue-coords.ts).
   *  Absent whenever nothing could be matched confidently, which is a normal outcome. */
  lat?: number;
  lon?: number;
  details: string; // one-line Norwegian summary for bookings.md
  stay?: { wifi?: string; doorCode?: string; checkIn?: string; checkOut?: string; rules?: string[]; leavingTasks?: string[] };
}

export interface BookingDeps {
  extract(mail: ReiseMail): Promise<Booking | null>; // the LLM call, injected — see makeExtractBooking
  store: TripStore;
  tg: { send(chatId: string, text: string, opts?: { buttons?: { text: string; data: string }[] }): Promise<string> };
  adminId: string;
  now(): number;
  /** Persistent per-message extraction results (2026-08-17 rethink — see
   *  lib/extraction-cache.ts). Optional so existing tests and callers keep working; without
   *  it the pipeline behaves exactly as before (every sweep re-extracts). */
  cache?: import("./extraction-cache.js").ExtractionCache;
  /** ORB-109 — resolves a booked venue's coordinates at filing time. Optional: without it
   *  bookings file exactly as before, with no `at:` in the header and no geofencing. */
  venueCoords?(booking: Booking): Promise<{ lat: number; lon: number; placeId?: string } | undefined>;
}

/** ORB-105 adds "cancelled": the mail was understood, and its effect was to REMOVE or suppress
 *  a reservation rather than file one. Distinct from every existing outcome — it is neither a
 *  filing nor a skip, and reporting it as either would misdescribe what happened. */
/** What `file()`/`applyCancellation()` can answer: everything except the two outcomes only
 *  mail-level processing can produce ("unclear" needs a failed extraction, "not-booking" a
 *  model verdict). This is also exactly the set the extraction cache stores. */
export type FiledOutcome = Exclude<MailOutcome, "unclear" | "not-booking">;

/** What the extraction cache stores: every outcome except "unclear", which is transient by
 *  design (model hiccup, unparseable reply) and deliberately retried on the next sweep. */
export type CacheableOutcome = Exclude<MailOutcome, "unclear">;

export type MailOutcome = "filed" | "cancelled" | "no-trip" | "duplicate" | "unclear" | "not-booking";

export interface BackfillResult {
  filed: number;
  /** Reservations removed or suppressed by a cancellation mail. */
  cancelled: number;
  duplicates: number;
  noTrip: number;
  notBooking: number;
  unclearSubjects: string[];
  /** How many mails the "Reise" label actually holds in the window, and how many of them this
   *  sweep read. They differ when the read cap truncates — and the completion report says so
   *  out loud (ORB-105 follow-up). A sweep that saw two thirds of the inbox and called itself
   *  finished is the ORB-45 defect verbatim: "the cap truncated silently and reported
   *  complete". Optional so every existing caller and test keeps working. */
  listed?: number;
  read?: number;
  /** True when the daily token budget ran out mid-sweep. The remaining mails were not read at
   *  all — never silently, always in the report. */
  budgetStopped?: boolean;
}

// Norwegian outcome labels for the reise-log — read verbatim by the chat brain.
const OUTCOME_LABEL: Record<MailOutcome, string> = {
  filed: "arkivert",
  cancelled: "avbestilt",
  duplicate: "allerede registrert (eller vetoet)",
  "no-trip": "traff ingen turdatoer",
  "not-booking": "ikke en booking",
  unclear: "uklar — kunne ikke tolkes",
};

const BOOKINGS_FILE = "bookings.md";
const TRIP_FILE = "trip.md";
const VETOED_FILE = "vetoed.json";
const HUS_HEADING = "## Hus (fra e-post)";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- vetoed.json (tombstones — a vetoed booking id must never get refiled by a re-poll
// or backfill, even though the booking block itself is removed from bookings.md) --------

function vetoedPath(trip: Trip): string {
  return path.join(trip.dir, VETOED_FILE);
}

function loadVetoed(trip: Trip): Record<string, boolean> {
  const file = vetoedPath(trip);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function markVetoed(trip: Trip, id: string): void {
  const vetoed = loadVetoed(trip);
  vetoed[id] = true;
  fs.mkdirSync(trip.dir, { recursive: true });
  fs.writeFileSync(vetoedPath(trip), JSON.stringify(vetoed));
}

const DATE_SHAPE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE_RE = /^\d{2}:\d{2}$/;

// Belt-and-braces against a malformed extractor value ever breaking BOOKING_RE parsing (each
// header field there is \S+ — whitespace anywhere would corrupt the match). The zod schema at
// the extraction boundary (makeExtractBooking, above) is the primary guard; this is the
// second, cheaper line of defense inside the file-writing path itself.
function sanitizeKind(kind: string): string {
  const collapsed = kind.trim().replace(/\s+/g, "-");
  return collapsed || "other";
}

function sanitizeDateField(value: string | undefined): string {
  if (value === undefined) return "-";
  return DATE_SHAPE_RE.test(value) ? value : "-";
}

function sanitizeTimeField(value: string | undefined): string {
  if (value === undefined) return "-";
  return TIME_SHAPE_RE.test(value) ? value : "-";
}

/**
 * `provider:` in the header — WHO the reservation is with (ORB-105 follow-up, 2026-08-17).
 *
 * Added because the live Big Apple file proved kind+dates is not an identity. Bendik cancelled
 * The Standard, High Line and booked PUBLIC Hotel for the SAME four nights. Both are
 * `kind:stay start:2026-08-26 end:2026-08-30`, so to every header-only matcher here they were
 * the same reservation: the Standard's booking mail was swallowed as a "semantic duplicate" of
 * PUBLIC's block, and the Standard's CANCELLATION would have removed PUBLIC's — deleting a live
 * hotel booking two weeks before the trip.
 *
 * Absent on every block filed before this change, which is why every reader below treats a
 * missing provider as "identity unknown" rather than "identity matches".
 */
function sanitizeProvider(provider: string | undefined): string {
  const normalized = normalizeProvider(provider ?? "");
  return normalized === "" ? "-" : normalized;
}

/** `at:<lat>,<lon>`, rounded to ~1 m. Written only when both are real numbers — a half-resolved
 *  coordinate is no coordinate (ORB-109). */
function sanitizeAt(lat: number | undefined, lon: number | undefined): string {
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return "-";
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export function bookingBlock(
  id: string,
  kind: string,
  startISO: string,
  endISO: string | undefined,
  startTime: string | undefined,
  details: string,
  provider?: string,
  coords?: { lat?: number; lon?: number },
  /** ORB-129 — the venue's name and address, which the extractor has always produced and this
   *  function used to discard, plus the maps link built from them. See lib/booking-venue.ts. */
  venue?: BookingVenue,
): string {
  const header =
    `<!-- booking id:${id} kind:${sanitizeKind(kind)} start:${sanitizeDateField(startISO)} ` +
    `end:${sanitizeDateField(endISO)} time:${sanitizeTimeField(startTime)} provider:${sanitizeProvider(provider)}` +
    `${coords === undefined ? "" : ` at:${sanitizeAt(coords.lat, coords.lon)}`} -->`;
  // The summary stays the FIRST body line: `detailsLineFor` (and the veto DM, the reise-log and
  // the supersede path through it) read the line immediately after the header, and an identity
  // line above it silently became "the details" everywhere. It rides second instead.
  const identity = venueLine(venue ?? {});
  return `${header}\n- ${details}${identity === "" ? "" : `\n${identity}`}\n<!-- /booking -->`;
}


/** Appends `at:<lat>,<lon>` to one block's header, leaving everything else byte-identical.
 *  Returns the content unchanged when the id is not found or already carries coordinates. */
function rewriteHeaderCoords(content: string, id: string, coords: { lat: number; lon: number }): string {
  const re = new RegExp(`(<!-- booking id:${escapeRegExp(id)}(?:\\s[^\\n]*?)?)( -->)`);
  const m = re.exec(content);
  if (!m || m[1]!.includes(" at:")) return content;
  return content.replace(re, `$1 at:${sanitizeAt(coords.lat, coords.lon)}$2`);
}

function hasBlockFor(content: string, id: string): boolean {
  const re = new RegExp(`<!-- booking id:${escapeRegExp(id)}(?=\\s)`);
  return re.test(content);
}

/** Semantic duplicate: the same reservation arrives in several mails (per-passenger
 *  e-tickets, confirmation + receipt). Same kind + same dates is a duplicate when the time
 *  also matches — or always for stays (check-in times drift between mail types). Different
 *  times on non-stays are genuinely different bookings (rental 18:00 vs parking 12:00). */

/**
 * Same provider, allowing for how mails name the same venue ("PUBLIC Hotel New York" in the
 * confirmation, "PUBLIC Hotel" in the check-in guide). Containment both ways, with a length
 * floor so short fragments cannot match everything — the same shape `lib/taste.ts`'s
 * `findSavedMatch` uses for the identical problem.
 */
function sameProvider(a: string, b: string): boolean {
  if (a === "" || b === "" || a === "-" || b === "-") return false;
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
}

function hasSemanticDuplicate(content: string, booking: Booking): boolean {
  // Compare against the same sanitized forms the header writer uses.
  const start = sanitizeDateField(booking.startISO);
  const end = sanitizeDateField(booking.endISO);
  const time = sanitizeTimeField(booking.startTime);
  const provider = sanitizeProvider(booking.provider);
  for (const m of content.matchAll(HEADER_RE)) {
    const [, , kind, s, e, t, p] = m;
    if (kind !== sanitizeKind(booking.kind)) continue;
    if (s !== start || e !== end) continue;
    // STAYS: a stay match ignores time (check-in times drift between mail types), which leaves
    // kind+dates alone deciding — and two DIFFERENT hotels on the same nights is a real thing
    // (the live Standard/PUBLIC case). So when the filed block records a provider, it has to be
    // the same provider. A block with no provider recorded keeps the old behavior: we cannot
    // tell, and calling a second confirmation of one hotel a second hotel would double-file it.
    if (kind === "stay") {
      if (p !== undefined && !sameProvider(p, provider)) continue;
      return true;
    }
    if (t === time) return true;
  }
  return false;
}

// ─── ORB-105: supersede — cancellations and modifications are ONE mechanism ──────────────
//
// A mail about a reservation that is ALREADY filed must replace or remove that filing, not sit
// beside it. Two live cases on 2026-08-17 proved both halves matter: a cancelled hotel stayed in
// The Big Apple's file (a trip file confidently listing a dead hotel is worse than a missing
// one), and a changed-date dinner only resolved correctly by dedupe luck.
//
// IDENTITY is the booking reference when the mail carries one — that is what the provider itself
// uses to mean "this same reservation" across a booking, a change and a cancellation. Failing
// that, kind + provider + start date, which is how a restaurant confirmation with no reference
// still identifies itself.

/** References are quoted inconsistently across mails ("ABC-123", "abc 123", "#ABC123"). */
function normalizeRef(ref: string): string {
  return ref.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeProvider(provider: string): string {
  return provider.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The identity two mails share when they are about the SAME reservation. */
export function supersedeKey(booking: Pick<Booking, "kind" | "provider" | "ref" | "startISO">): string {
  const ref = booking.ref?.trim() ? normalizeRef(booking.ref) : "";
  if (ref !== "") return `ref:${ref}`;
  return `pd:${sanitizeKind(booking.kind)}:${normalizeProvider(booking.provider)}:${sanitizeDateField(booking.startISO)}`;
}

/** Do these two mails describe the same reservation? */
export function isSameReservation(
  a: Pick<Booking, "kind" | "provider" | "ref" | "startISO">,
  b: Pick<Booking, "kind" | "provider" | "ref" | "startISO">,
): boolean {
  return supersedeKey(a) === supersedeKey(b);
}

export function isCancellation(booking: Pick<Booking, "action">): boolean {
  return booking.action === "cancel";
}

/**
 * The id of a filed block describing the same reservation, from the block HEADERS alone.
 *
 * The fallback for when the extraction cache cannot answer — a booking filed before the cache
 * existed, or a pipeline wired without one. Headers carry only kind/start/end, never the
 * reference, so this is much the coarser matcher and is deliberately strict about it:
 *
 *  - the WHOLE window must match, not either end. An earlier version accepted a match on the end
 *    date alone, and since a restaurant booking has no end date at all, every dinner in the trip
 *    matched every other one ("-" === "-") — one filing silently replaced an unrelated dinner.
 *    Caught by the four-dinner regression fixture, which is exactly what it is for.
 *  - a dateless window never matches anything.
 *  - AMBIGUITY REFUSES. If two filed blocks share the window, there is no way to tell which one
 *    this mail is about, and removing the wrong reservation is worse than removing none.
 *  - THE PROVIDER MUST AGREE, and an unrecorded provider counts as disagreement (2026-08-17,
 *    from the live file). Bendik cancelled The Standard, High Line and booked PUBLIC Hotel for
 *    the same four nights; both are `kind:stay start:2026-08-26 end:2026-08-30`, so window-only
 *    matching would have answered the Standard's cancellation by deleting PUBLIC's booking —
 *    one filed block, no ambiguity detected, entirely the wrong hotel. A block from before
 *    `provider:` existed cannot prove it is the same reservation, and this matcher's only power
 *    is REMOVAL, so it refuses. The cache-based path above is unaffected: it matches on the
 *    booking reference and is where a correctly-identified cancellation actually lands.
 */
function findBlockIdByWindow(content: string, booking: Booking): string | undefined {
  const kind = sanitizeKind(booking.kind);
  const start = sanitizeDateField(booking.startISO);
  const end = sanitizeDateField(booking.endISO);
  const provider = sanitizeProvider(booking.provider);
  if (start === "-") return undefined;

  const matches: string[] = [];
  for (const m of content.matchAll(HEADER_RE)) {
    const [, id, k, s, e, , p] = m;
    if (k !== kind || s !== start || e !== end) continue;
    if (p === undefined || !sameProvider(p, provider)) continue;
    matches.push(id!);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function removeBlockFor(content: string, id: string): { removed: boolean; content: string } {
  const re = new RegExp(`<!-- booking id:${escapeRegExp(id)}(?:\\s[^\\n]*)?-->\\n[\\s\\S]*?<!-- /booking -->\\n?`);
  if (!re.test(content)) return { removed: false, content };
  return { removed: true, content: content.replace(re, "") };
}

// The block's one-line Norwegian summary (the "- <details>" line right after the header) —
// used to make the veto admin DM readable ("Fjernet booking <details-first-line>").
function detailsLineFor(content: string, id: string): string | undefined {
  const re = new RegExp(`<!-- booking id:${escapeRegExp(id)}(?:\\s[^\\n]*)?-->\\n- ([^\\n]*)`);
  return content.match(re)?.[1];
}

function intersects(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

function hasStayContent(stay: Booking["stay"]): stay is NonNullable<Booking["stay"]> {
  if (!stay) return false;
  return Boolean(stay.wifi || stay.doorCode || stay.checkIn || stay.checkOut || stay.rules?.length || stay.leavingTasks?.length);
}

function buildHusSection(stay: NonNullable<Booking["stay"]>): string {
  const lines = [HUS_HEADING];
  if (stay.wifi) lines.push(`- Wifi: ${stay.wifi}`);
  if (stay.doorCode) lines.push(`- Dørkode: ${stay.doorCode}`);
  if (stay.checkIn) lines.push(`- Innsjekk: ${stay.checkIn}`);
  if (stay.checkOut) lines.push(`- Utsjekk: ${stay.checkOut}`);
  if (stay.rules?.length) lines.push(`- Husregler: ${stay.rules.join("; ")}`);
  if (stay.leavingTasks?.length) lines.push(`- Før avreise: ${stay.leavingTasks.join("; ")}`);
  return lines.join("\n");
}

function husSectionBounds(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((l) => l.trim() === HUS_HEADING);
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return { start, end };
}

// Inverse of buildHusSection: read the existing section's field lines back into a partial
// stay object so a new booking's facts can be OVERLAID rather than replacing the whole
// section (a check-in-guide mail and a separate host mail must both survive).
const HUS_LABELS: { label: string; field: keyof NonNullable<Booking["stay"]>; list: boolean }[] = [
  { label: "Wifi", field: "wifi", list: false },
  { label: "Dørkode", field: "doorCode", list: false },
  { label: "Innsjekk", field: "checkIn", list: false },
  { label: "Utsjekk", field: "checkOut", list: false },
  { label: "Husregler", field: "rules", list: true },
  { label: "Før avreise", field: "leavingTasks", list: true },
];

function parseHusSection(content: string): NonNullable<Booking["stay"]> {
  const lines = content.split("\n");
  const bounds = husSectionBounds(lines);
  const out: NonNullable<Booking["stay"]> = {};
  if (!bounds) return out;
  for (const line of lines.slice(bounds.start + 1, bounds.end)) {
    const m = line.match(/^- ([^:]+): (.*)$/);
    if (!m) continue;
    const spec = HUS_LABELS.find((s) => s.label === m[1]);
    if (!spec) continue;
    if (spec.list) {
      (out[spec.field] as string[]) = m[2].split("; ").filter(Boolean);
    } else {
      (out[spec.field] as string) = m[2];
    }
  }
  return out;
}

function unionLists(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  if (!incoming?.length) return existing;
  const merged = [...(existing ?? [])];
  for (const item of incoming) if (!merged.includes(item)) merged.push(item);
  return merged;
}

function mergeStay(store: TripStore, trip: Trip, stay: NonNullable<Booking["stay"]>): void {
  const existing = store.read(trip, TRIP_FILE);
  const prior = parseHusSection(existing);
  // Per-field accumulate: the new booking's defined fields win; everything the section
  // already knew is kept. List fields union without duplicates.
  const merged: NonNullable<Booking["stay"]> = {
    wifi: stay.wifi ?? prior.wifi,
    doorCode: stay.doorCode ?? prior.doorCode,
    checkIn: stay.checkIn ?? prior.checkIn,
    checkOut: stay.checkOut ?? prior.checkOut,
    rules: unionLists(prior.rules, stay.rules),
    leavingTasks: unionLists(prior.leavingTasks, stay.leavingTasks),
  };

  const lines = existing.split("\n");
  const bounds = husSectionBounds(lines);
  const base = (bounds ? lines.slice(0, bounds.start).concat(lines.slice(bounds.end)).join("\n") : existing).replace(/\s+$/, "");
  const section = buildHusSection(merged);
  const newContent = (base ? `${base}\n\n` : "") + section + "\n";
  store.write(trip, TRIP_FILE, newContent);
}

export class BookingPipeline {
  private deps: BookingDeps;

  constructor(deps: BookingDeps) {
    this.deps = deps;
  }

  private findTripFor(startISO: string, endISO: string | undefined): Trip | undefined {
    const bStart = startISO;
    const bEnd = endISO ?? startISO;
    return this.deps.store.trips().find((t) => intersects(bStart, bEnd, t.start, t.end));
  }

  private isVetoedAnywhere(id: string): boolean {
    return this.deps.store.trips().some((trip) => Boolean(loadVetoed(trip)[id]));
  }

  /**
   * ORB-105 order-independence, half one: has a cancellation for this reservation ALREADY been
   * seen?
   *
   * The two mails can arrive in either order, and a sweep reads a year of mail in whatever order
   * Gmail hands it over. If the cancellation is swept FIRST, the booking that follows must not be
   * filed at all — otherwise the trip file ends up confidently listing a dead reservation, which
   * is exactly the live 2026-08-17 case.
   *
   * The extraction cache IS the record: a cancellation is cached like any other understood mail,
   * so scanning it costs nothing and needs no second store. Without a cache (screenshot flows,
   * older callers) suppression cannot work and the pipeline behaves as before — the cancellation
   * still removes an already-filed block, it just cannot pre-empt a future one.
   */
  private cancellationFor(booking: Booking): Booking | undefined {
    for (const [, entry] of this.deps.cache?.entries() ?? []) {
      const other = entry.booking;
      if (other && isCancellation(other) && isSameReservation(other, booking)) return other;
    }
    return undefined;
  }

  /** The filed block describing the same reservation as `booking`: by reference via the cache
   *  first (exact), else by date window from the block headers (coarse). Never the booking's own
   *  block — that is a duplicate, handled separately. */
  private findSupersededBlockId(content: string, booking: Booking): string | undefined {
    for (const [id, entry] of this.deps.cache?.entries() ?? []) {
      if (id === booking.id) continue;
      const other = entry.booking;
      if (!other || isCancellation(other)) continue;
      if (!isSameReservation(other, booking)) continue;
      if (hasBlockFor(content, id)) return id;
    }
    // The header fallback is allowed to REMOVE (a cancellation naming a reservation the cache
    // never saw) but never to REPLACE. Removing on a coarse match is visible and recoverable —
    // Bendik gets a DM naming what went — whereas silently overwriting one booking with a
    // different one is neither.
    if (!isCancellation(booking)) return undefined;
    const byWindow = findBlockIdByWindow(content, booking);
    return byWindow === booking.id ? undefined : byWindow;
  }

  /**
   * ORB-105 order-independence, half two: a cancellation applied to whatever is filed.
   *
   * Removes the matching block from whichever trip holds it, logs it, tells Bendik. A
   * cancellation matching nothing is NOT a failure — it is the early half of the other ordering,
   * and its whole value is being cached so the booking it cancels is never filed later. Either
   * way the outcome is "cancelled": the mail was understood.
   */
  private async applyCancellation(cancellation: Booking): Promise<"cancelled"> {
    for (const trip of this.deps.store.trips()) {
      const content = this.deps.store.read(trip, BOOKINGS_FILE);
      const id = this.findSupersededBlockId(content, cancellation);
      if (!id) continue;

      const details = detailsLineFor(content, id);
      const { removed, content: next } = removeBlockFor(content, id);
      if (!removed) continue;

      this.deps.store.write(trip, BOOKINGS_FILE, next);
      // A tombstone, for the same reason a veto leaves one: the cached original would otherwise
      // be replayed straight back into the file by the next sweep.
      markVetoed(trip, id);

      const when = new Date(this.deps.now() * 1000).toISOString().slice(0, 16).replace("T", " ");
      this.deps.store.appendReiseLog(`- ${when} «${details ?? cancellation.details}» → avbestilt, fjernet fra ${trip.name}`);
      await this.deps.tg.send(this.deps.adminId, `🗑 Avbestilt: ${details ?? cancellation.details} — fjernet fra turen.`);
      return "cancelled";
    }
    return "cancelled";
  }

  async processMail(
    mail: ReiseMail,
    opts?: { quietUnclear?: boolean },
  ): Promise<MailOutcome> {
    const result = await this.processMailInner(mail, opts);
    // Every seen mail leaves a trace — silent skips (duplicate/no-trip/not-booking) were
    // invisible before, so Marcel denied ever seeing mail the sweep had actually read.
    this.deps.store.appendReiseLog(
      `- ${mail.receivedAt.slice(0, 16).replace("T", " ")} «${mail.subject}» (${mail.from}) → ${OUTCOME_LABEL[result]}`,
    );
    return result;
  }

  private async processMailInner(
    mail: ReiseMail,
    opts?: { quietUnclear?: boolean },
  ): Promise<MailOutcome> {
    // A previously-vetoed booking must never get refiled by a re-poll or backfill — check
    // BEFORE the (costly, LLM-backed) extract call, using the gmail message id directly.
    if (this.isVetoedAnywhere(mail.id)) return "duplicate";

    // CACHE FIRST (2026-08-17 rethink): a message we have already understood never costs a
    // second LLM call. A cached non-booking is a terminal skip; a cached BOOKING is
    // replayed against the CURRENT trip windows — which is what lets "create the trip,
    // sweep again" file yesterday's orphans for free.
    // A cached verdict from an OLDER extractor is not a verdict — see
    // lib/extraction-cache.ts's `isStaleVerdict`. This is what lets a prompt fix reach the mails
    // the old prompt got wrong, instead of being shadowed by its own cache forever.
    const cachedEntry = this.deps.cache?.get(mail.id);
    const cached = cachedEntry && !isStaleVerdict(cachedEntry) ? cachedEntry : undefined;
    if (cached) {
      if (!cached.booking) return "not-booking";
      // A cached CANCELLATION is re-applied rather than re-filed: on a later sweep the booking it
      // cancels may have been filed in between (a trip created since), and this is what removes it
      // again. Idempotent — one that matches nothing simply reports "cancelled".
      const replayed = isCancellation(cached.booking)
        ? await this.applyCancellation({ ...cached.booking, id: mail.id })
        : await this.file({ ...cached.booking, id: mail.id }, "Reise");
      this.deps.cache?.put(mail.id, { ...cached, outcome: replayed });
      return replayed;
    }

    // Seam contract: extract() returns null when the model concludes the mail is NOT a
    // booking (newsletters, order receipts, forwarded threads) — that's a silent skip. Only
    // a hard error (throw / unparseable reply) means "unclear" and worth a DM. Unclear is
    // deliberately NOT cached — transient, retried next sweep.
    let raw: Booking | null;
    try {
      raw = await this.deps.extract(mail);
    } catch {
      if (!opts?.quietUnclear) {
        await this.deps.tg.send(
          this.deps.adminId,
          `🤔 Skjønte ikke e-posten "${mail.subject}" — kan du videresende den, eller sende et skjermbilde?`,
        );
      }
      return "unclear";
    }

    if (!raw) {
      this.deps.cache?.put(mail.id, {
        outcome: "not-booking", booking: null, subject: mail.subject,
        extractedAt: new Date(this.deps.now() * 1000).toISOString(),
        extractorVersion: EXTRACTOR_VERSION,
      });
      return "not-booking";
    }

    // The dedupe/veto key is the actual gmail message id, not whatever the extractor echoed
    // back — enforce it here so it can never drift.
    const booking = { ...raw, id: mail.id };
    const outcome = isCancellation(booking)
      ? await this.applyCancellation(booking)
      : await this.file(booking, "Reise");
    this.deps.cache?.put(mail.id, {
      outcome, booking, subject: mail.subject,
      extractedAt: new Date(this.deps.now() * 1000).toISOString(),
      extractorVersion: EXTRACTOR_VERSION,
    });
    return outcome;
  }

  /** File an already-extracted booking (from mail or a screenshot) — window match, block
   *  append, stay merge, and the admin veto DM. The id is the caller's dedupe/veto key. */
  async file(booking: Booking, sourceLabel: string): Promise<FiledOutcome> {
    if (this.isVetoedAnywhere(booking.id)) return "duplicate";

    // ORB-105: a cancellation already seen for this reservation means it must never be filed,
    // whichever order the two mails arrived in.
    if (this.cancellationFor(booking)) return "cancelled";

    const trip = this.findTripFor(booking.startISO, booking.endISO);
    if (!trip) return "no-trip";

    const existing = this.deps.store.read(trip, BOOKINGS_FILE);
    if (hasBlockFor(existing, booking.id)) return "duplicate";
    if (hasSemanticDuplicate(existing, booking)) {
      // Same reservation in another mail (per-passenger ticket, confirmation vs receipt): no
      // new block, no DM — but its stay facts may be NEW (check-in guide vs host mail), so
      // the house-info merge still runs.
      if (hasStayContent(booking.stay)) mergeStay(this.deps.store, trip, booking.stay);
      return "duplicate";
    }

    // ORB-105: a CHANGED reservation (new date, new time, new room) carries the same reference as
    // the one already filed. Appending would leave the trip listing both the old dinner and the
    // new one — the second live case, which only looked right because dedupe happened to catch
    // it. Replace instead, and say so.
    const supersededId = this.findSupersededBlockId(existing, booking);
    let replaced: string | undefined;
    if (supersededId) {
      const previous = detailsLineFor(existing, supersededId);
      const { removed, content: next } = removeBlockFor(existing, supersededId);
      if (removed) {
        replaced = previous;
        this.deps.store.write(trip, BOOKINGS_FILE, next);
        markVetoed(trip, supersededId);
      }
    }

    // ORB-109 — resolve the venue's coordinates once, here, best-effort. A failure costs the
    // geofence and nothing else: the booking is filed either way.
    let coords: { lat: number; lon: number; placeId?: string } | undefined;
    if (this.deps.venueCoords) {
      try {
        coords = await this.deps.venueCoords(booking);
      } catch (err) {
        console.error("eve-marcel: venue coordinate lookup failed (booking filed anyway) —", err);
      }
    }

    const block = bookingBlock(
      booking.id, booking.kind, booking.startISO, booking.endISO, booking.startTime, booking.details, booking.provider,
      coords ?? (booking.lat !== undefined ? { lat: booking.lat, lon: booking.lon } : undefined),
      { name: booking.provider, address: booking.place, kind: booking.kind, ...(coords?.placeId ? { placeId: coords.placeId } : {}) },
    );
    this.deps.store.append(trip, BOOKINGS_FILE, block);

    if (hasStayContent(booking.stay)) {
      mergeStay(this.deps.store, trip, booking.stay);
    }

    await this.deps.tg.send(
      this.deps.adminId,
      replaced ? `✏️ Endret: ${replaced} → ${booking.details}` : `📩 Fant i ${sourceLabel}: ${booking.details}`,
      { buttons: [{ text: "Ikke denne turen", data: `veto:${booking.id}` }] },
    );

    if (replaced) {
      const when = new Date(this.deps.now() * 1000).toISOString().slice(0, 16).replace("T", " ");
      this.deps.store.appendReiseLog(`- ${when} «${replaced}» → erstattet av «${booking.details}»`);
    }

    return "filed";
  }

  /**
   * ORB-109 — give ALREADY-FILED blocks their coordinates.
   *
   * Coordinates are captured when a booking is filed, which does nothing for the bookings that
   * were filed before this existed — including every dinner of the NYC trip this feature was
   * built for. Without a backfill the geofence would have been correct and useless.
   *
   * Bounded and cheap: only blocks that have a provider and no `at:` are looked at, the taste
   * store answers most of them for free, and a block that cannot be resolved is left exactly as
   * it is and simply retried next sweep. Runs after a sweep, never in a tick.
   *
   * Returns how many blocks gained coordinates.
   */
  async backfillVenueCoords(): Promise<number> {
    if (!this.deps.venueCoords) return 0;
    let filled = 0;

    for (const trip of this.deps.store.trips()) {
      let content = this.deps.store.read(trip, BOOKINGS_FILE);
      let changed = false;

      for (const header of bookingHeaders(content)) {
        if (header.lat !== undefined) continue;

        // Prefer the CACHED extraction for this message: it holds the venue's real name and
        // address, while the header only kept a normalized slug ("publichotelnewyork"). A slug
        // still matches the taste store (both sides normalize), but it makes a poor Places
        // query — and Places is exactly the path that needs a readable name.
        //
        // It is also the ONLY source for a block filed before `provider:` existed, which is
        // every block of the trip this feature was built for. Keying on the header's provider
        // alone skipped all of them (found live, 2026-08-17): the block id IS the gmail message
        // id, so the cache answers for exactly those.
        const cached = this.deps.cache?.get(header.id)?.booking;
        if (!cached && header.provider === undefined) continue;
        let coords: { lat: number; lon: number } | undefined;
        try {
          coords = await this.deps.venueCoords(
            cached ?? {
              id: header.id,
              kind: header.kind,
              provider: header.provider ?? "",
              startISO: header.start,
              details: "",
            },
          );
        } catch (err) {
          console.error("eve-marcel: venue coordinate backfill failed for one block —", err);
        }
        if (!coords) {
          console.log(`eve-marcel: no coordinates for booked venue "${cached?.provider ?? header.provider ?? header.id}"`);
          continue;
        }

        const next = rewriteHeaderCoords(content, header.id, coords);
        if (next === content) continue;
        content = next;
        changed = true;
        filled++;
      }

      if (changed) this.deps.store.write(trip, BOOKINGS_FILE, content);
    }
    return filled;
  }

  async veto(bookingId: string): Promise<void> {
    for (const trip of this.deps.store.trips()) {
      const content = this.deps.store.read(trip, BOOKINGS_FILE);
      const details = detailsLineFor(content, bookingId);
      const { removed, content: next } = removeBlockFor(content, bookingId);
      if (removed) {
        this.deps.store.write(trip, BOOKINGS_FILE, next);
        markVetoed(trip, bookingId);

        // The filing already logged "arkivert" — without this line the reise-log would keep
        // claiming a booking exists that Bendik just removed.
        const when = new Date(this.deps.now() * 1000).toISOString().slice(0, 16).replace("T", " ");
        this.deps.store.appendReiseLog(`- ${when} «${details ?? bookingId}» → fjernet av Bendik («Ikke denne turen»)`);

        // v1 fix: stay facts already merged into trip.md aren't unmerged on veto (there's no
        // per-field provenance to undo). Detect the risk with the simplest available signal
        // — a Hus section exists on this trip at all — and tell the admin to check by hand
        // rather than silently leaving possibly-wrong house info in place.
        const tripMd = this.deps.store.read(trip, TRIP_FILE);
        if (tripMd.includes(HUS_HEADING)) {
          await this.deps.tg.send(
            this.deps.adminId,
            `⚠️ Fjernet booking ${details ?? bookingId}. NB: hus-info fra denne kan ligge igjen i trip.md (${HUS_HEADING}) — sjekk og rett manuelt.`,
          );
        }
        return;
      }
    }
  }

  /** Sweep variant: per-mail unclear DMs are suppressed — genuinely puzzling mails come back
   *  as subjects for ONE summary line in the completion message instead. */
  async backfill(mails: ReiseMail[], opts?: { listed?: number; budgetExceeded?: () => boolean }): Promise<BackfillResult> {
    const out: BackfillResult = { filed: 0, cancelled: 0, duplicates: 0, noTrip: 0, notBooking: 0, unclearSubjects: [] };
    let read = 0;
    for (const mail of mails) {
      // Caller-side budget check, per mail. The extraction call tracks spend but nothing ever
      // ENFORCED the cap inside a sweep — the gatekeeper has this check, the sweep never did,
      // and a sweep is ~100 sequential Opus calls, by far the most expensive thing Marcel does.
      // Stopping is reported, never silent.
      if (opts?.budgetExceeded?.() === true) {
        out.budgetStopped = true;
        break;
      }
      read++;
      const result = await this.processMail(mail, { quietUnclear: true });
      if (result === "filed") out.filed++;
      if (result === "cancelled") out.cancelled++;
      if (result === "duplicate") out.duplicates++;
      if (result === "no-trip") out.noTrip++;
      if (result === "not-booking") out.notBooking++;
      if (result === "unclear") out.unclearSubjects.push(mail.subject);
    }
    out.read = read;
    if (opts?.listed !== undefined) out.listed = opts.listed;
    return out;
  }

  /**
   * `/nytur`'s half of the 2026-08-17 rethink: the moment a trip is created, every cached
   * "no-trip" booking whose dates fall inside the new window is filed into it — no
   * re-sweep, no re-extraction, no waiting. Each filing goes through `file()`, so the
   * dedupe/veto/stay-merge rules and the per-booking veto DM apply exactly as if the mail
   * had arrived after the trip existed. Returns how many were filed.
   */
  async retroMatch(): Promise<number> {
    const cache = this.deps.cache;
    if (!cache) return 0;
    let filed = 0;
    for (const [id, entry] of cache.entries()) {
      if (entry.outcome !== "no-trip" || !entry.booking) continue;
      // A cancellation is never "filed" into a new trip, and neither is anything it cancels —
      // `file()` enforces the latter, this skips the former.
      if (isCancellation(entry.booking)) continue;
      const outcome = await this.file({ ...entry.booking, id }, "Reise (retro)");
      cache.put(id, { ...entry, outcome });
      if (outcome === "filed") filed++;
    }
    return filed;
  }
}

// ─── Trip discovery from orphans (2026-08-17 rethink) ────────────────────────────────────

export interface OrphanCluster {
  start: string; // ISO date of the earliest booking in the cluster
  end: string;   // ISO date of the latest end (or start) in the cluster
  count: number;
  /** Up to three one-line booking summaries, for the completion report. */
  samples: string[];
}

/** Groups cached no-trip bookings into date-window clusters — bookings whose windows
 *  overlap or sit within `gapDays` of each other belong to the same would-be trip. A
 *  cluster of 2+ is a trip announcing itself; singletons are noise and dropped. */
export function orphanClusters(
  entries: Array<[string, import("./extraction-cache.js").CachedExtraction]>,
  gapDays = 2,
): OrphanCluster[] {
  const orphans = entries
    .filter(([, e]) => e.outcome === "no-trip" && e.booking)
    .map(([, e]) => e.booking as Booking)
    .sort((a, b) => a.startISO.localeCompare(b.startISO));
  if (orphans.length === 0) return [];

  const gapMs = gapDays * 86_400_000;
  const clusters: Array<{ start: string; end: string; bookings: Booking[] }> = [];
  for (const b of orphans) {
    const bEnd = b.endISO ?? b.startISO;
    const cur = clusters[clusters.length - 1];
    if (cur && Date.parse(b.startISO) <= Date.parse(cur.end) + gapMs) {
      cur.bookings.push(b);
      if (bEnd > cur.end) cur.end = bEnd;
    } else {
      clusters.push({ start: b.startISO, end: bEnd, bookings: [b] });
    }
  }
  return clusters
    .filter((c) => c.bookings.length >= 2)
    .map((c) => ({
      start: c.start,
      end: c.end,
      count: c.bookings.length,
      samples: c.bookings.slice(0, 3).map((b) => b.details),
    }));
}
