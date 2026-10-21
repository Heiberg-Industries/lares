// This agent's `@lares/agent-kit` contribution, held directly in its own catalogue rather than
// reached through `agent/extensions/agent-kit/tools/vault_list.ts`. That
// mount file is an unconditional `disableTool` sentinel (see its own header), because a
// resolver-emitted tool under the same prefixed key (`agent-kit__vault_list`) replaces an
// authored/mounted tool of that name completely.
//
// A free, unbilled Vault read (no `.approval`), so nothing here needs a board card.
//
// Not a thin re-export. One tool lists whichever AREA it is given, and the mounted copy in the
// kit carries no area authority (it has no per-session definition read). So this file builds its
// own instance from the same factory, wired to `lib/vault-areas.ts`: the session may open only
// the areas its own definition grants, which is what keeps one tool for two areas from widening
// either of them.
import { listTool } from "@lares/agent-kit/note-tools";

import { vaultAreasForTurn } from "../lib/vault-areas.js";

export default listTool({ areas: vaultAreasForTurn });
