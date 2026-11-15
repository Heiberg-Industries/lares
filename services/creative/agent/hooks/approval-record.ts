/**
 * agent/hooks/approval-record.ts — writes down every approval card eve renders, and what the
 * owner answered. The logic and its reasons live in `@lares/agent-kit/approval-record-hook`
 * (shared with the other roles); this file only registers it. Creative had no
 * recorder before; without one its cards never got an answer in the ledger. Backs
 * `services/box/sql/001_baseline.sql` via `@lares/agent-kit/approval-ledger`.
 */
import { defineHook, type HookContext } from "eve/hooks";

import { makeApprovalRecord } from "@lares/agent-kit/approval-record-hook";

export { makeApprovalRecord };
export type { ApprovalRecordDeps } from "@lares/agent-kit/approval-record-hook";

const live = makeApprovalRecord();


export default defineHook({
  events: {
    "interaction.opened": live["interaction.opened"] as (event: unknown, ctx: HookContext) => Promise<void>,
    "interaction.settled": live["interaction.settled"] as (event: unknown, ctx: HookContext) => Promise<void>,
  },
});
