// services/atlas/lib/portfolio.ts
// `_portfolio.md`'s card list (the index of project notes), regenerated from the project notes'
// OWN frontmatter.
//
// This is the one place the job derives an Atlas file from other Atlas files, and it closes a
// drift that had to be fixed by hand once: the index claimed a project was blocked seven weeks
// after its repo said the blocker had COMPLETED. A card that restates a note's `status` and
// `one_liner` cannot disagree with the note, because it IS the note.
//
// Only the marked block is regenerated. The prose around it — the section headings' intent,
// the footer — is the owner's, and a generator that owned the whole file would silently eat it.
import type { ParsedNote } from "./frontmatter.js";
import { setFrontmatterKeys } from "./frontmatter.js";

export interface ProjectCard {
  brand: string;
  status: string;
  oneLiner: string;
  notePath: string;
  /** Part A's confidentiality flag, carried so the map keeps saying it (design §3.4). */
  confidential: boolean;
}

const BEGIN = "<!-- BEGIN GENERATED -->";
const END = "<!-- END GENERATED -->";

/**
 * The markers ARE the opt-in, and this asks only whether the file MENTIONS one. Three cases,
 * three behaviours, and the middle one is the reason this is not an "are both present?"
 * check: NEITHER marker means hand-written on purpose (skip, quietly); BOTH mean generate;
 * exactly ONE means someone edited the file badly, and `renderPortfolio` throws so that lands
 * as a loud failure. Collapsing the first and third would make real damage look like a
 * settled decision.
 *
 * The owner's call, made against the actual rendered output rather than in the abstract:
 * generating a hand-organised index would flatten its meaningful sections into one alphabetical
 * list, drop entries that have no `_projects/` note, and write `brand:` slugs over real names.
 * The drift it would prevent is real but smaller than what it would break.
 *
 * To turn generation ON later: fix the notes' `brand:` values to their real casing, then wrap
 * the card list in these two markers. No code change needed.
 */
export function optsIntoGeneration(raw: string): boolean {
  return raw.includes(BEGIN) || raw.includes(END);
}
const CONFIDENTIAL = /do not surface publicly/i;

export function cardFor(notePath: string, note: ParsedNote): ProjectCard {
  const str = (k: string) => String(note.frontmatter[k] ?? "—");
  return {
    brand: str("brand"),
    status: str("status"),
    oneLiner: str("one_liner"),
    notePath,
    // Read from the BODY, because that is where Part A put it and where an agent drafting
    // outbound copy will see it. Naming a thing internally and publishing it are different
    // acts, and this flag governs the second.
    //
    // The paragraph break is the real boundary the phrase must not straddle; inside a
    // paragraph, all whitespace — spaces, tabs, a prose-wrap newline, a stray CR left over
    // from CRLF-authored text `parseNote` doesn't normalise — is noise. So: split into
    // paragraphs FIRST (tolerating CRLF and indented blank lines), THEN collapse everything
    // within each paragraph to a single space. Doing it in the other order (collapse first,
    // split second) was round 2's bug: a blanket `/\s+/g` before any split dissolves the
    // paragraph boundary itself, bridging two unrelated paragraphs. Splitting on a narrower
    // pattern than the paragraphs actually use (LF-only, no CRLF) was this round's bug: it
    // missed a CRLF wrap entirely, and doubled internal spaces were never handled by the
    // narrowed within-paragraph collapse either.
    confidential: CONFIDENTIAL.test(
      note.body.split(/\r?\n[ \t]*\r?\n/).map((para) => para.replace(/\s+/g, " ")).join("\n\n"),
    ),
  };
}

function line(c: ProjectCard): string {
  const tail = c.confidential ? " *Do not surface publicly.*" : "";
  return `- **${c.brand}** — ${c.oneLiner} **${c.status}.** → \`${c.notePath}\`${tail}`;
}

/**
 * Deterministic in every respect: cards are sorted by brand, so the order does not depend
 * on directory-read order (which differs between the box's ext4 and a Mac's APFS).
 * `today` stamps `last_synced` ONLY when the block actually changed — same rule, same
 * reason, as mechanicalRefresh.
 */
export function renderPortfolio(cards: ProjectCard[], today: string, existingRaw: string): string {
  const start = existingRaw.indexOf(BEGIN);
  const end = existingRaw.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `atlas: _portfolio.md has no ${BEGIN} … ${END} block. Refusing to regenerate it — ` +
      "without the markers this would overwrite hand-written prose.",
    );
  }

  // Tiebreak on notePath: `Array.prototype.sort` is stable, so two cards with the SAME
  // brand (both "—", the unknown marker, is the realistic case) would otherwise fall back
  // to INPUT order — which is directory-read order upstream, and that is exactly the
  // ext4-vs-APFS churn this function exists to avoid.
  const sorted = [...cards].sort(
    (a, b) => a.brand.localeCompare(b.brand, "en") || a.notePath.localeCompare(b.notePath, "en"),
  );
  const open = sorted.filter((c) => !c.confidential);
  const closed = sorted.filter((c) => c.confidential);

  const block = [
    BEGIN,
    "",
    ...open.map(line),
    ...(closed.length > 0
      ? ["", "## Not public (tracked internally)", "", ...closed.map(line)]
      : []),
    "",
    END,
  ].join("\n");

  const rebuilt = existingRaw.slice(0, start) + block + existingRaw.slice(end + END.length);
  if (rebuilt === existingRaw) return existingRaw;      // fixed point: no stamp, no diff
  return setFrontmatterKeys(rebuilt, { last_synced: today });
}
