// A REAL pool tool, in the shape `services/<role>/catalogue/` holds one: its own description, its
// own input schema, its own board approval and its own executor — none of them known to the
// resolver that hands it over.
//
// It exists for `evals/replay.eval.ts`, which asks the one question Task 1's fixture could not:
// does a tool that reaches the model ONLY through a `session.started` resolver still behave like an
// authored tool across an approval pause? eve stores a session-scoped dynamic tool as durable
// metadata and reconstructs both its executor and its approval from registered step functions
// (`dynamic-tool-lifecycle.js` -> `build-dynamic-tools.js`), so every call is already a replay —
// and `buildReplayedApproval` falls back to "always ask" when the approval step is missing, which
// is why the eval has to prove the AUTONOMOUS case too. A card is not evidence; a card that can
// also NOT appear is.
//
// Named `vault_list`, a documented vault/shared tool (`VAULT_SHARED_TOOLS`,
// `packages/agent-kit/src/persona/capability-docs.ts`), so `capabilityOfTool` maps it to `vault`
// and `areaOfTool` to `shared` — the board's own `(agent, "vault", "shared")` row decides, exactly
// as it does for the authored `agent/tools/vault_write.ts`. It was `atlas_list` until W5C-s9:
// `capabilityOfTool("atlas_list")` went undefined the moment `atlas` left `KNOWN_CAPABILITIES`
// (W5C-s5/s6), and `boardApproval` had been failing this fixture closed, unnoticed, ever since —
// reusing an already-documented tool name is what makes it resolve again, the same way this
// package's `vault_write` pool entry already reuses the authored tool's own name (see
// `catalogue/index.ts`'s header).
import { appendFileSync } from "node:fs";
import { boardApproval } from "@lares/agent-kit/board-approval";
import { defineTool } from "eve/tools";
import { z } from "zod";
import manifest from "../agent.json";
import "../lib/file-board.js"; // the file-backed board, installed in THIS bundle's board-approval

export default defineTool({
  description: "List notes (pool fixture).",
  inputSchema: z.object({}),
  approval: boardApproval(manifest, "vault_list"),
  execute: async () => {
    appendFileSync(process.env["BOARD_LOG"]!, "pool-vault-list\n");
    return { from: "pool", tool: "vault_list" };
  },
});
