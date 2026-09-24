// Create a CRM opportunity. GATED WRITE — requires Bendik to tap Approve on the card on every call.
//
// Ported from `services/agent-runtime/lib/adapters/twenty-client.ts`'s `createOpportunity`
// (POST /opportunities { name, stage, brand, pointOfContactId? }).
import { defineTool } from "eve/tools";
import { z } from "zod";

import { twentyPost } from "../lib/twenty-client.js";
import { assertApproval } from "../lib/approvals.js";
import { opportunityStageSchema, opportunityBrandSchema } from "../lib/twenty-enums.js";
import { approvalFor } from "../lib/board.js";

/** Twenty wraps create responses under data.<verb> — pull the first object with a string id. */
function extractId(res: unknown): string | undefined {
  const data = (res as { data?: Record<string, unknown> })?.data;
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) {
      if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") {
        return (v as { id: string }).id;
      }
    }
  }
  return undefined;
}

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
    const payload: Record<string, string> = { name, stage, brand };
    if (pointOfContactId !== undefined) payload.pointOfContactId = pointOfContactId;
    const res = await twentyPost<unknown>("/opportunities", payload);
    const id = extractId(res);
    if (!id) throw new Error("Twenty createOpportunity: no id in create response");
    return { id };
  },
});
