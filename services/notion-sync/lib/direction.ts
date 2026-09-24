// The ONE definition of what a row's `direction` means — who owns the document,
// and therefore which side this service is allowed to write.
//
// It exists because the value was previously read as a BOOLEAN. Every branch point
// asked `=== "two_way"` and treated the else-branch as "mirror", which made the
// third value the schema has always allowed (`notion_to_md`, sql/015) behave
// byte-for-byte like `md_to_notion`: a Notion edit reverted from the vault with no
// 👍, a trashed page recreated from the vault, a "🔒 Mirror" stamp and a page lock
// on a document Notion authored. The column said one thing and the code did
// another, on the exact direction Phase 4 needs (T4's transcripts are one-way
// Notion→vault permanently, spec §17.2; T6's Notion-born pages are Notion-primary).
//
// Two predicates rather than three constants used inline, so a new branch point has
// to answer the OWNERSHIP question rather than re-derive it from a string compare:
//
//   md_to_notion  vaultOwns   — the vault is the source, Notion is its projection.
//                               Push writes Notion; a Notion edit is reverted.
//   two_way       (neither)   — negotiated. Notion edits arrive as 👍-gated
//                               proposals; the vault pushes.
//   notion_to_md  notionOwns  — Notion is the source, the vault is its projection.
//                               Notion edits arrive as 👍-gated proposals; the vault
//                               NEVER writes Notion, in any pass.
//
// Pure: no imports, no I/O. Both engines and the composition root read it.
import type { DeskRow, LinkedRow } from "./store.js";

/** The vault is the source of truth; Notion is a projection of it (the default). */
export const MD_TO_NOTION = "md_to_notion";
/** Both sides may write; disagreements go to a human (spec §6/§18.4). */
export const TWO_WAY = "two_way";
/** Notion is the source of truth; the vault is a projection of it (Phase 4). */
export const NOTION_TO_MD = "notion_to_md";

/**
 * "Vault wins, always" — the mirror. The ONLY direction for which this service may
 * write Notion from the vault without asking: the wholesale page revert
 * (`revertMirror`), the recreate-from-vault when a page is trashed, the push
 * pass's patches and its Archived=true sweep.
 *
 * Phrased as the positive case on purpose. It used to be `!== "two_way"`, and every
 * one of those writes silently applied to `notion_to_md` too.
 */
export function vaultOwns(direction: string): boolean {
  return direction === MD_TO_NOTION;
}

/**
 * Notion is the source; the vault is downstream. No pass may write Notion from the
 * vault for these rows — not a patch, not a recreate, not an Archived flag. Notion's
 * own edits still reach the vault the way every Notion→vault write does: as a
 * proposal behind Bendik's 👍.
 */
export function notionOwns(direction: string): boolean {
  return direction === NOTION_TO_MD;
}

/** The vault paths in a row snapshot that Notion owns — the push pass's hold-back set. */
export function notionOwnedPaths(rows: Map<string, DeskRow>): Set<string> {
  const paths = new Set<string>();
  for (const [vaultPath, row] of rows) {
    if (notionOwns(row.direction)) paths.add(vaultPath);
  }
  return paths;
}

/**
 * Every vault path the PUSH passes must not write, computed from the ACROSS-TARGETS
 * snapshot (`getLinkedRows`) rather than the desk-only one (Phase 4, review round 1).
 *
 * Two facts, one consequence, which is why they share a set:
 *
 *  - **Notion owns the document** (`notion_to_md`). The vault file is a projection,
 *    so pushing it back is the projection overwriting its own source.
 *  - **Another target owns the path.** A transcript's state row is a MEETINGS row
 *    with a vault_path, and `getDocRows` — the only rows the push engine sees — is
 *    `target='docs'`. So the push reads "no row for this path" as "adopt it",
 *    creates a second Notion page, and the adoption write repoints the Meetings row
 *    at the page it just invented. Config's `deskDirs[].exclude` normally keeps the
 *    file out of the walker's listing entirely — but that is a line in a config file
 *    an operator edits, and this is what has to hold when it is not there.
 *
 * The second test is on the TARGET, not on the direction, and that is deliberate
 * even though every Meetings row is `notion_to_md` today: the question being asked
 * is "does another pass own this path", and answering it with a direction would
 * silently stop working the day a row of another target carries a different one.
 *
 * Derived from the store rather than from config on purpose: the carve-out is the
 * thing that can go missing, so the guard that replaces it must depend on the state
 * row, which cannot.
 */
export function pushHoldBack(rows: Map<string, LinkedRow>): Set<string> {
  const paths = new Set<string>();
  for (const [vaultPath, row] of rows) {
    if (notionOwns(row.direction) || row.target !== "docs") paths.add(vaultPath);
  }
  return paths;
}
