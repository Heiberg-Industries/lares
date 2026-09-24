// The OKF (Open Knowledge Format) conformance check, moved here from services/atlas/lib/okf.ts
// so it can run over every area of the Vault (ADR-0017 rule 3), not only Atlas.
//
// OKF v0.2 requires exactly one frontmatter key — `type` — on every non-reserved .md file.
// The FIVE core values are the whole knowledge layer's shared floor (ADR-0010 §9); an area
// EXTENDS this list, it does not fork it — the taste store's vocabulary
// (packages/taste/src/index.ts:22) is the first example, added here as OKF_TASTE_TYPES.
//
// OKF's optional provenance families (`sources`, `generated`, `verified`, `stale_after`) are
// now adopted (ADR-0017 rule 3, reversing the 2026-08-11 decision recorded at the old
// services/atlas/lib/okf.ts:14-16) — permitted without comment, same as any other extra key.
//
// The `lares_*` extension fields are this decision's own addition. An unknown `lares_*` key is
// a finding, not a shrug: OKF permits arbitrary extra keys, but a field that LOOKS like one of
// ours and is misspelled or invented should not pass silently.
//
// This module owns a SELF-CONTAINED shallow frontmatter reader — it does not import atlas's
// parseNote (services/atlas/lib/frontmatter.ts): the kit cannot depend on a service. The shape
// is copied from frontmatter.ts:42-54; OKF's own rule is one required scalar, so nothing
// deeper than that is needed here.
import { isOrigin, ORIGIN_FRONTMATTER_KEY } from "./origin.js";

/** ADR-0010 §9's five, the shared floor every area starts from. */
export const OKF_CORE_TYPES = ["venture", "index", "reference", "profile", "note"] as const;

/** The taste store's additions (packages/taste/src/index.ts:22). */
export const OKF_TASTE_TYPES = ["place", "track", "playlist", "dish", "note"] as const;

export const OKF_OPTIONAL_FAMILIES = ["sources", "generated", "verified", "stale_after"] as const;

/** ADR-0017's extension fields. An unknown `lares_*` key is a finding, not a shrug. */
export const LARES_FIELDS = [
  "lares_origin",
  "lares_valid_from",
  "lares_valid_to",
  "lares_supersedes",
  "lares_scope",
] as const;

export interface ConformanceFinding {
  path: string;
  problem: "no-frontmatter" | "no-type" | "unknown-type" | "unknown-lares-field" | "bad-lares-origin";
  found?: string;
}

export interface ConformanceArea {
  /** For the message only — "brain", "atlas", "taste". */
  name: string;
  types: readonly string[];
  files: ReadonlyArray<{ path: string; raw: string }>;
}

/**
 * Shallow scalar frontmatter read: CRLF-normalised first, `---` required on line 1, the
 * closing `---` located, blank / `#` / indented lines skipped, each remaining line split on
 * the first `:`. Keys are the trimmed left side; values the trimmed right side with
 * surrounding quotes stripped. Returns undefined when there is no parseable block at all —
 * that is the `no-frontmatter` case; a missing or unterminated block is not distinguished
 * further, since the caller only needs to know whether a block was found.
 */
function readFrontmatter(raw: string): Record<string, string> | undefined {
  const text = raw.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return undefined;

  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trimStart().startsWith("#") || line.startsWith(" ")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    frontmatter[key] = value;
  }
  return frontmatter;
}

/** OKF's own conformance rule, widened to also validate the `lares_*` extension fields. */
export function checkConformance(
  files: ReadonlyArray<{ path: string; raw: string }>,
  opts: { types: readonly string[] },
): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  for (const f of files) {
    const frontmatter = readFrontmatter(f.raw);
    if (frontmatter === undefined) {
      findings.push({ path: f.path, problem: "no-frontmatter" });
      continue;
    }

    const type = frontmatter["type"];
    if (type === undefined || type.trim() === "") {
      findings.push({ path: f.path, problem: "no-type" });
    } else if (!opts.types.includes(type)) {
      findings.push({ path: f.path, problem: "unknown-type", found: type });
    }

    // Additive: a file with a type problem can still get a field finding too.
    for (const key of Object.keys(frontmatter)) {
      if (!key.startsWith("lares_")) continue;
      if (!(LARES_FIELDS as readonly string[]).includes(key)) {
        findings.push({ path: f.path, problem: "unknown-lares-field", found: key });
        continue;
      }
      if (key === ORIGIN_FRONTMATTER_KEY && !isOrigin(frontmatter[key])) {
        findings.push({ path: f.path, problem: "bad-lares-origin", found: frontmatter[key] });
      }
    }
  }
  return findings;
}

/** One call over every configured area; findings carry `<area>/<path>`. */
export function checkAreas(areas: readonly ConformanceArea[]): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  for (const area of areas) {
    for (const f of checkConformance(area.files, { types: area.types })) {
      findings.push({ ...f, path: `${area.name}/${f.path}` });
    }
  }
  return findings;
}
