/**
 * Dream-cycle confirmation selection and dedup key derivation.
 *
 * The dream's confirmation lane files observations that need owner input as memory proposals,
 * rather than shouting them in a message and hoping for a reply. This file provides the stable
 * dedup key (`deriveRef`) so the same observation is not filed twice, the cap on how many
 * observations one run may file (`DREAM_CONFIRM_MAX_PER_RUN`), and the function to select which
 * ones to show (`selectForConfirmation`). The `makeIdentitySurfacer` factory and confirmation
 * message builders were deleted when the confirmation machinery moved to the memory-proposals
 * lane (wave 5, slice 4).
 */

import type { Observation } from "./reflect.js";

// ─── Ref derivation ───────────────────────────────────────────────────────────

/**
 * Derive a stable ref from subject + text.
 *
 * We need a deterministic id with no Math.random or Date.now.
 * djb2 is tiny, needs no crypto, and gives a stable hex string for the same input.
 */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; // keep 32-bit unsigned
  }
  return h;
}

/**
 * THE DEDUP KEY an `add` proposal is filed under (W5X-s4). Exported because it is no longer an
 * internal detail of the surfacer: `memory_proposals.ref` carries this string, and
 * `memory_proposals_add_open_idx` (services/box/sql/074) is UNIQUE on it, so two nights that
 * derive the same observation cannot queue the same question twice.
 *
 * SUBJECT + TEXT, trimmed and lower-cased, and nothing else — no date, no run id, no
 * confidence. That is the whole of the promise: the same observation about the same subject is
 * the same ref forever, and a different wording is a different ref, which is exactly what
 * "unless something new is observed" means in the sentence the owner is shown when they reject
 * one (`memoryRejectConsequence`, `lib/proposals-store.ts`). Widening this key (adding the run
 * date, say) would re-ask a rejected question every night; narrowing it (dropping the subject)
 * would collide two genuinely different observations onto one row.
 *
 * Takes the two fields it reads rather than a whole `Observation`, so a caller holding a
 * proposal row can derive the same ref without inventing the rest of an observation.
 */
export function deriveRef(obs: Pick<Observation, "subject" | "text">): string {
  const key = `${obs.subject.trim().toLowerCase()}::${obs.text.trim().toLowerCase()}`;
  return `identity-${djb2(key).toString(16).padStart(8, "0")}`;
}

// ─── Selecting what to show (W4C-s2b) ──────────────────────────────────────────

/**
 * How many `needsConfirm` items a single dream run may surface to the owner in one notice.
 * The promotion gate (`@lares/agent-kit/learning`) now routes every agent-inferred observation
 * here, not just rare identity shifts — on a freshly-enabled installation that can be dozens on
 * the first night. Three, not all of them: enough to be useful, never a wall of text.
 */
export const DREAM_CONFIRM_MAX_PER_RUN = 3;

/**
 * Cap a run's `needsConfirm` list to what one notice may show, in the order the cycle produced
 * it (no ranking invented here). Pure — no store, no notify, so it is trivially unit-testable.
 *
 * Items past `max` are NOT dropped by this function: they stay exactly what the promoter already
 * recorded them as, and the caller must not mark them asked or dismissed. They become eligible
 * again whenever a later dream run re-derives them from the conversation log, the same as any
 * other observation the owner has not yet been asked about.
 */
export function selectForConfirmation<T>(
  items: readonly T[],
  opts: { max?: number } = {},
): { shown: T[]; heldBack: number } {
  const max = Math.max(opts.max ?? DREAM_CONFIRM_MAX_PER_RUN, 0);
  const shown = items.slice(0, max);
  return { shown, heldBack: items.length - shown.length };
}

