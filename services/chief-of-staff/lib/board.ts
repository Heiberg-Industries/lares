// The permissions board's check, bound to THIS agent's declaration (ORB-278 step 1). A tool writes
// `approval: approvalFor("<its own name>")`; board-wiring.test.ts keeps that honest.
//
// `contactHistory` is bound here, not left to the default: Saga ships the only contact tools whose
// recipients are checked per-call (`gmail_send`, `calendar_create_event` — @lares/agent-kit/always-ask's
// RECIPIENTS_OF), so this is where first contact actually gets decided for her.
//
// ORB-278 step 2: `startingLevel` makes the DEFINITION's level the fallback where the permissions
// board has no `ratchet` row. The manifest provides unmanaged defaults; boardApproval
// uses the verified managed runtime identity for board lookups and audit attribution.
import { boardApproval } from "@lares/agent-kit/board-approval";
import { autonomyOf } from "@lares/agent-kit/manifest";
import manifest from "../agent.json";
import { isKnownRecipient } from "./contact-history.js";
import { thisAgent } from "./definition.js";

export const approvalFor = (tool: string) =>
  boardApproval(manifest, tool, {
    contactHistory: isKnownRecipient,
    // The session id ties this to the SAME read of the definition the conversation's persona and
    // model came from, so the level applied can never disagree with the duties the model was told.
    startingLevel: async (capability, sessionId) => {
      const { loaded } = await thisAgent(sessionId);
      return autonomyOf(loaded.definition, capability);
    },
  });

/** Draft-only writes contact nobody. They default to autonomous, but installations can tighten
 * either action back to gated/never without changing the broader Gmail send policy. */
export const draftApprovalFor = (tool: "gmail_draft" | "gmail_draft_recipients") =>
  boardApproval(manifest, tool, { action: tool, defaultLevel: "autonomous" });
