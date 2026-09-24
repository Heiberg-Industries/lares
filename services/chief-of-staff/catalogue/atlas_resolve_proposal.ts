// Approve or reject an Atlas proposal. GATED WRITE — requires Bendik to tap Approve on the card on every call; the
// eve approval card this renders (id + decision, shown before he taps) replaces the old
// Telegram `ap:a:`/`ap:r:` button pair for this lane.
//
// Input is the plan's literal `{id, decision}` shape — nothing more. `resolveAtlasProposal`'s
// own atomicity (throws when `id` is not currently open) is the safety net against a
// stale/wrong id; the watch schedule that offers this tool always announces id+path together
// immediately before requesting a decision, so there is no long window for the model's belief
// about which note an id names to go stale between announce and resolve.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import {
  atlasApproveConsequence,
  atlasRejectConsequence,
  resolveAtlasProposal,
} from "../lib/proposals-store.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Approve or reject an Atlas proposal (requires Bendik to tap Approve on the card). Pass id and decision " +
    "('approve' | 'reject') from atlas_proposals — both are shown on his confirmation card. " +
    "Approving writes the re-derived note into the Atlas on the next sync tick, NOT " +
    "immediately. Rejecting leaves the note exactly as it is and the draft is not offered " +
    "again until one of its sources actually changes.",
  inputSchema: z.object({
    id: z.number().int().positive(),
    decision: z.enum(["approve", "reject"]),
  }),
  approval: approvalFor("atlas_resolve_proposal"),
  async execute(input, ctx) {
    await assertApproval(ctx, "atlas_resolve_proposal", input);
    const { id, decision } = input;

    const pool = getPool();
    const row = await resolveAtlasProposal(pool, id, decision);

    return {
      id: row.id,
      notePath: row.notePath,
      decision,
      consequence: decision === "approve" ? atlasApproveConsequence() : atlasRejectConsequence(),
    };
  },
});
