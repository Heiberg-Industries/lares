// Approve or reject a Notion→vault proposal. GATED WRITE — requires Bendik to tap Approve on the card on every
// call; the eve approval card this renders (id + decision, shown before he taps) is what
// replaces the old Telegram `np:a:`/`np:r:` button pair.
//
// Input is the plan's literal `{id, decision}` shape — nothing more. `resolveProposal`'s own
// atomicity (throws when `id` is not currently open) is the safety net against a stale/wrong
// id; the watch schedule that offers this tool always announces id+path together immediately
// before requesting a decision, so there is no long window for the model's belief about which
// file an id names to go stale between announce and resolve.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import {
  approveConsequence,
  rejectConsequence,
  resolveProposal,
} from "../lib/proposals-store.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Approve or reject a Notion→vault proposal (requires Bendik to tap Approve on the card). Pass id and decision " +
    "('approve' | 'reject') from notion_proposals — both are shown on his confirmation card. " +
    "Approving an ordinary edit writes it to the vault file (or creates it, for a NEW FILE " +
    "proposal) on the sync engine's next hourly tick, NOT immediately, so 'nothing has " +
    "changed yet' right afterwards is expected. Rejecting does one of three different things " +
    "depending on the proposal — quote notion_proposals's own consequence sentence to him " +
    "before asking for the approval rather than guessing.",
  inputSchema: z.object({
    id: z.number().int().positive(),
    decision: z.enum(["approve", "reject"]),
  }),
  approval: approvalFor("notion_resolve_proposal"),
  async execute(input, ctx) {
    await assertApproval(ctx, "notion_resolve_proposal", input);
    const { id, decision } = input;

    const pool = getPool();
    const row = await resolveProposal(pool, id, decision);

    return {
      id: row.id,
      vaultPath: row.vaultPath,
      decision,
      consequence: decision === "approve" ? approveConsequence(row) : rejectConsequence(row),
    };
  },
});
