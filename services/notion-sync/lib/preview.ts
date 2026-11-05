/**
 * The machine-readable preview behind `--preview`: what a first live tick WOULD do, per pass, as
 * four counts. It writes nothing anywhere (every pass runs with dryRun on) and it is the thing the
 * installation owner is shown, and must accept, before the sync is ever switched on.
 *
 * Pure on purpose (no database, no network): the entrypoint wires the real pass runners in, and
 * the tests wire in fakes.
 */
import type { AttendeeSyncResult } from "./run.js";
import type { PeopleSyncResult } from "./people-sync.js";

/** create = a new Notion row/page; adoptPatch = an existing one filled or corrected; skip = already right
 *  or nothing to do; conflict = a thing a human has to look at, left untouched. */
export interface PassPreview {
  create: number;
  adoptPatch: number;
  skip: number;
  conflict: number;
}

export interface PreviewReport {
  version: 1;
  passes: Record<string, PassPreview>;
}

/** Keeps only the passes a config allows, in their original order. `undefined` allows every pass. */
export function selectPasses<T extends { name: string }>(passes: T[], allowed: readonly string[] | undefined): T[] {
  return allowed === undefined ? passes : passes.filter((pass) => allowed.includes(pass.name));
}

const atLeastZero = (n: number): number => (n > 0 ? n : 0);

export function attendeePreview(r: AttendeeSyncResult): PassPreview {
  const conflict = r.flagged + r.errored;
  return { create: 0, adoptPatch: r.filled, skip: atLeastZero(r.scanned - r.filled - conflict), conflict };
}

export function peoplePreview(r: PeopleSyncResult): PassPreview {
  return {
    create: r.created,
    adoptPatch: r.updated + r.relationsUpdated,
    skip: r.unchanged + r.notNeeded + r.noEmail + r.relationsUnchanged,
    conflict: r.skipped.length + r.contestedAddresses.length + r.duplicates.length + r.errored,
  };
}

/**
 * Runs the named previews. A pass that is allowed but has no preview runner is a refusal, not a
 * silent gap: an owner who accepts a preview must be accepting everything the tick will do.
 */
export async function runPreview(
  runners: Record<string, () => Promise<PassPreview>>,
  allowed: readonly string[],
): Promise<PreviewReport> {
  const passes: Record<string, PassPreview> = {};
  for (const name of allowed) {
    const run = runners[name];
    if (run === undefined) throw new Error(`notion-sync: --preview has no preview for the "${name}" pass`);
    passes[name] = await run();
  }
  if (Object.keys(passes).length === 0) throw new Error("notion-sync: --preview has no pass to preview");
  return { version: 1, passes };
}
