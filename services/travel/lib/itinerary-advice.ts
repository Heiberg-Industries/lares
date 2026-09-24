/**
 * lib/itinerary-advice.ts — the day's bookings, in the confirmation's own words, plus the rules
 * that govern what Marcel may say about them (ORB-126).
 *
 * Bendik asked for this: "during trip he can post tomorrows weather, and if he has access to
 * the itinerary come with suggestions, eg if its pouring down perhaps move a indoors activity
 * if possible (if booked tickets, are they possible to change, etc)."
 *
 * The cheap part is that `bookings.md` already carries everything needed and has since ORB-109
 * — coordinates in `at:`, and indoor/outdoor plus the real change and cancellation terms in the
 * confirmation's own prose ("Outdoor Tavern Dining", "inside seating", "Free cancellation",
 * "Cancellation fee $25/person if cancelled after Aug 27 at 8:00pm"). So there is no new
 * parsing and no new data entry: the day's blocks go into the prompt WITH their text, and the
 * model reasons over them.
 *
 * The expensive part, and the whole point, is the honesty rules below. The failure this file
 * exists to prevent is a confident "yes, you can move that" about a booking whose confirmation
 * says nothing of the kind. A wrong reassurance is worse than silence: it is acted on. So the
 * rules are stated as absolutes, the booking text is passed through verbatim rather than
 * summarised, and "står ikke i bekreftelsen" is given as the required answer for the case the
 * model would otherwise fill in.
 *
 * Pure: strings in, strings out. Nothing here reads or writes a file, and nothing anywhere in
 * this path can change or cancel a real reservation — Marcel has no tool that could.
 */
import { bookingBlocks, type BookingBlock } from "./booking-header.js";

/**
 * The blocks filed for one day, in filing order.
 *
 * Matched on `start` alone, deliberately. A five-night hotel and a week of airport parking span
 * every day of a trip, but they are not PLANS — they are not threatened by rain and there is
 * nothing to swap. What the weather can ruin is the thing that starts that day, which is
 * exactly what `start` picks out.
 */
export function bookingsForDate(bookingsMd: string, dateISO: string): BookingBlock[] {
  return bookingBlocks(bookingsMd).filter((b) => b.header.start === dateISO);
}

/**
 * The day's bookings rendered for the prompt — header facts, then the body VERBATIM.
 *
 * Verbatim is the contract, not a stylistic choice. Every cancellation term Marcel is permitted
 * to quote has to reach him unaltered; a summary is already an interpretation, and the wrong
 * interpretation here is the whole risk. Returns "" when the day holds nothing, so callers can
 * simply skip the section.
 */
export function renderDayBookings(blocks: BookingBlock[]): string {
  if (blocks.length === 0) return "";
  return blocks
    .map((b) => {
      const facts = [
        b.header.kind,
        b.header.time ?? "uten klokkeslett",
        b.header.lat !== undefined ? `at ${b.header.lat},${b.header.lon}` : "uten koordinater",
      ].join(", ");
      return `[${facts}]\n${b.text}`;
    })
    .join("\n\n");
}

/**
 * The rules, in Norwegian, appended to any prompt that puts booking text in front of the model.
 *
 * Each line closes a specific way of being confidently wrong:
 *  1. quoting a policy that is not there,
 *  2. filling the silence with a reassuring guess,
 *  3. the specific words "refunderbar/kan endres/gratis å avbestille" arriving unsupported,
 *  4. acting instead of suggesting.
 */
export const BOOKING_HONESTY_RULES = [
  "Om avbestilling og endring: siter KUN det som faktisk står i den enkelte bookingens egen tekst over.",
  'Står det ingenting om avbestilling eller endring, si det rett ut — "står ikke i bekreftelsen" — og aldri gjett eller berolige.',
  "Aldri påstå at noe er refunderbart, kan endres eller er gratis å avbestille uten at ordene står der.",
  "Aldri endre eller avbestill en booking. Du foreslår; Bendik bestemmer.",
].join(" ");

/**
 * The weather-versus-plans instruction, given only when the day actually holds something.
 *
 * "Only when it applies" runs through the wording as well: on a fine day with an indoor dinner
 * there is nothing to advise, and a post that manufactures advice anyway trains everyone to
 * skim past the ones that matter.
 */
export function weatherAdviceInstruction(dateISO: string, rendered: string): string {
  return [
    `Bookinger for ${dateISO}, slik de er arkivert (teksten er bekreftelsens egne ord):`,
    "",
    rendered,
    "",
    "Se værmeldingen mot disse planene. Truer været noe av det — uteservering, noe utendørs, en lang gåtur —",
    "si hvilken plan det gjelder og hva som kunne byttes eller flyttes.",
    "Er været greit, eller treffer det ingenting av planene, la det ligge og ikke finn på et råd.",
    BOOKING_HONESTY_RULES,
  ].join("\n");
}
