// The permissions board's check, bound to THIS agent's declaration (ORB-278 step 1). A tool writes
// `approval: approvalFor("<its own name>")`; board-wiring.test.ts keeps that honest.
// ORB-278 step 2: `startingLevel` makes the DEFINITION's level the fallback where the permissions
// board has no `ratchet` row. The manifest provides unmanaged defaults; boardApproval
// uses the verified managed runtime identity for board lookups and audit attribution.
import { boardApproval } from "@lares/agent-kit/board-approval";
import { autonomyOf } from "@lares/agent-kit/manifest";
import manifest from "../agent.json";

import { thisAgent } from "./definition.js";

export const approvalFor = (tool: string) =>
  boardApproval(manifest, tool, {
    // The session id ties this to the SAME read of the definition the conversation's persona and
    // model came from, so the level applied can never disagree with the duties the model was told.
    startingLevel: async (capability, sessionId) => {
      const { loaded } = await thisAgent(sessionId);
      return autonomyOf(loaded.definition, capability);
    },
  });
