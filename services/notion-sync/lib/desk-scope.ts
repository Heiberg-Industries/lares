// The ONE definition of "config has carved this path out of the desk scope"
// (Phase 4, `deskDirs[].exclude`). A pure function of config, imported by every
// boundary that decides what a desk pass may see: the push pass's file discovery
// (adapters/vault-files.ts), its row-side scope (wiki-sync.ts), the pull pass's
// row loop (pull-sync.ts), and the two operator commands that write Notion for a
// whole snapshot (cli.ts reconcile / enable-two-way).
//
// Its own module rather than config.ts because config.ts is the PARSER — it reads
// and validates the file at startup and reaches for node:fs to do it. This is a
// question asked of already-parsed config on every tick, by pure engines that must
// stay free of the filesystem. Same split as store.ts (writes) vs the engines that
// ask it questions.
import type { DesksConfig, NotionSyncConfig } from "./types.js";

/**
 * Containment by PATH SEGMENT, never by bare string prefix: `path` is `dir`
 * itself, or lives underneath it.
 *
 * The naked `startsWith(dir)` this replaces is the trap the whole feature turns
 * on. With `exclude: ["transcripts"]` it would swallow `transcripts.md` (a note
 * merely NAMED like the folder) and `transcriptsfoo/a.md` — files nobody carved
 * out, silently dropped from the sync forever. The `path === dir` half is what
 * lets the same predicate answer for a DIRECTORY during a walk, where the
 * excluded folder is the thing being tested rather than something under it.
 */
export function isUnderDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * The desk-scope exclusion for a parsed `desks` config: given a VAULT-relative
 * path, has config carved it out of the desk passes?
 *
 * Two properties worth stating, because both were choices:
 *
 * - **Anchored, not floating.** An `exclude` entry is a path relative to its own
 *   desk dir's root (types.ts), so `{dir: "d", exclude: ["transcripts"]}` covers
 *   `d/transcripts/**` and NOT `d/anything/transcripts/**`. A floating match
 *   would mean a folder's name silently changes what syncs anywhere it appears —
 *   surprising to configure and impossible to reason about from the file.
 * - **A path under no desk dir is not excluded.** This predicate answers "did
 *   config carve this out", not "is this in scope": the pull pass also carries
 *   wiki mirror rows, which live under no desk dir at all and must keep syncing.
 *   So the honest answer for anything the `exclude` lists do not name is `false`,
 *   including for a config with no desk folders (`undefined`) at all.
 */
export function makeDeskExclusion(desks: DesksConfig | undefined): (vaultPath: string) => boolean {
  // Flattened once, at wiring time, into the vault-relative form every caller
  // compares against — the dir-relative form config carries is only
  // self-describing for a human reading the file.
  const excluded = (desks?.deskDirs ?? []).flatMap(
    (entry) => (entry.exclude ?? []).map((sub) => `${entry.dir}/${sub}`),
  );
  return (vaultPath) => excluded.some((dir) => isUnderDir(vaultPath, dir));
}

/**
 * May this service CREATE a vault file here? (Phase 4, T3b fix round 1.)
 *
 * `refuseVaultTarget` rules on the SHAPE of a path — no escapes, no dot-dirs, no
 * machine-owned areas, markdown only. It says nothing about WHERE, and a shape-only
 * guard leaves a real hole: T6 derives the folder from a Notion `Folder` property,
 * which is untrusted content. Set it to `personal` and an approved create writes
 * `personal/x.md` and inserts a docs row — a tracked document in a folder no pass
 * was ever configured to sync. The push sweep is prefix-scoped so it never sees it,
 * but the pull pass scopes rows only by `exclude`, so it picks the row up and drives
 * it: a file outside every synced folder, quietly kept in step with Notion forever.
 *
 * Two things are in scope, and the second is not an afterthought:
 *
 *  - **Inside a configured `deskDirs[].dir`, and not carved out of it.** The
 *    ordinary case (T6): a desk folder is exactly the set of places the desk passes
 *    manage, and `exclude` is exactly what config has taken back out.
 *  - **…unless the carve-out IS the transcripts folder** (`transcripts.dir`, T1).
 *    T4's transcripts live at `<project>/<transcripts.dir>/…`, and that sub-path is
 *    excluded from the DESK passes precisely so the transcript pass can own it
 *    one-way (ORB-39 decision 5 — it is why T2 and T3 exist at all). Applying the
 *    exclusion here without this exception would refuse every transcript this
 *    mechanism was built to create. An `exclude` entry means "the desk passes do
 *    not sync this", not "nothing may ever live here".
 *
 * Built from `isUnderDir` and the same parsed config as `makeDeskExclusion`, beside
 * it, rather than as a third notion of scope somewhere else.
 */
export function makeCreateScope(cfg: Pick<NotionSyncConfig, "desks" | "transcripts">):
(vaultPath: string) => boolean {
  const dirs = cfg.desks?.deskDirs ?? [];
  const transcriptsDir = cfg.transcripts?.dir;
  return (vaultPath) => dirs.some((entry) => {
    if (!isUnderDir(vaultPath, entry.dir)) return false;
    const carvedOut = (entry.exclude ?? []).filter((sub) => isUnderDir(vaultPath, `${entry.dir}/${sub}`));
    if (carvedOut.length === 0) return true;
    // Carved out of the desk passes — allowed only when the carve-out is the
    // transcripts folder, which another configured pass owns.
    return transcriptsDir !== undefined && isUnderDir(vaultPath, `${entry.dir}/${transcriptsDir}`);
  });
}

/**
 * A row snapshot minus every path the exclusion names — the desk scope, as a map.
 *
 * Applied to the WHOLE snapshot rather than checked inside each loop so that
 * everything downstream agrees by construction: the row loop, the counts it
 * reports, and any resolver built from the same map all see one set of rows. A
 * per-loop `continue` leaves the excluded rows visible to whatever else reads the
 * snapshot, which is how one of the two surfaces gets missed.
 *
 * Returns a new map; the caller's snapshot is never mutated.
 */
export function withoutExcluded<T>(
  rows: Map<string, T>,
  isExcluded: (vaultPath: string) => boolean,
): Map<string, T> {
  const kept = new Map<string, T>();
  for (const [vaultPath, row] of rows) {
    if (!isExcluded(vaultPath)) kept.set(vaultPath, row);
  }
  return kept;
}
