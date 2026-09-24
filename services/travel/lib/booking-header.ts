/**
 * lib/booking-header.ts — the one definition of a filed booking block's header.
 *
 * Split out of `lib/bookings.ts` (ORB-113) so that `lib/trip-context.ts` can read block headers
 * without importing the booking PIPELINE — that file's whole contract is being pure (no fs, no
 * model, no eve), and `bookings.ts` pulls in `ai`, `unpdf` and `node:fs`. One regex, two
 * consumers, no second copy to drift.
 *
 * `provider:` is optional so every block filed before ORB-105 added it still parses. Readers
 * must distinguish "no provider recorded" from "a provider that differs" — those lead to
 * opposite decisions when deciding whether two blocks are the same reservation.
 *
 * `at:<lat>,<lon>` is likewise optional (ORB-109): the venue's coordinates, resolved once when
 * the booking was filed. Absent means "we could not place it confidently", which is a normal
 * outcome and never an error — a booked venue without coordinates simply cannot be geofenced.
 */
export const HEADER_RE =
  /<!-- booking id:(\S+) kind:(\S+) start:(\S+) end:(\S+) time:(\S+)(?: provider:(\S+))?(?: at:(\S+))? -->/g;

/**
 * Every filed block's structured header fields. The `details` line is deliberately NOT returned:
 * it is prose a model composed, and `lib/day-skeleton.ts` exists precisely to reason from
 * structure rather than from prose.
 *
 * `end`/`time`/`provider` are `undefined` when the header recorded none ("-") or predates the
 * field.
 */
export interface BookingHeader {
  readonly id: string;
  readonly kind: string;
  readonly start: string;
  readonly end?: string;
  readonly time?: string;
  readonly provider?: string;
  /** ORB-109 — the venue's coordinates, when they could be resolved at filing time. */
  readonly lat?: number;
  readonly lon?: number;
}

/** The one mapping from HEADER_RE's capture groups to a BookingHeader. Shared by
 *  {@link bookingHeaders} and {@link bookingBlocks} so the two can never disagree about what a
 *  header means — the same reason this file exists at all (ORB-113). */
function toHeader(groups: (string | undefined)[]): BookingHeader {
  const [id, kind, start, end, time, provider, at] = groups;
  const [latRaw, lonRaw] = (at ?? "").split(",");
  const lat = Number(latRaw), lon = Number(lonRaw);
  const hasCoords = at !== undefined && at !== "-" && Number.isFinite(lat) && Number.isFinite(lon);
  return {
    id: id!,
    kind: kind!,
    start: start!,
    ...(end === undefined || end === "-" ? {} : { end }),
    ...(time === undefined || time === "-" ? {} : { time }),
    ...(provider === undefined || provider === "-" ? {} : { provider }),
    ...(hasCoords ? { lat, lon } : {}),
  };
}

export function bookingHeaders(content: string): BookingHeader[] {
  return [...content.matchAll(HEADER_RE)].map((m) => toHeader(m.slice(1)));
}

/**
 * ORB-126 — a filed block WITH its body text, which `bookingHeaders` deliberately throws away.
 *
 * `day-skeleton.ts` reasons from structure precisely so it never has to trust prose. This
 * reader exists for the opposite need: the confirmation's OWN WORDS are the only thing Marcel
 * is allowed to quote a cancellation or change policy from — "Free cancellation",
 * "Cancellation fee $25/person if cancelled after Aug 27 at 8:00pm", "Outdoor Tavern Dining".
 * Paraphrasing them is how a wrong "yes, you can move that" gets said, so this returns the body
 * verbatim, trimmed of nothing but surrounding whitespace.
 */
export interface BookingBlock {
  readonly header: BookingHeader;
  /** The block's body exactly as filed. Never summarised, never re-flowed. */
  readonly text: string;
}

/** Built from HEADER_RE's own source so the header grammar has exactly one definition. Group 8
 *  is the body: everything between the header line and this block's closing marker. */
const BLOCK_RE = new RegExp(`${HEADER_RE.source}\\n([\\s\\S]*?)<!-- /booking -->`, "g");

export function bookingBlocks(content: string): BookingBlock[] {
  return [...content.matchAll(BLOCK_RE)].map((m) => ({
    header: toHeader(m.slice(1, 8)),
    text: (m[8] ?? "").trim(),
  }));
}
