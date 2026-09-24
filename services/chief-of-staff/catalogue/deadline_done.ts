// Close a deadline as done, on the owner's word. GATED — a wrong close ends in a penalty, the
// same reasoning `deadline_mint_statutory`'s header states for its own gate.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { closeDeadline } from "../lib/deadlines-store.js";
import { ownerId } from "../lib/principals.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

/** `YYYY-MM-DD` -> `DD.MM.YYYY`, the Norwegian date form the brief and the mint card both
 *  already use — never the ISO order in a sentence meant for a human to read at a glance. */
function norwegianDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export default defineTool({
  description:
    "Close a deadline as DONE because the owner told you it's filed, paid, or otherwise " +
    "handled. Requires his approval — a wrong close on a real filing ends in a penalty. Pass what " +
    "evidences the close (what was filed, when, or simply that he said so). A row already " +
    "closed, or an unknown id, updates nothing — the result says so rather than claiming " +
    "success. A recurring deadline mints its next occurrence automatically; the result names " +
    "it, so confirm THAT date back to the owner rather than assuming the series continues " +
    "silently.",
  inputSchema: z.object({ id: z.string(), evidence: z.string().min(1) }),
  approval: approvalFor("deadline_done"),
  async execute(input, ctx) {
    await assertApproval(ctx, "deadline_done", input);
    const { id, evidence } = input;

    const result = await closeDeadline(getPool(), id, ownerId(), "done", evidence, new Date());
    if (!result.closed) {
      return {
        closed: false,
        message: "No open deadline with that id — nothing was closed.",
      };
    }

    if (result.minted) {
      return {
        closed: true,
        id,
        nextId: result.minted.id,
        nextDueDate: result.minted.dueDate,
        message: `Closed. Neste: ${norwegianDate(result.minted.dueDate)}.`,
      };
    }

    return { closed: true, id, message: "Closed — no recurrence, nothing minted." };
  },
});
