/**
 * The obligation radar's pure logic, its Gmail/Calendar adapters, and the two brief-content
 * builders this task actually delivers — `buildEveningBrief` / `buildMorningBrief`.
 *
 * THE ONE FEATURE EXCEPTION in this wave (see the Wave-1 plan): every other task in this wave
 * is a faithful port. This one is deliberately NEW. The old system reported obligations in
 * three narrated voices (a morning brief, a night-before pass, a re-ping nudge) that between
 * them re-told the same open item on more than one surface and, at least once, asked about a
 * proposal Bendik had already rejected the day before. The contract here is narrower and
 * stricter:
 *
 *   - Obligations are reported BY EXCEPTION. If nothing is owed, say nothing — no "nobody's
 *     waiting on a reply", no negative assurances. The radar speaks only when it caught
 *     something.
 *   - Evening (20:00) = tomorrow's PREP: tomorrow's commitments, plus whatever is owed to the
 *     people in them.
 *   - Morning (08:00) = today's PLATE, prioritised: today's commitments (not a delta — the
 *     frame the rest hangs on), plus the obligations that are new or changed since the evening
 *     pass (still strictly a delta). Amended 2026-08-18 at Bendik's request; it was
 *     delta-only, which meant it never told him what his day held.
 *   - Scheduled output exists to inform, not to prove checking happened.
 *
 * ORB-209 SPLIT OFF THE PIPELINE. The resolve → read → explain stage and the gather that
 * composes it (`gatherOpenObligations`, `GatherObligationsDeps`, `dropResolved`, and the
 * `RESOLUTION_*` constants) now live in `lib/obligation-pipeline.ts`, moved verbatim; the
 * `withTimeout` helper that used to be declared here lives in `lib/timeout.ts`. Both moves are
 * behaviour-neutral, and the second also removed a real ESM import cycle between this file and
 * `lib/obligation-resolution.ts`. The dependency runs ONE WAY now — `obligation-pipeline.ts`
 * imports this file's scan and selection rule, and nothing here imports it back.
 *
 * Ported near-verbatim, consolidated into this one file (the Wave-1 plan's file list gives
 * this task exactly `lib/brief-content.ts` + `lib/obligations-store.ts`, so every piece of the
 * pipeline that isn't a Postgres query lived here, in clearly banded sections, until ORB-209
 * moved the band named above):
 *   - `services/agent-runtime/lib/obligations/types.ts` — `ThreadSnapshot`, `Obligation`.
 *   - `services/agent-runtime/lib/obligations/candidate.ts` — `selectObligations`.
 *   - `services/agent-runtime/lib/obligations/surfaces.ts` — `assignSurfaces`,
 *     `nightBeforeCoveredDay`. Ported with `Obligation[]` in place of the old `RankedObligation[]`
 *     (see "Ranking is OFF" below) — the function never reads `.reason`/`.promise`, so nothing
 *     about the RULE changes.
 *   - `services/agent-runtime/lib/obligations/reping-budget.ts` — `rePingRemaining`/
 *     `rePingRecord`, verbatim. REMOVED by ORB-193: the re-ping cap is now the proactivity
 *     gate's central escalation ceiling (3 per owner-day per door, in `@lares/agent-kit`'s
 *     `initiations` ledger), not this file's per-process count. `heldBackLine` stands where
 *     that band was.
 *   - `services/agent-runtime/lib/adapters/obligations/gmail-source.ts` — `scanThreads`,
 *     `isAutomatedSender`, verbatim (against Task 6's `lib/google.ts` client instead of the old
 *     `gmail-client.ts`).
 *   - `services/agent-runtime/lib/adapters/brief/night-before-calendar.ts` — narrowed to the
 *     "tomorrow" case only (`listExternalMeetings`); the new morning brief's simpler delta
 *     rule (see `buildMorningBrief` below) never needs the "today" case the old morning brief
 *     used for its own participant-matching suppression.
 *   - `services/agent-runtime/lib/adapters/brief/ingested-picks.ts` — `readIngestedPicks`,
 *     verbatim logic, ported without pulling in the digest package's own `parseFrontmatter`
 *     (a five-line function, copied here rather than importing an unrelated module for it).
 *
 * RANKING IS OFF, entirely — not just for the re-ping lane (the old system's `{ rank: false }`)
 * but everywhere in this task. `surfaces.ts`'s own header already argues ranking has no
 * business deciding what interrupts; this task goes further and never spends the model call at
 * all, for any surface. `candidate.ts`'s `selectObligations` already returns most-overdue-first,
 * which is the only ordering anything here needs — `lib/adapters/obligations/rank.ts` (the
 * LLM-reason-per-item pass) is not ported. No message body is ever retained in memory beyond a
 * single tick, and none is ever persisted (`sql/019_obligations.sql`'s own banner).
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: write prose. `BriefContent` carries raw facts —
 * meetings, obligations, picks — never a pre-written sentence. The schedules
 * (`agent/schedules/evening-brief.ts` etc.) hand those facts to a resumed agent turn along with
 * the tone rule ("write to inform, not to prove checking happened; never state that nothing is
 * outstanding"), and the turn composes what Bendik actually reads.
 *
 * ONE EXCEPTION, named rather than left to be noticed: `heldBackLine` (ORB-193) returns a finished
 * sentence, in the caller's chosen language (LAR-16-s2). It is not brief CONTENT — it is a
 * statement about the delivery system itself
 * ("these three things were held back"), which the model has no way to know and no business
 * paraphrasing, since a paraphrase could soften or drop the one line that keeps a quiet gate from
 * being a silent one. It rides into the prompt as context like the facts do, and it is the only
 * pre-written sentence in this file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  detectCalendarConflicts,
  type CalendarConflict,
  type ConflictKind,
  type ConflictTrip,
} from "./calendar-conflicts.js";
import type { ResolvedConflict } from "./conflict-resolution.js";
import type { CalendarEvent } from "./google.js";
import type { ThreadMessage } from "./google.js";
import { dateIn, osloDate } from "./recurrence.js";
import { standingFactLine, type StandingFact } from "./standing-facts.js";
import type { BriefLanguage } from "./brief-settings.js";
import { BRIEF_STRINGS } from "./brief-strings.js";
import { DEFAULT_HOME_TZ } from "@lares/agent-kit/owner-clock";
import {
  DEFAULT_HORIZON_DAYS,
  TravelPathNotConfiguredError,
  currentTravel,
  type TravelBooking,
  type TravelItinerary,
  type TravelResult,
} from "./travel-store.js";
import { labeledContext } from "@lares/compose-contract";
import type { DeadlineSource } from "@lares/agent-kit/deadlines";
import type { SignalRow } from "@lares/agent-kit/signals-client";

/**
 * The address inside "Lars Eriksen <lars@nomono.co>", lowercased. A local copy of
 * `lib/person-sources.ts`'s `addressOf` rather than an import of it — that module pulls in
 * Twenty/Orakel/network clients this file (and its tests) have no reason to depend on for a
 * three-line string helper.
 */
export function addressOf(header: string): string {
  const m = /<([^>]+)>/.exec(header);
  return (m?.[1] ?? header).trim().toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Types — ported from services/agent-runtime/lib/obligations/types.ts
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * One thread reduced to the facts the rule needs — deliberately NOT the messages.
 *
 * Everything here is structural: who spoke last, how many of their messages went unanswered,
 * whether he was addressed. None of it requires reading a word of content, which is what lets
 * detection run with no model and no stored bodies.
 */
export interface ThreadSnapshot {
  threadId: string;
  /** Carried for the schedule prompt only. Never persisted — see lib/obligations-store.ts. */
  subject: string;
  counterpartyName: string;
  counterpartyAddress: string;
  lastMessageAt: Date;
  /** The most recent message in the thread came from them. */
  lastSpeakerIsThem: boolean;
  /** He was in To:, not merely Cc:. Being copied is not being asked. */
  addressedToHim: boolean;
  /** A list, a no-reply@, a notification. */
  isAutomated: boolean;
  /**
   * ORB-180 Workstream B — institutional DUE-NOTICE mail (`isInstitutionalDueNotice`): a VAT
   * reminder from Fiken, a letter from Skatteetaten, an invoice that falls due. Nobody behind
   * one of these is waiting for a reply, so `selectObligations` drops it; the morning brief
   * offers it ONCE as a deadline candidate instead (`deadlinesBlock`) and then goes quiet.
   *
   * OPTIONAL, and absent means "not one": every existing snapshot literal, and every Slack
   * snapshot (a Slack DM is a person, never an institution), keeps meaning exactly what it meant.
   */
  isDeadlineCandidate?: boolean;
  /** How many of their messages sit unanswered at the end of the thread. ≥2 is a re-ping. */
  theirUnansweredCount: number;
  /** Set when he has said "handled" — the item is closed for good. */
  dismissedAt?: Date;
  /**
   * IN FLIGHT ONLY (ORB-45 Task 10, B1) — the counterparty's last message, trimmed to
   * `LAST_MESSAGE_MAX_CHARS`. Feeds Task B3's bounded model read and Task B5's reason line.
   * Never persisted — `lib/obligations-store.ts`'s `upsertSeen` writes pointer columns only and
   * has no column for this.
   */
  lastMessageText?: string;
  /** Every address this counterparty is known by, for Task B2's cross-channel resolution
   *  ("did he answer them on email / calendar / Slack / iMessage after their message?"). */
  counterpartyEmails?: string[];
  counterpartySlackUserId?: string;
  /** Set by each scanner (`scanThreads` / the Slack builders) — never inferred from the
   *  threadId's prefix, so a caller never has to re-derive what the source already knows. */
  source: "gmail" | "slack";
}

/** The counterparty's last message, in flight, is trimmed to this many characters before it
 *  ever reaches an `Obligation` — bounding both the model read (Task B3) and the log/prompt
 *  surface it passes through on the way there. */
export const LAST_MESSAGE_MAX_CHARS = 2000;

export interface Obligation {
  threadId: string;
  subject: string;
  counterpartyName: string;
  counterpartyAddress: string;
  lastMessageAt: Date;
  ageHours: number;
  /** They messaged again on top of their own unanswered message. A FACT, not a judgement — and
   *  the only thing in this system permitted to interrupt him. */
  isRePing: boolean;
  /**
   * How many of their messages sit unanswered at the end of the thread — carried through from
   * the snapshot rather than collapsed into the `isRePing` boolean, so the re-ping dedupe can
   * tell a SECOND bump from a THIRD one (see `assignSurfaces` below).
   */
  unansweredCount: number;
  /** Carried from the snapshot, dropped by the store (see tests/obligations.test.ts) — never
   *  reaches `obligation_threads`. */
  lastMessageText?: string;
  counterpartyEmails?: string[];
  counterpartySlackUserId?: string;
  /** Derived from the snapshot that produced this obligation — see `ThreadSnapshot.source`. */
  source: "gmail" | "slack";
  /** Why it is on the list, in words — rendered on every brief line. Set by Task B5. */
  reason?: string;
}

export interface CandidateOptions {
  owedAfterHours?: number;
  rePingAfterHours?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Candidate selection — ported from services/agent-runtime/lib/obligations/candidate.ts
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Below this it is not late, it is Tuesday. */
export const OWED_AFTER_HOURS = 48;

/** A re-ping qualifies sooner, because it carries more information than age does: they cared
 *  enough to ask twice. */
export const REPING_AFTER_HOURS = 24;

const hoursBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / 3_600_000);

export function selectObligations(
  threads: ThreadSnapshot[],
  now: Date,
  opts: CandidateOptions = {},
): Obligation[] {
  const owedAfter = opts.owedAfterHours ?? OWED_AFTER_HOURS;
  const rePingAfter = opts.rePingAfterHours ?? REPING_AFTER_HOURS;

  const out: Obligation[] = [];
  for (const t of threads) {
    if (t.dismissedAt) continue;              // he has closed it; it does not come back
    if (!t.lastSpeakerIsThem) continue;       // he spoke last — the ball is not his
    if (t.isAutomated) continue;              // a list is not a person waiting
    // ORB-180 Workstream B — a due notice is a DEADLINE, not an owed reply. Nobody at Fiken is
    // waiting for him to write back; the brief offers it once as a candidate and stops.
    if (t.isDeadlineCandidate) continue;
    if (!t.addressedToHim) continue;          // being copied is not being asked

    const ageHours = hoursBetween(t.lastMessageAt, now);
    const isRePing = t.theirUnansweredCount >= 2;
    if (ageHours < (isRePing ? rePingAfter : owedAfter)) continue;

    out.push({
      threadId: t.threadId,
      subject: t.subject,
      counterpartyName: t.counterpartyName,
      counterpartyAddress: t.counterpartyAddress,
      lastMessageAt: t.lastMessageAt,
      ageHours,
      isRePing,
      unansweredCount: t.theirUnansweredCount,
      lastMessageText: t.lastMessageText,
      counterpartyEmails: t.counterpartyEmails,
      counterpartySlackUserId: t.counterpartySlackUserId,
      source: t.source,
    });
  }

  // Most overdue first. Recency ordering would bury the item that has been waiting longest,
  // which is exactly the one he has stopped seeing.
  return out.sort((a, b) => b.ageHours - a.ageHours);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Surfaces — ported from services/agent-runtime/lib/obligations/surfaces.ts, with Obligation[]
// in place of the old file's RankedObligation[] (ranking is off — see the module header).
// ═══════════════════════════════════════════════════════════════════════════════════════════

export interface SurfaceAssignment {
  nightBefore: Obligation[];
  brief: Obligation[];
  interrupt: Obligation[];
}

/**
 * Membership is decided BY RULE: an obligation owed to someone he is meeting tomorrow belongs
 * to the evening pass, everything else to the morning; no item is ever on both.
 *
 * The boundary this whole design turns on: interrupt = re-pings only. A re-ping is a FACT —
 * they messaged again on top of their own unanswered message. No model reaches this function,
 * and nothing it produces can put an item into `interrupt`.
 */
export function assignSurfaces(
  items: Obligation[],
  tomorrowsParticipants: Set<string>,
  /**
   * thread id → the unanswered count that was true when this thread last nudged him. A MAP
   * (not a Set) so the same bump stays quiet while a NEW one (a higher unanswered count) earns
   * one more nudge — still a mechanical comparison of two integers.
   */
  alreadyAnnounced: ReadonlyMap<string, number>,
): SurfaceAssignment {
  const meeting = new Set([...tomorrowsParticipants].map((a) => a.toLowerCase()));

  const nightBefore: Obligation[] = [];
  const brief: Obligation[] = [];
  const interrupt: Obligation[] = [];

  for (const o of items) {
    // `o.counterpartyAddress &&` guards a carried-forward placeholder: markRePingAnnounced /
    // markNightBeforeDelivered can write a '' address before upsertSeen ever heals it — an
    // empty counterpartyAddress must never match an empty `meeting` entry.
    if (o.counterpartyAddress && meeting.has(o.counterpartyAddress.toLowerCase())) nightBefore.push(o);
    else brief.push(o);

    // `>` not `>=`: an unchanged count is the SAME bump he was already told about. A count that
    // has GROWN is new information — they asked again after being told.
    const announcedAt = alreadyAnnounced.get(o.threadId);
    if (o.isRePing && (announcedAt === undefined || o.unansweredCount > announcedAt)) interrupt.push(o);
  }

  return { nightBefore, brief, interrupt };
}

/**
 * The calendar day an evening pass running at `now` is ABOUT — always tomorrow, on the OWNER's
 * clock (`tz`). Used both to decide which day's meetings count as "tomorrow" and to stamp
 * `night_before_delivered_day`, so the two can never drift apart.
 *
 * LAR-67 — this was the home clock's tomorrow. At 20:00 in New York it is already past midnight
 * at home, so the pass prepared him for the day AFTER tomorrow and stamped that day too. The
 * morning pass reads the stamp back as `dateIn(now, tz)` — ITS today on the same owner clock —
 * and the two must move together: a stamp written on one clock and read on the other matches
 * nothing, which repeats last night's obligations (the safe direction, but a repeat).
 *
 * If the owner's clock CHANGES between the evening and the next morning, the two dates still
 * agree in every ordinary case (the morning after is the day after, on either clock). The one
 * exception is a jump so far east that his next 08:00 falls two dates on (an evening in Los
 * Angeles, the next morning in Auckland): the stamp then names a day no morning pass asks for,
 * nothing is left out, and that brief repeats what the evening covered. A duplicate mention,
 * never a silent omission — the direction this file always picks.
 *
 * `tz` defaults to {@link DEFAULT_HOME_TZ}, so a caller with no owner clock gets the home day
 * exactly as before.
 */
export function nightBeforeCoveredDay(now: Date, tz: string = DEFAULT_HOME_TZ): string {
  return dateIn(new Date(now.getTime() + 24 * 3600_000), tz);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Held back — what the gate kept from him since the last brief (ORB-193)
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * REPLACES the local re-ping budget that used to live in this band (`rePingRemaining`/
 * `rePingRecord`/`EMPTY_REPING_BUDGET`, ported verbatim from the old runtime's
 * `obligations/reping-budget.ts`). That cap was one lane's private, in-memory, per-process
 * count of one kind of message; ORB-193 moves the ceiling into `@lares/agent-kit`'s ledger,
 * where it is durable, shared across every lane and door, and visible on the console. A per-lane
 * copy beside it could only ever disagree with it.
 *
 * What the brief owes him in exchange is this one line: the gate is allowed to stay quiet, but
 * it is never allowed to be SILENT about having done so. `deferredSince` counts each held item
 * once per door, however many ticks reconsidered it, so this line says "3 things are waiting",
 * not "480 deferrals were logged".
 *
 * Pure — it is rendered into the brief's context, not spoken by the model. `lang` is required
 * (LAR-16-s2): every caller must say which language it wants, rather than this file assuming
 * Norwegian. Returns `null` when nothing is held back, which is what keeps a normal day's prompt
 * byte-identical to the one before ORB-193.
 */
export function heldBackLine(rows: Array<{ door: string; count: number }>, lang: BriefLanguage): string | null {
  const s = BRIEF_STRINGS[lang].heldBack;
  const held = rows.filter((r) => r.count > 0);
  if (held.length === 0) return null;
  const parts = held.map((r, i) => {
    const noun = i === 0 ? s.count(r.count) : String(r.count);
    return `${noun} ${s.onDoor(doorLabel(r.door))}`;
  });
  return `${s.prefix} ${parts.join(", ")} ${s.suffix}`;
}

/** `slack:U0ABC` → "Slack". An unrecognised prefix is named as itself rather than dropped: a
 *  door this function has never heard of is still a door he was not reached on. */
function doorLabel(door: string): string {
  const kind = door.split(":")[0] ?? door;
  if (kind === "slack") return "Slack";
  if (kind === "telegram") return "Telegram";
  return kind;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Gmail scan source — ported from
// services/agent-runtime/lib/adapters/obligations/gmail-source.ts. Real performance
// engineering: the old shape (1 list + 1 messages.get PER candidate + 1 threads.get per thread
// SEQUENTIALLY) reliably timed out against a real 60-day inbox and — worse — was wrong before
// it was slow, since 200 newest-first messages out of 60 days is roughly the last week. This
// is N list pages (paged to the END, throwing rather than truncating) + exactly ONE
// threads.get per unique candidate thread, at bounded concurrency.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export interface GmailSourceDeps {
  /** EVERY thread id matching the query, paged to the end. */
  searchThreadIds(query: string, ceiling: number): Promise<string[]>;
  /** EVERY message in a thread, both directions. */
  readThread(threadId: string): Promise<ThreadMessage[]>;
}

/** The display name in front of the angle brackets, or the address when there is none. */
export function displayNameOf(header: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(header);
  return (m?.[1] ?? addressOf(header)).trim();
}

/**
 * Mail nobody is waiting behind. List-Unsubscribe is the reliable signal — a bulk sender is
 * obliged to set it. The no-reply address check is a second net for senders who skip it.
 */
export function isAutomatedSender(from: string, headers: Record<string, string>): boolean {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (lower["list-unsubscribe"]) return true;
  const addr = addressOf(from);
  return /(^|[.+_-])no-?reply@/.test(addr) || addr.startsWith("mailer-daemon@") || addr.startsWith("bounce");
}

// ─── ORB-180 Workstream B: institutional due-notice mail ───────────────────────────────────
//
// THE MISFILING THIS FIXES, verbatim from the ticket: a Fiken VAT reminder rode the morning
// brief as an OWED REPLY, in the list of people waiting on him. Nobody at Fiken is waiting on
// anything. The mail is a DUE NOTICE — a date with a consequence — and the only honest thing to
// do with it is to offer it once as a deadline candidate and then be quiet.
//
// The rule has two arms and they are deliberately unequal in strength:
//
//   1. THE DOMAIN. Mail from the tax authority, the register or the accounting system is a due
//      notice whatever the subject says and however it was sent — a caseworker typing by hand
//      from `@skatteetaten.no` is still the state writing to a company, not a person waiting for
//      a reply. Subdomains count (`mail.fiken.no`), lookalikes do not (`notfiken.no`), which is
//      why this is a suffix match on a dot and never a bare `includes`.
//   2. THE SHAPE, and only for mail that is ALREADY automated. An automated sender, a due word,
//      and a date token together are a due notice off the list too — the invoicing services and
//      municipal systems nobody can enumerate in advance. All three are required: an automated
//      newsletter titled "Fristen nærmer seg" carries a due word and no date, and is a
//      newsletter.
//
// THE OTHER DIRECTION IS THE ONE THAT COSTS HIM SOMETHING, so it is named here rather than left
// to be inferred: a PERSON writing "Frist for tilbud 15. mai?" from a company domain is not a
// due notice, whatever the subject says. The automated-sender precondition on arm 2 is the whole
// guard — without it, every human who ever wrote the word "frist" with a date would fall off the
// radar silently, which is a far worse failure than the one this rule was filed for.

/**
 * The senders whose mail is a due notice on the strength of WHO SENT IT. Norwegian statutory and
 * accounting systems: the tax authority, the login/message portal, the company register, and the
 * four accounting products a Norwegian AS is realistically on.
 */
export const INSTITUTIONAL_DOMAINS: ReadonlySet<string> = new Set([
  "skatteetaten.no",
  "altinn.no",
  "brreg.no",
  "fiken.no",
  "tripletex.no",
  "visma.net",
  "poweroffice.net",
]);

/** A subject that says something falls due. Norwegian first, `due` for the English-language
 *  systems; `betalingspåminnelse` is listed separately because `\b` cannot find a boundary in
 *  front of the `p` inside a compound. */
export const DUE_WORDS = /\b(frist|fristen|forfall|forfaller|forfalt|due|påminnelse|purring|betalingspåminnelse|innen)\b/iu;

/** A date in the subject — `31.08`, `31/08/2026`, `31. aug`. A due word with no date is a
 *  sentiment, not a deadline, and the ONLY thing keeping "Fristen nærmer seg" out. */
export const DATE_TOKEN = /(\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b|\b\d{1,2}\.?\s*(jan|feb|mar|apr|mai|jun|jul|aug|sep|okt|nov|des)\w*)/iu;

export function isInstitutionalDueNotice(from: string, subject: string, headers: Record<string, string>): boolean {
  const domain = addressOf(from).split("@")[1] ?? "";
  for (const known of INSTITUTIONAL_DOMAINS) {
    if (domain === known || domain.endsWith(`.${known}`)) return true;
  }
  return isAutomatedSender(from, headers) && DUE_WORDS.test(subject) && DATE_TOKEN.test(subject);
}

const DEFAULT_WINDOW_DAYS = 60;

/** Far above any real 60-day inbox precisely so reaching it means something is wrong with the
 *  WINDOW, not with the day. */
export const CANDIDATE_SCAN_CEILING = 5000;

/** How many threads.get calls may be in flight at once — bounded so a burst never trips
 *  Gmail's per-user rate ceiling and makes the limiter back off. */
const THREAD_FETCH_CONCURRENCY = 6;

export interface ScanOptions {
  windowDays?: number;
  ceiling?: number;
}

export interface ThreadScan {
  snapshots: ThreadSnapshot[];
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving input order in the result.
 *  Exported for `lib/obligation-lookups.ts`, which bounds its own Gmail thread reads the same
 *  way this file bounds the obligation scan's. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export async function scanThreads(
  deps: GmailSourceDeps,
  mine: string[],
  opts: ScanOptions = {},
): Promise<ThreadScan> {
  const mineSet = new Set(mine.map((a) => a.toLowerCase()));
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;

  // `in:inbox` finds every thread with INBOUND mail in the window (not the thread's full
  // message set — readThread below supplies the walk data). `-from:me` is safe narrowing: a
  // thread only becomes a candidate through an inbound message, so removing his own outbound
  // mail cannot drop a thread.
  const threadIds = await deps.searchThreadIds(
    `in:inbox -from:me newer_than:${windowDays}d`,
    opts.ceiling ?? CANDIDATE_SCAN_CEILING,
  );

  // ONE fetch per unique thread, bounded. A Google-generated RSVP is sent FROM the attendee's
  // real address, so drop it before counting or "Accepted: Pilot" becomes an unanswered
  // message he supposedly owes a reply to.
  const threads = await mapWithConcurrency(threadIds, THREAD_FETCH_CONCURRENCY, async (threadId) => ({
    threadId,
    msgs: (await deps.readThread(threadId)).filter((m) => !m.isCalendarNotice),
  }));

  const snapshots: ThreadSnapshot[] = [];
  for (const { threadId, msgs } of threads) {
    if (msgs.length === 0) continue;
    msgs.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
    const last = msgs[msgs.length - 1]!;
    const lastFromThem = !mineSet.has(addressOf(last.from));

    // Walk back from the end while the sender is still them — that run IS the unanswered
    // tail, and a run of two or more is a re-ping.
    let unanswered = 0;
    if (lastFromThem) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (mineSet.has(addressOf(msgs[i]!.from))) break;
        unanswered++;
      }
    }

    snapshots.push({
      threadId,
      subject: last.subject,
      counterpartyName: displayNameOf(last.from),
      counterpartyAddress: addressOf(last.from),
      lastMessageAt: new Date(last.sentAt),
      lastSpeakerIsThem: lastFromThem,
      addressedToHim: last.to.some((t) => mineSet.has(addressOf(t))),
      isAutomated: isAutomatedSender(last.from, last.headers),
      // ORB-180 Workstream B — read off the LAST message, the same one every other flag on this
      // snapshot is read off. A thread that has turned into a due notice is one now, whatever it
      // opened as.
      isDeadlineCandidate: isInstitutionalDueNotice(last.from, last.subject, last.headers),
      theirUnansweredCount: unanswered,
      source: "gmail",
      lastMessageText: last.bodyText.slice(0, LAST_MESSAGE_MAX_CHARS),
      counterpartyEmails: [addressOf(last.from)],
    });
  }
  return { snapshots };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Tomorrow's external meetings — narrowed from
// services/agent-runtime/lib/adapters/brief/night-before-calendar.ts to the "tomorrow" case
// only. The old file's "today" case existed solely to feed the old morning brief's
// participant-matching suppression; buildMorningBrief below uses a simpler delta rule (the
// night_before_delivered_day stamp alone) and never needs it.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export interface NightBeforeMeeting {
  title: string;
  startsAt: Date;
  participants: string[];
  /** An all-day block. `startsAt` is then only a DAY — never render a clock time from it. */
  allDay?: boolean;
  /** Where, when the event says so. Part of why an attendee-less block counts (ORB-118). */
  location?: string;
  /**
   * When it ENDS (fix round 1, Finding 2). Absent in two cases, both deliberate: the event
   * carried no end at all, and EVERY all-day row (`listMeetingsOn` omits it — see there). An
   * all-day block's "end" is the exclusive next midnight, which is not a clock time and must
   * never render as one.
   *
   * Without this the brief printed a start time and nothing else, so every overlap statement
   * the model made — "the 16:30 runs into the 17:00" — was invented from a start time and a
   * guessed duration. `listMeetingsOn` already computed the end to apply the duration floor;
   * it simply never passed it on. This is not a clash engine, just the second half of the fact.
   */
  endsAt?: Date;
  /** The event carries a way to JOIN it (`lib/google.ts`'s `CalendarEvent.hasConferenceLink`).
   *  Kept on the row so an in-person meeting can say a link also exists without that link
   *  deciding what kind of thing the meeting is. */
  hasConferenceLink?: boolean;
  /** ORB-165 — what KIND of thing this is. Decides whether it may be rendered as a commitment
   *  at all, and both briefs read it the same way (see `commitmentLine` / `travelContextLine`
   *  below, which are shared precisely so the two can never drift). */
  kind: EventKind;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ORB-165 — event KINDS.
//
// The 2026-08-25 morning brief said "you're based at Scandic Oslo Airport all day" off an
// all-day hotel reservation, and called a venue-less 16:30 intro call a "hard clash" with a
// 17:00 session 100 km away. One cause: nothing downstream knew what kind of event it was
// looking at, so a booking confirmation and a real commitment were the same shape.
//
// Everything here is DETERMINISTIC — Google's own `eventType` plus, among Gmail-created events
// only, a title pattern to say whether it is a stay or a journey. No model call: the API
// already knows, and a classifier that guesses is exactly the ungrounded assertion this fixes.
// The calendar-LEVEL equivalent is `lib/calendar-fanout.ts`'s `DEFAULT_CALENDAR_DENY`; this is
// the same idea one layer down, and the two are deliberately separate.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export type EventKind =
  /** A place he SLEEPS. Never presence: check-in is usually late evening. */
  | "lodging"
  /** A journey — a flight, a train. Where he MOVES, and only during it. */
  | "transport"
  /** Out of office / a working-location marker. A statement about availability, not a venue. */
  | "out-of-office"
  /** People on it, and nowhere to be — he takes it from wherever he already is. */
  | "remote-call"
  /** A real venue he has to get to. */
  | "in-person"
  /** Time he set aside: nobody on it, nowhere named. */
  | "block";

/** The kinds that are CONTEXT, never a commitment and never a whereabouts claim. */
const TRAVEL_CONTEXT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["lodging", "transport", "out-of-office"]);

export function isTravelContext(kind: EventKind): boolean {
  return TRAVEL_CONTEXT_KINDS.has(kind);
}

/** How the travel-context block names each kind, so the model never has to infer it. */
const TRAVEL_CONTEXT_LABEL: Record<string, string> = {
  "lodging": "lodging — where he sleeps",
  "transport": "transport — where he moves",
  // FIX ROUND 1 (Finding 3) — ONE kind covers two different eventTypes (`outOfOffice` and
  // `workingLocation`), and a working location is a statement about where he IS, not an
  // absence. The label therefore names both rather than asserting the wrong one of them; the
  // part that matters downstream — not a commitment — is true of either.
  "out-of-office": "out of office or a working-location marker — not a commitment",
};

/**
 * Gmail writes these titles itself and they are strikingly regular — verified against Bendik's
 * real calendar on 2026-08-25: "Stay at Scandic Oslo Airport", "Stay at PUBLIC Hotel New York",
 * "Flight to København (SK 455)", "Flight to Newark (SK 909)", "Reservation at The Tavern at
 * Gramercy Tavern".
 *
 * TRANSPORT is tested FIRST so "Flight to Hotel Bristol" is a journey rather than a bed.
 *
 * NOTE — a deliberate departure from ORB-165's acceptance criteria, which listed the bare word
 * "reservation" as a lodging pattern: the real calendar's one "Reservation at …" row is a
 * RESTAURANT booking, a place he actually goes. Calling that lodging would assert he sleeps
 * there. So lodging keys off stay/hotel words, and "Reservation at PUBLIC Hotel New York" still
 * lands as lodging via "hotel" while the restaurant stays an ordinary commitment.
 */
const TRANSPORT_TITLE = /\b(flight|flights|flyv|avreise|departure|boarding|train|tog|rail|jernbane|ferry|ferge|bus)\b/i;
const LODGING_TITLE = /\b(stay at|hotel|hotell|motel|motell|hostel|resort|airbnb|lodging|overnatting|guest ?house|check[-\s]?in|innsjekk)\b/i;

/** A link is not a place. Google puts Meet/Zoom/Teams URLs in `location` often enough that
 *  treating one as a venue is how a remote call becomes somewhere he has to travel to. */
const LINK_LOCATION = /^https?:\/\//i;
const CONFERENCE_HOST = /(meet\.google\.com|zoom\.us|teams\.microsoft\.com|whereby\.com|meet\.jit\.si)/i;

/** The facts classification is allowed to use. Nothing here is fetched or inferred — the
 *  caller passes what the API said. */
export interface ClassifiableEvent {
  summary?: string;
  /** Google's `eventType`, verbatim (`lib/google.ts`'s `CalendarEvent.eventType`). */
  eventType?: string;
  location?: string;
  /** People on the invitation OTHER than him — the brief's own `participants`, not the raw
   *  attendee list. An event whose only attendee is himself is a block, not a call. */
  participants?: readonly string[];
  hasConferenceLink?: boolean;
}

/** The REST API returns `fromGmail`; other Google surfaces spell the same enum `FROM_GMAIL`.
 *  Fold both to one token rather than betting on which one a caller holds. */
function normalizeEventType(raw: string | undefined): string {
  return (raw ?? "").trim().toLowerCase().replace(/[_\s-]/g, "");
}

/** The location, if it is a PLACE. A bare conference URL is not. */
function venueOf(location: string | undefined): string {
  const l = (location ?? "").trim();
  if (l === "") return "";
  if (LINK_LOCATION.test(l)) return "";
  if (CONFERENCE_HOST.test(l)) return "";
  return l;
}

/**
 * What kind of thing this event is. Pure, total, and deterministic — same input, same answer,
 * no I/O and no model.
 */
export function classifyEvent(e: ClassifiableEvent): EventKind {
  const type = normalizeEventType(e.eventType);

  // A statement about availability, whatever else it carries.
  if (type === "outofoffice" || type === "workinglocation") return "out-of-office";

  // Gmail-created: a booking confirmation, not something he was invited to. The title only
  // picks WHICH kind of travel context it is; anything that is neither a stay nor a journey
  // falls through to the ordinary rules below (a restaurant booking with a venue is a place he
  // really goes).
  if (type === "fromgmail") {
    const title = e.summary ?? "";
    if (TRANSPORT_TITLE.test(title)) return "transport";
    if (LODGING_TITLE.test(title)) return "lodging";
  }

  // FIX ROUND 1 (Finding 1) — A VENUE YOU CAN BE AT OUTRANKS A LINK YOU CAN JOIN.
  //
  // The first cut read "attendees and (no location or a conference link) → remote-call", which
  // made the link decisive. Google Workspace adds a Meet link to nearly every invitation by
  // default, so a board meeting at a counterpart's office came out announced as "not somewhere
  // he must be" — ORB-165's own defect, inverted, and worse: the first version at least erred
  // toward telling him about a place.
  //
  // So the venue is checked FIRST and unconditionally. A conference link now only matters when
  // there is nowhere to go, which also makes `remote-call ⇒ no venue` an invariant the render
  // and the prompt clause can both rely on.
  const venue = venueOf(e.location);
  if (venue !== "") return "in-person";
  if ((e.participants?.length ?? 0) > 0 || e.hasConferenceLink === true) return "remote-call";
  return "block";
}

/** The owner's wall-clock time in `tz` (LAR-16-s4 — was hardcoded to Europe/Oslo). An all-day
 *  block never reaches this — its instant is a UTC midnight, which would render as a
 *  meaningless 02:00. */
function wallTime(d: Date, tz: string): string {
  return d.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
}

/**
 * One commitment row, shared by BOTH briefs (they rendered identical copies of this before
 * ORB-165; a shared function is the only way "both briefs must agree" survives the next edit).
 *
 * Three things the row is careful about:
 *  - it prints the SPAN, not just a start (fix round 1, Finding 2) — an overlap the model
 *    states should come from the two end points, not from a guess at how long things run;
 *  - a `remote-call` renders "(remote)" and nothing else, which is now literally true:
 *    classification gives that kind only when no venue survived `venueOf`;
 *  - an in-person meeting that ALSO carries a join link says so, so the link is visible
 *    without ever being mistaken for the venue's absence.
 *
 * `tz` is required (LAR-16-s4): every caller says which clock to read, rather than this file
 * assuming Europe/Oslo.
 */
export function commitmentLine(m: NightBeforeMeeting, tz: string): string {
  const when = m.allDay
    ? "all day"
    : m.endsAt ? `${wallTime(m.startsAt, tz)}–${wallTime(m.endsAt, tz)}` : wallTime(m.startsAt, tz);
  const where =
    m.kind === "remote-call"
      ? " (remote)"
      : m.location
        ? ` (${m.location})${m.hasConferenceLink === true ? " (in person; a join link also exists)" : ""}`
        : "";
  const who = m.participants.length > 0
    ? `\n  participants: ${m.participants.join(", ")}`
    : "\n  participants: none on the invitation — a block he set aside, not a call to prepare people for";
  return `- ${when} — ${m.title}${where}${who}`;
}

/**
 * One travel-context row.
 *
 * Two deliberate differences from a commitment row. No participants line: a hotel booking's
 * only "attendee" is himself, and printing it invites the model to treat a reservation as a
 * meeting. And the time never LEADS the row as `all day — <title>` — that exact phrasing
 * (ORB-165, `morning-brief.ts` as it stood) is what produced "you're based at Scandic Oslo
 * Airport all day" from a booking whose check-in was that evening. An all-day entry says so as
 * a property of the entry, at the end, where it cannot be read as occupancy.
 *
 * `tz` is required, same reason as `commitmentLine` beside it (LAR-16-s4).
 */
export function travelContextLine(m: NightBeforeMeeting, tz: string): string {
  const when = m.allDay
    ? "an all-day entry, no clock time on it"
    : m.endsAt ? `${wallTime(m.startsAt, tz)}–${wallTime(m.endsAt, tz)}` : `from ${wallTime(m.startsAt, tz)}`;
  const where = m.location ? ` (${m.location})` : "";
  return `- ${m.title}${where} [${TRAVEL_CONTEXT_LABEL[m.kind] ?? m.kind}; ${when}]`;
}

/** Today's/tomorrow's rows split into what he must BE at and what merely frames the day. */
export function splitCommitments(meetings: readonly NightBeforeMeeting[]): {
  commitments: NightBeforeMeeting[];
  travel: NightBeforeMeeting[];
} {
  return {
    commitments: meetings.filter((m) => !isTravelContext(m.kind)),
    travel: meetings.filter((m) => isTravelContext(m.kind)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ORB-169 — the SAME travel block, now fed by the itinerary that knows the SPAN
//
// ORB-165 stopped the calendar's hotel row from being read as presence. It could not fix the
// other half of the same morning: the calendar knows only the day Gmail put on the event, so a
// three-night stay appeared on its check-in day and vanished for the two nights he was
// actually in it — and nothing on the calendar said the Scandic was booked FOR the 09:00
// flight the next morning. Marcel had all of that, correctly, in his own store, hours earlier.
//
// FOUR DECISIONS, each one deliberate:
//
//  1. **ONE block, two sources** (Ruling 7). The itinerary rows join `travelContextBlock`
//     rather than getting a block of their own, so the block's own grounding note — "where he
//     sleeps or moves, never where he is now" — and `eventKindClauses`' prose govern BOTH
//     sources. Two travel sections would mean two sets of rules for one subject.
//  2. **Every itinerary row is attributed ON THE ROW**, not only under the group heading. The
//     model reorders and paraphrases; a row that has drifted from its heading must still say
//     it is Marcel's filed reservation rather than something Bendik's calendar asserts.
//  3. **`other` is rendered, and rendered as unclassified.** Marcel's extractor enum is
//     flight|stay|car|restaurant|other, so a Vy train can only be filed as `other`. Dropping
//     it would be "hotel in Bergen, nothing about getting there" — this ticket's own bug, one
//     layer up. The wording matches `agent/instructions/travel-context.ts` verbatim so the
//     turn-instruction copy and the brief copy cannot drift apart.
//  4. **An outage is a DROPPED SOURCE, never an empty week.** `travel-store.ts` hands back an
//     `unavailable` reason beside the data precisely so this block cannot render "I could not
//     read Marcel's store" as "you have no travel". ORB-164 already owns that vocabulary for
//     Slack (`SLACK_DROPPED_SOURCE_LINE`, `absentBlockClause`); this is the same move.
//
// WHY THIS DUPLICATES `agent/instructions/travel-context.ts`, ON PURPOSE — do not collapse it.
// The same reasoning `standingFactsBlock` records below (search this file for "ORB-167 — the
// \"Standing facts"): those facts reach her on every turn AND are repeated as a labeled block,
// because a brief is composed under the contract's grounding rules and those rules apply PER
// BLOCK. A fact she is expected to ACT on inside a brief has to be a named piece of context in
// it, not background she happens to be carrying.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** What one brief was handed from Marcel's store, and which day it is about. */
export interface BriefTravel {
  /** The calendar date this brief covers, on the owner's clock (LAR-67) — today for the morning
   *  pass, tomorrow for the evening one: the SAME day its meetings are listed for, so one brief
   *  never has two day boundaries in it. Every row is rendered RELATIVE to it. */
  readonly day: string;
  /** The same word `transitClause` takes, and for the same reason: the evening pass composes
   *  tonight about tomorrow, so "tonight" would name the wrong night. */
  readonly dayWord: BriefDay;
  /** T5's reader, verbatim — trips plus an `unavailable` reason when the store is sick. */
  readonly travel: TravelResult<TravelItinerary>;
}

/**
 * The sentence the block carries when Marcel's store could not be read.
 *
 * A named constant for exactly the reason `SLACK_DROPPED_SOURCE_LINE` is one (ORB-164): the
 * failure worth guarding against is a block that looks perfectly normal while covering one
 * source instead of two, and "looked normal" is not something a test can assert the absence of
 * unless the disclosure has a name.
 */
export const TRAVEL_DROPPED_SOURCE_LINE =
  "Marcel's itinerary could not be read for this brief — the rows above are the calendar's " +
  "alone, and are NOT the whole picture.";

/**
 * The same disclosure, for the day the block has NO rows at all.
 *
 * REVIEW MINOR 3 — {@link TRAVEL_DROPPED_SOURCE_LINE} says "the rows above", and on a day with
 * no calendar travel and an unreadable store there are no rows above: the block rendered one
 * sentence pointing at nothing. The distinction it has to preserve is the same one, though, and
 * it matters MORE here rather than less: an empty travel block normally means "he is not going
 * anywhere", and this is precisely the case where that reading is false.
 */
export const TRAVEL_DROPPED_SOURCE_ONLY_LINE =
  "Marcel's itinerary could not be read for this brief, and the calendar shows no travel " +
  "either — so this block is empty because a source dropped, NOT because it is known that he " +
  "is going nowhere.";

/**
 * What the brief is handed from Marcel's store, or `undefined` when Saga has no travel wiring.
 *
 * REUSES T5's `currentTravel` and reads nothing itself (the plan's own cross-task rule). Never
 * throws: an unset `TRAVEL_PATH` is the one distinguishable case and yields `undefined` — the
 * brief then renders EXACTLY as it did before ORB-169, byte for byte — while any other failure
 * comes back as an `unavailable` reason so the block can say a source dropped.
 */
export function readBriefTravel(
  day: string,
  dayWord: BriefDay,
  env: NodeJS.ProcessEnv = process.env,
): BriefTravel | undefined {
  try {
    return { day, dayWord, travel: currentTravel(day, { horizonDays: DEFAULT_HORIZON_DAYS, env }) };
  } catch (err) {
    if (err instanceof TravelPathNotConfiguredError) {
      // REVIEW IMPORTANT 2 — silent was right for exactly as long as TRAVEL_PATH was unset.
      // It is set now (Deploy B2 shipped it), so this branch no longer means "not wired yet";
      // it means the variable WENT AWAY — a compose edit, a drift-guard accept, a container
      // recreated from a stale file. The behaviour stays correct (the brief renders exactly as
      // it did before ORB-169), and that is the danger: nothing looks wrong, the container is
      // healthy, and both briefs quietly lose travel forever. This repo has already paid for
      // that shape once — a diagnosis nobody printed hid a real bug for eight days. One warn,
      // naming the variable, is the whole fix.
      console.warn(
        "eve-saga: TRAVEL_PATH is not set — Marcel's itinerary is unavailable for this brief; " +
          "the travel block will be the calendar's alone",
      );
      return undefined;
    }
    console.error("brief-content: could not read Marcel's trip store — the brief will say so", err);
    return {
      day,
      dayWord,
      travel: { trips: [], unavailable: "Marcel's trip store could not be read" },
    };
  }
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** Whole days from `a` to `b`, both date-only — UTC arithmetic is exact here because no wall
 *  clock is involved. `NaN` when either side is not an ISO date, which every caller treats as
 *  "do not claim a span". */
function daysBetweenISO(a: string, b: string): number {
  if (!ISO_DAY_RE.test(a) || !ISO_DAY_RE.test(b)) return Number.NaN;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function shiftISO(day: string, by: number): string {
  if (!ISO_DAY_RE.test(day)) return day;
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + by);
  return at.toISOString().slice(0, 10);
}

/**
 * When a STAY sits relative to the brief's day, or `undefined` when it is over.
 *
 * THE MULTI-DAY FIX LIVES HERE. Marcel files a stay as `start` (check-in date) and `end`
 * (check-out date), so the nights slept are `start … end-1` — which is why a stay is present
 * on night two at all, and why the check-out morning says he slept there LAST night rather
 * than tonight. The calendar could never answer either question: it holds one event, on one
 * day, with no notion of the span.
 */
function lodgingWhen(b: TravelBooking, day: string, dayWord: BriefDay): string | undefined {
  const night = dayWord === "today" ? "tonight" : "tomorrow night";
  const spans = b.end !== undefined && b.end > b.start;
  const lastNight = spans ? shiftISO(b.end!, -1) : b.start;
  const nights = spans ? daysBetweenISO(b.start, b.end!) : 1;
  // REVIEW MINOR 6 — only a stay that actually SPANS has a check-out worth stating. Marcel
  // files some one-night rows with `end` equal to `start`, and printing that produced
  // "tonight, the night of 2026-08-25; checks out 2026-08-25" — a sentence that contradicts
  // itself, which is worse than saying nothing about the morning.
  const checkOut = spans ? `; checks out ${b.end}` : "";

  if (day < b.start) {
    return `upcoming, NOT ${night} — checks in ${b.start}${b.time === undefined ? "" : ` ${b.time}`}${checkOut}`;
  }
  if (day <= lastNight) {
    const which = Number.isNaN(nights) || nights <= 1
      ? ""
      : `, night ${daysBetweenISO(b.start, day) + 1} of ${nights}`;
    return `${night}, the night of ${day}${which}${checkOut}`;
  }
  if (b.end !== undefined && day === b.end) {
    return `he checks out ${dayWord}, ${b.end} — he slept there the night before, NOT ${night}`;
  }
  return undefined; // over; a bed he has already left says nothing about this day
}

/** When a JOURNEY or an unclassified reservation sits relative to the brief's day, or
 *  `undefined` when it is behind him. */
function movementWhen(b: TravelBooking, day: string, dayWord: BriefDay): string | undefined {
  const at = b.time === undefined ? b.start : `${b.start} ${b.time}`;
  const span = b.end !== undefined && b.end !== b.start ? ` → ${b.end}` : "";
  if (b.start === day) return `${dayWord}, ${at}${span}`;
  if (b.start > day) return `upcoming, NOT ${dayWord} — ${at}${span}`;
  if (b.end !== undefined && b.end >= day) return `under way — ${at}${span}`;
  return undefined;
}

/** One itinerary row, plus the instant it sorts on. Same bracketed shape as
 *  `travelContextLine` so the two sources read as one block, with the source itself as the
 *  first thing inside the bracket. */
function itineraryRow(b: TravelBooking, tripName: string, label: string, when: string): { at: string; line: string } {
  return {
    at: `${b.start}T${b.time ?? "00:00"}`,
    line: `- ${b.summary} [from Marcel's itinerary — ${tripName}; ${label}; ${when}]`,
  };
}

/** One trip's rows for this day, or `[]` when nothing it holds touches the day. A trip with no
 *  surviving row contributes no heading either: a trip's own span is not a whereabouts claim,
 *  and this block asserts only where he sleeps and moves. */
function itineraryTripLines(it: TravelItinerary, day: string, dayWord: BriefDay): string[] {
  const name = it.trip.name;
  const rows: { at: string; line: string }[] = [];

  for (const b of it.lodging) {
    const when = lodgingWhen(b, day, dayWord);
    if (when !== undefined) rows.push(itineraryRow(b, name, TRAVEL_CONTEXT_LABEL["lodging"]!, when));
  }
  for (const b of it.transport) {
    const when = movementWhen(b, day, dayWord);
    if (when !== undefined) {
      rows.push(itineraryRow(b, name, `${TRAVEL_CONTEXT_LABEL["transport"]} (${b.kind})`, when));
    }
  }
  for (const b of it.other) {
    const when = movementWhen(b, day, dayWord);
    if (when !== undefined) {
      // Word for word what `agent/instructions/travel-context.ts` says about the same bucket:
      // a Vy train Marcel could only file as `other` is named, and is never dressed up as a
      // confirmed leg. The word "departure" appears only inside the negation.
      rows.push(itineraryRow(
        b,
        name,
        `unclassified (${b.kind}) — a filed reservation, NOT a confirmed departure`,
        when,
      ));
    }
  }

  if (rows.length === 0) return [];
  // REVIEW MINOR 5 — `bookings.md` is in CONFIRMATION-MAIL ARRIVAL order, so without this a
  // hotel he checks into next week can sit above the bed he sleeps in tonight. Every row
  // self-describes, so nothing was false; the most salient row simply was not first. Sorted on
  // the booking's own instant (a row with no time sorts to the top of its day), stably, so
  // Marcel's order still decides between two things at the same minute.
  rows.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  const place = it.trip.destination ? ` — ${it.trip.destination}` : "";
  return [`${name}${place} (${it.trip.start} to ${it.trip.end}):`, ...rows.map((r) => r.line)];
}

/** The itinerary HALF of the travel block — "" when Marcel's store has nothing to add and was
 *  read successfully.
 *
 *  `hasCalendarRows` exists only for the dropped-source sentence: whether there are "rows above"
 *  is a fact about the WHOLE block, and this half cannot see the calendar half (REVIEW MINOR 3). */
function itineraryContent(itinerary: BriefTravel | undefined, hasCalendarRows: boolean): string {
  if (itinerary === undefined) return "";
  const { day, dayWord, travel } = itinerary;
  const groups = travel.trips
    .map((it) => itineraryTripLines(it, day, dayWord))
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"));

  const parts: string[] = [];
  if (groups.length > 0) {
    parts.push(
      "Travel context — from Marcel's itinerary (reservations he filed, not entries on the " +
        "calendar; a booking is not presence):",
      ...groups,
    );
  }
  // Unavailable is not "none": say the source dropped, even when the calendar half is empty —
  // and when it is empty AND the calendar's is too, say it in the words that fit a block with
  // nothing above the sentence.
  if (travel.unavailable !== undefined) {
    parts.push(
      hasCalendarRows || groups.length > 0
        ? TRAVEL_DROPPED_SOURCE_LINE
        : TRAVEL_DROPPED_SOURCE_ONLY_LINE,
    );
  }
  return parts.join("\n");
}

/**
 * The "Travel context" labeled block, or "" when there is none — `labeledContext` drops an
 * empty block rather than rendering a heading over nothing (@lares/compose-contract).
 *
 * `itinerary` is OPTIONAL and omitting it reproduces ORB-165's output byte for byte: a caller
 * with no travel wiring, and every existing test literal, keeps meaning exactly what it meant.
 *
 * `tz` defaults to {@link DEFAULT_HOME_TZ} (LAR-16-s4) — a default rather than a required
 * parameter ONLY because TypeScript will not allow a required parameter after the optional
 * `itinerary`; every real caller (`buildMorningPrompt`/`buildEveningPrompt`) passes the owner's
 * actual clock explicitly.
 */
export function travelContextBlock(
  travel: readonly NightBeforeMeeting[],
  itinerary?: BriefTravel,
  tz: string = DEFAULT_HOME_TZ,
): string {
  const calendar = travel.map((m) => travelContextLine(m, tz)).join("\n");
  const fromMarcel = itineraryContent(itinerary, calendar !== "");
  return labeledContext([{
    label: "Travel context",
    note: "where he sleeps or moves, never where he is now",
    content: [calendar, fromMarcel].filter((s) => s !== "").join("\n\n"),
  }]);
}

/** The one sentence the travel-context block needs beside it, and the one a remote call needs.
 *  Returned as lines so a prompt can splice them in only when they apply.
 *
 *  `itinerary` is optional for byte-stability, and it matters more than it looks: the block can
 *  now exist on a day with NO calendar travel at all, and the governing sentence has to fire
 *  with it — a block that arrives without its rule is how ORB-165's defect gets back in. */
export function eventKindClauses(
  commitments: readonly NightBeforeMeeting[],
  travel: readonly NightBeforeMeeting[],
  itinerary?: BriefTravel,
): string[] {
  const lines: string[] = [];
  const marcel = itineraryContent(itinerary, travel.length > 0);
  // REVIEW IMPORTANT 1, second pass — the same carve-out `transitClause` makes, made here too,
  // because this sentence is composed into the SAME prompt twenty-five lines above it. See the
  // block comment on the two variants below.
  const origin = itineraryOrigin(itinerary);
  if (travel.length > 0 || marcel !== "") {
    // REVIEW IMPORTANT 3 — the rule is written by DESCRIPTION, not by one block's name, because
    // a brief turn carries TWO travel blocks: this one, and the `## Travel` block
    // `agent/instructions/travel-context.ts` injects on every `turn.started`. Naming only "the
    // Travel context block" left the injected one governed by nothing at all.
    //
    // And they are anchored to DIFFERENT DAYS on the evening pass, which is the half the
    // `standingFactsBlock` precedent does not cover: standing facts are day-independent, travel
    // is not. The injector always speaks about today ± 7; this block speaks about the day the
    // brief covers, which at 20:00 is TOMORROW. So the tie-break is stated rather than left to
    // the model — this block wins on any question of which day or night something falls on.
    // REVIEW IMPORTANT 1, second pass — WHY THIS SENTENCE HAS TWO FORMS.
    //
    // "a hotel booking or a flight IN EITHER is not evidence of his whereabouts, so never say he
    // is based at, at, or in any of it" explicitly includes Marcel's itinerary block. Twenty-five
    // lines further down the same composed prompt, `ORIGIN_ESTABLISHED` calls an itinerary lodging
    // row "the record of where he is actually sleeping" and tells the model to say in plain words
    // that the journey starts there. Both fire together on any away night, so this was the same
    // contradiction the transit clause had, moved up the page.
    //
    // WHAT IS AT RISK IS THE DECLARATION, not the lookup. "Use it as the `from`" is an imperative
    // and survives; the SPOKEN origin is what a sentence above can suppress — and that spoken
    // origin is the entire mitigation for stating an origin confidently instead of hedging. A
    // wrong Marcel date that Saga announces is correctable in one message; a wrong one she acts on
    // silently is invisible, which is worse than the hedge that was traded away.
    //
    // THE CARVE-OUT IS AS NARROW AS THE ONE BELOW IT. A FLIGHT is never whereabouts, whoever filed
    // it — that half applies to both sources, unchanged. A CALENDAR lodging row is never presence
    // — ORB-165, unchanged. Only an ITINERARY lodging row is excepted, only for the question of
    // where a journey begins, and it is still not a claim about where he is right now.
    //
    // Byte-identical to its pre-review form when there is no such row, exactly as `ORIGIN_HONESTY`
    // is: a gate, not an edit.
    lines.push(
      "Travel reaches you in this turn from more than one place: the Travel context block in this",
      "brief, and a ## Travel block in your instructions when there is one. BOTH of them are where",
      ...(origin === undefined
        ? [
            "he sleeps or moves, never where he is now — a hotel booking or a flight in either is not",
            "evidence of his whereabouts, so never say he is based at, at, or in any of it.",
          ]
        : [
            "he sleeps or moves, never where he is now — a flight in either, and any hotel row that",
            "came off the CALENDAR, are not evidence of his whereabouts, so never say he is based at,",
            "at, or in any of them. The ONE exception is a lodging row MARCEL filed: he resolved that",
            "one, so it is the record of which night he sleeps where. It is still not a claim about",
            "where he is right now — but it does establish where a journey the next morning begins,",
            "and where this brief tells you to state that origin, state it in plain words rather than",
            "leaving it implied.",
          ]),
      "The Travel context block in this brief is the one anchored to the day this brief covers.",
      "Where the two disagree about which day or night something falls on, this brief's block is",
      "the one to trust.",
      "",
    );
  }
  if (marcel.includes("from Marcel's itinerary")) {
    lines.push(
      "Some of those rows come from Marcel's itinerary — reservations he filed, each one saying",
      "which night is booked or which journey is ticketed. A row marked unclassified is a filed",
      "reservation he could not categorise: name it as that, never as a confirmed departure.",
      // REVIEW IMPORTANT 2 — the ticket's OWN day renders the Scandic twice: once off the
      // calendar as an all-day entry, once off the itinerary with the night on it. Nothing said
      // they were one booking, so a brief could reasonably report two.
      "A row from the itinerary may be the same reservation as a calendar row in the same block —",
      "the itinerary row is the one that knows which night. Report it once.",
      "",
    );
  }
  // ORB-164's lesson, applied to a second source: the block states the fact, this tells her she
  // must pass it on. Without it she reasonably summarises the travel and leaves the meta-note
  // out — which is the silent half-picture the whole absent-vs-empty distinction exists to stop.
  if (itinerary?.travel.unavailable !== undefined) {
    lines.push(
      "Marcel's itinerary could not be read for this brief. Say so rather than implying his",
      "travel is known: what is above is the calendar's alone, and may be missing a night or a",
      "journey entirely.",
      "",
    );
  }
  if (commitments.some((m) => m.kind === "remote-call")) {
    lines.push(
      "A commitment marked (remote) has no venue — he takes it from wherever he already is, so",
      "it is never a place to travel to and never clashes with getting to something else.",
      "",
    );
  }
  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ORB-168 — the brief may state a REAL departure
//
// The 2026-08-25 morning brief, about a 17:00 in Tønsberg: "trains Oslo→Tønsberg run roughly
// hourly, about 1h40". Unverifiable, and useless for the only question he had — WHICH
// departure gets him there. `agent-kit__transit_plan` (Entur, granted `transit: read`) answers
// it with a real time, a real platform and a real arrival, and supports arrive-by, which is
// what makes "be in Tønsberg by 17:00" a question at all rather than a duration.
//
// WHAT THIS CODE OWNS AND WHAT IT DELEGATES, and the split is deliberate:
//
//   - The KINDS that could ever need a departure are deterministic, so they are decided here.
//     A remote call has no venue by construction (`classifyEvent`, ORB-165) and a travel-context
//     row is not somewhere he must get to — neither can reach the tool at all.
//   - The ARRIVE-BY instant is computed here too, as ISO-8601 with the real Oslo offset. eve
//     injects no date (`@lares/agent-kit`'s `clock.ts` header records what two wrong reminders
//     cost), so a model asked to build that string is guessing at both the date and whether
//     Oslo is currently +01:00 or +02:00.
//   - Whether the venue is in a DIFFERENT TOWN is NOT decided here, because it cannot be. The
//     17:00's `location` is the bare string "FÆRD Kommunikasjon" — no town in it anywhere. A
//     string comparison against a hardcoded home town would answer "unknown" on the very row
//     this ticket was filed about. The tool's own result names the resolved locality, so the
//     grounded way to learn the town is to ask it; the clause says so.
//
// NO NEW BILLED CALL. This is text spliced into a prompt the brief already sends — one tool
// call inside an existing turn, on demand, never a poll and never a second composition.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** The owner's wall-clock instant, in `tz`, as ISO-8601 WITH offset — the shape `transit_plan`
 *  requires (LAR-16-s4 — was hardcoded to Europe/Oslo).
 *
 *  The offset is MEASURED (`tz`'s wall clock read back against the UTC instant), never assumed:
 *  most zones (Oslo included) are one offset half the year and another the other half, and an
 *  `arriveBy` an hour out picks the wrong train in the most plausible-looking way possible.
 *  `sv-SE` because it formats as `YYYY-MM-DD HH:MM:SS` — the same reason `lib/recurrence.ts`
 *  reaches for it. */
function isoWithOffset(d: Date, tz: string): string {
  const [date, clock] = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, dateStyle: "short", timeStyle: "medium",
  }).format(d).split(" ");
  const [y, mo, day] = (date ?? "").split("-").map(Number);
  const [h, mi, s] = (clock ?? "").split(":").map(Number);
  const asIfUtc = Date.UTC(y!, mo! - 1, day!, h!, mi!, s!);
  const offsetMinutes = Math.round((asIfUtc - d.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date}T${clock}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The commitments a real departure could be looked up FOR — and nothing else may be.
 *
 * Three conditions, each of them a real exclusion rather than defensive filtering:
 *  - `in-person`, so a remote call can never reach the tool (it has no venue at all, which is
 *    an invariant `classifyEvent` maintains and `eventKindClauses` already states in prose);
 *  - a non-blank `location`, because that string is the tool's `to` and there is nothing to
 *    plan a journey to without it;
 *  - not all-day, because `arriveBy` is an instant and an all-day row's `startsAt` is a UTC
 *    midnight — rendering a clock time from one is the ORB-118 lesson, and doing so here would
 *    send him to a station for an 02:00 that does not exist.
 *
 * Travel-context rows never appear here because `splitCommitments` has already taken them out;
 * both briefs pass `commitments`, not `content.meetings`.
 */
export function transitCandidates(commitments: readonly NightBeforeMeeting[]): NightBeforeMeeting[] {
  return commitments.filter(
    (m) => m.kind === "in-person" && m.allDay !== true && (m.location ?? "").trim() !== "",
  );
}

/** Which day the brief is ABOUT. Not cosmetic: it decides the tense of the origin, and the
 *  evening pass gets that wrong in a way that costs a real train (see `transitClause`). */
export type BriefDay = "today" | "tomorrow";

/**
 * The two sentences that must reach the model whatever the day looks like — REVIEW FINDING 1.
 *
 * The first cut returned `[]` when no commitment qualified for a lookup, which dropped the
 * PROHIBITION along with the instruction. An all-day in-person row is excluded from
 * `transitCandidates` for a good reason (no instant to arrive by) and still puts an out-of-town
 * venue in front of the model with no transport rule attached — which is precisely the
 * 2026-08-25 regression, arriving through the door the fix left open.
 *
 * So the ban is unconditional in both briefs, on every day, candidates or none. It deliberately
 * does NOT name the tool: naming it here would make "the tool is instructed" true of a day of
 * remote calls, and a prohibition is not an instruction to use anything.
 *
 * REVIEW FINDING 4 — the tool has THREE non-answers, not two. `{notFound: {query}}` (a place
 * name that did not resolve) is literally neither a failure nor an empty result, so a rule
 * written as "fails, or comes back with nothing" leaves it uncovered. It is named.
 *
 * The banned phrasing is quoted verbatim from the brief that went out: "do not estimate" reads
 * to a model as a style note, while the sentence it actually wrote reads as a rule.
 */
const TRANSIT_BAN: readonly string[] = [
  "Never state a departure time, a line, a platform, a duration or a frequency for any journey",
  "unless a transit lookup returned it in this turn — and never write anything of the shape",
  "\"trains run roughly hourly\" or \"about 1h40\". That guess is what this replaces; an estimate is",
  "not an answer, and saying nothing about transport is always better than inventing it.",
  "If a lookup fails, comes back with nothing, or reports that it could not resolve one of the",
  "place names, you were not told about transport at all: say nothing about it — do not report it",
  "as empty, and do not state that there was nothing.",
  "",
];

/**
 * REVIEW FINDING 3 — what to do when the origin is not knowable, which is the NORMAL case.
 *
 * Nothing in the prompt, the persona or `agent.json` grounds where Bendik is. `to` is grounded
 * (the calendar's own venue string, which the geocoder either resolves or refuses) and
 * `arriveBy` is computed here — `from` is the one input the model supplies from nothing.
 *
 * Get it wrong and the tool still returns a REAL departure, with a real platform, from a place
 * he is not: "14:05 fra Oslo S, spor 3" while he is at Gardermoen. An address-resolved origin
 * comes back as a nearby stop, so the wrong answer arrives wearing the same detail the right one
 * would. Two sentences turn the most convincing possible failure into a visible one: state the
 * assumption out loud, or decline to make it.
 */
const ORIGIN_HONESTY: readonly string[] = [
  "Say in plain words where you assumed the journey starts — \"the 14:05 from Oslo S, if he's in",
  "town\" — so the assumption is his to correct. If you cannot actually say where he will be, say",
  "THAT and look nothing up: a wrong origin still returns a real departure from a real platform,",
  "which reads as detail rather than as the guess it is.",
  "",
];

/**
 * REVIEW IMPORTANT 1 — the same honesty, NARROWED, for the day the brief actually knows.
 *
 * {@link ORIGIN_HONESTY} is written for the case it was filed for: nothing in the prompt grounds
 * where Bendik will be, so the model must either declare the assumption or decline. On a night
 * covered by Marcel's itinerary that second half is FALSE — the brief is holding the answer, ten
 * lines further up — and telling a model to "say you cannot say where he will be and look
 * nothing up" on exactly the night the evening lookup exists for is how ORB-168's whole feature
 * gets talked out of firing.
 *
 * So this replaces it there, and nowhere else. The declaration survives verbatim in spirit — she
 * still says out loud where the journey starts, so a wrong row is his to correct — and only the
 * "you cannot know this" branch is dropped, because the itinerary is precisely the knowledge
 * Saga lacked. ORIGIN_HONESTY itself is untouched and still fires on every other day.
 */
const ORIGIN_ESTABLISHED = (origin: string, day: BriefDay): readonly string[] => [
  "This brief DOES establish where the journey starts: Marcel's itinerary has him sleeping at",
  `${origin}.`,
  `That is where he sets off ${day === "today" ? "this morning" : "tomorrow morning"}. It is not a calendar reservation and must not`,
  "be treated as one — it is the itinerary Marcel resolved, the record of where he is actually",
  "sleeping. Use it as the `from` for the lookup, and say in plain words that the journey starts",
  "there, so a wrong row is his to correct.",
  "",
];

/**
 * Where Marcel's itinerary says he sleeps the night BEFORE the briefed day, or `undefined` when
 * it says nothing about that night — REVIEW IMPORTANT 1.
 *
 * THE NIGHT BEFORE is the whole point, and it is a different night for each pass: the evening
 * brief composes tonight about tomorrow, so tomorrow morning's journey starts in tonight's bed;
 * the morning brief covers today, so today's journey starts in last night's. Both are answered
 * by the same question — "which lodging row covers `day - 1`" — which is why one helper serves
 * both and neither pass has to reason about tense.
 *
 * The coverage rule is `lodgingWhen`'s, deliberately: a stay's nights are `start … end-1`, so
 * check-out morning is NOT a night in that bed. Getting that wrong would put the origin one town
 * behind reality on exactly the morning he travels home.
 *
 * An `unavailable` store contributes no trips, so a store that could not be read yields
 * `undefined` here and {@link ORIGIN_HONESTY} fires — which is correct: a source that dropped
 * establishes nothing.
 */
export function itineraryOrigin(itinerary: BriefTravel | undefined): string | undefined {
  if (itinerary === undefined || !ISO_DAY_RE.test(itinerary.day)) return undefined;
  const night = shiftISO(itinerary.day, -1);
  for (const it of itinerary.travel.trips) {
    for (const b of it.lodging) {
      const spans = b.end !== undefined && b.end > b.start;
      const lastNight = spans ? shiftISO(b.end!, -1) : b.start;
      if (b.start <= night && night <= lastNight) {
        // The town, but only when the booking's own line does not already carry it — Marcel
        // usually writes "Scandic Ørnen, Bergen", and "(Bergen, Norway)" bolted onto that reads
        // as two places rather than one.
        const town = (it.trip.destination.split(",")[0] ?? "").trim();
        const place = town !== "" && !b.summary.includes(town) ? ` (${it.trip.destination})` : "";
        return `${b.summary}${place}, the night of ${night}`;
      }
    }
  }
  return undefined;
}

/**
 * The "Getting there" clause. Lines, so a prompt splices it exactly the way `eventKindClauses`
 * is spliced — and shared by both briefs for the same reason those are: the two read the same
 * day and must instruct the same way.
 *
 * Two halves with different gates, and the split is the whole shape of this function:
 *
 *   - The BAN is unconditional (see `TRANSIT_BAN`). Every brief carries it.
 *   - The LOOKUP INSTRUCTION rides on `transitCandidates` — no qualifying commitment, no
 *     instruction, and a day of remote calls never mentions the tool at all.
 *
 * THE GROUNDING VOCABULARY IS BORROWED, NOT INVENTED. `absentBlockClause`
 * (@lares/compose-contract) already owns the distinction this needs: a read that did not happen
 * is not a read that came back empty, and neither licenses saying anything. ORB-164 set the
 * precedent for lifting the contract's wording into a brief's own clause rather than editing
 * the contract — the invariant clauses stay byte-stable.
 *
 * REVIEW FINDING 2 — `day` exists because the evening pass composes at 20:00 about TOMORROW.
 * "Where he already is" is true in the morning and false the night he is in Bergen for a
 * Bergen meeting tomorrow: read against a model's Oslo default it plans a 06:12 he is 460 km
 * from. The lodging ban (correctly) removes the one row that hinted otherwise, so the evening
 * text has to say plainly that tonight's town is not tomorrow's answer.
 *
 * REVIEW IMPORTANT 1 (ORB-169 follow-up) — `itinerary` closes the half of finding 2 that was
 * left open. Saying "tonight's town is not tomorrow's answer" was right while the only travel
 * source was the calendar; once Marcel's itinerary is in the same prompt it is wrong, because
 * that itinerary answers the question. On a night it covers the clause now NAMES the origin
 * ({@link ORIGIN_ESTABLISHED}); on every other night nothing changes and
 * {@link ORIGIN_HONESTY} fires exactly as before.
 */
export function transitClause(
  commitments: readonly NightBeforeMeeting[],
  travel: readonly NightBeforeMeeting[],
  day: BriefDay,
  // REVIEW IMPORTANT 1 — the itinerary reaches this clause too. Every other brief helper already
  // took it (`travelContextBlock`, `eventKindClauses`); this one did not, so it went on asserting
  // that "nothing in this brief establishes" the origin eleven lines below its own block naming
  // the hotel. Optional for the same byte-stability reason as its siblings.
  itinerary?: BriefTravel,
  // LAR-16-s4 — defaults to DEFAULT_HOME_TZ for the same TypeScript-ordering reason as
  // `travelContextBlock`'s own `tz` (a required parameter cannot follow the optional
  // `itinerary` above it); both live callers pass the owner's actual clock explicitly.
  tz: string = DEFAULT_HOME_TZ,
): string[] {
  const candidates = transitCandidates(commitments);
  if (candidates.length === 0) return [...TRANSIT_BAN];

  const today = day === "today";
  const origin = itineraryOrigin(itinerary);
  return [
    "Getting there — these commitments have a real venue and a time he has to be at it:",
    // REVIEW FINDING 6 — the venue is free text off Google Calendar and may carry a newline;
    // unflattened it splits this row in two and `— arriveBy …` reads as a second commitment.
    ...candidates.map(
      (m) => `- ${m.title} — venue: ${(m.location ?? "").replace(/\s+/g, " ").trim()} — arriveBy ${isoWithOffset(m.startsAt, tz)}`,
    ),
    "",
    today
      ? "For one of those whose venue is in a DIFFERENT TOWN from where he already is, call"
      : "For one of those whose venue is in a DIFFERENT TOWN from where he will be tomorrow, call",
    "`agent-kit__transit_plan` — `to` that venue, `from` where the journey would really begin, and",
    "`arriveBy` set to the exact value on its line — then say which departure gets him there: the",
    "time, where it leaves from, the platform when Entur gives one, and when it arrives. At most",
    "ONE lookup per commitment listed, and none at all for a venue in the town" +
      (today ? " he is already in." : " he will already be in."),
    "When the venue line does not say which town it is in, the lookup is how you find out — what",
    "comes back names the locality it resolved to; do not decide the town from the name of the",
    "place.",
    "",
    ...(today
      ? []
      : [
          "This pass is about TOMORROW, so the journey starts wherever he will be TOMORROW MORNING —",
          "which is a different question from where he is tonight on exactly the nights it matters" +
            (origin === undefined ? ", and nothing in this brief establishes it." : "."),
          "",
        ]),
    // REVIEW IMPORTANT 1 — the two lodging sentences, and why they do not contradict each other.
    //
    // A CALENDAR lodging row is not presence. That is ORB-165's ruling and it stands unchanged: a
    // reservation on the calendar says a booking exists, nothing more, and it is exactly what
    // produced "you're based at Scandic Oslo Airport all day". So the ban below still fires, on
    // its own terms — whenever such a row is actually in the block — and it now says CALENDAR out
    // loud, because it was written when that was the only kind of lodging row there was.
    //
    // An ITINERARY lodging row is different in kind, which is the whole distinction ORB-169
    // exists to draw. Marcel resolved it: it is the record of where Bendik is actually sleeping,
    // with the span on it, which is precisely the knowledge Saga lacked when she read a booking
    // as occupancy. That row IS evidence of where tomorrow morning starts, and it is named.
    //
    // Order matters: the positive statement comes first, so the ban that follows reads as the
    // exception it is rather than as a retraction of the sentence above it.
    ...(origin === undefined ? [] : ORIGIN_ESTABLISHED(origin, day)),
    // REVIEW FINDING 5 — gated on an actual LODGING row, not on travel context generally:
    // `travel` also carries flights and out-of-office markers, and a day with only a flight was
    // printing a warning about a hotel that is not there.
    ...(travel.some((m) => m.kind === "lodging")
      ? origin === undefined
        ? [
            "A lodging row from the CALENDAR is not evidence of where he is, so never pass a",
            "calendar lodging row as the journey's origin.",
            "",
          ]
        : [
            "A lodging row from the CALENDAR is still not evidence of where he is, so never pass a",
            "calendar lodging row as the journey's origin. The itinerary row named just above is the",
            "one exception, and it is not the same kind of thing: Marcel resolved that one, while the",
            "calendar merely holds a booking.",
            "",
          ]
      : []),
    ...(origin === undefined ? ORIGIN_HONESTY : []),
    ...TRANSIT_BAN,
  ];
}

/**
 * ORB-167 — the "Standing facts — his words" block, or "" when he has told her nothing.
 *
 * A sibling of `travelContextBlock` and shared by both briefs for the same reason: the two read
 * the same facts, so they must render them the same way. `labeledContext` drops the block when
 * it is empty (@lares/compose-contract) — no `emptyText`, deliberately: an absent block here
 * carries no meaning worth stating, and "(none)" would invite her to remark on having no memory.
 *
 * These already reach the agent through `agent/instructions/standing-facts.ts`, once per session
 * (W4B-s2), brief turns included. They are repeated here as a LABELED block because a brief is
 * composed under the contract's grounding rules, and those rules apply per block: a fact the
 * agent is expected to ACT on in the brief has to be a named piece of context in it, not
 * background it happens to carry.
 */
export function standingFactsBlock(facts: readonly StandingFact[]): string {
  return labeledContext([{
    label: "Standing facts — his words",
    note: "things he has told you once; they hold until he says otherwise",
    content: facts.map(standingFactLine).join("\n"),
  }]);
}

/** The ONE sentence the standing-facts block needs beside it, and only when it is there.
 *  Returned as lines so a prompt splices it in exactly the way `eventKindClauses` is spliced. */
export function standingFactsClause(facts: readonly StandingFact[]): string[] {
  if (facts.length === 0) return [];
  return [
    "Apply these without being asked; they are his words.",
    "",
  ];
}

/**
 * ORB-166 — the ONE thing both briefs must be told about a `person_lookup` that comes back with
 * no record of the PERSON.
 *
 * The morning this was filed, the brief said of a 16:30 intro call: "first contact, no prior
 * history — worth a quick look at Cyrus if you want a steer going in." Cyrus is the bridge his own
 * dev agent runs on and he has been a self-hosting customer since May; the dossier simply had no
 * organisation half, so the only honest thing she could say about the company was nothing. Now
 * that the dossier HAS one, she still needs telling that an unknown person and an unknown company
 * are two different findings — and that the second one is usually the useful half.
 *
 * Unconditional, unlike `standingFactsClause` and `eventKindClauses`: those describe a BLOCK that
 * may or may not be in the prompt, while this describes what to do with a TOOL RESULT that only
 * exists at turn time. Neither brief can know in advance whether a lookup will come back that way.
 *
 * Shared by both briefs, from one place, for the same reason every other clause here is: the
 * evening pass looks up each of tomorrow's participants and the morning pass looks up the
 * obligations, and the two must not disagree about what an ORGANISATION section means.
 */
export function organisationLookupClause(): string[] {
  return [
    "A lookup that says UNKNOWN is a finding about the PERSON only. If it also carries an",
    "ORGANISATION section, you know their company even though you do not know them — so this is",
    "NOT \"no prior history\": say it is first contact with them, then say what the relationship",
    "with the organisation is. That section lists NOTES, a store and a path each: read the note",
    "before you use it and say only what it says. Never infer a relationship from a filename and",
    "never fill the gap from memory.",
    // ORB-167 review fix — "memory" and the "What Bendik has told me" block are two different
    // things, and this same prompt carries both. Without this sentence a literal reader takes
    // "never fill the gap from memory" as an instruction to suppress his standing facts when
    // writing about a company, which is the opposite of what either clause asks for.
    "\"Memory\" there means your own recollection of the company. His standing facts are not that:",
    "they are his own words, and they apply here like everywhere else.",
    "",
  ];
}

export interface CalendarSourceDeps {
  listEvents(o: { timeMin: string; timeMax: string; max: number }): Promise<CalendarEvent[]>;
  /** Every address he owns — comparison against attendees is done lowercased. */
  myAddresses(): Promise<string[]>;
}

// The real client clamps `max` to 250 internally — pass its ceiling directly.
const MEETINGS_MAX = 250;

// Wide on purpose: a naive "UTC midnight" guess at tomorrow's bounds lands hours off the owner's
// true midnight, by a different amount in every zone and season. Fetching generously and
// filtering by CALENDAR DATE on the owner's clock sidesteps the guess entirely — at a 20:00
// pass "tomorrow" is the 4th to the 28th hour from now wherever he is, well inside 48.
const FETCH_WINDOW_MS = 48 * 3600_000;

/** A block this short with nobody else on it, no location and no all-day span is a personal
 *  marker (a buffer, a reminder-shaped hold), not something to prepare him for. */
const COMMITMENT_MIN_MINUTES = 60;

/**
 * Tomorrow's real commitments — tomorrow on the owner's clock, `tz` (LAR-67; see
 * {@link nightBeforeCoveredDay}).
 *
 * ORB-118 — the rule was ONCE "has an attendee outside his own addresses", and that silence
 * cost a three-hour meeting: Folkepuls at Folio, copied in from another calendar, carrying no
 * attendee list at all. Attendee metadata turns out to be the exception in his calendar, not
 * the rule — he blocks working time deliberately, and copied/forwarded invitations arrive
 * bare. So an event counts when ANY of these is true:
 *
 *   - someone outside his own addresses is on it   (the original rule, still the strongest)
 *   - it is an all-day block                       (a travel day IS the day)
 *   - it names a location                          (he is going somewhere)
 *   - it runs an hour or longer                    (he set aside real time for it)
 *
 * A missed meeting is far worse than an extra line in a brief, so the tie goes to including.
 * What stays out is the short attendee-less hold with no place attached.
 *
 * THROWS on a read failure, on a truncated window, or when the identity registry cannot say
 * which addresses are his — never returns `[]` for any of those. `[]` renders as "nothing on
 * tomorrow", a claim his day has not earned from a failed or untrustworthy read.
 */
export async function listTomorrowMeetings(
  deps: CalendarSourceDeps, now: Date, tz: string = DEFAULT_HOME_TZ,
): Promise<NightBeforeMeeting[]> {
  return listMeetingsOn(
    deps, nightBeforeCoveredDay(now, tz), now, new Date(now.getTime() + FETCH_WINDOW_MS), tz,
  );
}

/** How far back TODAY's read reaches. The morning brief fires at 08:00, so anything already
 *  under way (or an all-day block, whose instant is midnight) must still be fetched — the
 *  calendar-date filter, not the window, decides what is "today". */
const TODAY_LOOKBACK_MS = 12 * 3600_000;

/**
 * Today's commitments, today on the owner's clock `tz` (LAR-67) — same rule as
 * `listTomorrowMeetings`, different day.
 *
 * The morning brief was a pure delta and said nothing about his day (Bendik, 2026-08-18: "the
 * morning brief should let me know what's on my plate"). Repeating what last night's prep
 * covered is DELIBERATE here — at 08:00 the day's fixed points are the frame everything else
 * hangs on, and the evening pass is 12 hours old.
 */
export async function listTodayMeetings(
  deps: CalendarSourceDeps, now: Date, tz: string = DEFAULT_HOME_TZ,
): Promise<NightBeforeMeeting[]> {
  return listMeetingsOn(
    deps, dateIn(now, tz), new Date(now.getTime() - TODAY_LOOKBACK_MS), new Date(now.getTime() + FETCH_WINDOW_MS), tz,
  );
}

/**
 * The window's events plus his own addresses — the I/O half of a calendar pass, split out
 * (ORB-139) so the SAME read can feed both the day's rows and the conflict pass without
 * fetching twice. Behaviour is unchanged: every throw below is the throw `listMeetingsOn`
 * already made, in the same order.
 */
async function readCalendarWindow(
  deps: CalendarSourceDeps, from: Date, to: Date,
): Promise<{ events: CalendarEvent[]; mine: Set<string> }> {
  const events = await deps.listEvents({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    max: MEETINGS_MAX,
  });

  // The real calendar client orders ascending by startTime with NO pagination. A full-length
  // result does not mean "a packed day" — it means the window held MORE than MEETINGS_MAX
  // events and the newest were cut off the end. (With the multi-calendar fan-out in
  // lib/calendar-fanout.ts the authoritative check is per calendar, where the ceiling is
  // actually hit; this one still guards any single-source caller.)
  if (events.length === MEETINGS_MAX) {
    throw new Error(
      `calendar returned the maximum ${MEETINGS_MAX} events for this window — the newest may be missing, so tomorrow's meetings cannot be trusted`,
    );
  }

  const mine = new Set((await deps.myAddresses()).map((a) => a.toLowerCase()));
  if (mine.size === 0) {
    throw new Error("cannot tell which attendees are external: the identity registry returned no addresses for the owner");
  }

  return { events, mine };
}

/**
 * The calendar date an event STARTS on, read on the owner's clock `tz`.
 *
 * An all-day entry arrives as a bare `YYYY-MM-DD` and IS its date: turning it into an instant
 * and reading that back in a zone west of UTC lands on the day before (UTC midnight is still
 * yesterday evening in New York). On the home clock the two readings agree, which is why this
 * never showed before LAR-67 — `lib/calendar-conflicts.ts`'s `isDateOnly` records the same trap.
 */
function eventDay(start: string, tz: string): string {
  const bare = start.trim();
  return ISO_DAY_RE.test(bare) ? bare : dateIn(new Date(start), tz);
}

/** The pure half of a calendar pass: one fetched window reduced to ONE day's rows — the day
 *  `targetDay`, with every event's own date read on the same clock `tz` that named it. */
function meetingsFromEvents(
  events: readonly CalendarEvent[], targetDay: string, mine: ReadonlySet<string>, tz: string,
): NightBeforeMeeting[] {
  // Sorted here, not by the source: the fan-out merges several calendars, each ordered only
  // within itself, so a 09:00 zero7 call would otherwise print after a 17:00 heiberg block.
  return events.flatMap((e): NightBeforeMeeting[] => {
    if (!e.start) return [];
    if (eventDay(e.start, tz) !== targetDay) return [];   // a neighbouring day — not the brief's
    const participants = (e.attendees ?? [])
      .map((a) => a.email.toLowerCase())
      .filter((email) => !mine.has(email));

    const location = (e.location ?? "").trim();
    const minutes = e.end ? (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000 : 0;
    const counts =
      participants.length > 0 ||
      e.allDay === true ||
      location !== "" ||
      minutes >= COMMITMENT_MIN_MINUTES;
    if (!counts) return [];

    return [{
      title: e.summary || "(untitled)",
      startsAt: new Date(e.start),
      participants,
      // ORB-165 — classified HERE, once, off `participants` rather than the raw attendee list:
      // an event whose only "attendee" is himself (every Gmail-created booking is) must not
      // read as a call. Nothing is filtered out at this point; the renderers decide what may
      // be shown as a commitment.
      kind: classifyEvent({
        summary: e.summary, eventType: e.eventType, location, participants,
        ...(e.hasConferenceLink === true ? { hasConferenceLink: true } : {}),
      }),
      ...(e.allDay === true ? { allDay: true as const } : {}),
      ...(location !== "" ? { location } : {}),
      // Fix round 1, Finding 2 — the end was computed above for the duration floor and thrown
      // away. An all-day entry's "end" is the exclusive next midnight, which is not a clock
      // time and must never render as one.
      ...(e.end && e.allDay !== true ? { endsAt: new Date(e.end) } : {}),
      ...(e.hasConferenceLink === true ? { hasConferenceLink: true as const } : {}),
    }];
  }).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

async function listMeetingsOn(
  deps: CalendarSourceDeps, targetDay: string, from: Date, to: Date, tz: string,
): Promise<NightBeforeMeeting[]> {
  const { events, mine } = await readCalendarWindow(deps, from, to);
  return meetingsFromEvents(events, targetDay, mine, tz);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ORB-139 — the conflict pass, on the calendar read the brief already makes.
//
// On 2026-08-20 Saga caught two overlapping New York hotels and a status meeting that landed
// at 06:00 where he actually was — unprompted, off no code at all. The model happened to
// notice. `lib/calendar-conflicts.ts` is the deterministic version of that noticing; this is
// where the morning brief runs it.
//
// TWO DELIBERATE CHOICES:
//
//  1. **The SAME read, not a second one.** `readCalendarWindow` is fetched once and feeds both
//     the day's rows and the conflict pass. A second fan-out would double the brief's calendar
//     cost, and — worse — could disagree with the first one about what is on his day.
//  2. **Detection is bounded to the brief's DAY, not to the fetched window.** The window runs
//     from 12 hours back to 48 hours forward (`TODAY_LOOKBACK_MS`/`FETCH_WINDOW_MS`), so
//     without this bound a clash tomorrow evening would crowd a brief that is about today. A
//     multi-night stay still qualifies: it OVERLAPS today even though it started days ago,
//     which is exactly the shape the founding case had.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** One calendar pass: the day's rows, and what on that day contradicts itself. */
export interface DayCalendar {
  meetings: NightBeforeMeeting[];
  /** By exception — `[]` on a day with nothing wrong on it, and nothing is rendered for `[]`. */
  conflicts: CalendarConflict[];
}

/** Marcel's trips as the conflict radar needs them: which days, and whose clock. An
 *  `unavailable` store yields NO trips, which reads as "home", and that is the honest floor —
 *  it is what the radar would assume anyway, and inventing a zone from a failed read is the
 *  one thing worse than assuming the usual one. */
export function conflictTrips(travel: BriefTravel | undefined): ConflictTrip[] {
  return (travel?.travel.trips ?? []).map((it) => ({
    start: it.trip.start,
    end: it.trip.end,
    timezone: it.trip.timezone,
  }));
}

/**
 * TODAY's commitments AND today's clashes, off one calendar read — today on the owner's clock,
 * `opts.tz` (LAR-67; omitted, the home clock, exactly as before).
 *
 * Identical to {@link listTodayMeetings} in what it fetches, what it throws and what rows it
 * returns — the conflict list is added beside them, never instead of them. A caller with no
 * travel wiring passes no trips and gets the home clock, exactly as the radar's own default.
 *
 * ONE `today` for both halves, so a brief never lists one day's meetings beside another day's
 * clashes. KNOWN LIMIT, left alone on purpose: the radar is a home-clock module by its own
 * contract (`lib/calendar-conflicts.ts` reads every timed event's date on the HOME zone, because
 * its timezone-trap class needs "home" to mean home). So on the rare morning the two dates
 * differ — only far east of home, where 08:00 is still yesterday evening at home — the radar
 * bounds the owner's date as the home clock sees it, which begins some hours into his day.
 * Meetings are unaffected; giving the radar a day-zone of its own is a change to that module.
 */
export async function listTodayCalendar(
  deps: CalendarSourceDeps, now: Date, opts: { trips?: readonly ConflictTrip[]; tz?: string } = {},
): Promise<DayCalendar> {
  const tz = opts.tz ?? DEFAULT_HOME_TZ;
  const from = new Date(now.getTime() - TODAY_LOOKBACK_MS);
  const to = new Date(now.getTime() + FETCH_WINDOW_MS);
  const { events, mine } = await readCalendarWindow(deps, from, to);
  const today = dateIn(now, tz);
  return {
    meetings: meetingsFromEvents(events, today, mine, tz),
    conflicts: detectCalendarConflicts(events, {
      days: [today],
      ...(opts.trips ? { trips: opts.trips } : {}),
    }),
  };
}

/** At most this many clash lines reach a brief. The radar can find more; a morning message
 *  that opens with six of them is a wall, and the ones past the third are the ones he would
 *  have skipped anyway. The block says plainly when it is holding some back. */
export const CONFLICT_LINES_MAX = 3;

/** One clash, as the brief states it: what kind, and the radar's own sentence.
 *
 * LAR-59-s6 — when `c.resolution.strength === "strong"`, the line appends the evidence
 * sentence `lib/conflict-evidence.ts`'s `evidenceSentence` built (sender, date, a truncated
 * subject — never body text), prefixed by `lang`'s fixed "Evidence:" word. `lang` defaults to
 * `"en"` so every existing call site — none of which passes a resolution today — renders
 * byte-identical to before. A `"weak"` match, or no `resolution` at all, appends nothing: the
 * plain flag stands exactly as it always has. */
export function conflictLine(c: ResolvedConflict, lang: BriefLanguage = "en"): string {
  const evidence =
    c.resolution?.strength === "strong"
      ? ` ${BRIEF_STRINGS[lang].conflicts.evidenceLabel} ${c.resolution.sentence}`
      : "";
  return `- ${CONFLICT_LABEL[c.kind]} — ${c.explanation}${evidence}`;
}

const CONFLICT_LABEL: Record<ConflictKind, string> = {
  "double-booked": "double-booked",
  "overlapping-stay": "two beds, same night",
  "timezone-trap": "wrong clock",
};

/**
 * The labeled `## Clashes` block, or `""` when the radar found nothing.
 *
 * BY EXCEPTION, like the obligations it sits beside: an empty block is DROPPED by
 * `labeledContext`, never rendered as "no conflicts". That is not a formatting preference —
 * this file's own header spells out why a brief never writes negative assurances, and a radar
 * that reports its own silence every morning is the fastest way to teach him to skip the
 * block on the morning it has something.
 *
 * The note names what the rows are AND what they are not. LAR-59-s6: the plain
 * "nothing here has been resolved, checked against mail, or acted on" wording is now only
 * true of a pass that found no evidence, and that is EXACTLY the case that keeps rendering it —
 * `hasEvidence` here means "at least one shown row already carries a resolution", never
 * "a search ran". A pass with no evidence anywhere is byte-identical to before this slice, note
 * included; only once a row actually carries the mail's own sentence does the wording — and the
 * `thirdParty` flag below — change with it.
 *
 * `thirdParty: true` is set ONLY alongside that changed note, i.e. only when at least one SHOWN
 * line carries evidence: the evidence sentence is built from a mail's own sender/date/subject
 * (attacker-controllable words), so the block containing it must carry `THIRD_PARTY_NOTICE`
 * (`@lares/compose-contract`) directly under its heading, per the origin-model spec's in-turn
 * taint rule. A block with no evidence line has nothing mail-derived in it and stays unflagged.
 */
export function conflictsBlock(conflicts: readonly ResolvedConflict[], lang: BriefLanguage = "en"): string {
  if (conflicts.length === 0) return "";
  const shown = conflicts.slice(0, CONFLICT_LINES_MAX);
  const held = conflicts.length - shown.length;
  const hasEvidence = shown.some((c) => c.resolution?.strength === "strong");
  const lines = shown.map((c) => conflictLine(c, lang));
  if (held > 0) lines.push(`- (${held} more clash${held === 1 ? "" : "es"} today, not listed here)`);
  const note = hasEvidence
    ? "found by a deterministic pass over today's calendar — checked against mail only where a " +
      "row says so; nothing has been acted on"
    : "found by a deterministic pass over today's calendar — nothing here has been resolved, " +
      "checked against mail, or acted on";
  return labeledContext([
    {
      label: "Clashes",
      note,
      content: lines.join("\n"),
      ...(hasEvidence ? { thirdParty: true } : {}),
    },
  ]);
}

/** The ONE sentence that tells her what to do with the block above — and only when there is a
 *  block. Same shape and same reason as `standingFactsClause`: the block states the facts, the
 *  clause says she must pass them on rather than quietly reasoning about them.
 *
 * LAR-59-s6 — a row with no evidence keeps this clause byte-identical to before: no deciding,
 * no mail, no offering. When at least one row already carries a strong resolution, ONE extra
 * sentence is appended (never a rewrite of the three lines above it) that truthfully narrows
 * the ban: she may now mention that a cancellation mail already exists and OFFER to remove the
 * stale entry — always behind `calendar_delete_event`'s own approval card, and only after
 * waiting for his answer. Nothing here lets her decide which booking stands or act without him.
 */
export function conflictsClause(conflicts: readonly ResolvedConflict[]): string[] {
  if (conflicts.length === 0) return [];
  const hasEvidence = conflicts.some((c) => c.resolution?.strength === "strong");
  return [
    "Something on today's calendar contradicts itself. Say so in one clause, name what clashes,",
    "and stop there — do not decide which one is right, do not check mail for the answer, and do",
    "not offer to cancel, decline or move anything.",
    ...(hasEvidence
      ? [
          "Where a row above already names a cancellation mail, you may say so and offer to " +
            "remove the stale entry through its approval card — never delete it yourself, and " +
            "wait for his answer before doing anything else.",
        ]
      : []),
    "",
  ];
}

/** Operational failures since the previous brief. Errors are all retained; warnings are a
 * count plus the top three. A read-and-empty result disappears completely. */
export function signalsBlock(signals: readonly SignalRow[]): string {
  if (signals.length === 0) return "";
  const errors = signals.filter((signal) => signal.severity === "error");
  const warnings = signals.filter((signal) => signal.severity === "warn");
  if (errors.length === 0 && warnings.length === 0) return "";
  const line = (signal: SignalRow) =>
    `- ${signal.severity} · [${signal.project}] ${signal.title} · ${signal.lastSeen}` +
    `${signal.linearRef ? ` · ${signal.linearRef}` : ""}` +
    `${signal.count > 1 ? ` · ×${signal.count}` : ""}` +
    `${signal.state === "recovered" ? " · recovered" : ""}`;
  const rows = [...errors.map(line)];
  if (warnings.length > 0) {
    rows.push(`- ${warnings.length} warning${warnings.length === 1 ? "" : "s"} since last brief:`);
    rows.push(...warnings.slice(0, 3).map(line));
  }
  return labeledContext([{ label: "Signals since last brief", content: rows.join("\n") }]);
}

export function signalsClause(signals: readonly SignalRow[]): string[] {
  if (!signals.some((signal) => signal.severity === "error" || signal.severity === "warn")) return [];
  return [
    "The signals block is the spine's record since the previous brief. Include its errors and",
    "warning summary in the prioritised message; do not reinterpret an empty or absent block.",
    "",
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Frister — the deadline block (ORB-180)
//
// A statutory due date is a FIXED POINT of his day, in the same family as a meeting he has to be
// at, and nothing like a reply he owes a person. That is why the block sits above the obligations
// heading in the morning prompt and why `deadlinesClause` exists at all: the one failure mode
// worth a sentence of prompt is the model folding these lines into the owed-a-reply list, which
// is exactly the misfiling Workstream B removes on the other side of the pipeline.
//
// Rendered into the prompt as CONTEXT rather than spoken — the same standing this file gives
// `heldBackLine`. LAR-16-s2 moved the wording itself out to `lib/brief-strings.ts`, keyed by
// `BriefLanguage`; the Norwegian (`nb`) strings are today's exact wording and are asserted
// verbatim in tests/brief-content.test.ts and tests/brief-language.test.ts.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** One open deadline, as the brief states it. `daysToDue` is computed by the caller against the
 *  OWNER's clock (`@lares/agent-kit/deadlines`), never re-derived here from `dueDate`.
 *
 *  `vendor`/`amount`/`currency` are LAR-22-s3: who is paid and how much, mostly meaningful for a
 *  `'renewal'` row but not restricted to one (`deadline_add` accepts them on any source — see its
 *  own header). All three optional and independently nullable, matching `DeadlineRow` — a row
 *  minted before this ticket, or one with only some of the three filled in, is ordinary, not an
 *  error. */
export interface DeadlineLine {
  id: string;
  entity: string;
  title: string;
  dueDate: string;
  daysToDue: number;
  consequence: string | null;
  source: DeadlineSource;
  vendor?: string | null;
  amount?: number | null;
  currency?: string | null;
}

/** A mail that LOOKS like a due notice, offered once. Never a deadline — only an offer to make
 *  one, with both ways out named on the line. */
export interface CandidateLine {
  threadId: string;
  subject: string;
  sender: string;
}

/**
 * At most this many CANDIDATE lines reach one brief — the `CONFLICT_LINES_MAX` precedent above,
 * for the same reason and one this ticket can date.
 *
 * The scan reads a 60-day inbox, so the first tick after this ships flags every institutional
 * mail in that window at once. Uncapped, day one is a brief that opens with a wall of offers,
 * which is the fastest way to teach him to skip the block on the morning it has one that matters.
 * Capped, the rest stay UNSTAMPED and drain five a morning until the backlog is gone.
 *
 * Applied where the list is BUILT (agent/schedules/morning-brief.ts), never here: only the
 * candidates actually rendered may be stamped `surfaced_at`, and a cap applied at render time
 * would stamp six and show five.
 *
 * DELIBERATELY NO "(N more …)" TAIL, unlike `conflictsBlock`. A held-back clash is a fact about
 * today he is not being told; a held-back candidate is an offer that has not been made yet, and
 * announcing the size of a queue of offers is noise about the system rather than news about his
 * day.
 */
export const CANDIDATE_LINES_MAX = 5;

/** `- SISTE FRIST — i dag:` / `- Forfalt for 2 dager siden:` / `- Om 8 dager (2026-09-16):`, or
 *  their `lang` equivalent from `BRIEF_STRINGS` (LAR-16-s2). The date rides along on the far rows
 *  so the model never has to compute one — the arithmetic is done here, on the owner's clock,
 *  where it can be tested. */
function dueLabel(daysToDue: number, dueDate: string, lang: BriefLanguage): string {
  const s = BRIEF_STRINGS[lang].deadlines.dueLabel;
  if (daysToDue < 0) return s.overdue(-daysToDue);
  if (daysToDue === 0) return s.dueToday;
  if (daysToDue === 1) return s.dueTomorrow;
  return s.dueIn(daysToDue, dueDate);
}

/** `199` for a whole number, `199.50` / `199.99` for anything with a fractional part — never a
 *  thousands separator (the number as it is STORED, `numeric(12,2)`, not a locale rendering). A
 *  trailing `.00` on a whole amount would be a decimal the owner never entered, so it only
 *  appears when the amount actually has one. */
function formatAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/** `" — Domeneshop, 199 NOK"` (LAR-22-s3) — vendor and amount/currency, appended after the
 *  consequence clause and before the trailing `[id …]`. PURE DATA, no language-specific words:
 *  a vendor name and an ISO currency code read the same in every `BriefLanguage`, so this never
 *  touches `BRIEF_STRINGS`. Composed from whichever of the three fields are actually present —
 *  vendor alone, amount alone (with or without its currency), or vendor plus amount — so a
 *  partially-filled row (e.g. vendor with no amount yet) still renders cleanly rather than with
 *  a stray comma or an empty parenthetical. `""` when none of the three are set, which is what
 *  keeps a pre-LAR-22 row byte-identical to today's output. */
function vendorAmountClause(d: DeadlineLine): string {
  const parts: string[] = [];
  if (d.vendor) parts.push(d.vendor);
  if (d.amount !== null && d.amount !== undefined) {
    parts.push(d.currency ? `${formatAmount(d.amount)} ${d.currency}` : formatAmount(d.amount));
  } else if (d.currency) {
    // An amount-less currency is a degenerate row (nothing entered the ladder to require it),
    // but a fact typed in is a fact rendered — never silently dropped.
    parts.push(d.currency);
  }
  return parts.length > 0 ? ` — ${parts.join(", ")}` : "";
}

function deadlineRow(d: DeadlineLine, lang: BriefLanguage): string {
  // The consequence clause is OMITTED, not emptied: "… (Vol de Nuit AS) — [id d2]" reads as a
  // consequence that failed to render, which is worse than one that was never claimed.
  const consequence = d.consequence ? ` — ${d.consequence}` : "";
  const vendorAmount = vendorAmountClause(d);
  return `- ${dueLabel(d.daysToDue, d.dueDate, lang)} ${d.title} (${d.entity})${consequence}${vendorAmount} [id ${d.id}]`;
}

/**
 * The thread id is written into BOTH tool calls as well as the trailing `[thread …]` marker.
 * Deliberate redundancy: a line the model has to assemble an argument for is a line it can
 * assemble wrong, and the cost of repeating a short id three times is nothing next to a
 * `deadline_add` aimed at the wrong thread.
 *
 * `deadline_add`/`deadline_dismiss` and their argument names are CODE, not prose (LAR-16-s2):
 * `BRIEF_STRINGS[lang].deadlines.candidateRow` translates the sentence around them and nothing
 * inside the parentheses.
 */
function candidateRow(c: CandidateLine, lang: BriefLanguage): string {
  return BRIEF_STRINGS[lang].deadlines.candidateRow(c.subject, c.sender, c.threadId);
}

/**
 * At most this many DEADLINE lines reach one brief — the same reasoning as `CANDIDATE_LINES_MAX`
 * above, for a case that arrives all at once (review fix, ORB-180).
 *
 * A statutory mint is a WHOLE YEAR in one approval: twelve rows for a Norwegian AS, and a second
 * entity doubles it. `MENTION_DAYS` alone keeps most mornings short, but the day two entities' 30-
 * day marks coincide — or the morning after a backfill — the block becomes a wall, and a wall is
 * read as furniture. Eight is where the list still scans as a list.
 *
 * Unlike the candidate cap, this one DOES print a tail (`+N flere frister — se konsollen`): a
 * held-back candidate is an offer that has not been made yet, but a held-back deadline is a dated
 * obligation that exists whether or not it fits, and hiding the size of that is the ORB-179 defect
 * in miniature.
 *
 * OVERDUE ROWS STILL APPEAR EVERY DAY, and are never the ones truncated — the sort puts them
 * first. That daily repetition is deliberate: overdue is the penalty case, and the one place this
 * brief is allowed to nag.
 */
export const DEADLINE_LINES_MAX = 8;

/**
 * The labeled `## Frister` block, or `""` when there is nothing due and nothing to offer.
 *
 * BY EXCEPTION, like `conflictsBlock` beside it: an empty block is DROPPED rather than rendered
 * as "ingen frister". A brief that reports its own silence every morning is the fastest way to
 * teach him to skip the block on the morning it has something.
 *
 * ORDER: overdue and imminent (≤2 days) first — most overdue first, then closest — and the rest
 * closest-first behind them, which is one ascending sort by `daysToDue` and is written as one.
 * Candidates last, in the order given (the store hands them back oldest-sighting first), because
 * an offer to record a deadline never outranks a deadline that already exists.
 *
 * Deadline lines are capped at {@link DEADLINE_LINES_MAX}, most urgent kept; the candidate cap of
 * {@link CANDIDATE_LINES_MAX} is applied where the list is BUILT (the schedule), not here, because
 * only the candidates actually rendered may be stamped `surfaced_at`.
 *
 * `lang` is required (LAR-16-s2), same reason as `heldBackLine`: every caller says which language
 * it wants rather than this file assuming Norwegian.
 */
export function deadlinesBlock(rows: readonly DeadlineLine[], candidates: readonly CandidateLine[], lang: BriefLanguage): string {
  if (rows.length === 0 && candidates.length === 0) return "";
  const s = BRIEF_STRINGS[lang].deadlines;
  const sorted = [...rows].sort((a, b) => a.daysToDue - b.daysToDue);
  const shown = sorted.slice(0, DEADLINE_LINES_MAX);
  const hidden = sorted.length - shown.length;
  const lines = [
    ...shown.map((d) => deadlineRow(d, lang)),
    // Named as a count and a place to look, never as a silent truncation.
    ...(hidden > 0 ? [s.moreTail(hidden)] : []),
    ...candidates.map((c) => candidateRow(c, lang)),
  ];
  return labeledContext([{ label: s.blockLabel, content: lines.join("\n") }]);
}

/** The ONE sentence that tells her what to do with the block above — and only when there is a
 *  block. Same shape and same reason as `conflictsClause`: the block states the facts, the
 *  clause stops her folding them into the list of people waiting on him. `lang` required, same
 *  reason as `deadlinesBlock` beside it. */
export function deadlinesClause(rows: readonly DeadlineLine[], candidates: readonly CandidateLine[], lang: BriefLanguage): string[] {
  if (rows.length === 0 && candidates.length === 0) return [];
  return [BRIEF_STRINGS[lang].deadlines.clause, ""];
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Ingested picks — ported from services/agent-runtime/lib/adapters/brief/ingested-picks.ts.
// Notes that entered the Brain (the vault's raw/ folder, BRIEF_PICKS_DIR) recently — reading,
// never events or meetings.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export interface IngestedPick {
  title: string;
  url?: string;
  /** Filename inside the declared dir (vault-relative to raw/). */
  path: string;
  /** Oslo calendar day the note entered the Brain, "YYYY-MM-DD". */
  created: string;
}

/** Cap so the brief's nudge stays lean. */
export const PICKS_MAX = 8;

/** How far back "entered the Brain recently" reaches, in Oslo days (inclusive boundary). */
export const PICKS_WINDOW_DAYS = 7;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Strip surrounding quotes an LLM may have added around a scalar. */
function unquote(v: string): string {
  return v.replace(/^["']|["']$/g, "").trim();
}

/**
 * Parse the YAML frontmatter block at the top of a note body — a flat key→value map of string
 * scalars only. Ported from `services/agent-runtime/lib/adapters/digest/extract.ts`'s
 * `parseFrontmatter` (a five-line function, copied here rather than importing an unrelated
 * digest module for it).
 */
function parseFrontmatter(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!body.startsWith("---")) return result;
  const end = body.indexOf("\n---", 3);
  if (end === -1) return result;
  const block = body.slice(3, end).trim();
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key && val) result[key] = val;
  }
  return result;
}

/** "why-eu-sovereign-ai-matters.md" → "Why eu sovereign ai matters" — last-resort title. */
function humanise(filename: string): string {
  const base = filename.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : filename;
}

export interface PicksReader {
  readdir(dir: string): string[];
  readFile(path: string): string;
}

const nodePicksReader: PicksReader = {
  readdir: (dir) => readdirSync(dir),
  readFile: (path) => readFileSync(path, "utf8"),
};

/**
 * Notes that entered the Brain within the window. `dir` = the vault's raw/ folder (declared —
 * no magic paths). Newest-first, capped at PICKS_MAX. Returns [] when the input is off, the
 * dir is unreadable, or nothing qualifies. Never throws — a brief must still send.
 */
export function readIngestedPicks(
  dir: string | undefined, now: Date, reader: PicksReader = nodePicksReader,
): IngestedPick[] {
  if (!dir) return [];
  try {
    // LAR-67 — DELIBERATELY still the home clock, the one day decision in this file that is. A
    // note's `created` is a date the vault wrote at home, so the cutoff it is compared against
    // has to come off that same clock; where the owner is standing has no bearing on when a
    // note was filed. Moving this one would compare dates taken from two different clocks.
    const cutoff = osloDate(new Date(now.getTime() - PICKS_WINDOW_DAYS * DAY_MS));
    const picks: IngestedPick[] = [];
    for (const name of reader.readdir(dir)) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      let body: string;
      try {
        body = reader.readFile(join(dir, name));
      } catch {
        continue;
      }
      const fm = parseFrontmatter(body);
      const created = unquote(fm["created"] ?? "");
      if (!DAY_RE.test(created)) continue; // no usable date ⇒ we cannot claim it's recent
      if (created < cutoff) continue; // ISO days compare lexicographically
      const title = unquote(fm["title"] ?? "") || humanise(name);
      const url = unquote(fm["source"] ?? "") || undefined;
      picks.push({ title, ...(url ? { url } : {}), path: name, created });
    }
    picks.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
    return picks.slice(0, PICKS_MAX);
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// BriefContent — the two functions this task actually delivers. Both pure: given the raw facts
// (already gathered by the caller — a schedule, in production; a fake in tests), decide
// whether there is anything to say and, if so, what belongs in it. Neither writes prose and
// neither touches Postgres, Gmail, or the calendar — that I/O lives in gatherOpenObligations /
// listTomorrowExternalMeetings / readIngestedPicks above, called by the schedules.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export interface BriefContent {
  /** Tomorrow's external meetings — evening only; always [] on the morning brief. */
  meetings: NightBeforeMeeting[];
  /** The obligations this brief covers — the evening's nightBefore bucket, or the morning's
   *  delta. Never the same threadId on both surfaces. */
  obligations: Obligation[];
  /** Notes that entered the Brain recently — morning only; always [] on the evening brief. */
  picks: IngestedPick[];
  /**
   * ORB-164 — TRUE when a source this brief normally reads could not be read at all this pass
   * (today: Slack; `gatherOpenObligations` catches a `deps.slack` failure and continues
   * Gmail-only). Not a count and not an error object: the ONE thing the prose has to convey is
   * that `obligations` above is a partial list, so a renderer can never accidentally present it
   * as the whole picture.
   *
   * This is the absent-vs-empty distinction `@lares/compose-contract`'s `absentBlockClause`
   * spells out, carried in data rather than hoped for in a prompt: an empty `obligations` with
   * this `false` is a fact obtained ("nothing is owed"); the same empty list with this `true` is
   * no information at all about the Slack half. On the first real morning after ORB-149 those
   * two rendered identically, and Bendik had no way to tell a whole source had dropped out.
   *
   * Optional so every existing construction site (the evening brief, every test literal) keeps
   * meaning exactly what it meant before: nothing was dropped.
   */
  slackUnavailable?: boolean;
  /**
   * ORB-139 — what on TODAY's calendar contradicts itself (`lib/calendar-conflicts.ts`).
   * Morning only; the evening brief never carries it.
   *
   * BY EXCEPTION and OPTIONAL, and the two go together: absent or empty both mean "nothing
   * rendered", so every existing construction site keeps meaning exactly what it meant. Unlike
   * `slackUnavailable`, absence here carries no claim in either direction — a caller that
   * never ran the pass and a pass that found nothing are the same silence, because a clash
   * list is not a source whose emptiness the prose ever asserts.
   *
   * LAR-59-s6 — `ResolvedConflict`, not the bare `CalendarConflict`: a row may carry the
   * optional `resolution` `lib/conflict-resolution.ts`'s bounded mailbox search attached. Every
   * existing construction site hands over plain `CalendarConflict[]` still, which is
   * structurally a `ResolvedConflict[]` with no row's `resolution` set — nothing about this
   * widening changes what an unresolved brief renders.
   */
  conflicts?: ResolvedConflict[];
  /**
   * ORB-180 — the open deadlines the brief names today (`mentionsToday`, applied by the
   * schedule), and the mails that look like due notices and have never been offered.
   *
   * Morning only; the evening brief never carries either. BY EXCEPTION and OPTIONAL, the ORB-139
   * `conflicts` pattern exactly: absent and empty both mean "nothing rendered", so every
   * existing construction site keeps meaning what it meant and a morning with no deadlines
   * renders byte-for-byte the brief this function returned before ORB-180.
   *
   * The two are NOT symmetric in what they earn (see `buildMorningBrief`): a due deadline makes
   * a brief happen, a candidate does not.
   */
  deadlines?: DeadlineLine[];
  deadlineCandidates?: CandidateLine[];
  /** Errors and warnings recorded by the spine since the previous morning brief. */
  signals?: SignalRow[];
}

export interface EveningBriefInput {
  /** Tomorrow's external meetings, already fetched (listTomorrowExternalMeetings). */
  meetings: NightBeforeMeeting[];
  /** ALL currently open obligations, already gathered (gatherOpenObligations) — this function
   *  itself decides which of them belong to tonight via assignSurfaces. */
  obligations: Obligation[];
}

/**
 * Tomorrow's external meetings, plus whatever is owed specifically to the people in them.
 * `null` when there is nothing to say — no meetings AND nothing owed to anyone tomorrow — and
 * a `null` return means the caller must send NOTHING, not an empty/negative brief.
 *
 * Stamping `night_before_delivered_day` (lib/obligations-store.ts's `markNightBeforeDelivered`)
 * is deliberately NOT done here: it must happen only after the schedule's send has actually
 * succeeded (mirroring the old system's `recordNightBeforeDelivery`, which never marks on an
 * unconfirmed send) — this function has no I/O and cannot know that. The returned content's
 * `obligations` list IS the exact set of threads "actually covered", for the caller to stamp.
 */
export function buildEveningBrief(input: EveningBriefInput): BriefContent | null {
  const participants = new Set(input.meetings.flatMap((m) => m.participants));
  const { nightBefore } = assignSurfaces(input.obligations, participants, new Map());

  if (input.meetings.length === 0 && nightBefore.length === 0) return null;

  return { meetings: input.meetings, obligations: nightBefore, picks: [] };
}

export interface MorningBriefInput {
  /** TODAY's commitments (listTodayMeetings) — the frame the rest hangs on. Unlike the
   *  obligations below these are NOT a delta: last night's prep is 12 hours old, and he asked
   *  for the morning to open with what's on his plate (2026-08-18). */
  meetings: NightBeforeMeeting[];
  /** ALL currently open obligations, already gathered (gatherOpenObligations). */
  obligations: Obligation[];
  /** Thread ids whose night-before message covered TODAY (lib/obligations-store.ts's
   *  `nightBeforeDelivered(nightBeforeCoveredDay-of-yesterday's-pass)`, i.e. what last night's
   *  20:00 pass actually told him about) — the only thing that may buy a thread's silence
   *  here. Threads NOT in this set are new or changed since last night and belong in the
   *  delta. */
  deliveredLastNight: ReadonlySet<string>;
  /** Notes that entered the Brain recently (readIngestedPicks). */
  picks: IngestedPick[];
  /** ORB-172 — Marcel's itinerary for TODAY (readBriefTravel), read BEFORE the null decision.
   *  A trip whose span covers `day` earns the brief even when everything above is empty: the
   *  ticket's founding case was a New York day with no meetings rendering as total silence.
   *  Optional so callers without travel wiring keep the exact pre-ORB-172 contract. */
  travel?: BriefTravel;
  /** ORB-164 — see `BriefContent.slackUnavailable`. Set by the schedule when its Slack
   *  obligation source failed or outran its budget and the gather continued Gmail-only. */
  slackUnavailable?: boolean;
  /** ORB-139 — today's clashes (`listTodayCalendar`). Passed straight through; they never
   *  make a brief happen on their own. A clash lives ON one of today's commitments, so a
   *  calendar with a clash on it is never a calendar with no meetings — making this earn the
   *  brief would add a case that cannot arise, and a case that cannot arise is a case no test
   *  can honestly cover.
   *
   *  LAR-59-s6 — `ResolvedConflict`, so a caller (the morning schedule) may pass rows that
   *  already went through `resolveConflicts`. See `BriefContent.conflicts` for what that
   *  widening does and does not change. */
  conflicts?: ResolvedConflict[];
  /**
   * ORB-180 — the open deadlines due today or on a mention day, already filtered by
   * `mentionsToday` against the OWNER's clock (this function has no clock and must never
   * re-derive one), and the unsurfaced due-notice candidates.
   *
   * A non-empty `deadlines` BREAKS THE SILENCE RULE below: a statutory due date is a reason to
   * send on a morning with nothing else on it, in the same way ORB-172's travel day is. A
   * candidate is not — an offer to record a deadline can wait for a morning that already has
   * something to say, and a brief that fired only to ask about a mail would be exactly the
   * "prove checking happened" output this file's header forbids.
   */
  deadlines?: DeadlineLine[];
  deadlineCandidates?: CandidateLine[];
  signals?: SignalRow[];
}

/**
 * What's on his plate today: TODAY's commitments, the obligation DELTA since last night's
 * pass, and recently-ingested picks. `null` only when all three are empty AND every source was
 * actually read (ORB-164 — see the `slackUnavailable` branch below) — a day with meetings is
 * never silent, even when nothing changed overnight.
 *
 * The obligations half is still strictly a delta (Bendik, 2026-08-18: "delta is of course
 * important if/when it happens"); the calendar half deliberately is not, because his day's
 * fixed points are the frame the rest hangs on and last night's prep is 12 hours stale by the
 * time he reads this.
 *
 * KNOWN LIMITATION (accepted, not a bug): this is a flat filter on `deliveredLastNight` — it
 * does not recompute against today's calendar, so it loses the old system's "a meeting was
 * cancelled overnight → resurface what was owed to that person immediately" behaviour. The
 * blast radius is bounded: `deliveredLastNight` is scoped per Oslo calendar day
 * (`obligations-store.ts`'s `nightBeforeDelivered`), so a still-open obligation reappears the
 * FOLLOWING morning regardless — a one-day delay on an item that was already ≥48h overdue, never
 * a permanent drop. Restoring the old behaviour would cost a second calendar read here for that
 * bounded, minor timeliness gain; ruled not worth it (Task 12 fix round).
 */
/**
 * ORB-172 — does travel earn the brief? TRUE only for a KNOWN trip whose inclusive span covers
 * the brief's day (`currentTravel`'s horizon reaches days ahead, so trips.length alone would
 * fire a week early). An `unavailable` store earns nothing: we do not KNOW he travels, and a
 * brief sent every morning a mount is sick would be noise wearing a safety argument — the
 * drop-notice line renders whenever a brief happens for real reasons, which is where that
 * failure belongs.
 */
export function travelCoversDay(travel: BriefTravel | undefined): boolean {
  if (!travel) return false;
  return travel.travel.trips.some((it) => it.trip.start <= travel.day && travel.day <= it.trip.end);
}

export function buildMorningBrief(input: MorningBriefInput): BriefContent | null {
  const obligations = input.obligations.filter((o) => !input.deliveredLastNight.has(o.threadId));

  // ORB-164 — a DROPPED SOURCE breaks the silence rule, deliberately. The `null` contract above
  // reads "all three are empty, so there is nothing to say"; that is a claim about what is on
  // his plate, and a pass whose Slack half never returned has not earned it. Staying silent
  // here would be the same lie the ticket was filed about — an unread source rendered
  // identically to a read-and-empty one — just at the outer edge instead of inside the prose.
  // So: absent ≠ empty, all the way up. A quiet morning with every source read is still silent.
  //
  // ORB-172 — and a TRAVEL day is not a quiet morning. `buildMorningBrief` used to return null
  // before travel was ever read, so a New York day with no meetings was total silence. A known
  // trip covering today earns the brief; the travel content itself rides the prompt's travel
  // block, which the schedule already builds.
  if (
    input.meetings.length === 0 &&
    obligations.length === 0 &&
    input.picks.length === 0 &&
    !input.slackUnavailable &&
    !travelCoversDay(input.travel) &&
    // ORB-180 — and a day with a statutory deadline on it is not a quiet morning either. Only
    // the DEADLINES count here: a candidate is an offer, not a due date, and an offer is never
    // urgent enough to be the sole reason a brief exists.
    (input.deadlines ?? []).length === 0
    && (input.signals ?? []).every((signal) => signal.severity === "info")
  ) {
    return null;
  }

  return {
    meetings: input.meetings,
    obligations,
    picks: input.picks,
    ...(input.slackUnavailable ? { slackUnavailable: true } : {}),
    // ORB-139 — omitted entirely when there is nothing to say, so a brief with no clashes is
    // byte-for-byte the brief this function returned before the radar existed.
    ...(input.conflicts && input.conflicts.length > 0 ? { conflicts: input.conflicts } : {}),
    // ORB-180 — the same pattern, for the same reason.
    ...(input.deadlines && input.deadlines.length > 0 ? { deadlines: input.deadlines } : {}),
    ...(input.deadlineCandidates && input.deadlineCandidates.length > 0
      ? { deadlineCandidates: input.deadlineCandidates }
      : {}),
    ...(input.signals && input.signals.length > 0 ? { signals: input.signals } : {}),
  };
}
