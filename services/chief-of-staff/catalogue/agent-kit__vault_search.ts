// This service's `@lares/agent-kit` contribution, held directly in its OWN catalogue rather than
// reached through `agent/extensions/agent-kit/tools/vault_search.ts` (ORB-278 step 2, Task 9).
// That override file is now an unconditional `disableTool()` sentinel — see its own header —
// because a resolver-emitted tool under the same prefixed key (`agent-kit__vault_search`)
// replaces an authored/mounted tool of that name completely (Task 1, Q1c).
//
// A free, unbilled Vault read (no `.approval`) — nothing here needs a board card.
//
// NO LONGER A THIN RE-EXPORT (W5C-s3): one tool searches whichever AREA it is given, replacing
// the separate `atlas_search` beside it. See `agent-kit__vault_list.ts`'s header for why the
// instance is built here rather than re-exported from the kit.
import { searchTool } from "@lares/agent-kit/note-tools";

import { vaultAreasForTurn } from "../lib/vault-areas.js";

export default searchTool({ areas: vaultAreasForTurn });
