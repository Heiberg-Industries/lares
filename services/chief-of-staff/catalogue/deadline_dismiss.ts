// Dismiss a deadline, or a mail-scanner candidate, on the owner's word. GATED — same reason as
// `deadline_done`: a wrong dismiss can hide a filing that was never actually done.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { closeDeadline, resolveCandidate } from "../lib/deadlines-store.js";
import { ownerId } from "../lib/principals.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Dismiss a deadline (pass `id`) or a mail-scanner candidate that isn't actually a " +
    "deadline (pass `candidateThreadId`) — exactly one of the two. Requires the owner's approval. " +
    "Always pass `reason`. Never the wrong one silently: dismissing the wrong id can hide a " +
    "filing that still has to happen, so if you're not sure which is meant, ask rather than " +
    "guess. Zero rows changed (a stale or unknown id) is reported as `dismissed: false`, never " +
    "as a success.",
  inputSchema: z.object({
    id: z.string().optional(),
    candidateThreadId: z.string().optional(),
    reason: z.string().min(1),
  }),
  approval: approvalFor("deadline_dismiss"),
  async execute(input, ctx) {
    await assertApproval(ctx, "deadline_dismiss", input);
    const { id, candidateThreadId, reason } = input;

    if ((id === undefined) === (candidateThreadId === undefined)) {
      throw new Error("deadline_dismiss: pass exactly one of id or candidateThreadId");
    }

    const pool = getPool();

    if (id !== undefined) {
      const result = await closeDeadline(pool, id, ownerId(), "dismissed", reason, new Date());
      if (!result.closed) {
        return { dismissed: false, message: "No open deadline with that id — nothing was dismissed." };
      }
      return { dismissed: true, id, message: `Dismissed — ${reason}` };
    }

    const resolved = await resolveCandidate(pool, ownerId(), candidateThreadId!, "ignored");
    if (!resolved) {
      return { dismissed: false, message: "No candidate with that thread id — nothing was dismissed." };
    }
    return { dismissed: true, candidateThreadId, message: `Dismissed — ${reason}` };
  },
});
