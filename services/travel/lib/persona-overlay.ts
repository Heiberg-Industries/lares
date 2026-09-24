// lib/persona-overlay.ts — the per-trip destination persona overlay (ORB-96).
//
// Marcel's core persona is Riviera-flavored (cousin Jean-Pierre in Sainte-Maxime, French
// framing). In New York that reads as charmingly lost rather than locally sharp. The fix is
// NOT to regenerate the persona per conversation — that costs a model call per turn and drifts
// the voice, and this fleet keeps personas byte-stable for hard-learned reasons. It is a
// one-time, per-trip OVERLAY: generated once when the trip is created, written to a plain file
// in the trip's own directory, and injected only while that trip's context is being assembled.
//
// TWO RULES make this safe, and both are enforced here rather than left to the prompt's mood:
//
//  1. THE CORE STAYS BYTE-STABLE. `agent/instructions.md` is never touched. The overlay is an
//     additive section in the DYNAMIC per-trip context (lib/trip-context.ts), delimited by the
//     marker comments below so both a reader and a future editor can see exactly where the
//     generated text starts and stops. It may adjust flavor, instincts and framing — never
//     capabilities, never gates, never the honesty rules.
//
//  2. CHARACTER, NEVER FACTS. Invented local color is allowed (a local "kjenning" in Marcel's
//     own style, the way cousin Jean-Pierre works today). Every FACTUAL claim — venue names,
//     opening hours, prices, transit specifics — must still come from a tool at conversation
//     time, per the truthfulness contract. The generation prompt says so explicitly (pinned by
//     tests/persona-overlay.test.ts), and the rendered section repeats it to the model so the
//     rule survives even if the file is later hand-edited.
//
// Strength dial: Bendik chose (b) — instincts and framing PLUS light local lore, i.e. one named
// local contact. Not (a) framing-only, not (c) full character transformation.
//
// The file is plain markdown in the trip dir, so the edit path is "open it and type". The
// regenerate path is the admin-DM `persona_overlay` tool (agent/tools/persona_overlay.ts),
// which overwrites it with a fresh generation.

export const OVERLAY_FILE = "persona-overlay.md";

export const OVERLAY_START = "<!-- persona-overlay-start -->";
export const OVERLAY_END = "<!-- persona-overlay-end -->";

/** The clause that keeps invented color from becoming invented fact. Exported so the test can
 *  pin it against the prompt rather than re-typing it — if this text ever drifts out of the
 *  prompt, the test fails rather than the contract silently weakening. */
export const TRUTHFULNESS_CLAUSE =
  "Du skal ikke finne på FAKTA. Oppdiktet lokalfarge er lov (en lokal kjenning, en holdning, " +
  "en stemning) — men aldri konkrete opplysninger: ingen navngitte restauranter, barer, " +
  "butikker, hoteller, museer eller arrangementer, ingen åpningstider, priser, adresser, " +
  "linjenumre eller avstander. Alt slikt henter Marcel med verktøy i selve samtalen.";

export interface OverlayTripInfo {
  readonly name: string;
  readonly destination: { readonly name: string };
  readonly start: string;
  readonly end: string;
}

/**
 * The generation prompt. Norwegian, because the overlay itself is injected into a Norwegian
 * persona and read by the model in that voice — an English overlay would sit in the context
 * like a translation note.
 */
export function overlayPrompt(trip: OverlayTripInfo): string {
  return [
    "Du skriver en kort, varig persona-overlay for Marcel — en fransk reisekonsierge som til",
    "vanlig snakker med Rivieraen i ryggmargen (fetteren Jean-Pierre i Sainte-Maxime, sørfransk",
    "innramming). Han skal på tur, og trenger lokal teft for nettopp dette reisemålet.",
    "",
    `Reisemål: ${trip.destination.name}`,
    `Tur: ${trip.name} (${trip.start}–${trip.end})`,
    "",
    "Skriv på norsk, i Marcels egen stemme, 120–200 ord. Overlayen skal inneholde:",
    "",
    "1. INSTINKTER — hvordan en som kjenner stedet tenker: nabolagsfølelse, rytme, tempo,",
    "   hva som er turistfelle-energi og hva som er ekte, når på døgnet ting skjer.",
    "2. INNRAMMING — hva Marcel legger merke til og hvordan han formulerer seg her, som en",
    "   lokal ville gjort. Han er fortsatt Marcel: samme varme, samme tørre humor.",
    "3. ÉN LOKAL KJENNING — en oppdiktet person Marcel «kjenner» på stedet, i samme ånd som",
    "   fetteren Jean-Pierre. Gi vedkommende navn, yrke og en holdning. Ingenting mer.",
    // ORB-130 — Marcel signed EVERY message with 🇫🇷, on every trip. The French heart is a
    // feature and stays; the flag is not the heart, it is a souvenir from the wrong trip. One
    // line, generated with the overlay because the destination is already right here.
    "4. FLAGG — kun flagg-emojien for landet reisemålet ligger i, på formen «FLAGG: 🇺🇸».",
    "   Ingen forklaring, ingen alternativer, kun det ene flagget.",
    "",
    TRUTHFULNESS_CLAUSE,
    "",
    "Ikke skriv noe om hva Marcel KAN gjøre, hvilke verktøy han har, hva han må spørre om lov",
    "til, eller hvordan han skal oppføre seg sikkerhetsmessig — det står allerede i personaen",
    "hans og skal ikke gjentas eller endres her.",
    "",
    "Svar med ren markdown-tekst — ingen overskrift, ingen innledning, ingen kommentar om",
    "oppgaven. Bare selve overlayen.",
  ].join("\n");
}

/** Wraps generated text in the markers. Idempotent: text that already carries them is
 *  returned as-is, so a regenerate that reads back its own output never double-wraps. */
export function wrapOverlay(text: string): string {
  const body = extractOverlay(text);
  if (body === "") return "";
  return `${OVERLAY_START}\n${body}\n${OVERLAY_END}\n`;
}

/**
 * Pulls the overlay body out of a stored file. Markers are the contract, but a hand-edited
 * file that lost them must still work — Bendik editing his own file is an expected path, not
 * a corruption — so an unmarked file is taken whole.
 */
export function extractOverlay(raw: string): string {
  const start = raw.indexOf(OVERLAY_START);
  const end = raw.indexOf(OVERLAY_END);
  if (start !== -1 && end > start) {
    return raw.slice(start + OVERLAY_START.length, end).trim();
  }
  return raw.trim();
}

export interface OverlayDeps {
  /** One model call, same `generateText`-shaped seam lib/dream.ts uses, so tests need no
   *  gateway wiring and the cost stays visible at the call site. */
  distill(prompt: string): Promise<string>;
}

/**
 * Generates the overlay for a trip. Returns the marker-wrapped text ready to write, or "" if
 * the model came back empty — an empty file is indistinguishable from no overlay downstream,
 * which is the correct degradation.
 */
export async function generateOverlay(deps: OverlayDeps, trip: OverlayTripInfo): Promise<string> {
  const text = await deps.distill(overlayPrompt(trip));
  return wrapOverlay(text ?? "");
}
