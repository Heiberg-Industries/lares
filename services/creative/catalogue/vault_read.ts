// Read one Vault note by its store-relative path, in the area it is given. Read-only, UNGATED.
//
// W5C-s3: replaces `atlas_read`. The store is no longer chosen at construction — the model says
// which area, and `lib/vault-areas.ts` refuses any area this role's declaration does not grant,
// which is the shared one only.
import { readTool } from "@lares/agent-kit/note-tools";

import { vaultAreasForTurn } from "../lib/vault-areas.js";

export default readTool({ areas: vaultAreasForTurn });
