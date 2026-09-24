// List the memory changes waiting for the owner: a standing preference a nightly run wants to
// replace, which it is not allowed to replace on its own (ADR-0018 rule 2). Read-only, ungated
// — memory_resolve_proposal is the gated one.
//
// The third lane of the shape catalogue/notion_proposals.ts and catalogue/atlas_proposals.ts
// already established. Two differences from those two, both deliberate:
//
//   1. It shows the literal BEFORE and AFTER, not a diff preview. What is being decided here is
//      one sentence replacing another sentence, and the whole point of the card is that the
//      owner reads both. Neither is truncated by this tool.
//   2. Every word of it comes off the stored row. Nothing the model believes about a proposal
//      can reach the apply step, which re-reads the row by id (lib/memory-proposal-apply.ts).
//
// Role-neutral throughout: "the owner", never a name. The Atlas and Notion pair this is modelled
// on still carry one; a copy is not a licence to carry it forward.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import {
  getOpenMemoryProposals,
  memoryApproveConsequence,
  memoryRejectConsequence,
} from "../lib/proposals-store.js";

export default defineTool({
  description:
    "List the memory changes waiting for the owner's decision: something the owner told you " +
    "that a nightly run now believes has changed, or something the run worked out on its own " +
    "that it is not allowed to keep without asking first. A run may add what it learns, but it " +
    "may never replace what the owner said — so it records the change here instead, and " +
    "nothing happens until the owner decides. Each row shows the id, what is standing now " +
    "(null when there is nothing standing — the run is offering something new), what would " +
    "replace it, and the approve/reject consequence sentence — quote that sentence rather than " +
    "writing your own. Use it whenever the owner asks what memory changes are waiting, and " +
    "ALWAYS immediately before calling memory_resolve_proposal, so you act on a current id " +
    "rather than one from earlier in the conversation.",
  inputSchema: z.object({}),
  async execute() {
    const rows = await getOpenMemoryProposals(getPool());
    return {
      proposals: rows.map((p) => ({
        id: p.id,
        action: p.action,
        subject: p.subject,
        /** What the owner told the agent, as the standing row holds it — null for an `add`,
         *  which has no standing row to show (an empty string would read as data loss rather
         *  than as "there is nothing here yet"). */
        standingNow: p.action === "add" ? null : p.existingText,
        /** What would replace it — empty when the change is to retire it with nothing in its place. */
        wouldBecome: p.proposedText,
        state: p.state,
        /** The run that proposed it, so the owner can see when this came up. */
        proposedBy: p.source,
        createdAt: p.createdAt.toISOString(),
        approveConsequence: memoryApproveConsequence(p),
        rejectConsequence: memoryRejectConsequence(p),
      })),
    };
  },
});
