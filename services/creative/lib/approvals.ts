// Binds the kit's approval rules (`@lares/agent-kit/approval-policy`) to this role: Slack and web
// chat, no schedules (so no declared approver), no exact-approval adapters.
import { approvalPolicy } from "@lares/agent-kit/approval-policy";
import * as principals from "./principals.js";

export const {
  approverFrom, assertApprover, assertOwnerAnswerer, assertApproval, nativeAnswerDecision,
  catalogueApprovalRequest, catalogueApprovalResponse, guardCatalogueExecution,
} = approvalPolicy({
  role: "creative",
  principals,
  approvalDoors: "Slack",
  // A web chat reservation that cannot be made throws (eve parks the conversation).
  reserveRefusal: "throw",
  // This role's one gated write never runs in a bound console conversation without an approved card.
  needsExactCard: (name) => name === "vault_write",
});
