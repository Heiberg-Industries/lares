// The permissions board's check, bound to THIS agent's declaration. A tool writes
// `approval: approvalFor("<its own name>")`; board-wiring.test.ts keeps that honest.
//
// `contactHistory` is bound here, not left to the default: the chief of staff ships the only contact tools whose
// recipients are checked per-call (`gmail_send`, `calendar_create_event` — @lares/agent-kit/always-ask's
// RECIPIENTS_OF), so this is where first contact actually gets decided for the agent.
//
// `startingLevel` makes the DEFINITION's level the fallback where the permissions
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

/** Track operations keep their neutral tool names, but Twenty-backed writes use the same
 * capability/board action as the existing Twenty create or stage tool. */
export function trackItemApproval(tool: "track_add_item" | "track_move_item") {
  return async (ctx?: { toolInput?: unknown }) => {
    const input = ctx?.toolInput;
    const home = input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).home : undefined;
    const policyTool = home === "twenty"
      ? (tool === "track_add_item" ? "twenty_create_opportunity" : "twenty_set_stage")
      : tool;
    if (home !== "twenty" && (typeof home !== "string" || !/^vault:[A-Za-z0-9_-]{1,128}$/.test(home))) {
      return { type: "denied", reason: "Choose an exact connected track home." } as never;
    }
    return await approvalFor(policyTool)(ctx as never);
  };
}
