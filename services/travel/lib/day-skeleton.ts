/**
 * lib/day-skeleton.ts — what each day of the trip actually IS (ORB-113).
 *
 * ## The miss this exists for
 *
 * Marcel offered to "fylle inn de siste kveldene" with dinner bookings for The Big Apple. There
 * are no last evenings: the flight home leaves EWR 17:20 on 30.8 and lands Oslo 14:20 on 31.8.
 * 29.8 is the last dinner night, 30.8 is a departure day, 31.8 is a morning arrival and a car
 * pickup. Every fact needed to know that was sitting in his own bookings file — he just had to
 * count, across two bookings, and models do not reliably count dates in prose.
 *
 * So the counting happens here, deterministically, once per turn, and the model is handed the
 * answer instead of the arithmetic. The same miss would otherwise recur endlessly: activities
 * proposed on a departure day, breakfast on the wrong side of a night flight.
 *
 * ## Derived from block HEADERS only — never from prose
 *
 * `bookings.md` block headers carry `kind`, `start`, `end`. That is structured data we wrote
 * ourselves. The `details` line is free text a model composed from a mail, and mining it for
 * "Hjemreise 30 Aug … 17:20" would be exactly the guessing this is meant to replace.
 *
 * Which means the anchor is the STAY, not the flight:
 *
 *   - the main stay's `start` is the arrival day,
 *   - the main stay's `end` is the departure day — you check out on the day you leave,
 *   - a stay that ends where the main one begins is a pre-departure night (Gardermoen),
 *   - the last flight's `end` beyond the departure day is the day you get home (+1 arrivals).
 *
 * Flight TIMES are deliberately absent from the skeleton. The model already has the full booking
 * details in the same context; once the skeleton tells it 30.8 is a departure day, it can quote
 * the 17:20 itself. Structure here, specifics there.
 *
 * ## Missing data omits a line; it never invents one
 *
 * No stay inside the window means no skeleton at all — an empty string, and the context is
 * simply as it was before. A trip with nothing booked has no derivable shape, and a made-up one
 * is worse than none.
 */

/** The subset of a filed booking block this needs. Parsed from headers by the caller. */
export interface SkeletonBooking {
  readonly kind: string;
  /** ISO date, "YYYY-MM-DD". */
  readonly start: string;
  /** ISO date, or undefined when the header recorded none ("-"). */
  readonly end?: string;
}

export interface SkeletonInput {
  readonly tripStart: string;
  readonly tripEnd: string;
  readonly bookings: readonly SkeletonBooking[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s: string | undefined): s is string {
  return typeof s === "string" && ISO_DATE.test(s);
}

/** Days between two ISO dates. Both are plain calendar dates, so UTC arithmetic is exact — no
 *  timezone enters here, which is the point: a trip's days are wall-clock days. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** "2026-08-30" → "30.8" — how Norwegians write a date in passing. */
export function shortNo(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}`;
}

export interface DaySkeleton {
  /** Where the trip actually happens: check-in day of the main stay. */
  readonly arrival: string;
  /** Check-out day of the main stay — the day you leave. */
  readonly departure: string;
  /** Whole days on the ground, between arrival and departure (may be empty). */
  readonly fullDays: readonly string[];
  /** The last evening a dinner makes sense: the night before departure, when there is one. */
  readonly lastDinnerNight?: string;
  /** A night spent somewhere before the main stay begins (e.g. an airport hotel). */
  readonly preNight?: string;
  /** The day you are home, when a flight says it is later than the departure day (+1 arrivals). */
  readonly homeArrival?: string;
}

/**
 * The main stay: the longest one that starts inside the trip window. Longest rather than first,
 * because a one-night airport hotel before departure would otherwise win — and ties break on the
 * later end, so a stay that was extended supersedes the one it replaced.
 */
function mainStay(input: SkeletonInput): SkeletonBooking | undefined {
  const stays = input.bookings.filter(
    (b) => b.kind === "stay" && isDate(b.start) && isDate(b.end) && b.start >= input.tripStart && b.start <= input.tripEnd,
  );
  if (stays.length === 0) return undefined;

  return stays.reduce((best, s) => {
    const bestNights = daysBetween(best.start, best.end!);
    const nights = daysBetween(s.start, s.end!);
    if (nights > bestNights) return s;
    if (nights === bestNights && s.end! > best.end!) return s;
    return best;
  });
}

export function deriveDaySkeleton(input: SkeletonInput): DaySkeleton | undefined {
  const stay = mainStay(input);
  if (!stay || !isDate(stay.end)) return undefined;

  const arrival = stay.start;
  const departure = stay.end;
  if (daysBetween(arrival, departure) < 1) return undefined;

  const fullDays: string[] = [];
  for (let d = 1; d < daysBetween(arrival, departure); d++) fullDays.push(addDays(arrival, d));

  // A night that ends exactly where the main stay starts — an airport hotel, a stopover.
  const preNight = input.bookings.find(
    (b) => b.kind === "stay" && isDate(b.start) && b.end === arrival && b.start < arrival,
  )?.start;

  // Home later than departure means a night in the air. Taken from flight headers only, and only
  // when it is genuinely after the departure day.
  const flightEnds = input.bookings
    .filter((b) => b.kind === "flight" && isDate(b.end))
    .map((b) => b.end!)
    .filter((e) => e > departure);
  const homeArrival = flightEnds.length > 0 ? flightEnds.reduce((a, b) => (a > b ? a : b)) : undefined;

  return {
    arrival,
    departure,
    fullDays,
    ...(fullDays.length > 0 ? { lastDinnerNight: fullDays[fullDays.length - 1]! } : {}),
    ...(preNight === undefined ? {} : { preNight }),
    ...(homeArrival === undefined ? {} : { homeArrival }),
  };
}

/**
 * The context section. Norwegian, short, and stating only what the dates prove — no flight times
 * (see this file's header), no adjectives, and the departure day says outright that a dinner
 * booking is not wanted, because that is the sentence Marcel got wrong.
 */
export function renderDaySkeleton(skeleton: DaySkeleton): string {
  const lines = ["## Dagsplan-skjelett", "Utledet fra bookingene dine — bruk det til å ikke foreslå noe på feil dag."];

  if (skeleton.preNight !== undefined) {
    lines.push(`- ${shortNo(skeleton.preNight)}: natt før avreise`);
  }
  lines.push(`- ${shortNo(skeleton.arrival)}: ankomstdag`);
  if (skeleton.fullDays.length === 1) {
    lines.push(`- ${shortNo(skeleton.fullDays[0]!)}: hel dag`);
  } else if (skeleton.fullDays.length > 1) {
    const first = skeleton.fullDays[0]!;
    const last = skeleton.fullDays[skeleton.fullDays.length - 1]!;
    lines.push(`- ${shortNo(first)}–${shortNo(last)}: hele dager (siste middagskveld: ${shortNo(last)})`);
  }
  lines.push(`- ${shortNo(skeleton.departure)}: avreisedag — ingen middagsbooking her, sjekk flytiden i bookingene`);
  if (skeleton.homeArrival !== undefined) {
    lines.push(`- ${shortNo(skeleton.homeArrival)}: hjemme`);
  }
  return lines.join("\n");
}

/** Convenience for the caller: the whole section, or "" when the bookings cannot prove a shape. */
export function daySkeletonMarkdown(input: SkeletonInput): string {
  const skeleton = deriveDaySkeleton(input);
  return skeleton === undefined ? "" : renderDaySkeleton(skeleton);
}
