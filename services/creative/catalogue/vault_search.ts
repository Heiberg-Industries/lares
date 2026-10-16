// Search one area of the Vault — the knowledge she grounds every brief on.
// Read-only and UNGATED: a gate on a read trains people to tap without reading.
//
// W5C-s3: replaces `atlas_search` — see `vault_read.ts` for why the area is an input and what
// stops it reaching an area this role was not granted.
import { searchTool } from "@lares/agent-kit/note-tools";

import { vaultAreasForTurn } from "../lib/vault-areas.js";

export default searchTool({ areas: vaultAreasForTurn });
