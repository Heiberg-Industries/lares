// services/atlas/lib/migrate-okf.ts
// The one-shot that brings the WHOLE bundle to OKF conformance — every non-reserved .md
// gets a `type:`, the two legacy type values migrate into the shared vocabulary, and legacy
// bare `canonical_sources` become `repo:`-prefixed.
//
// It is a MECHANICAL field change, so there is no 👍 gate (spec §4.2): nothing here is
// drafted, every value is computed from the file's own path and contents, and no note BODY
// is touched. One commit, so the migration reads as one event in the store's history.
//
// It is IDEMPOTENT by construction — it is the same `mechanicalRefresh` the daily tick runs,
// applied to every file rather than to the venture notes. That is deliberate: if the
// migration and the tick disagreed about what conformance means, the tick would spend
// forever undoing the migration. One implementation, two callers.
import { mechanicalRefresh } from "./mechanical.js";
import { OKF_CORE_TYPES, checkConformance, type ConformanceFinding } from "@lares/vault-format/okf";
import type { AtlasWriter } from "./adapters/atlas-writer.js";

export interface MigrateResult {
  changed: string[];
  /** Empty when the bundle is conformant. Non-empty means the migration did not finish. */
  findings: ConformanceFinding[];
  /**
   * Paths `mechanicalRefresh` threw on (an unmapped directory — `okfTypeFor` has no rule for
   * it) — collected, not thrown, so one bad path doesn't take the whole migration down with
   * it. Every OTHER file still gets typed and written; a non-empty list here is the operator's
   * punch list, not a failed run.
   */
  failures: Array<{ path: string; error: string }>;
}

export async function migrateOkf(writer: AtlasWriter, today: string): Promise<MigrateResult> {
  const paths = writer.listNotes();
  const updated: Array<{ path: string; raw: string }> = [];
  const failures: Array<{ path: string; error: string }> = [];

  for (const path of paths) {
    const raw = writer.readNote(path);
    try {
      const res = mechanicalRefresh({ path, raw, today });
      if (res.changed) updated.push({ path, raw: res.raw });
    } catch (err) {
      failures.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (updated.length > 0) {
    await writer.writeNotes(updated, "atlas: adopt OKF frontmatter (type:) across the store");
  }

  // Re-read from the writer rather than trusting what we just computed: the check must
  // describe the STORE, not this function's intentions.
  const findings = checkConformance(
    paths.map((path) => ({ path, raw: writer.readNote(path) })),
    { types: OKF_CORE_TYPES },
  );
  return { changed: updated.map((u) => u.path), findings, failures };
}
