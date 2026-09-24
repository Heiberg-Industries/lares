/**
 * ORB-45 Task 10, B2 — resolveElsewhere: before a stale thread reaches the brief, check whether
 * Bendik already answered this counterparty on ANOTHER channel after their last message. Four
 * metadata-only lookups (Gmail sent, calendar attendance, Slack own messages, network-replica
 * outbound) run in parallel, each best-effort and individually bounded (`RESOLUTION_LOOKUP_TIMEOUT_MS`)
 * — a lookup that throws or times out contributes nothing (fails OPEN: it never blocks a real
 * answer elsewhere from clearing the obligation) and is named in `unreadable`. Task B5 wires the
 * real deps (Gmail/Calendar/Slack scan/network replica) and decides what a caller does with a
 * resolved obligation; this module only answers "did he already handle this, and how do we know".
 *
 * No lookup here reads a message body — every hit is a timestamp (+ a calendar summary, itself
 * metadata) matching the network replica's own contract (services/network/lib/replica.ts strips
 * `content` before the box ever sees it).
 */
// ORB-209 — `withTimeout` moved to its own leaf module. It used to come from
// `./brief-content.js`, which imported `RESOLUTION_LOOKUP_TIMEOUT_MS` back out of this file: a
// value-level ESM cycle that only stayed harmless because neither binding is read at module
// init. What is left is a TYPE-only edge to `brief-content.js`, which erases at compile time.
import { withTimeout } from "./timeout.js";
import type { Obligation } from "./brief-content.js";

/** Per-lookup timeout — each of the four sources gets its own, so one slow source never
 *  costs the others their answer (matches the sub-timeout pattern already used for the Slack
 *  scan in brief-content.ts). */
export const RESOLUTION_LOOKUP_TIMEOUT_MS = 5_000;

export interface Resolution {
  via: "gmail" | "calendar" | "slack" | "imessage" | "call";
  at: Date;
  evidence: string;
  /** Always the four source names, in `SOURCES` order — same list the caller gets back. */
  consulted: string[];
  /** Sources that threw or timed out — contributed nothing either way. */
  unreadable: string[];
}

export interface ResolutionDeps {
  /** Latest message FROM him TO any of `addresses`, sent after `since` — or null. */
  gmailSentAfter(addresses: string[], since: Date): Promise<Date | null>;
  /** A calendar event with them that ENDED in (since, now] — or null. */
  calendarEndedWith(addresses: string[], since: Date, now: Date): Promise<{ at: Date; summary: string } | null>;
  /** Synchronous: reads the scan's ownLastMessageByUser map (in memory already) — no I/O. */
  slackOwnMessageAfter(slackUserId: string | undefined, since: Date): Date | null;
  /** Synchronous: reads the network replica (metadata only — see network-client.ts). */
  networkOutboundAfter(
    identities: { emails: string[]; slackUserId?: string },
    since: Date,
  ): { channel: "imessage" | "call"; at: Date } | null;
}

// The four sources, in the fixed order `consulted`/`unreadable` always report, and the
// tie-break order when two sources land a hit at the identical timestamp.
const SOURCES = ["gmail", "calendar", "slack", "network"] as const;
type Source = (typeof SOURCES)[number];

/** `YYYY-MM-DD HH:mm` in Europe/Oslo — the one clock every evidence sentence quotes. */
function osloStamp(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  // Some ICU builds render midnight as "24" under hour12:false instead of "00" — normalize it
  // so the sentence never reads "you emailed them 2026-08-15 24:00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
}

interface Candidate {
  source: Source;
  via: Resolution["via"];
  at: Date;
  evidence: string;
}

interface LookupResult<T> {
  name: Source;
  value: T | null;
  ok: boolean;
}

/** Runs one source through the shared timeout/try path. A sync dep (slack, network) is lifted
 *  into a promise so all four sources go through Promise.all uniformly — the timeout can't fire
 *  before a sync function returns, but wrapping it anyway keeps every source's failure handling
 *  identical, per the task decision. */
async function runLookup<T>(name: Source, fn: () => Promise<T> | T): Promise<LookupResult<T>> {
  try {
    const value = await withTimeout(
      Promise.resolve().then(fn),
      RESOLUTION_LOOKUP_TIMEOUT_MS,
      `resolveElsewhere:${name}`,
    );
    return { name, value, ok: true };
  } catch {
    return { name, value: null, ok: false };
  }
}

export async function resolveElsewhere(
  o: Obligation,
  deps: ResolutionDeps,
  now: Date,
): Promise<{ resolution: Resolution | null; consulted: string[]; unreadable: string[] }> {
  const since = o.lastMessageAt;
  const emails = o.counterpartyEmails ?? [];
  const slackUserId = o.counterpartySlackUserId;

  const [gmail, calendar, slack, network] = await Promise.all([
    runLookup("gmail", () => deps.gmailSentAfter(emails, since)),
    runLookup("calendar", () => deps.calendarEndedWith(emails, since, now)),
    runLookup("slack", () => deps.slackOwnMessageAfter(slackUserId, since)),
    runLookup("network", () => deps.networkOutboundAfter({ emails, slackUserId }, since)),
  ]);

  const consulted: string[] = [...SOURCES];
  const unreadable = [gmail, calendar, slack, network].filter((r) => !r.ok).map((r) => r.name);

  const candidates: Candidate[] = [];
  if (gmail.ok && gmail.value) {
    candidates.push({ source: "gmail", via: "gmail", at: gmail.value, evidence: `you emailed them ${osloStamp(gmail.value)}` });
  }
  if (calendar.ok && calendar.value) {
    candidates.push({
      source: "calendar",
      via: "calendar",
      at: calendar.value.at,
      evidence: `you met ${osloStamp(calendar.value.at)}: ${calendar.value.summary}`,
    });
  }
  if (slack.ok && slack.value) {
    candidates.push({
      source: "slack",
      via: "slack",
      at: slack.value,
      evidence: `you wrote to them on Slack ${osloStamp(slack.value)}`,
    });
  }
  if (network.ok && network.value) {
    const { channel, at } = network.value;
    candidates.push({
      source: "network",
      via: channel,
      at,
      evidence: channel === "imessage" ? `you messaged them ${osloStamp(at)}` : `you called them ${osloStamp(at)}`,
    });
  }

  if (candidates.length === 0) {
    return { resolution: null, consulted, unreadable };
  }

  // Latest `at` wins; a tie breaks by SOURCES order (gmail, calendar, slack, network).
  candidates.sort((a, b) => {
    const byTime = b.at.getTime() - a.at.getTime();
    return byTime !== 0 ? byTime : SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source);
  });
  const winner = candidates[0]!;

  return {
    resolution: { via: winner.via, at: winner.at, evidence: winner.evidence, consulted, unreadable },
    consulted,
    unreadable,
  };
}
