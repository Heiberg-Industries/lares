// lib/trip-context.ts — pure dynamic-per-trip section assembly.
//
// Fix Wave B, Finding 1 (the big gap the whole-branch review found): old Marcel's
// `buildSystemPrompt` (`services/marcel/lib/brain.ts:81-130`) assembled the FULL per-turn
// system prompt from named sections, each rendered via a `section(heading, body)` helper that
// OMITS the section entirely when its body is blank. This file ports ONLY the genuinely
// dynamic, per-trip sections of that function — persona and the static "## Dette gjør du
// automatisk" block are already ported statically into `agent/instructions.md` (Task 10) and
// must NOT be re-ported here, or they'd render twice.
//
// This is a PURE function — no fs, no model, no eve imports — exactly like old Marcel's own
// `buildSystemPrompt`, so it is testable in isolation. `agent/instructions/trip-context.ts`
// is the thin I/O wrapper that resolves a chat's linked trip, reads the files this function's
// arguments need, and calls it once per `turn.started` event.
//
// Section order (matches old Marcel's `buildSystemPrompt`, minus the two statically-ported
// sections, plus one addition): `## Tur: <name>` (always present — dates + destination +
// trip.md body), `## Lokal farge (denne turen)` (ORB-96, NEW — the per-trip persona overlay;
// placed here because it frames how Marcel SPEAKS about everything that follows),
// `## Reiseplan`, `## Bookinger`, `## Handleliste`, `## Lært om gruppen`,
// `## Din smak (det Marcel har lagt merke til)`, `## Dine lagrede steder nær turen` (ORB-100 —
// both renamed when their source changed from Marcel's own CSVs to the fleet taste store),
// `## Reise-e-poster nylig lest (automatisk logg)`, `## Samtalen nylig`, `## I dag` (always
// present — never gated by `section()`, since `todayISO` is never blank).

import { bookingHeaders } from "./booking-header.js";
import { daySkeletonMarkdown } from "./day-skeleton.js";

export interface TripContextTripInfo {
  readonly name: string;
  readonly start: string; // ISO date, inclusive
  readonly end: string; // ISO date, inclusive
  readonly destination: { readonly name: string };
}

export interface TripContextArgs {
  readonly trip: TripContextTripInfo;
  readonly tripMd: string;
  readonly itinerary: string;
  readonly bookings: string;
  readonly shopping: string;
  readonly learned: string;
  /** ORB-96: the per-trip persona overlay, marker-wrapped as stored. Blank for a trip that has
   *  none (or whose one-shot generation failed) — and blank means the section never renders,
   *  which is what keeps a no-overlay trip byte-identical to before this feature existed. */
  readonly personaOverlay?: string;
  /** Marcel's OWN learned taste (preferences.md) plus, since ORB-100, a compact digest of the
   *  non-place half of Bendik's store — playlists, dishes, notes. */
  readonly tasteProfile: string;
  /** Saved places near this trip's destination, from `/srv/taste` (ORB-100). Blank when the
   *  store is empty or unmounted — which is what keeps the mount from being load-bearing. */
  readonly tasteGeoHits: string;
  readonly todayISO: string;
  readonly transcript?: string;
  readonly reiseLog?: string;
}

/** Ported verbatim from old Marcel's `section` helper (`lib/brain.ts:74-77`): omits the
 *  heading entirely when the body is blank/whitespace-only. */
function section(heading: string, body: string): string {
  const trimmed = body.trim();
  return trimmed ? `${heading}\n${trimmed}` : "";
}

/**
 * ORB-96 — the per-trip persona overlay, wrapped in a standing frame.
 *
 * The frame is written HERE, in code, not by the generator: it is the part that must be true
 * of every overlay ever generated, including one Bendik has since hand-edited. It says the
 * overlay is style rather than fact, and that concrete claims still come from tools — the
 * truthfulness contract restated at the point of use, where the model actually reads it.
 * Blank overlay renders nothing at all (via `section`), which is the no-op path.
 */
/**
 * ORB-130 — the trip's own flag, pulled out of the overlay's FLAGG section.
 *
 * Two regional-indicator code points in a row are a flag emoji and nothing else, so this reads
 * the overlay without depending on how the generating model formatted the heading.
 */
export function overlayFlag(overlay: string): string | undefined {
  const match = overlay.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  return match?.[0];
}

/**
 * ORB-130 — the signature rule, rendered as a per-turn fact rather than left to the persona.
 *
 * The first attempt put "use the trip's flag, never the French one" in `agent/instructions.md`
 * and a FLAGG section in the overlay. Both shipped, and Marcel still signed off with 🇫🇷 —
 * a habit reinforced by every previous message he can see. A static instruction competing with
 * a vivid in-context pattern loses, the same lesson ORB-107's sweep-status line already taught.
 *
 * So the flag is stated here, close to the voice it governs, naming BOTH the flag to use and
 * the one to stop using. No flag in the overlay means no section at all — and the persona's own
 * fallback is then to use none, which is the safe direction.
 */
function signatureSection(overlay: string): string {
  const flag = overlayFlag(overlay);
  if (!flag) return "";
  // Worded as a rule, not a preference. The first version offered "or no flag at all, that is
  // fine too" and Marcel read the whole section as optional — he kept signing 🇫🇷 through two
  // deploys. What has to be unambiguous is the prohibition, not the permission.
  return section(
    "## Signatur",
    `Flagget for denne turen er ${flag}. Bruker du en flagg-emoji i en melding, er det dette og bare dette. ` +
      "🇫🇷 skal ikke stå i noen melding på denne turen — det franske er stemmen din, ikke signaturen din, " +
      "og flagget hører til en annen reise. Vil du avslutte uten flagg i det hele tatt, er det også riktig.",
  );
}

function personaOverlaySection(overlay: string): string {
  return section(
    "## Lokal farge (denne turen)",
    overlay.trim()
      ? "Dette er STIL, ikke fakta. Teksten under justerer tonen din for dette reisemålet — " +
          "instinkter, innramming, en lokal kjenning. Den endrer ingenting ved hva du kan gjøre, " +
          "hva du må spørre om lov til, eller kravet om å være ærlig. Hver konkrete opplysning " +
          "(sted, åpningstid, pris, transport, avstand) henter du fortsatt med verktøy i " +
          "øyeblikket — aldri herfra.\n\n" +
          overlay.trim()
      : "",
  );
}

/** Pure — assembles the dynamic per-trip markdown sections. Never returns persona or the
 *  static automatic-behaviors block (those already live in `agent/instructions.md`). */
export function buildTripContextMarkdown(args: TripContextArgs): string {
  const tur = [
    `## Tur: ${args.trip.name}`,
    `${args.trip.start} – ${args.trip.end} · ${args.trip.destination.name}`,
    ...(args.tripMd.trim() ? ["", args.tripMd.trim()] : []),
  ].join("\n");

  const sections = [
    tur,
    personaOverlaySection(args.personaOverlay ?? ""),
    signatureSection(args.personaOverlay ?? ""),
    section("## Reiseplan", args.itinerary),
    section("## Bookinger", args.bookings),
    // ORB-113 — derived from those same booking headers, right after them: which day is arrival,
    // which is departure, and where the last real evening is. Empty when the bookings cannot
    // prove a shape, and it then drops out with every other empty section below.
    daySkeletonMarkdown({ tripStart: args.trip.start, tripEnd: args.trip.end, bookings: bookingHeaders(args.bookings) }),
    section("## Handleliste", args.shopping),
    section("## Lært om gruppen", args.learned),
    section("## Din smak (det Marcel har lagt merke til)", args.tasteProfile),
    // ORB-100's truthfulness framing (the parent's standing rule): these are Bendik's OWN saved
    // entries and are recommended AS SUCH — "du har lagret…" — never as Marcel's independent
    // knowledge of the city. Whether a place is open, what it costs, whether it still exists:
    // all of that is a tool call at answer time, not a line from this list.
    section(
      "## Dine lagrede steder nær turen",
      args.tasteGeoHits.trim()
        ? "Dette er steder DU selv har lagret, ikke Marcels egne funn — snakk om dem som «du har lagret …». " +
            "Om et sted er åpent, hva det koster, eller om det fortsatt finnes, sjekker du med verktøy når " +
            "spørsmålet kommer.\n" +
            args.tasteGeoHits.trim()
        : "",
    ),
    section(
      "## Reise-e-poster nylig lest (automatisk logg)",
      (args.reiseLog ?? "").trim()
        ? "Dette er e-poster systemet ditt faktisk har lest fra Reise-etiketten, med utfall. «allerede registrert» betyr at innholdet allerede står i Bookinger — e-posten ER sett.\n" +
            (args.reiseLog ?? "").trim()
        : "",
    ),
    section("## Samtalen nylig", args.transcript ?? ""),
    `## I dag\n${args.todayISO}`,
  ];

  return sections.filter((s) => s.length > 0).join("\n\n");
}
