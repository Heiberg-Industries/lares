// WHICH AREAS OF THE VAULT THIS SESSION MAY OPEN (ADR-0017 rule 1, W5C-s3).
//
// The note tools take an `area` and refuse one they were not given. This is what they ask. It
// reads the SAME per-session definition the tool list itself resolved from (`lib/definition.ts`'s
// `thisAgent`, pinned by session id), through the SAME derivation the session seam uses
// (`grantedVaultAreas`), so the list of tools this agent was handed and each tool's own refusal
// can never disagree.
//
// THIS IS WHAT KEEPS THIS ROLE OUT OF THE PRIVATE AREA now that one tool reads both. Its
// declaration grants the shared store and not the personal one, so `grantedVaultAreas` returns
// the shared area alone and a read of the private one is refused by name — the same guarantee
// the separate `atlas_*` tools used to get from being bound to one store at construction, now
// enforced against the declaration instead of against a string in a filename.
//
// A definition that cannot be read is NOT an open door: the rejection propagates out of the
// tool, which eve renders as that tool's failure.
import { grantedVaultAreas, type VaultArea } from "@lares/agent-kit/manifest";

import { thisAgent } from "./definition.js";

export async function vaultAreasForTurn(
  ctx: { session?: { id?: string } | undefined },
): Promise<readonly VaultArea[]> {
  const { loaded } = await thisAgent(ctx.session?.id);
  return grantedVaultAreas(loaded.definition);
}

/** The areas this role's WRITE tool serves. One: the shared store `atlas_write` was bound to
 *  before W5C-s4 renamed it. It is a separate list from the granted areas on purpose — a future
 *  grant must not silently hand this role's single write tool a second store, the way it would
 *  if the write authority were simply "everything granted". */
const WRITABLE_AREAS = ["shared"] as const satisfies readonly VaultArea[];

/**
 * WHICH AREAS THIS SESSION MAY WRITE (W5C-s4). The granted areas, intersected with the one this
 * role's write tool serves. Both halves must agree: a declaration that stopped granting the
 * shared store would close the door on the next session, and a declaration that granted every
 * area would still not open a second one.
 */
export async function vaultWriteAreasForTurn(
  ctx: { session?: { id?: string } | undefined },
): Promise<readonly VaultArea[]> {
  const open = await vaultAreasForTurn(ctx);
  return WRITABLE_AREAS.filter((area) => open.includes(area));
}
