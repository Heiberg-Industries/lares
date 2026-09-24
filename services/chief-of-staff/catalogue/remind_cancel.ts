// Cancel a pending reminder by id. GATED WRITE — requires Bendik to tap Approve on the card on every call.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { cancelReminder } from "../lib/reminders-store.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Cancel one of Bendik's pending reminders by id (requires him to tap Approve on the card). Use remind_list first " +
    "to find the id.",
  inputSchema: z.object({ id: z.string() }),
  approval: approvalFor("remind_cancel"),
  async execute(input, ctx) {
    await assertApproval(ctx, "remind_cancel", input);
    const { id } = input;
    await cancelReminder(getPool(), id);
    return { id, status: "cancelled" };
  },
});
