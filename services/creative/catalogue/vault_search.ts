// Search one area of the Vault — the knowledge every brief is grounded on.
// Read-only and UNGATED: a gate on a read trains people to tap without reading.
//
// See `vault_read.ts` for why the area is an input and what
// stops it reaching an area this role was not granted.
import { searchTool } from "@lares/agent-kit/note-tools";

import { vaultAreasForTurn } from "../lib/vault-areas.js";

export default searchTool({ areas: vaultAreasForTurn });
