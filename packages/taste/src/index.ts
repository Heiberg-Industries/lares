// packages/taste/src/index.ts
// The taste store's entry shape (ORB-97 parent, ORB-98).
//
// `/srv/taste` is a plain markdown store: one file per entry, OKF-shaped frontmatter with
// `type:` required. TWO processes touch it — the console writes it, Marcel reads it — and the
// compose-contract lesson (ORB-94) says a shape held in two places forks. So the shape lives
// here, in one pure package both sides import, and nowhere else.
//
// Pure: no fs, no deps. Callers own reading and writing files; this file owns what a file MEANS.
//
// Vocabulary: OKF v0.2's `type` is required on every non-reserved .md file. The Atlas fixed the
// portfolio's five values (`venture | index | reference | profile | note`, ADR-0010 §9) and said
// in as many words that the taste store EXTENDS that list rather than forking it — so `note` is
// the shared value and `place | track | playlist | dish` are this store's additions.
//
// Why frontmatter is hand-rolled rather than a YAML dependency: same reason the Atlas does it
// (`services/atlas/lib/frontmatter.ts`) — a YAML round-trip rewrites quoting and key order on
// every write, turning a no-op into a diff. Here the stakes are lower (the console rewrites whole
// files) but the store is ALSO hand-editable by Bendik, and a parser that quietly reformats his
// file is a parser that loses his intent.

export const TASTE_TYPES = ["place", "track", "playlist", "dish", "note"] as const;
export type TasteType = (typeof TASTE_TYPES)[number];

export const TASTE_DOMAINS = ["places", "music", "food", "notes"] as const;
export type TasteDomain = (typeof TASTE_DOMAINS)[number];

/**
 * When the store last touched this entry — the only fields here that describe the FILE rather
 * than the thing (ORB-110). `importedAt` is stamped once, when the entry first lands;
 * `updatedAt` when a later import actually changes it. Both are ISO-8601 instants.
 *
 * Every entry that predates ORB-110 has neither, and that is a legitimate state, not a gap to
 * backfill: "we do not know when this arrived" is the truth about 862 places imported before
 * anything recorded it. The browse view reads absence as "not fresh" and shows no badge.
 */
interface StoreStamps {
  readonly importedAt?: string;
  readonly updatedAt?: string;
}

/** A saved place — the Google Maps / Takeout shape, and the only type with coordinates.
 *  `note` is the file BODY (free prose), not a frontmatter scalar, so it may run to several
 *  paragraphs without any escaping games. */
export interface PlaceEntry extends StoreStamps {
  readonly type: "place";
  readonly name: string;
  readonly lat?: number;
  readonly lon?: number;
  readonly city?: string;
  /** Operator-supplied, per list, at import (ORB-110) — never geocoded. A country is a fact
   *  about the list ("this is my Copenhagen list"), not something to pay an API to guess. */
  readonly country?: string;
  readonly url?: string;
  /**
   * Google's REAL place id (`ChIJ…`), captured whenever a Places match is accepted (ORB-117).
   *
   * Worth far more than the coordinate it arrives with: the saved URL's feature id is useless to
   * every supported API, but a `place_id` is accepted by Place Details forever after — so an entry
   * holding one can be refreshed for opening hours, rating or a moved address, cheaply and
   * exactly, without ever guessing again.
   */
  readonly placeId?: string;
  /**
   * True when `lat`/`lon` came from decoding the saved URL's S2 cell rather than from a confirmed
   * match — a real pin, typically city- to neighbourhood-accurate, occasionally kilometres stale.
   *
   * The flag exists because the two kinds of pin must be used differently: an approximate pin is
   * fine for "which city is this in" and for a map dot, and is NOT fine for Marcel's 250 m
   * proximity alert, which would otherwise fire on the wrong street.
   */
  readonly approx?: boolean;
  /** `formattedAddress` from the accepted match — the source city and country are derived from
   *  it, so it is kept rather than parsed-and-discarded. */
  readonly address?: string;
  /** Which saved list this came from — half of the upsert key (see `entryFilename`). */
  readonly sourceList?: string;
  readonly note?: string;
}

/** Everything that is a LIST rather than a pin: a playlist, a run of tracks, dishes to cook,
 *  a freeform note. One file per list; the body is markdown list items. */
export interface ListEntry extends StoreStamps {
  readonly type: Exclude<TasteType, "place">;
  readonly name: string;
  readonly sourceList?: string;
  readonly items: readonly string[];
}

export type TasteEntry = PlaceEntry | ListEntry;

const DOMAIN_BY_TYPE: Record<TasteType, TasteDomain> = {
  place: "places",
  track: "music",
  playlist: "music",
  dish: "food",
  note: "notes",
};

/** Which folder under `/srv/taste` an entry belongs in. The layout IS the taxonomy, same as
 *  the Atlas — a caller that invents its own folder puts files somewhere nothing reads. */
export function domainFor(type: TasteType): TasteDomain {
  return DOMAIN_BY_TYPE[type];
}

export function isPlace(entry: TasteEntry): entry is PlaceEntry {
  return entry.type === "place";
}

// ── frontmatter scalars ──────────────────────────────────────────────────────────────────

const FENCE = "---";

/** Quote only when the raw form would not survive the round trip: a value that is empty, that
 *  carries meaningful leading/trailing space, that opens with a character the parser treats
 *  specially, or that contains a line break. Everything else stays bare and readable — the
 *  point of this store is that Bendik can open a file and edit it. */
function serializeScalar(value: string): string {
  const needsQuoting =
    value === "" ||
    value !== value.trim() ||
    /^[["'#|>&*!%@`]/.test(value) ||
    /[\n\r]/.test(value);
  return needsQuoting ? JSON.stringify(value) : value;
}

function parseScalar(text: string): string {
  const t = text.trim();
  if (t.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Hand-edited, unbalanced quotes: fall through and take it literally rather than
      // failing the whole file over one line.
    }
  }
  return t;
}

/** Shallow key/value scan of the frontmatter block. Unknown keys are ignored rather than
 *  rejected (a hand-added `# note to self` or an extra key must not make a file unreadable);
 *  the caller's own validation is what decides whether the KNOWN keys make sense. */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== FENCE) {
    throw new Error("taste: entry has no frontmatter block (first line must be `---`)");
  }
  const end = lines.indexOf(FENCE, 1);
  if (end === -1) {
    throw new Error("taste: entry has an unterminated frontmatter block (no closing `---`)");
  }
  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trimStart().startsWith("#") || line.startsWith(" ")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim()] = parseScalar(line.slice(colon + 1));
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

// ── validation ───────────────────────────────────────────────────────────────────────────

function requireType(found: string | undefined): TasteType {
  if (found === undefined || found === "") {
    throw new Error(
      `taste: entry has no \`type:\` — OKF requires one of ${TASTE_TYPES.join(" | ")} on every file`,
    );
  }
  if (!(TASTE_TYPES as readonly string[]).includes(found)) {
    throw new Error(`taste: unknown \`type: ${found}\` — expected one of ${TASTE_TYPES.join(" | ")}`);
  }
  return found as TasteType;
}

function requireName(found: string | undefined): string {
  const name = found ?? "";
  if (name.trim() === "") throw new Error("taste: entry has no `name:` — an unnamed entry is unreachable");
  return name;
}

/**
 * A store stamp, or nothing. Unlike a coordinate, a bad timestamp is DROPPED rather than thrown
 * on — deliberately, and this is the one place in this file that bends the "validate the known
 * keys" rule.
 *
 * The asymmetry is about what the field costs when it is wrong. A bad `lat` would send Marcel to
 * the wrong side of a city, so it must stop the file. A bad `imported_at` — a date Bendik typed
 * by hand into a file he is allowed to hand-edit — drives one cosmetic badge in the browse view.
 * Throwing would make the whole entry unreadable, which in Marcel's reader means the PLACE
 * disappears from his recommendations. Losing a badge is the smaller loss by a wide margin.
 */
function parseStamp(text: string | undefined): string | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  return Number.isFinite(Date.parse(text)) ? text.trim() : undefined;
}

function parseCoord(field: "lat" | "lon", text: string): number {
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error(`taste: \`${field}: ${text}\` is not a number`);
  const limit = field === "lat" ? 90 : 180;
  if (Math.abs(n) > limit) throw new Error(`taste: \`${field}: ${text}\` is out of range (±${limit})`);
  return n;
}

// ── parse / serialize ────────────────────────────────────────────────────────────────────

/** Read one taste file. Throws — loudly and specifically — on anything the store must never
 *  hold: no frontmatter, no `type:`, a type outside the vocabulary, no name, half a coordinate. */
export function parseEntry(raw: string): TasteEntry {
  const { fields, body } = parseFrontmatter(raw);
  const type = requireType(fields["type"]);
  const name = requireName(fields["name"]);
  const sourceList = fields["source_list"];
  const importedAt = parseStamp(fields["imported_at"]);
  const updatedAt = parseStamp(fields["updated_at"]);
  const stamps = {
    ...(importedAt === undefined ? {} : { importedAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };

  if (type !== "place") {
    return {
      type,
      name,
      ...(sourceList === undefined ? {} : { sourceList }),
      ...stamps,
      items: parseItems(body),
    };
  }

  const hasLat = fields["lat"] !== undefined;
  const hasLon = fields["lon"] !== undefined;
  if (hasLat !== hasLon) {
    throw new Error(`taste: place "${name}" has a \`lat\` without a \`lon\` (or the reverse) — half a coordinate is unusable`);
  }

  const note = body.trim();
  return {
    type: "place",
    name,
    ...(hasLat ? { lat: parseCoord("lat", fields["lat"]!), lon: parseCoord("lon", fields["lon"]!) } : {}),
    // `approx` is only meaningful alongside a coordinate, and only ever true — an entry with a
    // confirmed pin simply omits the key rather than writing `approx: false` on 900 files.
    ...(hasLat && fields["approx"] === "true" ? { approx: true } : {}),
    ...(fields["city"] === undefined ? {} : { city: fields["city"] }),
    ...(fields["country"] === undefined ? {} : { country: fields["country"] }),
    ...(fields["url"] === undefined ? {} : { url: fields["url"] }),
    ...(fields["place_id"] === undefined ? {} : { placeId: fields["place_id"] }),
    ...(fields["address"] === undefined ? {} : { address: fields["address"] }),
    ...(sourceList === undefined ? {} : { sourceList }),
    ...stamps,
    ...(note === "" ? {} : { note }),
  };
}

/** Body → list items. A leading `-` or `*` bullet is stripped; a bare line is KEPT as an item
 *  rather than dropped, because a pasted list is exactly as tidy as whatever Bendik pasted. */
function parseItems(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => l.replace(/^[-*]\s+/, ""));
}

/** Write one taste file. Validates first — an entry this function accepts is an entry
 *  `parseEntry` can read back, which is the property the round-trip tests pin. */
export function serializeEntry(entry: TasteEntry): string {
  requireType(entry.type);
  requireName(entry.name);

  const head: string[] = [`type: ${entry.type}`, `name: ${serializeScalar(entry.name)}`];
  if (isPlace(entry)) {
    if ((entry.lat === undefined) !== (entry.lon === undefined)) {
      throw new Error(`taste: place "${entry.name}" needs both lat and lon, or neither`);
    }
    if (entry.city !== undefined) head.push(`city: ${serializeScalar(entry.city)}`);
    if (entry.country !== undefined) head.push(`country: ${serializeScalar(entry.country)}`);
    if (entry.lat !== undefined) {
      head.push(`lat: ${parseCoord("lat", String(entry.lat))}`);
      head.push(`lon: ${parseCoord("lon", String(entry.lon))}`);
      if (entry.approx) head.push("approx: true");
    } else if (entry.approx) {
      throw new Error(`taste: place "${entry.name}" is flagged approx with no coordinate to qualify`);
    }
    if (entry.address !== undefined) head.push(`address: ${serializeScalar(entry.address)}`);
    if (entry.url !== undefined) head.push(`url: ${serializeScalar(entry.url)}`);
    if (entry.placeId !== undefined) head.push(`place_id: ${serializeScalar(entry.placeId)}`);
  }
  if (entry.sourceList !== undefined) head.push(`source_list: ${serializeScalar(entry.sourceList)}`);
  // Stamps go last: they change on every touch, so keeping them at the bottom means a re-import
  // that changed nothing else produces a diff confined to the final lines.
  for (const [key, value] of [["imported_at", entry.importedAt], ["updated_at", entry.updatedAt]] as const) {
    if (value === undefined) continue;
    if (parseStamp(value) === undefined) {
      throw new Error(`taste: \`${key}: ${value}\` on "${entry.name}" is not a readable timestamp`);
    }
    head.push(`${key}: ${value}`);
  }

  const body = isPlace(entry) ? (entry.note ?? "").trim() : entry.items.map((i) => `- ${i}`).join("\n");

  const out = [FENCE, ...head, FENCE];
  if (body !== "") out.push("", body);
  return out.join("\n") + "\n";
}

// ── filenames ────────────────────────────────────────────────────────────────────────────

/** ASCII-safe slug. Norwegian letters are FOLDED, not stripped: `ø`/`æ`/`å` have no canonical
 *  NFD decomposition worth relying on across ext4 (box) and APFS (Mac), and stripping them
 *  turns "Nøtterøy" into "nttery". Same fix as Marcel's own `normalizePlaceName`. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "aa")
    .replace(/œ/g, "oe")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The file name IS the upsert key. Re-importing the same saved list must overwrite its entries
 * rather than pile up duplicates (ORB-99's acceptance criterion), and the cheapest way to get
 * that is a name derived deterministically from (sourceList, name) — write the file, done. No
 * index, no scan, no dedupe pass.
 *
 * Collision is possible in principle (two names slugifying identically within one list) and
 * accepted: the second would overwrite the first. In a hand-curated store that is a visible,
 * recoverable outcome; a hash suffix would trade it for filenames nobody can read.
 */
export function entryFilename(entry: TasteEntry): string {
  const name = slugify(entry.name);
  if (name === "") {
    throw new Error(`taste: "${entry.name}" slugifies to nothing — it has no addressable file name`);
  }
  const list = entry.sourceList === undefined ? "" : slugify(entry.sourceList);
  return list === "" ? `${name}.md` : `${list}--${name}.md`;
}

/** FNV-1a, 32-bit. Inline rather than `node:crypto` so this package stays dependency-free; a
 *  filename discriminator needs distinctness, not cryptographic strength. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/** What makes two same-named entries genuinely different places: the saved URL first (a Takeout
 *  export's true identity), then coordinates, then the list body. */
function identityOf(entry: TasteEntry): string {
  if (isPlace(entry)) {
    if (entry.url !== undefined) return entry.url;
    if (entry.lat !== undefined) return `${entry.lat},${entry.lon}`;
    return entry.name;
  }
  return entry.items.join(" ");
}

/**
 * Assigns each entry the file it should be written to, keeping distinct entries distinct.
 *
 * `entryFilename` alone is the upsert key, and that is right for the common case — re-import a
 * saved list and its entries overwrite themselves. But a real saved list holds the same NAME at
 * different places: Bendik's NYC list has two Supremes, two Roberta's and two Santo Tacos,
 * blocks apart. Keyed on (list, name) alone, one silently overwrote the other and three real
 * pins vanished — invisible, because the remaining count still looked plausible.
 *
 * So: a name unique within the batch keeps its plain, readable filename. A name that collides
 * gives EVERY member of that group a short suffix derived from the entry's own identity — not
 * from its position — so re-importing the same list reproduces exactly the same filenames and
 * still upserts cleanly. Two entries sharing a name AND an identity are the same place listed
 * twice, and collapse to one file, which is correct.
 *
 * (Going from one Supreme to two does rename the first. That is a one-time rename on the import
 * that discovers the collision; the alternative — always suffixing — costs every file its
 * readability to protect the 2% that collide.)
 */
export function assignFilenames(entries: readonly TasteEntry[]): Array<{ entry: TasteEntry; file: string }> {
  const byBase = new Map<string, TasteEntry[]>();
  for (const entry of entries) {
    const base = entryFilename(entry);
    const group = byBase.get(base);
    if (group) group.push(entry);
    else byBase.set(base, [entry]);
  }

  return entries.map((entry) => {
    const base = entryFilename(entry);
    const group = byBase.get(base)!;
    const distinct = new Set(group.map(identityOf)).size;
    return group.length === 1 || distinct === 1
      ? { entry, file: base }
      : { entry, file: `${base.slice(0, -".md".length)}--${fnv1a(identityOf(entry))}.md` };
  });
}
