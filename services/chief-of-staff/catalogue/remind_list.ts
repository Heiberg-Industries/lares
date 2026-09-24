// List Bendik's pending reminders. Read-only, ungated — matches the plan's TOOL verdict for
// remind_list (only remind_set/remind_cancel are gated, the deliberate tightening).
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { listPending } from "../lib/reminders-store.js";

export default defineTool({
  description:
    "List Bendik's pending reminders, soonest due first: id, when it's due, recurrence " +
    "(if any), the message text, and which door it's pinned to.",
  inputSchema: z.object({}),
  async execute() {
    const rows = await listPending(getPool());
    return {
      reminders: rows.map((r) => ({
        id: r.id,
        dueAt: r.due_at.toISOString(),
        recurrence: r.recurrence,
        message: r.payload.text,
        door: r.payload.door,
        createdBy: r.created_by,
      })),
    };
  },
});
