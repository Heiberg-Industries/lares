/**
 * The obligation radar's pure logic, its Gmail/Calendar adapters, and the two brief-content
 * builders: `buildEveningBrief` / `buildMorningBrief`.
 *
 * Obligations are reported BY EXCEPTION. A radar that re-told the same open item on several
 * surfaces (a morning brief, a night-before pass, a re-ping nudge), or asked about a proposal
 * the owner had already rejected, teaches the owner to skip it. The contract is narrow and
 * strict:
 *
 *   - Obligations are reported BY EXCEPTION. If nothing is owed, say nothing — no "nobody's
 *     waiting on a reply", no negative assurances. The radar speaks only when it caught
 *     something.
 *   - Evening (20:00) = tomorrow's PREP: tomorrow's commitments, plus whatever is owed to the
 *     people in them.
 *   - Morning (08:00) = today's PLATE, prioritised: today's commitments (not a delta — the
 *     frame the rest hangs on), plus the obligations that are new or changed since the evening
 *     pass (still strictly a delta). A delta-only morning brief never told the owner what the
 *     owner's day held, which is why the commitments are there.
 *   - Scheduled output exists to inform, not to prove checking happened.
 *
 * SPLIT OFF THE PIPELINE. The resolve → read → explain stage and the gather that
 * composes it (`gatherOpenObligations`, `GatherObligationsDeps`, `dropResolved`, and the
 * `RESOLUTION_*` constants) live in `lib/obligation-pipeline.ts`; the `withTimeout` helper
 * lives in `lib/timeout.ts`. Keeping them out of this file also avoids an ESM import cycle
 * between this file and `lib/obligation-resolution.ts`. The dependency runs ONE WAY:
 * `obligation-pipeline.ts` imports this file's scan and selection rule, and nothing here
 * imports it back.
 *
 * What this file holds, in clearly banded sections:
 *   - the thread and obligation types (`ThreadSnapshot`, `Obligation`);
 *   - candidate selection (`selectObligations`);
 *   - surface assignment (`assignSurfaces`, `nightBeforeCoveredDay`), which works on
 *     `Obligation[]`: it never reads `.reason`/`.promise`, so ranking plays no part in the rule;
 *   - `heldBackLine`. The re-ping cap is the proactivity gate's central escalation ceiling
 *     (3 per owner-day per door, in `@lares/agent-kit`'s `initiations` ledger), not a
 *     per-process count in this file;
 *   - the Gmail scan (`scanThreads`, `isAutomatedSender`) against the `lib/google.ts` client;
 *   - the calendar read, narrowed to the "tomorrow" case (`listExternalMeetings`): the morning
 *     brief's simpler delta rule (see `buildMorningBrief` below) never needs a "today" read for
 *     participant-matching suppression;
 *   - `readIngestedPicks`, with a five-line `parseFrontmatter` copied here rather than
 *     importing an unrelated module for it.
 *
 * RANKING IS OFF, entirely, for every surface: ranking has no business deciding what
 * interrupts, so no model call is spent on it. `selectObligations` returns most-overdue-first,
 * which is the only ordering anything here needs. No message body is ever retained in memory
 * beyond a single tick, and none is ever persisted (`sql/001_baseline.sql`'s own banner).
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: write prose. `BriefContent` carries raw facts —
 * meetings, obligations, picks — never a pre-written sentence. The schedules
 * (`agent/schedules/evening-brief.ts` etc.) hand those facts to a resumed agent turn along with
 * the tone rule ("write to inform, not to prove checking happened; never state that nothing is
 * outstanding"), and the turn composes what the owner actually reads.
 *
 * ONE EXCEPTION, named rather than left to be noticed: `heldBackLine` returns a finished
 * sentence, in the caller's chosen language. It is not brief CONTENT — it is a
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
} from "./calendar-conflicts.js";
import type { ResolvedConflict } from "./conflict-resolution.js";
import type { CalendarEvent } from "./google.js";
import type { ThreadMessage } from "./google.js";
import { dateIn, homeDate } from "./recurrence.js";
import { standingFactLine, type StandingFact } from "./standing-facts.js";
import type { BriefLanguage } from "./brief-settings.js";
import { BRIEF_STRINGS } from "./brief-strings.js";
import { homeTzFromEnv } from "@lares/agent-kit/owner-clock";
import { labeledContext } from "@lares/compose-contract";
import type { DeadlineSource } from "@lares/agent-kit/deadlines";
import type { SignalRow } from "@lares/agent-kit/signals-client";

/**
 * The address inside "Per Hansen <per@partner.example>", lowercased. A local copy of
 * `lib/person-sources.ts`'s `addressOf` rather than an import of it — that module pulls in
 * Twenty/network clients this file (and its tests) have no reason to depend on for a
 * three-line string helper.
 */
export function addressOf(header: string): string {
  const m = /<([^>]+)>/.exec(header);
  return (m?.[1] ?? header).trim().toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * One thread reduced to the facts the rule needs — deliberately NOT the messages.
 *
 * Everything here is structural: who spoke last, how many of their messages went unanswered,
 * whether the owner was addressed. None of it requires reading a word of content, which is what lets
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
  /** The owner was in To:, not merely Cc:. Being copied is not being asked. */
  addressedToHim: boolean;
  /** A list, a no-reply@, a notification. */
  isAutomated: boolean;
  /**
   * Workstream B — institutional DUE-NOTICE mail (`isInstitutionalDueNotice`): a VAT
   * reminder from an accounting system, a letter from the tax office, an invoice that falls due. Nobody behind
   * one of these is waiting for a reply, so `selectObligations` drops it; the morning brief
   * offers it ONCE as a deadline candidate instead (`deadlinesBlock`) and then goes quiet.
   *
   * OPTIONAL, and absent means "not one": every existing snapshot literal, and every Slack
   * snapshot (a Slack DM is a person, never an institution), keeps meaning exactly what it meant.
   */
  isDeadlineCandidate?: boolean;
  /** How many of their messages sit unanswered at the end of the thread. ≥2 is a re-ping. */
  theirUnansweredCount: number;
  /** Set when the owner has said "handled" — the item is closed for good. */
  dismissedAt?: Date;
  /**
   * IN FLIGHT ONLY — the counterparty's last message, trimmed to
   * `LAST_MESSAGE_MAX_CHARS`. Feeds the bounded model read and the reason line.
   * Never persisted — `lib/obligations-store.ts`'s `upsertSeen` writes pointer columns only and
   * has no column for this.
   */
  lastMessageText?: string;
  /** Every address this counterparty is known by, for the cross-channel resolution
   *  ("did the owner answer them on email / calendar / Slack / iMessage after their message?"). */
  counterpartyEmails?: string[];
  counterpartySlackUserId?: string;
  /** Set by each scanner (`scanThreads` / the Slack builders) — never inferred from the
   *  threadId's prefix, so a caller never has to re-derive what the source already knows. */
  source: "gmail" | "slack";
}

/** The counterparty's last message, in flight, is trimmed to this many characters before it
 *  ever reaches an `Obligation` — bounding both the model read and the log/prompt
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
   *  the only thing in this system permitted to interrupt the owner. */
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
  /** Why it is on the list, in words — rendered on every brief line. Set by the explain step. */
  reason?: string;
}

export interface CandidateOptions {
  owedAfterHours?: number;
  rePingAfterHours?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Candidate selection
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
    if (t.dismissedAt) continue;              // the owner has closed it; it does not come back
    if (!t.lastSpeakerIsThem) continue;       // the owner spoke last — the ball is not the owner's
    if (t.isAutomated) continue;              // a list is not a person waiting
    // Workstream B — a due notice is a DEADLINE, not an owed reply. Nobody at the sender is
    // waiting for the owner to write back; the brief offers it once as a candidate and stops.
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
  // which is exactly the one the owner has stopped seeing.
  return out.sort((a, b) => b.ageHours - a.ageHours);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Surfaces. `assignSurfaces` works on Obligation[] (ranking is off — see the module header).
// ═══════════════════════════════════════════════════════════════════════════════════════════

export interface SurfaceAssignment {
  nightBefore: Obligation[];
  brief: Obligation[];
  interrupt: Obligation[];
}

/**
 * Membership is decided BY RULE: an obligation owed to someone the owner is meeting tomorrow belongs
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
   * thread id → the unanswered count that was true when this thread last nudged the owner. A MAP
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

    // `>` not `>=`: an unchanged count is the SAME bump the owner was already told about. A count that
    // has GROWN is new information — they asked again after being told.
    const announcedAt = alreadyAnnounced.get(o.threadId);
    if (o.isRePing && (announcedAt === undefined || o.unansweredCount > announcedAt)) interrupt.push(o);
  }

  return { nightBefore, brief, interrupt };
}

/**
 * The calendar day an evening pass running at `now` is ABOUT — always tomorrow, on the owner's
 * clock (`tz`). Used both to decide which day's meetings count as "tomorrow" and to stamp
 * `night_before_delivered_day`, so the two can never drift apart.
 *
 * this was the home clock's tomorrow. At 20:00 in New York it is already past midnight
 * at home, so the pass prepared the owner for the day AFTER tomorrow and stamped that day too. The
 * morning pass reads the stamp back as `dateIn(now, tz)` — ITS today on the same owner clock —
 * and the two must move together: a stamp written on one clock and read on the other matches
 * nothing, which repeats last night's obligations (the safe direction, but a repeat).
 *
 * If the owner's clock CHANGES between the evening and the next morning, the two dates still
 * agree in every ordinary case (the morning after is the day after, on either clock). The one
 * exception is a jump so far east that the owner's next 08:00 falls two dates on (an evening in Los
 * Angeles, the next morning in Auckland): the stamp then names a day no morning pass asks for,
 * nothing is left out, and that brief repeats what the evening covered. A duplicate mention,
 * never a silent omission — the direction this file always picks.
 *
 * `tz` defaults to {@link homeTzFromEnv}, so a caller with no owner clock gets the home day
 * exactly as before.
 */
export function nightBeforeCoveredDay(now: Date, tz: string = homeTzFromEnv()): string {
  return dateIn(new Date(now.getTime() + 24 * 3600_000), tz);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Held back — what the gate kept from the owner since the last brief
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * REPLACES the local re-ping budget that used to live in this band. That cap was one lane's
 * private, in-memory, per-process count of one kind of message; the proactivity gate in
 * `@lares/agent-kit` now holds the ceiling in its ledger, where it is durable, shared across
 * every lane and door, and visible on the console. A per-lane copy beside it could only ever
 * disagree with it.
 *
 * What the brief owes the owner in exchange is this one line: the gate is allowed to stay quiet, but
 * it is never allowed to be SILENT about having done so. `deferredSince` counts each held item
 * once per door, however many ticks reconsidered it, so this line says "3 things are waiting",
 * not "480 deferrals were logged".
 *
 * Pure — it is rendered into the brief's context, not spoken by the model. `lang` is required:
 * every caller must say which language it wants, rather than this file assuming
 * Norwegian. Returns `null` when nothing is held back, which is what keeps a normal day's prompt
 * byte-identical to what it was before the held-back line existed.
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
 *  door this function has never heard of is still a door the owner was not reached on. */
function doorLabel(door: string): string {
  const kind = door.split(":")[0] ?? door;
  if (kind === "slack") return "Slack";
  if (kind === "telegram") return "Telegram";
  return kind;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Gmail scan source. Real performance engineering: the obvious shape (1 list + 1 messages.get
// PER candidate + 1 threads.get per thread SEQUENTIALLY) reliably timed out against a real
// 60-day inbox and — worse — was wrong before it was slow, since 200 newest-first messages
// out of 60 days is roughly the last week. This is N list pages (paged to the END, throwing
// rather than truncating) + exactly ONE threads.get per unique candidate thread, at bounded
// concurrency.
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

// ─── Institutional due-notice mail ───────────────────────────────────
//
// THE MISFILING THIS PREVENTS: an accounting system's VAT reminder rode the
// morning brief as an OWED REPLY, in the list of people waiting on the owner. Nobody there is waiting on
// anything. The mail is a DUE NOTICE — a date with a consequence — and the only honest thing to
// do with it is to offer it once as a deadline candidate and then be quiet.
//
// The rule has two arms and they are deliberately unequal in strength:
//
//   1. THE DOMAIN. Mail from the tax authority, the register or the accounting system is a due
//      notice whatever the subject says and however it was sent — a caseworker typing by hand
//      from the authority's domain is still the state writing to a company, not a person waiting for
//      a reply. Subdomains count (`mail.sender.example`), lookalikes do not (`notsender.example`), which is
//      why this is a suffix match on a dot and never a bare `includes`.
//   2. THE SHAPE, and only for mail that is ALREADY automated. An automated sender, a due word,
//      and a date token together are a due notice off the list too — the invoicing services and
//      municipal systems nobody can enumerate in advance. All three are required: an automated
//      newsletter titled "Fristen nærmer seg" carries a due word and no date, and is a
//      newsletter.
//
// THE OTHER DIRECTION IS THE ONE THAT COSTS THE OWNER SOMETHING, so it is named here rather than left
// to be inferred: a PERSON writing "Frist for tilbud 15. mai?" from a company domain is not a
// due notice, whatever the subject says. The automated-sender precondition on arm 2 is the whole
// guard — without it, every human who ever wrote the word "frist" with a date would fall off the
// radar silently, which is a far worse failure than the one this rule was filed for.

/**
 * The senders whose mail is a due notice on the strength of WHO SENT IT: the installation's tax
 * authority, company register and accounting systems. Installation data, never engine code:
 * `INSTITUTIONAL_SENDER_DOMAINS` is a JSON array of domains (`["authority.example"]`). Unset or
 * invalid means none, and only the shape arm below applies.
 */
export function institutionalDomains(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  const raw = env["INSTITUTIONAL_SENDER_DOMAINS"];
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((d) => typeof d === "string")) throw new Error("not an array of strings");
    return new Set(parsed.map((d) => (d as string).trim().toLowerCase().replace(/^@/, "")).filter((d) => d !== ""));
  } catch (e) {
    console.warn(`INSTITUTIONAL_SENDER_DOMAINS is not a JSON array of domains (${(e as Error).message}); none are configured`);
    return new Set();
  }
}

/** A subject that says something falls due. Norwegian first, `due` for the English-language
 *  systems; `betalingspåminnelse` is listed separately because `\b` cannot find a boundary in
 *  front of the `p` inside a compound. */
export const DUE_WORDS = /\b(frist|fristen|forfall|forfaller|forfalt|due|påminnelse|purring|betalingspåminnelse|innen)\b/iu;

/** A date in the subject — `31.08`, `31/08/2026`, `31. aug`. A due word with no date is a
 *  sentiment, not a deadline, and the ONLY thing keeping "Fristen nærmer seg" out. */
export const DATE_TOKEN = /(\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b|\b\d{1,2}\.?\s*(jan|feb|mar|apr|mai|jun|jul|aug|sep|okt|nov|des)\w*)/iu;

export function isInstitutionalDueNotice(from: string, subject: string, headers: Record<string, string>): boolean {
  const domain = addressOf(from).split("@")[1] ?? "";
  for (const known of institutionalDomains()) {
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
  // thread only becomes a candidate through an inbound message, so removing the owner's own outbound
  // mail cannot drop a thread.
  const threadIds = await deps.searchThreadIds(
    `in:inbox -from:me newer_than:${windowDays}d`,
    opts.ceiling ?? CANDIDATE_SCAN_CEILING,
  );

  // ONE fetch per unique thread, bounded. A Google-generated RSVP is sent FROM the attendee's
  // real address, so drop it before counting or "Accepted: Pilot" becomes an unanswered
  // message the owner supposedly owes a reply to.
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
      // Workstream B — read off the LAST message, the same one every other flag on this
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
// Tomorrow's external meetings. Only the "tomorrow" case is read: a "today" read would exist
// solely to feed participant-matching suppression in the morning brief, and buildMorningBrief
// below uses a simpler delta rule (the night_before_delivered_day stamp alone) and never needs it.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export interface NightBeforeMeeting {
  title: string;
  startsAt: Date;
  participants: string[];
  /** An all-day block. `startsAt` is then only a DAY — never render a clock time from it. */
  allDay?: boolean;
  /** Where, when the event says so. Part of why an attendee-less block counts. */
  location?: string;
  /**
   * When it ENDS. Absent in two cases, both deliberate: the event
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
  /** what KIND of thing this is. Decides whether it may be rendered as a commitment
   *  at all, and both briefs read it the same way (see `commitmentLine` / `travelContextLine`
   *  below, which are shared precisely so the two can never drift). */
  kind: EventKind;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// event KINDS.
//
// Without event kinds, a brief could say "you're based at Hotel A all day" off an
// all-day hotel reservation, and call a venue-less 16:30 intro call a "hard clash" with a
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
  /** A place the owner SLEEPS. Never presence: check-in is usually late evening. */
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
  // ONE kind covers two different eventTypes (`outOfOffice` and
  // `workingLocation`), and a working location is a statement about where the owner IS, not an
  // absence. The label therefore names both rather than asserting the wrong one of them; the
  // part that matters downstream — not a commitment — is true of either.
  "out-of-office": "out of office or a working-location marker — not a commitment",
};

/**
 * Gmail writes these titles itself and they are strikingly regular — verified against the owner's
 * real calendar: "Stay at Hotel A", "Stay at Hotel B",
 * "Flight to City A (XX 100)", "Flight to City B (XX 200)", "Reservation at Restaurant A".
 *
 * TRANSPORT is tested FIRST so "Flight to Hotel A" is a journey rather than a bed.
 *
 * NOTE — a deliberate departure from acceptance criteria, which listed the bare word
 * "reservation" as a lodging pattern: the real calendar's one "Reservation at …" row is a
 * RESTAURANT booking, a place the owner actually goes. Calling that lodging would assert the owner sleeps
 * there. So lodging keys off stay/hotel words, and "Reservation at Hotel B" still
 * lands as lodging via "hotel" while the restaurant stays an ordinary commitment.
 */
const TRANSPORT_TITLE = /\b(flight|flights|flyv|avreise|departure|boarding|train|tog|rail|jernbane|ferry|ferge|bus)\b/i;
const LODGING_TITLE = /\b(stay at|hotel|hotell|motel|motell|hostel|resort|airbnb|lodging|overnatting|guest ?house|check[-\s]?in|innsjekk)\b/i;

/** A link is not a place. Google puts Meet/Zoom/Teams URLs in `location` often enough that
 *  treating one as a venue is how a remote call becomes somewhere the owner has to travel to. */
const LINK_LOCATION = /^https?:\/\//i;
const CONFERENCE_HOST = /(meet\.google\.com|zoom\.us|teams\.microsoft\.com|whereby\.com|meet\.jit\.si)/i;

/** The facts classification is allowed to use. Nothing here is fetched or inferred — the
 *  caller passes what the API said. */
export interface ClassifiableEvent {
  summary?: string;
  /** Google's `eventType`, verbatim (`lib/google.ts`'s `CalendarEvent.eventType`). */
  eventType?: string;
  location?: string;
  /** People on the invitation OTHER than the owner — the brief's own `participants`, not the raw
   *  attendee list. An event whose only attendee is the owner is a block, not a call. */
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

  // Gmail-created: a booking confirmation, not something the owner was invited to. The title only
  // picks WHICH kind of travel context it is; anything that is neither a stay nor a journey
  // falls through to the ordinary rules below (a restaurant booking with a venue is a place the owner
  // really goes).
  if (type === "fromgmail") {
    const title = e.summary ?? "";
    if (TRANSPORT_TITLE.test(title)) return "transport";
    if (LODGING_TITLE.test(title)) return "lodging";
  }

  // A VENUE YOU CAN BE AT OUTRANKS A LINK YOU CAN JOIN.
  //
  // A rule that treated "attendees and (no location or a conference link)" as remote-call made
  // the link decisive. Google Workspace adds a Meet link to nearly every invitation by
  // default, so a board meeting at a counterpart's office came out announced as "not somewhere
  // the owner must be" — the same defect inverted, and worse: the opposite error at least erred
  // toward telling the owner about a place.
  //
  // So the venue is checked FIRST and unconditionally. A conference link now only matters when
  // there is nowhere to go, which also makes `remote-call ⇒ no venue` an invariant the render
  // and the prompt clause can both rely on.
  const venue = venueOf(e.location);
  if (venue !== "") return "in-person";
  if ((e.participants?.length ?? 0) > 0 || e.hasConferenceLink === true) return "remote-call";
  return "block";
}

/** The owner's wall-clock time in `tz`. An all-day
 *  block never reaches this — its instant is a UTC midnight, which would render as a
 *  meaningless 02:00. */
function wallTime(d: Date, tz: string): string {
  return d.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
}

/**
 * One commitment row, shared by BOTH briefs (a shared function is the only way "both briefs
 * must agree" survives the next edit).
 *
 * Three things the row is careful about:
 *  - it prints the SPAN, not just a start  — an overlap the model
 *    states should come from the two end points, not from a guess at how long things run;
 *  - a `remote-call` renders "(remote)" and nothing else, which is now literally true:
 *    classification gives that kind only when no venue survived `venueOf`;
 *  - an in-person meeting that ALSO carries a join link says so, so the link is visible
 *    without ever being mistaken for the venue's absence.
 *
 * `tz` is required: every caller says which clock to read, rather than this file
 * assuming a fixed zone such as Europe/Berlin.
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
 * only "attendee" is the owner, and printing it invites the model to treat a reservation as a
 * meeting. And the time never LEADS the row as `all day — <title>` — that exact phrasing
 * (`morning-brief.ts` as it stood) is what produced "you're based at Hotel A
 * Airport all day" from a booking whose check-in was that evening. An all-day entry says so as
 * a property of the entry, at the end, where it cannot be read as occupancy.
 *
 * `tz` is required, same reason as `commitmentLine` beside it.
 */
export function travelContextLine(m: NightBeforeMeeting, tz: string): string {
  const when = m.allDay
    ? "an all-day entry, no clock time on it"
    : m.endsAt ? `${wallTime(m.startsAt, tz)}–${wallTime(m.endsAt, tz)}` : `from ${wallTime(m.startsAt, tz)}`;
  const where = m.location ? ` (${m.location})` : "";
  return `- ${m.title}${where} [${TRAVEL_CONTEXT_LABEL[m.kind] ?? m.kind}; ${when}]`;
}

/** Today's/tomorrow's rows split into what the owner must BE at and what merely frames the day. */
export function splitCommitments(meetings: readonly NightBeforeMeeting[]): {
  commitments: NightBeforeMeeting[];
  travel: NightBeforeMeeting[];
} {
  return {
    commitments: meetings.filter((m) => !isTravelContext(m.kind)),
    travel: meetings.filter((m) => isTravelContext(m.kind)),
  };
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * The "Travel context" labeled block, or "" when there is none — `labeledContext` drops an
 * empty block rather than rendering a heading over nothing (@lares/compose-contract). The rows
 * come from the calendar alone: lodging, transport and out-of-office entries.
 *
 * `tz` defaults to {@link homeTzFromEnv}; every real caller
 * (`buildMorningPrompt`/`buildEveningPrompt`) passes the owner's actual clock explicitly.
 */
export function travelContextBlock(
  travel: readonly NightBeforeMeeting[],
  tz: string = homeTzFromEnv(),
): string {
  return labeledContext([{
    label: "Travel context",
    note: "where he sleeps or moves, never where he is now",
    content: travel.map((m) => travelContextLine(m, tz)).join("\n"),
    thirdParty: true,
  }]);
}

/** The one sentence the travel-context block needs beside it, and the one a remote call needs.
 *  Returned as lines so a prompt can splice them in only when they apply. */
export function eventKindClauses(
  commitments: readonly NightBeforeMeeting[],
  travel: readonly NightBeforeMeeting[],
): string[] {
  const lines: string[] = [];
  if (travel.length > 0) {
    // The Travel context block is anchored to the day this brief covers, which at 20:00 is
    // TOMORROW. A hotel booking or a flight is a reservation, never evidence of where the owner is.
    lines.push(
      "The Travel context block in this brief is where he sleeps or moves, never where he is now —",
      "a hotel booking or a flight in it is not evidence of his whereabouts, so never say he is",
      "based at, at, or in any of it.",
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
// the brief may state a REAL departure
//
// A morning brief, about a 17:00 in another town: "trains from the home city run roughly
// hourly, about 1h40". Unverifiable, and useless for the only question the owner had — WHICH
// departure gets the owner there. `agent-kit__transit_plan` (Entur, granted `transit: read`) answers
// it with a real time, a real platform and a real arrival, and supports arrive-by, which is
// what makes "be in the other town by 17:00" a question at all rather than a duration.
//
// WHAT THIS CODE OWNS AND WHAT IT DELEGATES, and the split is deliberate:
//
//   - The KINDS that could ever need a departure are deterministic, so they are decided here.
//     A remote call has no venue by construction (`classifyEvent`) and a travel-context
//     row is not somewhere the owner must get to — neither can reach the tool at all.
//   - The ARRIVE-BY instant is computed here too, as ISO-8601 with the real UTC offset. eve
//     injects no date (`@lares/agent-kit`'s `clock.ts` header records what two wrong reminders
//     cost), so a model asked to build that string is guessing at both the date and whether
//     the zone is currently on summer or winter time.
//   - Whether the venue is in a DIFFERENT TOWN is NOT decided here, because it cannot be. The
//     17:00's `location` is the bare string "Fjord Kommunikasjon" — no town in it anywhere. A
//     string comparison against a hardcoded home town would answer "unknown" on the very row
//     the row this exists for. The tool's own result names the resolved locality, so the
//     grounded way to learn the town is to ask it; the clause says so.
//
// NO NEW BILLED CALL. This is text spliced into a prompt the brief already sends — one tool
// call inside an existing turn, on demand, never a poll and never a second composition.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** The owner's wall-clock instant, in `tz`, as ISO-8601 WITH offset — the shape `transit_plan`
 *  requires.
 *
 *  The offset is MEASURED (`tz`'s wall clock read back against the UTC instant), never assumed:
 *  most zones  are one offset half the year and another the other half, and an
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
 *    midnight — rendering a clock time from one is the lesson, and doing so here would
 *    send the owner to a station for an 02:00 that does not exist.
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
 * The two sentences that must reach the model whatever the day looks like.
 *
 * The first cut returned `[]` when no commitment qualified for a lookup, which dropped the
 * PROHIBITION along with the instruction. An all-day in-person row is excluded from
 * `transitCandidates` for a good reason (no instant to arrive by) and still puts an out-of-town
 * venue in front of the model with no transport rule attached — which is precisely the
 * out-of-town-venue regression, arriving through the door the fix left open.
 *
 * So the ban is unconditional in both briefs, on every day, candidates or none. It deliberately
 * does NOT name the tool: naming it here would make "the tool is instructed" true of a day of
 * remote calls, and a prohibition is not an instruction to use anything.
 *
 * The tool has THREE non-answers, not two. `{notFound: {query}}` (a place
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
 * What to do when the origin is not knowable, which is the NORMAL case.
 *
 * Nothing in the prompt, the persona or `agent.json` grounds where the owner is. `to` is grounded
 * (the calendar's own venue string, which the geocoder either resolves or refuses) and
 * `arriveBy` is computed here — `from` is the one input the model supplies from nothing.
 *
 * Get it wrong and the tool still returns a REAL departure, with a real platform, from a place
 * the owner is not: "14:05 from Central Station, platform 3" while the owner is somewhere else. An address-resolved origin
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
 * is not a read that came back empty, and neither licenses saying anything. set the
 * precedent for lifting the contract's wording into a brief's own clause rather than editing
 * the contract — the invariant clauses stay byte-stable.
 *
 * `day` exists because the evening pass composes at 20:00 about TOMORROW.
 * "Where the owner already is" is true in the morning and false the night the owner is in another town for a
 * meeting there tomorrow: read against a model's home-city default it plans a 06:12 the owner is 460 km
 * from. The lodging ban (correctly) removes the one row that hinted otherwise, so the evening
 * text has to say plainly that tonight's town is not tomorrow's answer.
 */
export function transitClause(
  commitments: readonly NightBeforeMeeting[],
  travel: readonly NightBeforeMeeting[],
  day: BriefDay,
  // defaults to the home zone; both live callers pass the owner's actual clock.
  tz: string = homeTzFromEnv(),
  // `transit` is an optional capability (off in the neutral default): the live callers pass
  // whether the agent holds it. Without the tool there is no lookup to instruct, only the ban.
  transitGranted = true,
): string[] {
  const candidates = transitGranted ? transitCandidates(commitments) : [];
  if (candidates.length === 0) return [...TRANSIT_BAN];

  const today = day === "today";
  return [
    "Getting there — these commitments have a real venue and a time he has to be at it:",
    // The venue is free text off Google Calendar and may carry a newline;
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
            ", and nothing in this brief establishes it.",
          "",
        ]),
    // A CALENDAR lodging row is not presence: a reservation on the calendar says a
    // booking exists, nothing more, and it is exactly what produced "you're based at Hotel A
    // Airport all day". Gated on an actual LODGING row, not on travel context generally: `travel`
    // also carries flights and out-of-office markers, and a day with only a flight was printing a
    // warning about a hotel that is not there.
    ...(travel.some((m) => m.kind === "lodging")
      ? [
          "A lodging row from the CALENDAR is not evidence of where he is, so never pass a",
          "calendar lodging row as the journey's origin.",
          "",
        ]
      : []),
    ...ORIGIN_HONESTY,
    ...TRANSIT_BAN,
  ];
}

/**
 * The labelled standing-facts block, or "" when the owner has told the agent nothing.
 *
 * A sibling of `travelContextBlock` and shared by both briefs for the same reason: the two read
 * the same facts, so they must render them the same way. `labeledContext` drops the block when
 * it is empty (@lares/compose-contract) — no `emptyText`, deliberately: an absent block here
 * carries no meaning worth stating, and "(none)" would invite the agent to remark on having no memory.
 *
 * These already reach the agent through `agent/instructions/standing-facts.ts`, once per session,
 * brief turns included. They are repeated here as a LABELED block because a brief is
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
 * the ONE thing both briefs must be told about a `person_lookup` that comes back with
 * no record of the PERSON.
 *
 * Without this, the brief would say of a 16:30 intro call: "first contact, no prior
 * history — worth a quick look at Bridgeco if you want a steer going in." Bridgeco is a customer
 * organisation the owner knows well; a dossier with no
 * organisation half, so the only honest thing the agent could say about the company was nothing. Now
 * that the dossier HAS one, the agent still needs telling that an unknown person and an unknown company
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
    //  "memory" and the "What the owner has told me" block are two different
    // things, and this same prompt carries both. Without this sentence a literal reader takes
    // "never fill the gap from memory" as an instruction to suppress the owner's standing facts when
    // writing about a company, which is the opposite of what either clause asks for.
    "\"Memory\" there means your own recollection of the company. His standing facts are not that:",
    "they are his own words, and they apply here like everywhere else.",
    "",
  ];
}

export interface CalendarSourceDeps {
  listEvents(o: { timeMin: string; timeMax: string; max: number }): Promise<CalendarEvent[]>;
  /** Every address the owner owns — comparison against attendees is done lowercased. */
  myAddresses(): Promise<string[]>;
}

// The real client clamps `max` to 250 internally — pass its ceiling directly.
const MEETINGS_MAX = 250;

// Wide on purpose: a naive "UTC midnight" guess at tomorrow's bounds lands hours off the owner's
// true midnight, by a different amount in every zone and season. Fetching generously and
// filtering by CALENDAR DATE on the owner's clock sidesteps the guess entirely — at a 20:00
// pass "tomorrow" is the 4th to the 28th hour from now wherever the owner is, well inside 48.
const FETCH_WINDOW_MS = 48 * 3600_000;

/** A block this short with nobody else on it, no location and no all-day span is a personal
 *  marker (a buffer, a reminder-shaped hold), not something to prepare the owner for. */
const COMMITMENT_MIN_MINUTES = 60;

/**
 * Tomorrow's real commitments — tomorrow on the owner's clock, `tz` (see
 * {@link nightBeforeCoveredDay}).
 *
 * the rule was ONCE "has an attendee outside the owner's own addresses", and that silence
 * cost a three-hour meeting: the meeting at a venue, copied in from another calendar, carrying no
 * attendee list at all. Attendee metadata turns out to be the exception in the owner's calendar, not
 * the rule — the owner blocks working time deliberately, and copied/forwarded invitations arrive
 * bare. So an event counts when ANY of these is true:
 *
 *   - someone outside the owner's own addresses is on it   (the original rule, still the strongest)
 *   - it is an all-day block                       (a travel day IS the day)
 *   - it names a location                          (the owner is going somewhere)
 *   - it runs an hour or longer                    (the owner set aside real time for it)
 *
 * A missed meeting is far worse than an extra line in a brief, so the tie goes to including.
 * What stays out is the short attendee-less hold with no place attached.
 *
 * THROWS on a read failure, on a truncated window, or when the identity registry cannot say
 * which addresses are the owner's — never returns `[]` for any of those. `[]` renders as "nothing on
 * tomorrow", a claim the owner's day has not earned from a failed or untrustworthy read.
 */
export async function listTomorrowMeetings(
  deps: CalendarSourceDeps, now: Date, tz: string = homeTzFromEnv(),
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
 * Today's commitments, today on the owner's clock `tz` — same rule as
 * `listTomorrowMeetings`, different day.
 *
 * The morning brief was a pure delta and said nothing about the owner's day (the owner wanted the
 * brief to say what is on the owner's plate that day). Repeating what last night's prep
 * covered is DELIBERATE here — at 08:00 the day's fixed points are the frame everything else
 * hangs on, and the evening pass is 12 hours old.
 */
export async function listTodayMeetings(
  deps: CalendarSourceDeps, now: Date, tz: string = homeTzFromEnv(),
): Promise<NightBeforeMeeting[]> {
  return listMeetingsOn(
    deps, dateIn(now, tz), new Date(now.getTime() - TODAY_LOOKBACK_MS), new Date(now.getTime() + FETCH_WINDOW_MS), tz,
  );
}

/**
 * The window's events plus the owner's own addresses — the I/O half of a calendar pass, split out
 * so the SAME read can feed both the day's rows and the conflict pass without
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
 * never showed before — `lib/calendar-conflicts.ts`'s `isDateOnly` records the same trap.
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
  // within itself, so a 09:00 call on one account would otherwise print after a 17:00 block on the other.
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
      // classified HERE, once, off `participants` rather than the raw attendee list:
      // an event whose only "attendee" is the owner (every Gmail-created booking is) must not
      // read as a call. Nothing is filtered out at this point; the renderers decide what may
      // be shown as a commitment.
      kind: classifyEvent({
        summary: e.summary, eventType: e.eventType, location, participants,
        ...(e.hasConferenceLink === true ? { hasConferenceLink: true } : {}),
      }),
      ...(e.allDay === true ? { allDay: true as const } : {}),
      ...(location !== "" ? { location } : {}),
      // The end was computed above for the duration floor and thrown
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
// the conflict pass, on the calendar read the brief already makes.
//
// The chief of staff once caught two overlapping hotel bookings and a status meeting that landed
// at 06:00 where the owner actually was — unprompted, off no code at all. The model happened to
// notice. `lib/calendar-conflicts.ts` is the deterministic version of that noticing; this is
// where the morning brief runs it.
//
// TWO DELIBERATE CHOICES:
//
//  1. **The SAME read, not a second one.** `readCalendarWindow` is fetched once and feeds both
//     the day's rows and the conflict pass. A second fan-out would double the brief's calendar
//     cost, and — worse — could disagree with the first one about what is on the owner's day.
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

/**
 * TODAY's commitments AND today's clashes, off one calendar read — today on the owner's clock,
 * `opts.tz` (omitted, the home clock, exactly as before).
 *
 * Identical to {@link listTodayMeetings} in what it fetches, what it throws and what rows it
 * returns — the conflict list is added beside them, never instead of them.
 *
 * ONE `today` for both halves, so a brief never lists one day's meetings beside another day's
 * clashes. The radar is handed the owner's clock as `dayTimezone`, so it decides which
 * day an event is on the way the meetings do; its timezone-trap class still reads "home" as home.
 */
export async function listTodayCalendar(
  deps: CalendarSourceDeps, now: Date, opts: { tz?: string } = {},
): Promise<DayCalendar> {
  const tz = opts.tz ?? homeTzFromEnv();
  const from = new Date(now.getTime() - TODAY_LOOKBACK_MS);
  const to = new Date(now.getTime() + FETCH_WINDOW_MS);
  const { events, mine } = await readCalendarWindow(deps, from, to);
  const today = dateIn(now, tz);
  return {
    meetings: meetingsFromEvents(events, today, mine, tz),
    conflicts: detectCalendarConflicts(events, {
      days: [today],
      dayTimezone: tz,
    }),
  };
}

/** At most this many clash lines reach a brief. The radar can find more; a morning message
 *  that opens with six of them is a wall, and the ones past the third are the ones the owner would
 *  have skipped anyway. The block says plainly when it is holding some back. */
export const CONFLICT_LINES_MAX = 3;

/** One clash, as the brief states it: what kind, and the radar's own sentence.
 *
 * when `c.resolution.strength === "strong"`, the line appends the evidence
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
 * that reports its own silence every morning is the fastest way to teach the owner to skip the
 * block on the morning it has something.
 *
 * The note names what the rows are AND what they are not. the plain
 * "nothing here has been resolved, checked against mail, or acted on" wording is now only
 * true of a pass that found no evidence, and that is EXACTLY the case that keeps rendering it —
 * `hasEvidence` here means "at least one shown row already carries a resolution", never
 * "a search ran". A pass with no evidence anywhere is byte-identical to one without any evidence feature, note
 * included; only once a row actually carries the mail's own sentence does the wording — and the
 * `thirdParty` flag below — change with it.
 *
 * `thirdParty: true` is always set: a clash row carries calendar titles (and, with evidence, a
 * mail's own sender/date/subject), all of it attacker-controllable words, so the block carries
 * `THIRD_PARTY_NOTICE` (`@lares/compose-contract`) directly under its heading, per the
 * in-turn taint rule of the origin model.
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
      thirdParty: true,
    },
  ]);
}

/** The ONE sentence that tells the agent what to do with the block above — and only when there is a
 *  block. Same shape and same reason as `standingFactsClause`: the block states the facts, the
 *  clause says the agent must pass them on rather than quietly reasoning about them.
 *
 * A row with no evidence keeps this clause unchanged: no deciding,
 * no mail, no offering. When at least one row already carries a strong resolution, ONE extra
 * sentence is appended (never a rewrite of the three lines above it) that truthfully narrows
 * the ban: the agent may now mention that a cancellation mail already exists and OFFER to remove the
 * stale entry — always behind `calendar_delete_event`'s own approval card, and only after
 * waiting for the owner's answer. Nothing here lets the agent decide which booking stands or act without the owner.
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
  return labeledContext([{ label: "Signals since last brief", content: rows.join("\n"), thirdParty: true }]);
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
// Frister — the deadline block
//
// A statutory due date is a FIXED POINT of the owner's day, in the same family as a meeting the owner has to be
// at, and nothing like a reply the owner owes a person. That is why the block sits above the obligations
// heading in the morning prompt and why `deadlinesClause` exists at all: the one failure mode
// worth a sentence of prompt is the model folding these lines into the owed-a-reply list, which
// is exactly the misfiling Workstream B removes on the other side of the pipeline.
//
// Rendered into the prompt as CONTEXT rather than spoken — the same standing this file gives
// `heldBackLine`. moved the wording itself out to `lib/brief-strings.ts`, keyed by
// `BriefLanguage`; the Norwegian (`nb`) strings are today's exact wording and are asserted
// verbatim in tests/brief-content.test.ts and tests/brief-language.test.ts.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** One open deadline, as the brief states it. `daysToDue` is computed by the caller against the
 *  owner's clock (`@lares/agent-kit/deadlines`), never re-derived here from `dueDate`.
 *
 *  `vendor`/`amount`/`currency` are who is paid and how much, mostly meaningful for a
 *  `'renewal'` row but not restricted to one (`deadline_add` accepts them on any source — see its
 *  own header). All three optional and independently nullable, matching `DeadlineRow` — a row
 *  minted without them, or one with only some of the three filled in, is ordinary, not an
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
 * for the same reason.
 *
 * The scan reads a 60-day inbox, so the first tick on a fresh installation flags every institutional
 * mail in that window at once. Uncapped, day one is a brief that opens with a wall of offers,
 * which is the fastest way to teach the owner to skip the block on the morning it has one that matters.
 * Capped, the rest stay UNSTAMPED and drain five a morning until the backlog is gone.
 *
 * Applied where the list is BUILT (agent/schedules/morning-brief.ts), never here: only the
 * candidates actually rendered may be stamped `surfaced_at`, and a cap applied at render time
 * would stamp six and show five.
 *
 * DELIBERATELY NO "(N more …)" TAIL, unlike `conflictsBlock`. A held-back clash is a fact about
 * today the owner is not being told; a held-back candidate is an offer that has not been made yet, and
 * announcing the size of a queue of offers is noise about the system rather than news about the owner's
 * day.
 */
export const CANDIDATE_LINES_MAX = 5;

/** `- SISTE FRIST — i dag:` / `- Forfalt for 2 dager siden:` / `- Om 8 dager (2026-09-16):`, or
 *  their `lang` equivalent from `BRIEF_STRINGS`. The date rides along on the far rows
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

/** `" — Registrar A, 199 NOK"` — vendor and amount/currency, appended after the
 *  consequence clause and before the trailing `[id …]`. PURE DATA, no language-specific words:
 *  a vendor name and an ISO currency code read the same in every `BriefLanguage`, so this never
 *  touches `BRIEF_STRINGS`. Composed from whichever of the three fields are actually present —
 *  vendor alone, amount alone (with or without its currency), or vendor plus amount — so a
 *  partially-filled row (e.g. vendor with no amount yet) still renders cleanly rather than with
 *  a stray comma or an empty parenthetical. `""` when none of the three are set, which is what
 *  keeps a pre-row byte-identical to today's output. */
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
  // The consequence clause is OMITTED, not emptied: "… (a company AS) — [id d2]" reads as a
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
 * `deadline_add`/`deadline_dismiss` and their argument names are CODE, not prose:
 * `BRIEF_STRINGS[lang].deadlines.candidateRow` translates the sentence around them and nothing
 * inside the parentheses.
 */
function candidateRow(c: CandidateLine, lang: BriefLanguage): string {
  return BRIEF_STRINGS[lang].deadlines.candidateRow(c.subject, c.sender, c.threadId);
}

/**
 * At most this many DEADLINE lines reach one brief — the same reasoning as `CANDIDATE_LINES_MAX`
 * above, for a case that arrives all at once.
 *
 * A statutory mint is a WHOLE YEAR in one approval: twelve rows for a Norwegian AS, and a second
 * entity doubles it. `MENTION_DAYS` alone keeps most mornings short, but the day two entities' 30-
 * day marks coincide — or the morning after a backfill — the block becomes a wall, and a wall is
 * read as furniture. Eight is where the list still scans as a list.
 *
 * Unlike the candidate cap, this one DOES print a tail (`+N flere frister — se konsollen`): a
 * held-back candidate is an offer that has not been made yet, but a held-back deadline is a dated
 * obligation that exists whether or not it fits, and hiding the size of that is the defect
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
 * teach the owner to skip the block on the morning it has something.
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
 * `lang` is required, same reason as `heldBackLine`: every caller says which language
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
  return labeledContext([{ label: s.blockLabel, content: lines.join("\n"), thirdParty: true }]);
}

/** The ONE sentence that tells the agent what to do with the block above — and only when there is a
 *  block. Same shape and same reason as `conflictsClause`: the block states the facts, the
 *  clause stops the agent folding them into the list of people waiting on the owner. `lang` required, same
 *  reason as `deadlinesBlock` beside it. */
export function deadlinesClause(rows: readonly DeadlineLine[], candidates: readonly CandidateLine[], lang: BriefLanguage): string[] {
  if (rows.length === 0 && candidates.length === 0) return [];
  return [BRIEF_STRINGS[lang].deadlines.clause, ""];
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Ingested picks. Notes that entered the vault (the vault's raw/ folder, BRIEF_PICKS_DIR)
// recently — reading, never events or meetings.
// ═══════════════════════════════════════════════════════════════════════════════════════════

export interface IngestedPick {
  title: string;
  url?: string;
  /** Filename inside the declared dir (vault-relative to raw/). */
  path: string;
  /** Home-clock calendar day the note entered the vault, "YYYY-MM-DD". */
  created: string;
}

/** Cap so the brief's nudge stays lean. */
export const PICKS_MAX = 8;

/** How far back "entered the vault recently" reaches, in home-clock days (inclusive boundary). */
export const PICKS_WINDOW_DAYS = 7;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Strip surrounding quotes an LLM may have added around a scalar. */
function unquote(v: string): string {
  return v.replace(/^["']|["']$/g, "").trim();
}

/**
 * Parse the YAML frontmatter block at the top of a note body — a flat key→value map of string
 * scalars only. A five-line copy of the digest module's `parseFrontmatter`, kept here rather
 * than importing an unrelated digest module for it.
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
 * Notes that entered the vault within the window. `dir` = the vault's raw/ folder (declared —
 * no magic paths). Newest-first, capped at PICKS_MAX. Returns [] when the input is off, the
 * dir is unreadable, or nothing qualifies. Never throws — a brief must still send.
 */
export function readIngestedPicks(
  dir: string | undefined, now: Date, reader: PicksReader = nodePicksReader,
): IngestedPick[] {
  if (!dir) return [];
  try {
    // DELIBERATELY still the home clock, the one day decision in this file that is. A
    // note's `created` is a date the vault wrote at home, so the cutoff it is compared against
    // has to come off that same clock; where the owner is standing has no bearing on when a
    // note was filed. Moving this one would compare dates taken from two different clocks.
    const cutoff = homeDate(new Date(now.getTime() - PICKS_WINDOW_DAYS * DAY_MS));
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
// BriefContent — the two brief builders. Both pure: given the raw facts
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
  /** Notes that entered the vault recently — morning only; always [] on the evening brief. */
  picks: IngestedPick[];
  /**
   * TRUE when a source this brief normally reads could not be read at all this pass
   * (today: Slack; `gatherOpenObligations` catches a `deps.slack` failure and continues
   * Gmail-only). Not a count and not an error object: the ONE thing the prose has to convey is
   * that `obligations` above is a partial list, so a renderer can never accidentally present it
   * as the whole picture.
   *
   * This is the absent-vs-empty distinction `@lares/compose-contract`'s `absentBlockClause`
   * spells out, carried in data rather than hoped for in a prompt: an empty `obligations` with
   * this `false` is a fact obtained ("nothing is owed"); the same empty list with this `true` is
   * no information at all about the Slack half. On the first real morning after those
   * two rendered identically, and the owner had no way to tell a whole source had dropped out.
   *
   * Optional so every existing construction site (the evening brief, every test literal) keeps
   * meaning exactly what it meant before: nothing was dropped.
   */
  slackUnavailable?: boolean;
  /**
   * One plain line per source the brief normally reads but could not ("Calendar not connected",
   * "Email could not be read"). Same absent-is-not-empty rule as `slackUnavailable`, for the
   * sources a fresh installation may simply not have yet (Google). Omitted when every source was
   * read, so such a brief renders exactly as before.
   */
  unavailable?: string[];
  /**
   * what on TODAY's calendar contradicts itself (`lib/calendar-conflicts.ts`).
   * Morning only; the evening brief never carries it.
   *
   * BY EXCEPTION and OPTIONAL, and the two go together: absent or empty both mean "nothing
   * rendered", so every existing construction site keeps meaning exactly what it meant. Unlike
   * `slackUnavailable`, absence here carries no claim in either direction — a caller that
   * never ran the pass and a pass that found nothing are the same silence, because a clash
   * list is not a source whose emptiness the prose ever asserts.
   *
   * `ResolvedConflict`, not the bare `CalendarConflict`: a row may carry the
   * optional `resolution` `lib/conflict-resolution.ts`'s bounded mailbox search attached. Every
   * existing construction site hands over plain `CalendarConflict[]` still, which is
   * structurally a `ResolvedConflict[]` with no row's `resolution` set — nothing about this
   * widening changes what an unresolved brief renders.
   */
  conflicts?: ResolvedConflict[];
  /**
   * the open deadlines the brief names today (`mentionsToday`, applied by the
   * schedule), and the mails that look like due notices and have never been offered.
   *
   * Morning only; the evening brief never carries either. BY EXCEPTION and OPTIONAL, the
   * `conflicts` pattern exactly: absent and empty both mean "nothing rendered", so every
   * existing construction site keeps meaning what it meant and a morning with no deadlines
   * renders byte-for-byte the brief this function returned before deadlines existed.
   *
   * The two are NOT symmetric in what they earn (see `buildMorningBrief`): a due deadline makes
   * a brief happen, a candidate does not.
   */
  deadlines?: DeadlineLine[];
  deadlineCandidates?: CandidateLine[];
  /** Errors and warnings recorded by the spine since the previous morning brief. */
  signals?: SignalRow[];
}

/** The labeled block both prompts carry when a source could not be read. "" when none, which
 *  drops it from the prompt entirely. Plain wording on purpose: the model repeats these lines. */
export function unavailableSourcesBlock(unavailable: readonly string[] | undefined): string {
  if (!unavailable || unavailable.length === 0) return "";
  return labeledContext([
    {
      label: "Sources not available",
      note: "NOT read this time, so the lists in this message are NOT the whole picture",
      content: unavailable.map((u) => `- ${u}`).join("\n"),
    },
  ]) + "\nSay plainly, in one short line, which of these is missing. Never describe a missing source as empty or as a quiet day.";
}

export interface EveningBriefInput {
  /** Tomorrow's external meetings, already fetched (listTomorrowExternalMeetings). */
  meetings: NightBeforeMeeting[];
  /** ALL currently open obligations, already gathered (gatherOpenObligations) — this function
   *  itself decides which of them belong to tonight via assignSurfaces. */
  obligations: Obligation[];
  /** Sources that could not be read, one line each. They never make the evening pass send on
   *  their own (the evening pass is silent by contract, and a nightly "not connected" would be
   *  noise; the morning brief carries that disclosure); they ride along when something else
   *  earns a send, so a shorter list is never mistaken for a whole one. */
  unavailable?: readonly string[];
}

/**
 * Tomorrow's external meetings, plus whatever is owed specifically to the people in them.
 * `null` when there is nothing to say — no meetings AND nothing owed to anyone tomorrow — and
 * a `null` return means the caller must send NOTHING, not an empty/negative brief.
 *
 * Stamping `night_before_delivered_day` (lib/obligations-store.ts's `markNightBeforeDelivered`)
 * is deliberately NOT done here: it must happen only after the schedule's send has actually
 * succeeded (a delivery stamp must never be written for an
 * unconfirmed send) — this function has no I/O and cannot know that. The returned content's
 * `obligations` list IS the exact set of threads "actually covered", for the caller to stamp.
 */
export function buildEveningBrief(input: EveningBriefInput): BriefContent | null {
  const participants = new Set(input.meetings.flatMap((m) => m.participants));
  const { nightBefore } = assignSurfaces(input.obligations, participants, new Map());

  if (input.meetings.length === 0 && nightBefore.length === 0) return null;

  return {
    meetings: input.meetings,
    obligations: nightBefore,
    picks: [],
    ...(input.unavailable && input.unavailable.length > 0 ? { unavailable: [...input.unavailable] } : {}),
  };
}

export interface MorningBriefInput {
  /** TODAY's commitments (listTodayMeetings) — the frame the rest hangs on. Unlike the
   *  obligations below these are NOT a delta: last night's prep is 12 hours old, and the owner wanted
   *  for the morning to open with what's on the owner's plate. */
  meetings: NightBeforeMeeting[];
  /** ALL currently open obligations, already gathered (gatherOpenObligations). */
  obligations: Obligation[];
  /** Thread ids whose night-before message covered TODAY (lib/obligations-store.ts's
   *  `nightBeforeDelivered(nightBeforeCoveredDay-of-yesterday's-pass)`, i.e. what last night's
   *  20:00 pass actually told the owner about) — the only thing that may buy a thread's silence
   *  here. Threads NOT in this set are new or changed since last night and belong in the
   *  delta. */
  deliveredLastNight: ReadonlySet<string>;
  /** Notes that entered the vault recently (readIngestedPicks). */
  picks: IngestedPick[];
  /** see `BriefContent.slackUnavailable`. Set by the schedule when its Slack
   *  obligation source failed or outran its budget and the gather continued Gmail-only. */
  slackUnavailable?: boolean;
  /** see `BriefContent.unavailable`. Unlike the evening pass, a morning with an unread source
   *  is never silent: on a fresh installation the gap IS the news. */
  unavailable?: readonly string[];
  /** today's clashes (`listTodayCalendar`). Passed straight through; they never
   *  make a brief happen on their own. A clash lives ON one of today's commitments, so a
   *  calendar with a clash on it is never a calendar with no meetings — making this earn the
   *  brief would add a case that cannot arise, and a case that cannot arise is a case no test
   *  can honestly cover.
   *
   *  `ResolvedConflict`, so a caller (the morning schedule) may pass rows that
   *  already went through `resolveConflicts`. See `BriefContent.conflicts` for what that
   *  widening does and does not change. */
  conflicts?: ResolvedConflict[];
  /**
   * the open deadlines due today or on a mention day, already filtered by
   * `mentionsToday` against the owner's clock (this function has no clock and must never
   * re-derive one), and the unsurfaced due-notice candidates.
   *
   * A non-empty `deadlines` BREAKS THE SILENCE RULE below: a statutory due date is a reason to
   * send on a morning with nothing else on it. A
   * candidate is not — an offer to record a deadline can wait for a morning that already has
   * something to say, and a brief that fired only to ask about a mail would be exactly the
   * "prove checking happened" output this file's header forbids.
   */
  deadlines?: DeadlineLine[];
  deadlineCandidates?: CandidateLine[];
  signals?: SignalRow[];
}

/**
 * What's on the owner's plate today: TODAY's commitments, the obligation DELTA since last night's
 * pass, and recently-ingested picks. `null` only when all three are empty AND every source was
 * actually read (see the `slackUnavailable` branch below) — a day with meetings is
 * never silent, even when nothing changed overnight.
 *
 * The obligations half is still strictly a delta (the owner wants a change called out
 * when it happens); the calendar half deliberately is not, because the day's
 * fixed points are the frame the rest hangs on and last night's prep is 12 hours stale by the
 * time the owner reads this.
 *
 * KNOWN LIMITATION (accepted, not a bug): this is a flat filter on `deliveredLastNight` — it
 * does not recompute against today's calendar, so it cannot resurface what was owed to a
 * person when a meeting with them was cancelled overnight. The
 * blast radius is bounded: `deliveredLastNight` is scoped per home-clock calendar day
 * (`obligations-store.ts`'s `nightBeforeDelivered`), so a still-open obligation reappears the
 * FOLLOWING morning regardless — a one-day delay on an item that was already ≥48h overdue, never
 * a permanent drop. Resurfacing it immediately would cost a second calendar read here for that
 * bounded, minor timeliness gain, which is not worth it.
 */
export function buildMorningBrief(input: MorningBriefInput): BriefContent | null {
  const obligations = input.obligations.filter((o) => !input.deliveredLastNight.has(o.threadId));

  // a DROPPED SOURCE breaks the silence rule, deliberately. The `null` contract above
  // reads "all three are empty, so there is nothing to say"; that is a claim about what is on
  // the owner's plate, and a pass whose Slack half never returned has not earned it. Staying silent
  // here would be the same lie — an unread source rendered
  // identically to a read-and-empty one — just at the outer edge instead of inside the prose.
  // So: absent ≠ empty, all the way up. A quiet morning with every source read is still silent.
  if (
    input.meetings.length === 0 &&
    obligations.length === 0 &&
    input.picks.length === 0 &&
    !input.slackUnavailable &&
    (input.unavailable ?? []).length === 0 &&
    // and a day with a statutory deadline on it is not a quiet morning either. Only
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
    ...(input.unavailable && input.unavailable.length > 0 ? { unavailable: [...input.unavailable] } : {}),
    // omitted entirely when there is nothing to say, so a brief with no clashes is
    // byte-for-byte the brief this function returned before the radar existed.
    ...(input.conflicts && input.conflicts.length > 0 ? { conflicts: input.conflicts } : {}),
    // the same pattern, for the same reason.
    ...(input.deadlines && input.deadlines.length > 0 ? { deadlines: input.deadlines } : {}),
    ...(input.deadlineCandidates && input.deadlineCandidates.length > 0
      ? { deadlineCandidates: input.deadlineCandidates }
      : {}),
    ...(input.signals && input.signals.length > 0 ? { signals: input.signals } : {}),
  };
}
