/**
 * lib/sveip-run.ts — the Reise-inbox sweep itself, callable WITHOUT a model in the loop.
 *
 * ## Why this file exists (ORB-107)
 *
 * `/sveip` used to be nothing but a tool description, which meant every sweep depended on the
 * model choosing to call it. On 2026-08-17 the model stopped choosing. A sweep started at
 * 13:44 was killed mid-flight by a deploy, so its completion report never arrived; the
 * completion report and the interruption DM are both raw `sendTelegramMessage` sends, invisible
 * to the agent session, so the last thing the model had in context was the 13:44 ack. From
 * then on it answered every `/sveip` with a polite refusal — *"Sveipen kjører allerede fra i
 * sted, så jeg starter den ikke på nytt"* — and the refusal happened UPSTREAM of the tool, so
 * ORB-104's marker file (which knew perfectly well that no sweep was running) was never
 * consulted. Four attempts, four refusals, zero Gmail traffic, an afternoon lost.
 *
 * The fix is structural, not a prompt tweak: `/sveip` is now a **channel-level command**
 * (`agent/channels/telegram.ts`'s `onMessage`, beside the kill-switch branch) that calls
 * `startSveip` directly. Model discretion is removed from the command path entirely. The
 * marker is the only arbiter of "already running", because the marker is the truth and the
 * model's memory is not.
 *
 * The tool (`agent/tools/sveip.ts`) still exists and still calls straight into here — a
 * conversational "kan du sveipe innboksen?" must keep working. What stops THAT path from
 * repeating the same refusal is the sweep-status line
 * `agent/instructions/trip-context.ts` now injects each turn, read from the same marker.
 *
 * ## Sequencing contract (unchanged from the tool's original, and load-bearing)
 *
 * `startSveip` must NOT await the sweep. It sends an immediate ack, writes ORB-104's marker,
 * detaches `backfill()` as a background promise and returns — the sweep can run up to 100
 * sequential LLM extractions and take minutes (old Marcel's `bin/marcel.ts:355-356`: "must not
 * block the serialized update queue — Marcel stays responsive"). The completion report goes out
 * through the SAME raw Telegram primitive, never `to(telegram, {...}).send()`: it is
 * deterministic pre-composed text (filed/cancelled/duplicate/no-trip/not-booking counts), not
 * something a model should paraphrase.
 */
import { readFileSync } from "node:fs";
import { type gmail_v1 } from "googleapis";
import { sendTelegramMessage } from "eve/channels/telegram";

import { gmailClient } from "./google.js";
import { withGmailRateLimit } from "./gmail-ratelimit.js";
import { gatewayModel } from "./gateway-provider.js";
import { telegramCredentials } from "./telegram-credentials.js";
import { mdToTelegramHtml, splitTelegramHtml } from "@lares/agent-kit/telegram-markdown";
import { TripStore } from "./trip-store.js";
import { fileExtractionCache } from "./extraction-cache.js";
import { sharedBudget } from "./shared-budget.js";
import { TasteStore } from "./taste-store.js";
import { makeGooglePlaces } from "./google-places.js";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";
import { resolveVenueCoords } from "./venue-coords.js";
import {
  SWEEP_ALREADY_RUNNING,
  clearSweepMarker,
  isSweepRunning,
  readSweepMarker,
  writeSweepMarker,
} from "./sweep-marker.js";
import {
  BookingPipeline,
  orphanClusters,
  type OrphanCluster,
  extractionDateContext,
  makeExtractBooking,
  renderMailText,
  toReiseMailHeaderFields,
  type AttachmentFetch,
  type BackfillResult,
  type RawGmailMessage,
  type ReiseMail,
} from "./bookings.js";

/** Gate key for Marcel's single shared mailbox — same string old Marcel used
 *  (`services/marcel/lib/gmail.ts`'s `GMAIL_MAILBOX_KEY`), scoping the rate-limit backoff. */
const GMAIL_MAILBOX_KEY = "marcel-reise";
const REISE_LABEL = "Reise";
// Gmail's `after:` filters on RECEIVED date — booking confirmations arrive weeks or months
// before the travel dates, so sweep a full year of the label and let the pipeline's travel-
// date extraction + trip-window matching do the actual filtering (ported from old Marcel's
// `makeGmailBackfill`, `bin/marcel.ts:968-978`).
const BACKFILL_LOOKBACK_DAYS = 365;
/**
 * How many mails one sweep will READ. Raised from 100 on 2026-08-17 (ORB-105 follow-up).
 *
 * The old value was both too low and, far worse, invisible: `messages.list` was called once
 * with `maxResults: 100`, whatever came back was declared the inbox, and the completion report
 * said "ferdig". That is the ORB-45 defect verbatim — a cap that truncates silently and reports
 * completeness — and it is the most likely reason a cancellation mail sitting in the label was
 * never reached by two consecutive sweeps.
 *
 * The real guards are the other two, not this number: the extraction cache makes a re-read of
 * an already-understood mail free, and the daily token budget stops a sweep that would spend
 * too much. Both are reported. This is only the ceiling.
 */
const BACKFILL_MAX_MAILS = 400;
/** Gmail's per-page maximum. Paging is what lets us count the label before truncating it. */
const GMAIL_PAGE_SIZE = 500;

export const SVEIP_ACK = "Sveiper Reise-innboksen — dette tar noen minutter… 🧳";

function brainModelId(): string {
  const id = process.env["MARCEL_MODEL_BRAIN"];
  if (!id) throw new Error("sveip: MARCEL_MODEL_BRAIN is not set");
  return id;
}

/** `services/box/compose.yaml`'s `eve-marcel:` block bind-mounts `/srv/eve-marcel` and
 *  sets `MARCEL_DATA_ROOT` to it. The `/data/marcel` fallback is a safe non-production default
 *  only (local dev/tests). */
function dataRoot(): string {
  return process.env["MARCEL_DATA_ROOT"] ?? "/data/marcel";
}

export function adminChatId(): string {
  const id = (process.env["MARCEL_ADMIN_TELEGRAM_ID"] ?? "").trim();
  if (!id) throw new Error("sveip: MARCEL_ADMIN_TELEGRAM_ID is not set");
  return id;
}

/** "Today", Europe/Oslo wall-clock — matches old Marcel's own sweep wiring
 *  (`todayISOFor("Europe/Oslo", nowSec)`, `bin/marcel.ts:1102`) so year-less dates in mail
 *  ("Wed 29 Jul") resolve the same way. Not per-trip tz: the sweep runs across every trip at
 *  once, so there is no single trip timezone to anchor to. */
function todayISOOslo(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Real Gmail listing for the "Reise" label — ported from old Marcel's `makeGmailReader().
 *  listSince` (`services/marcel/lib/gmail.ts:124-156`), rebuilt against a `gmail_v1.Gmail`
 *  client directly and wrapped in `withGmailRateLimit` on every call. */
async function listReiseMail(
  gmail: gmail_v1.Gmail,
  afterEpochSec: number,
  max: number,
): Promise<{ mails: ReiseMail[]; listed: number }> {
  const fetchAttachment: AttachmentFetch = async (messageId, attachmentId) => {
    const att = await withGmailRateLimit(GMAIL_MAILBOX_KEY, () =>
      gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId }));
    return Buffer.from(att.data.data ?? "", "base64url");
  };

  // Page through the WHOLE label first. Two ids are cheap (one list call per 500 mails) and it
  // is the only way to know whether the read cap below is truncating — which is the entire
  // point: the previous single-page read could not tell "that is all of it" from "that is the
  // first hundred of it", and reported the first as if it were the second.
  const q = `label:${REISE_LABEL} after:${Math.trunc(afterEpochSec)}`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await withGmailRateLimit(GMAIL_MAILBOX_KEY, () =>
      gmail.users.messages.list({ userId: "me", q, maxResults: GMAIL_PAGE_SIZE, ...(pageToken ? { pageToken } : {}) }));
    for (const m of page.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = page.data.nextPageToken ?? undefined;
  } while (pageToken !== undefined);

  const listed = ids.length;
  // Newest first is Gmail's own order, so a truncation drops the OLDEST — the least likely to
  // still matter for a trip.
  const out: ReiseMail[] = [];
  for (const id of ids.slice(0, max)) {
    const got = await withGmailRateLimit(GMAIL_MAILBOX_KEY, () =>
      gmail.users.messages.get({ userId: "me", id, format: "full" }));
    if (got.data?.id) {
      const raw = got.data as RawGmailMessage;
      out.push({ ...toReiseMailHeaderFields(raw), bodyText: await renderMailText(raw, fetchAttachment) });
    }
  }
  return { mails: out, listed };
}

/** Raw Telegram send adapter for `BookingDeps.tg` — every filed booking gets a veto-button
 *  admin DM through this during the sweep, same deterministic-text/raw-primitive rule as the
 *  ack and completion report. Button → inline-keyboard mapping ported from old Marcel's
 *  `services/marcel/lib/telegram.ts:95-96` (`callback_data: veto:<id>`, one row). */
export async function tgSend(
  chatId: string,
  text: string,
  opts?: { buttons?: { text: string; data: string }[] },
): Promise<string> {
  // ORB-112: every raw send goes out as Telegram HTML. These texts carry booking details lifted
  // straight out of mail — a hotel called "Smith & Sons" has to survive, which is what the
  // converter's escape-first pass is for. It also means a sweep report and a model reply are
  // formatted by the same rule instead of two.
  //
  // Telegram hard-caps sendMessage at 4096 chars and answers HTTP 400 past it (live 2026-08-17:
  // an uncapped sweep report). The raw primitive does NOT auto-split like eve's channel post
  // path does, so chunk here — on newlines, which `mdToTelegramHtml` guarantees never cut a tag.
  // Buttons ride ONLY the final chunk; they belong to the message as a whole.
  const chunks = splitTelegramHtml(mdToTelegramHtml(text));
  const reply_markup = opts?.buttons
    ? { inline_keyboard: [opts.buttons.map((b) => ({ text: b.text, callback_data: b.data }))] }
    : undefined;

  let firstId = "";
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    const result = await sendTelegramMessage({
      credentials: telegramCredentials,
      chatId,
      // `parse_mode` is absent from eve's typed TelegramMessageBody but passes straight through
      // at runtime (`normalizeTelegramMessageBody` spreads the body) — the same reason
      // agent/tools/predeparture_pack.ts routes its own HTML sends through the raw API.
      body: { text: chunk, ...(isLast && reply_markup ? { reply_markup } : {}), parse_mode: "HTML" } as never,
      fetch: telegramFetch,
    });
    if (index === 0) firstId = result.id;
  }
  return firstId;
}

/** The real sweep: list a year of "Reise"-labelled mail, run the extraction/dedupe/merge
 *  pipeline over it. This is the seam `SveipDeps.backfill` injects for tests — the ONLY
 *  seam: everything else (the ack, the completion send) goes through the raw
 *  `sendTelegramMessage` primitive directly, verified in tests by mocking that import. */
async function realBackfill(): Promise<BackfillResult> {
  const gmail = await gmailClient();
  const after = Math.floor(Date.now() / 1000) - BACKFILL_LOOKBACK_DAYS * 86_400;
  const { mails, listed } = await listReiseMail(gmail, after, BACKFILL_MAX_MAILS);

  const store = new TripStore(dataRoot());
  // Recomputed on every extraction call (not frozen at sweep start) so a trip created mid-
  // sweep is visible to later calls — matches old Marcel's own `dateContext` closure.
  const dateContext = () => extractionDateContext(todayISOOslo(), store.trips());
  // `sharedBudget` — the SAME instance the gatekeeper's own gate-decision calls add to. See
  // lib/shared-budget.ts for why a second instance would silently lose writes.
  const extract = makeExtractBooking(gatewayModel(brainModelId()), dateContext, sharedBudget);

  // ORB-109 — the Places key is OPTIONAL: without it the taste store is the only source, which
  // is the free one and covers most booked venues anyway. Read lazily, once per sweep, matching
  // agent/tools/nearby_places.ts's own `optionalSecret` posture (a build has no secrets at all).
  let placesKey: string | undefined;
  try {
    placesKey = readFileSync(process.env["GOOGLE_PLACES_API_KEY_FILE"] ?? "/run/secrets/google-places-api-key", "utf8").trim() || undefined;
  } catch {
    placesKey = undefined;
  }
  const google = placesKey ? makeGooglePlaces({ apiKey: placesKey, fetch: telegramFetch }) : undefined;

  const pipeline = new BookingPipeline({
    extract,
    store,
    tg: { send: tgSend },
    adminId: adminChatId(),
    now: () => Math.floor(Date.now() / 1000),
    cache: fileExtractionCache(dataRoot()),
    venueCoords: async (booking) => {
      // The NAME is `provider` ("Cosme", "The Golden Swan"). `place` is whatever the extractor
      // put there, which for a restaurant confirmation is the street ADDRESS — matching on that
      // finds nothing in the taste store and can never slug-match a Places result, so passing it
      // as the name silently resolved nothing at all (found live, 2026-08-17). The address is
      // still useful, but only as a BIAS on the query.
      const hit = await resolveVenueCoords(booking.provider, {
        saved: () => new TasteStore().places(),
        ...(google
          ? {
              searchText: async (q) => {
                const query = booking.place?.trim() ? `${q}, ${booking.place.trim()}` : q;
                return (await google.searchText(query)).map((h) => ({ name: h.name, lat: h.lat, lon: h.lon, id: h.id }));
              },
            }
          : {}),
      });
      return hit ? { lat: hit.lat, lon: hit.lon, ...(hit.placeId ? { placeId: hit.placeId } : {}) } : undefined;
    },
  });

  // The daily cap is shared with the gatekeeper's own calls — see lib/shared-budget.ts. A sweep
  // is the most expensive thing Marcel does (~1 Opus call per uncached mail), so it is the one
  // place that most needs a stop, and until now was the one place without one.
  const result = await pipeline.backfill(mails, { listed, budgetExceeded: () => sharedBudget.exceeded() });

  // ORB-109 — after the mail pass, give any already-filed block its coordinates. Bounded by the
  // number of filed bookings, mostly free (the taste store answers first), and the only way the
  // trip that motivated the feature ever gets geofenced: its dinners were filed before the
  // coordinate capture existed.
  try {
    const filled = await pipeline.backfillVenueCoords();
    // Logged even at zero: "nothing to do" and "tried and resolved nothing" look identical from
    // the outside, and telling them apart is what cost two deploys on 2026-08-17.
    console.log(`eve-marcel: venue-coordinate backfill filled ${filled} block(s)`);
  } catch (err) {
    console.error("eve-marcel: venue coordinate backfill failed (sweep result unaffected) —", err);
  }

  return result;
}

/** The trip-discovery half of the completion report: cached no-trip bookings clustered
 *  into would-be trips (2026-08-17 rethink). Read fresh from the cache AFTER a backfill. */
function realOrphanClusters(): OrphanCluster[] {
  return orphanClusters(fileExtractionCache(dataRoot()).entries());
}

export interface SveipDeps {
  backfill(): Promise<BackfillResult>;
  /** Post-backfill trip-discovery clusters for the completion report. */
  orphans?(): OrphanCluster[];
  /** Injectable clock for ORB-104's marker lifecycle — tests drive the freshness window
   *  without sleeping. */
  now?(): number;
}

export const defaultSveipDeps: SveipDeps = { backfill: realBackfill, orphans: realOrphanClusters };

/** Norwegian completion summary — ported verbatim (minus the per-trip name, since this sweep
 *  runs across every trip at once) from old Marcel's `startSweep`, `bin/marcel.ts:361-374`. */
export function composeCompletionReport(result: BackfillResult, clusters: OrphanCluster[] = []): string {
  const { filed, cancelled, duplicates, noTrip, notBooking, unclearSubjects, listed, read, budgetStopped } = result;
  let msg = `Reise-sveipet er ferdig: fant ${filed} ny${filed === 1 ? "" : "e"} booking${filed === 1 ? "" : "er"}.`;

  // COVERAGE FIRST, before any counts (ORB-105 follow-up). A sweep that read two thirds of the
  // label and said "ferdig" is the ORB-45 defect verbatim; if this sweep did not see everything,
  // that is the most important sentence in the message, not a footnote.
  if (budgetStopped === true) {
    msg = `⚠️ Reise-sveipet stoppet på dagens token-budsjett etter ${read ?? 0} av ${listed ?? "?"} e-poster — kjør /sveip igjen i morgen, resten er cachet. Så langt: fant ${filed} ny${filed === 1 ? "" : "e"} booking${filed === 1 ? "" : "er"}.`;
  } else if (listed !== undefined && read !== undefined && read < listed) {
    msg = `⚠️ Reise-sveipet leste de ${read} nyeste av ${listed} e-poster i Reise-labelen (taket) — eldre e-poster ble ikke sett. Fant ${filed} ny${filed === 1 ? "" : "e"} booking${filed === 1 ? "" : "er"}.`;
  } else if (listed !== undefined) {
    msg = `Reise-sveipet er ferdig: leste alle ${listed} e-poster i Reise-labelen, fant ${filed} ny${filed === 1 ? "" : "e"} booking${filed === 1 ? "" : "er"}.`;
  }
  // Full accounting — a mail that was seen but skipped must never look like "not seen".
  const skips = [
    // ORB-105: a cancellation is neither a filing nor a skip. It changed the trip file, so it
    // belongs in the report — a sweep that quietly removed a hotel must say it did.
    cancelled > 0 ? `${cancelled} avbestilt` : "",
    duplicates > 0 ? `${duplicates} allerede registrert` : "",
    noTrip > 0 ? `${noTrip} traff ingen turdatoer` : "",
    notBooking > 0 ? `${notBooking} var ikke bookinger` : "",
  ].filter((s) => s.length > 0);
  if (skips.length > 0) msg += ` Ellers: ${skips.join(", ")}.`;
  if (unclearSubjects.length > 0) {
    const shown = unclearSubjects.slice(0, 3).map((s) => `«${s}»`).join(", ");
    msg += ` ${unclearSubjects.length} e-post${unclearSubjects.length === 1 ? "" : "er"} skjønte jeg ikke: ${shown}${unclearSubjects.length > 3 ? " …" : ""} — videresend eller send skjermbilde om noen av dem gjelder turen.`;
  }
  // Trip discovery (2026-08-17): orphan bookings clustering in a shared window ARE a trip —
  // surface them instead of burying them in the no-trip counter. /nytur retro-files them.
  // Capped at the 3 largest clusters with trimmed samples (live 2026-08-17 lesson: a fresh
  // store makes EVERY historical booking an orphan, and an uncapped report blew Telegram's
  // 4096-char limit — the sweep succeeded and the report itself 400'd).
  const top = [...clusters].sort((a, b) => b.count - a.count).slice(0, 3);
  for (const c of top) {
    const period = c.start === c.end ? c.start : `${c.start} – ${c.end}`;
    const samples = c.samples.slice(0, 2).map((x) => `«${x.length > 60 ? `${x.slice(0, 60)}…` : x}»`).join(", ");
    msg += `\n\n🧳 Mulig ny tur: ${period} — ${c.count} bookinger uten tur (${samples}). Opprett den med /nytur, så arkiverer jeg dem automatisk.`;
  }
  if (clusters.length > top.length) {
    msg += `\n(+ ${clusters.length - top.length} eldre klynger til — antakelig gamle turer fra før arkivet.)`;
  }
  return msg;
}

/** What a start attempt did. Returned rather than logged so BOTH callers — the channel command
 *  and the tool — can say the same thing in their own idiom without re-deriving it. */
export type SveipStartOutcome = "started" | "already-running";

/**
 * Starts a sweep, or declines because one is genuinely in flight.
 *
 * The ONLY arbiter of "already running" is ORB-104's marker file. Not the model's memory of
 * having acked one, which is what failed on 2026-08-17: a marker is cleared on BOTH settle
 * paths and goes stale after `SWEEP_FRESH_MS`, so a sweep that died with its process, or hung,
 * stops blocking new ones. The model's belief has neither property.
 *
 * Never throws for the ordinary reasons: a failed send is logged, and the sweep still runs.
 */
export async function startSveip(deps: SveipDeps = defaultSveipDeps): Promise<SveipStartOutcome> {
  const chatId = adminChatId();
  const now = deps.now?.() ?? Date.now();

  // Double-start guard: a fresh marker means a sweep is genuinely in flight. Starting a second
  // one costs another ~100 sequential extractions and interleaves two writers over the same
  // trip files, so say so instead.
  if (isSweepRunning(readSweepMarker(dataRoot()), now)) {
    await tgSend(chatId, `⏳ ${SWEEP_ALREADY_RUNNING} — vent til rapporten kommer.`);
    return "already-running";
  }

  // Through `tgSend` like every other outbound text (ORB-112) — one formatting rule for the
  // whole agent, not one per call site.
  await tgSend(chatId, SVEIP_ACK);

  // ORB-104: written BEFORE the detach, cleared by both settle paths below. A marker that
  // survives to the next startup is how an interrupted sweep announces itself
  // (lib/sweep-marker.ts's notifyIfSweepInterrupted) rather than dying in silence.
  writeSweepMarker(dataRoot(), now);

  // Fire-and-forget — explicitly NOT awaited. See this file's top-of-file doc comment.
  void deps
    .backfill()
    // Through `tgSend`, NOT the raw primitive: the report is the one message that routinely
    // exceeds Telegram's 4096-char cap (live 2026-08-17 — a fresh store makes every historical
    // booking an orphan).
    .then((result) => tgSend(chatId, composeCompletionReport(result, deps.orphans?.() ?? [])))
    .catch(async (err: unknown) => {
      console.error("eve-marcel: /sveip backfill failed —", err);
      const message = err instanceof Error ? err.message : String(err);
      await tgSend(chatId, `⚠️ Reise-sveipet feilet: ${message}`).catch(() => {});
    })
    // Both settle paths clear it: a sweep that REPORTED (either way) is not interrupted, and
    // leaving the marker behind would blame the next startup for a sweep that finished fine.
    .finally(() => clearSweepMarker(dataRoot()));

  return "started";
}
