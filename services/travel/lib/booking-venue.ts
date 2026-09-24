/**
 * lib/booking-venue.ts — the venue identity line that opens every filed booking block.
 *
 * The gap this closes, found by Bendik on 2026-08-19 reading a real post: the extractor has
 * always pulled `provider` (the venue's NAME — "Cosme", "The Golden Swan") and `place` (its
 * street ADDRESS) out of every confirmation, and `lib/bookings.ts` then threw both away.
 * `bookingBlock` wrote the header plus a one-line summary, so `bookings.md` carried four New
 * York dinner reservations that named no restaurant and gave no address — and every downstream
 * reader, the evening post included, could only say "bord for to" because that is genuinely all
 * it had. The data was never missing; it was discarded at the last step, and it is still sitting
 * in the extraction cache, which is why repairing already-filed blocks needs no new sweep and no
 * model call at all.
 *
 * The line also carries the maps link, because `agent/instructions.md`'s own standing rule is
 * that a named place is ALWAYS given as `[Navn](mapsUrl)` and **never** as a bare coordinate
 * link. A booking is the one kind of place Marcel knows for certain the group is going to, so it
 * is the last place that should have been an exception.
 *
 * Link policy, in order of preference:
 *  1. `mapsPlaceUrl(name, placeId)` — the exact business page, immune to same-name branches
 *     (the "Kiwi bug"). Available whenever the venue's coordinates came from a Places hit.
 *  2. `mapsSearchUrl("<name>, <address>")` — what `lib/places.ts` itself falls back to. Good
 *     enough to resolve the right business, and never a naked pin.
 *
 * Pure: strings in, strings out.
 */
import { mapsPlaceUrl, mapsSearchUrl } from "./places.js";
import { HEADER_RE } from "./booking-header.js";

export interface BookingVenue {
  /** The venue's name — `Booking.provider`. */
  readonly name?: string;
  /** Its street address — `Booking.place`. */
  readonly address?: string;
  /** Google place id, when the coordinates came from a Places hit. */
  readonly placeId?: string;
  /** `Booking.kind`. A flight never gets a line: see {@link isNavigable}. */
  readonly kind?: string;
}

/**
 * Whether this booking is somewhere you can be NAVIGATED to.
 *
 * Two exclusions, both learned from the first draft of this file producing
 * `[SAS](maps?query=SAS)` for a flight:
 *
 *  - **A flight is never a venue.** `provider` there is an AIRLINE. Searching Google Maps for
 *    "SAS" returns whatever SAS-named business is nearest the phone, which is the precise shape
 *    of confidently-wrong that a booking link must never have.
 *  - **A name with no address and no place id is not enough.** "Onepark / Avinor" alone resolves
 *    to nothing trustworthy. An address or a Places id is what makes a link answerable.
 */
function isNavigable(venue: BookingVenue): boolean {
  if (venue.kind === "flight") return false;
  if (!venue.name?.trim()) return false;
  return Boolean(venue.placeId?.trim() || venue.address?.trim());
}

/** The maps URL for a venue, or undefined when there is not even a name to search for. A link
 *  is never built from coordinates alone: see this file's header for why. */
// Parentheses encoding lives in `lib/places.ts`'s builders themselves as of ORB-131 —
// this file carried its own copy first (ORB-129, the il Buco truncation), and the two
// encoders disagreeing was the stated reason to centralize.
export function venueMapsUrl(venue: BookingVenue): string | undefined {
  if (!isNavigable(venue)) return undefined;
  const name = venue.name!.trim();
  if (venue.placeId?.trim()) return mapsPlaceUrl(name, venue.placeId.trim());
  return mapsSearchUrl(`${name}, ${venue.address!.trim()}`);
}

/**
 * The identity line, or "" when nothing is known about the venue — a block for a booking whose
 * confirmation named no place stays exactly as it was rather than gaining an empty heading.
 */
export function venueLine(venue: BookingVenue): string {
  const url = venueMapsUrl(venue);
  if (!url) return "";
  const address = venue.address?.trim();
  return `- [${venue.name!.trim()}](${url})${address ? ` — ${address}` : ""}`;
}

/** A block already carries its identity line when any body line is a markdown link. */
function hasVenueLine(body: string): boolean {
  return /^\s*-\s*\[[^\]]+\]\(/m.test(body);
}

/**
 * Repairs already-filed blocks in place: inserts the identity line at the top of every block
 * whose id `lookup` can name and which does not have one yet.
 *
 * Everything else is left byte-identical — the header untouched, the existing summary line
 * untouched, unknown ids untouched. A repair that rewrites more than it can prove is how the
 * taste layer put 59 pins in the wrong city; here the only thing that licenses a write is an
 * exact booking-id match against the extraction the block was filed from.
 */
export function withVenueLines(bookingsMd: string, lookup: (id: string) => BookingVenue | undefined): string {
  const blockRe = new RegExp(`(${HEADER_RE.source})\\n([\\s\\S]*?)(<!-- /booking -->)`, "g");
  return bookingsMd.replace(blockRe, (whole, header: string, ...rest: unknown[]) => {
    // HEADER_RE contributes 7 capture groups of its own between `header` and the body.
    const body = rest[7] as string;
    const closing = rest[8] as string;
    const id = rest[0] as string;
    if (hasVenueLine(body)) return whole;
    const line = venueLine(lookup(id) ?? {});
    if (line === "") return whole;
    // Appended, never prepended: `lib/bookings.ts`'s `detailsLineFor` reads the line directly
    // after the header, and an identity line inserted above it would quietly become "the
    // details" in the veto DM, the reise-log and the supersede path.
    return `${header}\n${body.replace(/\s*$/, "")}\n${line}\n${closing}`;
  });
}
