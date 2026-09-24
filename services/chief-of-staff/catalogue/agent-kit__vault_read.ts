// Saga's `@lares/agent-kit` contribution, held directly in her OWN catalogue rather than reached
// through `agent/extensions/agent-kit/tools/vault_read.ts` (ORB-278 step 2, Task 9). That override
// file is now an unconditional `disableTool()` sentinel — see its own header — because a
// resolver-emitted tool under the same prefixed key (`agent-kit__vault_read`) replaces an
// authored/mounted tool of that name completely (Task 1, Q1c).
//
// A free, unbilled personal-vault read (no `.approval`) — nothing here needs a board card.
//
// NO LONGER A THIN RE-EXPORT (W5A-s3). The shared object
// (`packages/agent-kit/extension/tools/vault_read.ts`) carries neither an `onRead` nor an area
// authority — agent-kit is shared by every role service and must not import this service's
// `lib/memory-reads.ts` or its per-session definition read. This file builds its OWN `readTool`
// instance instead, wired to both, so a read is recorded the same way whichever area it opened:
// kind `vault_note`, ref = the path ASKED FOR, and nothing recorded when the turn cannot be
// named.
//
// ONE TOOL, TWO AREAS (W5C-s3). It replaces the separate `atlas_read` this catalogue used to
// carry beside it. `areas` is what keeps that from widening anything: the session may open only
// the areas its own definition grants — see `lib/vault-areas.ts`.
import { readTool } from "@lares/agent-kit/note-tools";

import { getPool } from "@lares/agent-kit/db";
import { configuredOwnerId } from "../lib/identity-client.js";
import { recordRead } from "../lib/memory-reads.js";
import { vaultAreasForTurn } from "../lib/vault-areas.js";

export default readTool({
  areas: vaultAreasForTurn,
  onRead: (_store, path, sessionId, turnId) => {
    if (typeof sessionId !== "string" || typeof turnId !== "string") return;
    void recordRead(getPool(), {
      sessionId,
      turnId,
      owner: configuredOwnerId(),
      kind: "vault_note",
      refs: [path],
    }).catch(() => {});
  },
});
