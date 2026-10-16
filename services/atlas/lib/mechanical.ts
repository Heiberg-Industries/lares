// services/atlas/lib/mechanical.ts
// The deterministic half of a refresh: fields that are COMPUTED, never drafted, and
// therefore need no model and no 👍 (spec §4.2, "split by determinism").
//
// THE RULE THIS FILE EXISTS TO ENFORCE: `last_synced` is stamped ONLY when something else
// changed. A pass that stamped it every run would make the wall clock a content source —
// every tick a diff, every diff a commit, and every commit a change to an `atlas:` source
// that other notes derive from. That is the "correct for one tick, broken on the next"
// defect arriving through the front door, and `mechanicalRefresh` being pure (the date is a
// PARAMETER, never `new Date()`) is what makes a test able to catch it.
import { parseNote, setFrontmatterKeys } from "./frontmatter.js";
import { okfTypeFor } from "./okf.js";
import { normaliseCanonicalSources } from "./sources.js";

export interface MechanicalInput {
  /** Atlas-relative path — decides the OKF type and whether this is a venture note. */
  path: string;
  raw: string;
  /** YYYY-MM-DD. A parameter, never read from the clock in here. */
  today: string;
}

export interface MechanicalResult {
  raw: string;
  changed: boolean;
  /** Which frontmatter fields moved — for the commit message and the run summary. */
  fields: string[];
}

function isVentureNote(path: string): boolean {
  return path.normalize("NFC").toLowerCase().startsWith("_projects/");
}

/**
 * Detects an opening frontmatter fence tolerantly: past a leading BOM, and past a CRLF line
 * ending. Getting this wrong is silent and destructive, not merely inconvenient — a note
 * that already HAS frontmatter but fails a strict `raw.startsWith("---\n")` check reads as
 * having none, so `ensureFrontmatter` PREPENDS a second block, demoting the real one
 * (brand, status, canonical_sources, last_synced) into the body. The result is idempotent
 * afterwards, so it never self-corrects and never re-flags — the one shot at catching it is
 * this check. Only the DETECTION is tolerant; no bytes are rewritten here or elsewhere.
 */
function hasOpeningFence(raw: string): boolean {
  const withoutBom = raw.startsWith("﻿") ? raw.slice(1) : raw;
  return withoutBom.startsWith("---\n") || withoutBom.startsWith("---\r\n");
}

/** A file with no frontmatter at all (the icp/ files) gets the minimum OKF needs. */
function ensureFrontmatter(path: string, raw: string): { raw: string; added: boolean } {
  if (hasOpeningFence(raw)) return { raw, added: false };
  return { raw: `---\ntype: ${okfTypeFor(path)}\n---\n\n${raw.replace(/^\n+/, "")}`, added: true };
}

export function mechanicalRefresh(input: MechanicalInput): MechanicalResult {
  const seeded = ensureFrontmatter(input.path, input.raw);
  const fields: string[] = seeded.added ? ["type"] : [];

  let raw = seeded.raw;
  const note = parseNote(raw);
  const updates: Record<string, string> = {};

  const wantType = okfTypeFor(input.path);
  if (note.frontmatter["type"] !== wantType) {
    updates["type"] = wantType;
    if (!seeded.added) fields.push("type");
  }

  // canonical_sources and last_synced belong to venture notes. The ICP profiles, the
  // portfolio map and the entity map are not derived from a source list, and inventing an
  // empty one for them would be a lie in the shape of a contract.
  //
  // The "current" value is read off `note.frontmatter`, already parsed by `parseNote`, not
  // by re-scanning `raw` for a line starting with `canonical_sources:`. A line scan breaks
  // on real files in three ways: a value containing a colon inside a locator (Notion page
  // titles, `vault:` paths under a folder with a colon in its name) would still match the
  // `startsWith` test but the comparison itself is fine there — the real hazards are (a) the
  // BODY containing a line that happens to start with `canonical_sources:` (a code fence
  // quoting frontmatter, for instance, which this store's own docs do), which a raw scan
  // would find first if it ever searched past the closing `---`, and (b) a multi-line YAML
  // block value, which `parseScalar` doesn't support today but a raw-line scan would silently
  // read as a single truncated line instead of erroring. Comparing against the value
  // `parseNote` already produced reuses the one parser this codebase trusts instead of a
  // second, weaker one, and can't be fooled by either case.
  if (isVentureNote(input.path) && Array.isArray(note.frontmatter["canonical_sources"])) {
    const normalised = normaliseCanonicalSources(note);
    const current = `[${(note.frontmatter["canonical_sources"] as string[]).map((s) => `"${s}"`).join(", ")}]`;
    if (current !== normalised) {
      updates["canonical_sources"] = normalised;
      fields.push("canonical_sources");
    }
  }

  if (fields.length === 0) return { raw: input.raw, changed: false, fields: [] };

  // Something DID change — so, and only so, the freshness stamp moves.
  if (note.frontmatter["last_synced"] !== undefined) {
    updates["last_synced"] = input.today;
    fields.push("last_synced");
  }

  raw = setFrontmatterKeys(raw, updates);
  return { raw, changed: raw !== input.raw, fields: [...new Set(fields)].sort() };
}
