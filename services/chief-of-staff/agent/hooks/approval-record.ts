/**
 * agent/hooks/approval-record.ts — writes down every approval card eve renders, and what the
 * owner answered. The logic and its reasons live in `@lares/agent-kit/approval-record-hook`
 * (shared with the other roles); this file only registers it. Backs
 * `services/box/sql/001_baseline.sql` via `@lares/agent-kit/approval-ledger`.
 */
import { defineHook, type HookContext } from "eve/hooks";

import { makeApprovalRecord } from "@lares/agent-kit/approval-record-hook";

export { makeApprovalRecord };
export type { ApprovalRecordDeps } from "@lares/agent-kit/approval-record-hook";

const live = makeApprovalRecord();


export default defineHook({
  events: {
    "input.requested": live["input.requested"] as (event: unknown, ctx: HookContext) => Promise<void>,
    "input.resolved": live["input.resolved"] as (event: unknown, ctx: HookContext) => Promise<void>,
  },
});
