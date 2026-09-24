// Heiberg-overlay vocabulary for lintRole() (ORB-145 Phase 2, Task 6).
//
// A role template extracted from Bendik's own agents can silently keep his world — a name, a
// company, a vendor, a place, a language — unless something proves it doesn't. The lists below
// ARE that proof, and they are DELIBERATELY the Heiberg overlay's own vocabulary, not a
// general-purpose name/place detector. A future installation (a different owner, a different
// fleet) extends this file with ITS OWN words; the mechanism in lint.ts never changes.
//
// Two kinds of rule live here:
//   - Literal vocabulary: exact words/phrases we already know describe Bendik's world
//     (person/company/vendor/place/language), each compiled to a word-bounded, case-insensitive
//     RegExp — plus `address`/`url`, which are structural rather than vocabulary but travel with
//     the others so lint.ts can treat all seven uniformly.
//   - A structural fallback for `person`: any two-capitalised-word sequence that ISN'T known role
//     vocabulary (ROLE_VOCABULARY_ALLOWLIST) and isn't built from ordinary English/role words
//     (PERSON_NAME_STOPWORDS) is treated as an unlisted name. This is what catches a name this
//     file's authors never anticipated — the literal list above can only catch names it already
//     knows about.

import { CAPABILITY_DOCS } from "./capability-docs.js";

export type LintRule = "person" | "company" | "vendor" | "place" | "language" | "address" | "url";

export interface VocabRule {
  rule: LintRule;
  patterns: RegExp[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// JavaScript's `\b` is ASCII-word-only (defined over `[A-Za-z0-9_]`), so it is not a boundary at
// all next to Æ/Ø/Å/æ/ø/å — `\bØystein\b` can never match "Øystein" as a standalone word, since
// neither side of the leading `\b` is an ASCII word character. `\p{L}`/`\p{N}` (Unicode letter/
// number categories, hence the `u` flag everywhere these are used) fix that for any script, not
// just Norwegian.
const WORD_START = "(?<![\\p{L}\\p{N}_])";
const WORD_END = "(?![\\p{L}\\p{N}_])";

/** A word-bounded, case-insensitive match for an exact term (may contain internal spaces). */
function term(word: string): RegExp {
  return new RegExp(`${WORD_START}${escapeRegExp(word)}${WORD_END}`, "iu");
}

// --- person --------------------------------------------------------------------------------
// The names that appear in today's personas. "Heiberg" is excluded when it opens "Heiberg
// Industries" — that's the company (caught by the `company` rule below), not the person.
const PERSON_PATTERNS: RegExp[] = [
  new RegExp(`${WORD_START}Bendik${WORD_END}`, "iu"),
  new RegExp(`${WORD_START}Heiberg${WORD_END}(?!\\s+Industries${WORD_END})`, "iu"),
  new RegExp(`${WORD_START}Kamilla${WORD_END}`, "iu"),
];

// --- company ---------------------------------------------------------------------------------
export const COMPANY_NAMES: string[] = [
  "Heiberg Industries",
  "Zero7",
  "Orakel",
  "Murmur",
  "Folkepuls",
  "Vol de Nuit",
  "Cratedigger",
  "Ledidi",
  "SOMA",
  "Trouvaille",
];

// --- vendor ----------------------------------------------------------------------------------
// Derived from CAPABILITY_DOCS' adapters at module load, plus vendors that carry no capability
// doc of their own (Slack, Telegram, Linear, Fiken, Karakeep, Ghost, Hetzner, Coolify —
// infrastructure and channels, not capabilities). A compound vendor string ("Entur + Google") is
// split on its separator so each half matches on its own; a new adapter in CAPABILITY_DOCS
// extends this list for free, with nothing to keep in sync by hand.
//
// `backedBy` (ORB-210 item 1) contributes on the same footing, from adapters AND core entries: a
// service a capability merely calls is still a vendor name a ROLE TEMPLATE must never carry, even
// though the capability is not identified with it.
const STATIC_VENDOR_NAMES: string[] = ["Slack", "Telegram", "Linear", "Fiken", "Karakeep", "Ghost", "Hetzner", "Coolify"];

/** A vendor string may be compound ("Entur + Google"); each part stands on its own. */
export function vendorParts(vendor: string): string[] {
  return vendor
    .split(/[+/,]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function deriveVendorNames(): string[] {
  const names = new Set<string>();
  for (const doc of Object.values(CAPABILITY_DOCS)) {
    if (doc.kind === "adapter" && doc.vendor) for (const part of vendorParts(doc.vendor)) names.add(part);
    for (const backend of doc.backedBy ?? []) for (const part of vendorParts(backend)) names.add(part);
  }
  for (const name of STATIC_VENDOR_NAMES) names.add(name);
  return [...names];
}

export const VENDOR_NAMES: string[] = deriveVendorNames();

// --- place -----------------------------------------------------------------------------------
export const PLACE_NAMES: string[] = ["Oslo", "Norway", "Norge", "Tønsberg", "Gardermoen", "New York", "Paris", "Bryggeveien"];

/** How a country an adapter declares in `region.countries` (ORB-184, ISO 3166-1 alpha-3) is
 *  actually SPELLED in prose — the country's names and its demonym (ORB-210 item 1).
 *
 *  A `place` or `language` word is banned in a role template because a role must be portable; it
 *  is REQUIRED in the doc of an adapter whose coverage genuinely stops at a border. Entur's
 *  summary has to say "Norwegian", because the whole Entur scar
 *  (docs/solutions/2026-08-25-entur-geocoder-is-norway-biased.md) is the agent not knowing that.
 *  So the doc lint licenses exactly the words that name a country the entry already declares —
 *  never a free pass on places, and nothing an entry has not declared.
 *
 *  Extend this as adapters declare more countries; an undeclared code licenses nothing, which
 *  fails loud rather than silently letting a place name through. */
export const COUNTRY_TERMS: Record<string, readonly string[]> = {
  NOR: ["Norway", "Norge", "Norwegian"],
};

// --- language --------------------------------------------------------------------------------
// A role must not say which language it works in — that's voice, not scope.
export const LANGUAGE_NAMES: string[] = ["Norwegian", "norsk", "bokmål", "nynorsk", "English"];

// --- tool names ------------------------------------------------------------------------------
// TOOL NAMES ARE AN EXEMPTION CLASS, matched as whole identifiers (ORB-210 item 3).
//
// This was already true by accident and is now true on purpose. `strava_routes` passed the vendor
// rule only because WORD_END below counts `_` as a word character, so `\bStrava\b`-style matching
// could never fire inside a snake_case identifier — an accident that would silently reverse the
// day someone dropped `_` from that class. It is a decision, and it is the right one: a role
// template that says "call `strava_routes`" is naming an INTERFACE the agent holds, not choosing
// a vendor. Renaming the tool is the only thing that can change it, and a portable role template
// still has to call the tool by the name eve exposes.
//
// The bare word is untouched: "Strava" in prose is still a vendor finding. Only the identifier is
// exempt, and only as a whole identifier — `_` and `-` count as identifier characters here, so a
// mention of `read_urls` is not licensed by the existence of `read_url`.
//
// The set is derived from CAPABILITY_DOCS, so a new tool is exempt the moment it is documented,
// with nothing to keep in sync by hand.
export const TOOL_NAMES: string[] = [...new Set(Object.values(CAPABILITY_DOCS).flatMap((d) => d.tools))];

const IDENT_START = "(?<![\\p{L}\\p{N}_-])";
const IDENT_END = "(?![\\p{L}\\p{N}_-])";

/** Word-bounded, case-sensitive matcher for one tool name — tool names are lowercase by
 *  convention and a capitalised near-miss is worth seeing rather than exempting. */
export const TOOL_NAME_PATTERNS: RegExp[] = TOOL_NAMES.map(
  (name) => new RegExp(`${IDENT_START}${escapeRegExp(name)}${IDENT_END}`, "u"),
);

export const RULES: VocabRule[] = [
  { rule: "person", patterns: PERSON_PATTERNS },
  { rule: "company", patterns: COMPANY_NAMES.map(term) },
  { rule: "vendor", patterns: VENDOR_NAMES.map(term) },
  { rule: "place", patterns: PLACE_NAMES.map(term) },
  { rule: "language", patterns: LANGUAGE_NAMES.map(term) },
  { rule: "address", patterns: [/[\w.+-]+@[\w-]+\.[\w.]+/] },
  { rule: "url", patterns: [/https?:\/\//] },
];

// --- the structural fallback for `person` -----------------------------------------------------
// Any `<Capitalised word> <Capitalised word>` pair is a CANDIDATE unlisted name — deliberately
// crude, so it also matches ordinary English ("The Brain", "Every Monday"). Two escapes, both
// required, keep it from drowning role prose in false positives without an ever-growing
// allowlist:
//
//   1. STRUCTURAL_PERSON_ALLOWLIST — an exact phrase that IS legitimate despite looking like a
//      name: role vocabulary ("Chief Of" [Staff], "Site Reliability" — extend
//      ROLE_VOCABULARY_ALLOWLIST for a new role title), plus every multi-word company/vendor/
//      place name declared above, so a known proper noun is reported once, by its own rule, not
//      twice more as an "unlisted person".
//   2. PERSON_NAME_STOPWORDS — ordinary English/role words (articles, determiners, pronouns,
//      prepositions, auxiliaries, weekdays, months, plus common role nouns). A candidate pair is
//      dismissed as ordinary prose the moment EITHER word is one of these — a real name
//      essentially never is.
export const CAPITALIZED_WORD = new RegExp(`${WORD_START}\\p{Lu}\\p{Ll}+${WORD_END}`, "gu");

export const ROLE_VOCABULARY_ALLOWLIST: string[] = ["Chief Of", "Site Reliability"];

function multiWordLower(names: string[]): string[] {
  return names.filter((name) => /\s/.test(name)).map((name) => name.toLowerCase());
}

export const STRUCTURAL_PERSON_ALLOWLIST: Set<string> = new Set([
  ...ROLE_VOCABULARY_ALLOWLIST.map((s) => s.toLowerCase()),
  ...multiWordLower(COMPANY_NAMES),
  ...multiWordLower(VENDOR_NAMES),
  ...multiWordLower(PLACE_NAMES),
  ...multiWordLower(LANGUAGE_NAMES),
]);

const ARTICLES = ["The", "A", "An"];
const DETERMINERS = [
  "This", "That", "These", "Those", "Every", "Each", "Some", "Any", "All", "No",
  "Both", "Either", "Neither", "My", "Your", "His", "Its", "Our", "Their",
];
const PRONOUNS = ["I", "You", "He", "She", "It", "We", "They", "Me", "Him", "Her", "Us", "Them", "Who", "Whom", "Whose", "Which"];
const PREPOSITIONS = [
  "Of", "In", "On", "At", "By", "For", "With", "About", "Against", "Between",
  "Into", "Through", "During", "Above", "Below", "To", "From", "Up", "Down", "Over", "Under", "Off", "Out",
];
const AUXILIARIES = ["Is", "Am", "Are", "Was", "Were", "Be", "Been", "Being", "Have", "Has", "Had", "Do", "Does", "Did", "Will", "Would", "Shall", "Should", "May", "Might", "Must", "Can", "Could"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Named explicitly in ORB-145 Phase 2's plan — words that read as role prose, not a name.
const ROLE_NOUNS = [
  "Chief", "Staff", "Site", "Reliability", "Brain", "Atlas", "Owner", "Store", "Answers",
  "Duties", "Discipline", "Before", "After", "Always", "Never", "How", "What", "When", "Where", "Why",
];

export const PERSON_NAME_STOPWORDS: Set<string> = new Set(
  [...ARTICLES, ...DETERMINERS, ...PRONOUNS, ...PREPOSITIONS, ...AUXILIARIES, ...WEEKDAYS, ...MONTHS, ...ROLE_NOUNS].map((w) =>
    w.toLowerCase(),
  ),
);
