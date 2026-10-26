// Create a CRM opportunity. GATED WRITE: requires the owner to tap Approve on the card on every call.
//
// POST /opportunities { name, stage, brand, pointOfContactId? }.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { assertApproval } from "../lib/approvals.js";
import { opportunityStageSchema, opportunityBrandSchema } from "../lib/twenty-enums.js";
import { approvalFor } from "../lib/board.js";
import { TwentyTracksHome } from "../lib/twenty-tracks.js";

export default defineTool({
  description: "Create a CRM opportunity (tick-initiated; requires tapping Approve on the card)",
  inputSchema: z.object({
    name: z.string(),
    stage: opportunityStageSchema,
    brand: opportunityBrandSchema,
    pointOfContactId: z.string().optional(),
  }),
  approval: approvalFor("twenty_create_opportunity"),
  async execute(input, ctx) {
    await assertApproval(ctx, "twenty_create_opportunity", input);
    const { name, stage, brand, pointOfContactId } = input;
    const opportunity = await new TwentyTracksHome().createOpportunity({ name, stage, brand, pointOfContactId });
    return { id: opportunity.id };
  },
});
