// This agent's `@lares/agent-kit` contribution, held directly in its own catalogue rather than
// reached through `agent/extensions/agent-kit/tools/vault_backlinks.ts`.
// That mount file is an unconditional `disableTool` sentinel (see its own header),
// because a resolver-emitted tool under the same prefixed key (`agent-kit__vault_backlinks`)
// replaces an authored/mounted tool of that name completely.
//
// A free, unbilled Vault read (no `.approval`), so nothing here needs a board card.
//
// Not a thin re-export: one tool follows backlinks in whichever AREA it is given.
// See `agent-kit__vault_list.ts`'s header for why the instance is built here rather than
// re-exported from the kit.
import { backlinksTool } from "@lares/agent-kit/note-tools";

import { vaultAreasForTurn } from "../lib/vault-areas.js";

export default backlinksTool({ areas: vaultAreasForTurn });
