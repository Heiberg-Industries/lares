// services/chief-of-staff/lib/person/types.ts
// CORE — vendor-neutral (no zod, no pg, no SDKs).
// Ported verbatim from services/agent-runtime/lib/person/types.ts (Task 8) — logic unchanged.

/**
 * The four states a source can be in, kept apart on purpose.
 *
 * `empty` is a claim about the world: we asked and there is nothing.
 * `failed` is a claim about us: we could not ask, and next time we might.
 * `not-applicable` is a claim about the QUESTION: this source cannot answer a query
 *   of this shape at all, and no retry will change that.
 *
 * Collapsing the first two is how an expired token becomes the confident sentence
 * "there is nothing on Lars in the CRM". Collapsing the second two is how a permanent
 * structural limit — Pulse is indexed by name, so it cannot be asked about a bare email
 * address — arrives as "your tools are broken", every single night, for every new meeting
 * participant. Three different facts, three different sentences. Every consumer must be
 * forced to handle all of them, which is why this is a discriminated union and not
 * `T | null`.
 */
export type SourceStatus = "found" | "empty" | "failed" | "not-applicable";

export type SourceResult<T> =
  | { status: "found"; source: string; data: T }
  | { status: "empty"; source: string }
  | { status: "failed"; source: string; reason: string }
  | { status: "not-applicable"; source: string; reason: string };

/**
 * Thrown by a source that cannot answer a query of this SHAPE — not one that tried and
 * broke. `attempt()` in gather.ts maps this (and only this) to `not-applicable`; every
 * other throw stays `failed`.
 *
 * It lives here, in core, so a source can signal "wrong question for me" without core
 * having to know anything about which source or which vendor. A distinct class rather than
 * a magic message prefix: a message is something a future edit can reword by accident, and
 * the whole point of this file is that the distinctions cannot be lost by accident.
 */
export class NotApplicableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotApplicableError";
  }
}

/**
 * How far back (and, for the calendar, forward) each source is actually searched.
 *
 * Stated in the rendered output on purpose. An unstated window turns "we found nothing in
 * the last 400 days" into "he has never met them" — an assertion about the relationship
 * that the query never established. The adapter that does the searching imports these, so
 * the numbers the render quotes are the numbers the search used, not a second copy that
 * can drift.
 */
export const SEARCH_WINDOW_DAYS = {
  mail: 400,
  calendarBack: 180,
  calendarAhead: 90,
} as const;

/** Anything the dossier can place on a timeline. */
export interface DatedItem { at: Date }

/**
 * An interaction Bendik ACTIVELY took part in: mail he sent, a meeting he attended,
 * a transcript naming them both.
 *
 * Their unanswered inbound mail is deliberately NOT an engagement. If it were, every
 * message they sent would move the anchor forward and the diff would always be empty —
 * which is precisely backwards, because unanswered inbound is the thing the diff exists
 * to surface.
 */
export interface EngagementEvent extends DatedItem {
  kind: "sent-email" | "meeting" | "transcript";
  /** Gmail thread id, calendar event id, or vault path. */
  ref: string;
}

/** What Bendik asked about. At least one field is present.
 *
 *  `emails` (plural) is the MERGE form: "these addresses are one human". It exists because a
 *  job change gives someone two mailboxes, and without it that person is permanently
 *  ambiguous — he can pick one address, but never see the whole relationship. When he supplies
 *  the list he has already made the identity judgement, so this form never returns ambiguous. */
export interface PersonQuery {
  name?: string;
  email?: string;
  emails?: string[];
}

/** One human a source believes matches the query. */
export interface Candidate {
  source: string;
  sourceId: string;
  displayName: string;
  emails: string[];
  company?: string;
}
