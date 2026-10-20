/**
 * agent/hooks/approval-supersede.ts — a revised proposal withdraws the older approval card it
 * replaces. All the logic, and the reasons, are in `@lares/agent-kit/approval-supersede-hook`;
 * this file only registers it for `input.requested`. Backs `services/box/sql/006_approval_session.sql`.
 */
import { defineHook, type HookContext } from "eve/hooks";

import { makeApprovalSupersede } from "@lares/agent-kit/approval-supersede-hook";

export { makeApprovalSupersede };

const live = makeApprovalSupersede();

export default defineHook({
  events: {
    "input.requested": live["input.requested"] as (event: unknown, ctx: HookContext) => Promise<void>,
  },
});
