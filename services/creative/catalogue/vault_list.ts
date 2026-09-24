// List every note path in one area of the Vault, store-relative. Read-only, UNGATED.
// Without it she can only find notes whose path she can already guess.
//
// W5C-s3: replaces `atlas_list` — see `vault_read.ts` for why the area is an input and what
// stops it reaching an area this role was not granted.
import { listTool } from "@lares/agent-kit/note-tools";

import { vaultAreasForTurn } from "../lib/vault-areas.js";

export default listTool({ areas: vaultAreasForTurn });
