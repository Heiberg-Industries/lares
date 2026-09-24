// services/atlas/lib/sources.ts
// `canonical_sources` is the derive-don't-curate contract: the list of things a note is
// re-rendered from. Exactly FOUR store prefixes exist and a fifth must never be invented —
// an unrecognised prefix is an ERROR, not a fallback, because the fallback would be a
// filesystem read of the box with a path this code did not choose.
import type { ParsedNote } from "./frontmatter.js";

export const STORE_PREFIXES = ["repo", "vault", "notion", "atlas"] as const;
export type StorePrefix = (typeof STORE_PREFIXES)[number];

export interface SourceRef {
  prefix: StorePrefix;
  /** Store-relative path, or a Notion page id. */
  locator: string;
  /** Exactly as written in the note — what a human sees in an error message. */
  declared: string;
  /**
   * `repo:` ONLY — the note's `codebase:`, carried so the reader knows WHICH repository the
   * locator is relative to. Three of the four stores are single-rooted (one Atlas, one
   * vault, one Notion workspace) but `repo:` spans seven repos under two different owners,
   * so a bare locator like `docs/CURRENT_STATUS.md` is meaningless on its own — every note
   * has one. It lives on the ref rather than being threaded through `resolveAll` because a
   * repo reference genuinely IS relative to a repo; that is a fact about the reference.
   *
   * Deliberately NOT part of `formatSourceRef`, so it never reaches `sourcesHash` or the
   * rendered `canonical_sources` — adding it must not restate every note's fingerprint.
   */
  codebase?: string;
}

const NOTION_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/**
 * A path may not climb out of its store. Syntactic on purpose: this runs before any store
 * root is chosen, so there is no real path to `realpath` yet. The adapters repeat the check
 * against real inodes once they DO have a root (a symlinked directory passes this one).
 * This layer additionally rejects backslashes (not legitimate in Atlas paths) and
 * percent-encoded traversals (%2e%2e) because those could evade a naive segment check.
 */
function assertContained(locator: string, declared: string): void {
  if (locator.startsWith("/") || locator.split("/").includes("..")) {
    throw new Error(`atlas: canonical source "${declared}" would escape its store root`);
  }
  if (locator.includes("\\")) {
    throw new Error(`atlas: canonical source "${declared}" would escape its store root`);
  }
  if (/%2e%2e/i.test(locator)) {
    throw new Error(`atlas: canonical source "${declared}" would escape its store root`);
  }
}

/**
 * `opts.codebase` is the note's `codebase:` value, or null when it has none. It answers two
 * questions at once — whether a bare, unprefixed path can mean anything (it cannot without a
 * repo), and WHICH repo a `repo:` locator is relative to — which is why it is the value
 * rather than a boolean: a boolean could say "yes there is a repo" without being able to
 * name it, and the reader needs the name.
 */
export function parseSourceRef(declared: string, opts: { codebase: string | null }): SourceRef {
  const trimmed = declared.trim();
  const colon = trimmed.indexOf(":");
  const head = colon === -1 ? "" : trimmed.slice(0, colon);

  if ((STORE_PREFIXES as readonly string[]).includes(head)) {
    const prefix = head as StorePrefix;
    const locator = trimmed.slice(colon + 1).trim();
    if (locator === "") throw new Error(`atlas: canonical source "${declared}" has an empty locator`);
    if (prefix === "notion") {
      if (!NOTION_ID.test(locator)) {
        throw new Error(`atlas: canonical source "${declared}" is not a Notion page id`);
      }
    } else {
      assertContained(locator, declared);
    }
    if (prefix === "repo") {
      if (opts.codebase === null) {
        throw new Error(
          `atlas: canonical source "${declared}" is a repo reference but the note has no ` +
          "codebase, so there is no repository for the path to be relative to.",
        );
      }
      return { prefix, locator, declared, codebase: opts.codebase };
    }
    return { prefix, locator, declared };
  }

  if (colon !== -1 && head !== "" && !head.includes("/") && !head.includes(" ")) {
    throw new Error(
      `atlas: unknown store prefix "${head}:" in canonical source "${declared}". Exactly four ` +
      `exist: ${STORE_PREFIXES.map((p) => `${p}:`).join(" ")} — do not invent a fifth.`,
    );
  }

  // Legacy: Part A's earlier notes (murmur, orakel, zero7, vol-de-nuit) list bare
  // repo-relative paths. They mean `repo:`, and the first mechanical pass normalises them —
  // but only where a repo exists for them to mean it against.
  if (opts.codebase === null) {
    throw new Error(
      `atlas: canonical source "${declared}" has no store prefix and the note has no codebase, ` +
      "so there is no repo to resolve it against. Give it an explicit prefix.",
    );
  }
  if (trimmed === "") throw new Error(`atlas: canonical source "${declared}" has an empty locator`);
  assertContained(trimmed, declared);
  return { prefix: "repo", locator: trimmed, declared, codebase: opts.codebase };
}

/** `codebase: —` is SCHEMA.md's "genuinely unknown" marker, not a path. */
export function hasCodebase(note: ParsedNote): boolean {
  const cb = note.frontmatter["codebase"];
  return typeof cb === "string" && cb.trim() !== "" && cb.trim() !== "—";
}

export function sourceRefsFor(note: ParsedNote): SourceRef[] {
  const raw = note.frontmatter["canonical_sources"];
  if (!Array.isArray(raw)) return [];
  const cb = note.frontmatter["codebase"];
  const opts = { codebase: hasCodebase(note) ? String(cb).trim() : null };
  return raw.map((entry) => parseSourceRef(String(entry), opts));
}

export function formatSourceRef(ref: SourceRef): string {
  return `${ref.prefix}:${ref.locator}`;
}

/**
 * The rendered `canonical_sources` value the mechanical pass writes. Quoting every entry
 * uniformly is what makes this a FIXED POINT: an already-normalised list renders
 * byte-identically, so an unchanged note produces no diff and therefore no commit.
 */
export function normaliseCanonicalSources(note: ParsedNote): string {
  return `[${sourceRefsFor(note).map((r) => `"${formatSourceRef(r)}"`).join(", ")}]`;
}
