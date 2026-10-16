// WHICH AREAS OF THE VAULT THIS SESSION MAY OPEN (ADR-0017 rule 1, W5C-s3).
//
// The four note tools take an `area` and refuse one they were not given. This is what they ask.
// It reads the SAME per-session definition the tool list itself resolved from
// (`lib/definition.ts`'s `thisAgent`, pinned by session id), through the SAME derivation the
// session seam uses (`grantedVaultAreas`), so the list of tools this agent was handed and each
// tool's own refusal can never disagree.
//
// NEVER WIDEN. Between this slice and W5C-s6 the definitions still grant `brain`/`atlas`/
// `memory`, so `grantedVaultAreas` reads those three names as one area each; after s6 they
// grant `vault` with explicit areas and it reads those instead. Neither spelling adds an area
// the other did not have, and an agent that today can open only one of the two note areas can
// open only that one after this slice.
//
// A definition that cannot be read is NOT an open door: the rejection propagates out of the
// tool, which eve renders as that tool's failure — the same shape a missing store root has
// always had here.
import { grantedVaultAreas, type VaultArea } from "@lares/agent-kit/manifest";
import { writableAreas } from "@lares/agent-kit/note-write-tools";

import { thisAgent } from "./definition.js";

export async function vaultAreasForTurn(
  ctx: { session?: { id?: string } | undefined },
): Promise<readonly VaultArea[]> {
  const { loaded } = await thisAgent(ctx.session?.id);
  return grantedVaultAreas(loaded.definition);
}

/**
 * THE SAME QUESTION, FOR A WRITE (W5C-s4) — and the answer is narrower, because reads and
 * writes were never symmetrical here.
 *
 * This role reads BOTH note areas today (it had `agent-kit__vault_read` and `atlas_read` side by
 * side), so folding the reads into one area-taking tool widened nothing. It WRITES only the
 * private one: the three write tools were bound to the personal store at
 * construction and there has never been an `atlas_write` in this catalogue. But the declaration
 * grants `atlas` as well — for the Atlas sync job's proposal lane — so `grantedVaultAreas`
 * returns the shared area too, and handing that straight to a write tool would give this role a
 * shared-store write it does not have.
 *
 * So the write authority is the granted areas INTERSECTED with the areas the kit's write tools
 * serve (`writableAreas`, which is `["private"]`). Both halves must agree: revoke `brain` and
 * the door shuts on the next session; grant every area in the world and it stays shut anyway.
 */
export async function vaultWriteAreasForTurn(
  ctx: { session?: { id?: string } | undefined },
): Promise<readonly VaultArea[]> {
  return writableAreas(await vaultAreasForTurn(ctx));
}
