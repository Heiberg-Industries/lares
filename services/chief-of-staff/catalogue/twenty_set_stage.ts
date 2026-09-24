// Move an opportunity to a pipeline stage. GATED WRITE — requires Bendik to tap Approve on the card on every call.
//
// Ported from `services/agent-runtime/lib/adapters/twenty-client.ts`'s `setOpportunityStage`
// (PATCH /opportunities/{id} { stage }).
import { defineTool } from "eve/tools";
import { z } from "zod";

import { twentyPatch } from "../lib/twenty-client.js";
import { assertApproval } from "../lib/approvals.js";
import { opportunityStageSchema } from "../lib/twenty-enums.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description: "Move an opportunity to a pipeline stage (tick-initiated; requires tapping Approve on the card)",
  inputSchema: z.object({ opportunityId: z.string(), stage: opportunityStageSchema }),
  approval: approvalFor("twenty_set_stage"),
  async execute(input, ctx) {
    await assertApproval(ctx, "twenty_set_stage", input);
    const { opportunityId, stage } = input;
    await twentyPatch(`/opportunities/${opportunityId}`, { stage });
    return { ok: true } as const;
  },
});
