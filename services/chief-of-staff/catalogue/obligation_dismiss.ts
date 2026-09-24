/**
 * Close an item on the obligation radar. Ported from
 * `services/agent-runtime/lib/adapters/hands/obligation.ts`'s `obligation.dismiss` action.
 *
 * Deliberately UNGATED (no `approval`), same reasoning as the old hand: dismissal only
 * changes what Bendik is SHOWN — it never sends mail, never touches a CRM record, never
 * reaches a real stranger. It is not on his approval gate list (Task 9's confirm-card set).
 *
 * Why its own tool rather than a `remind_cancel`-style action: an obligation has no due time
 * and is not in the reminder queue (lib/obligations-store.ts / sql/019_obligations.sql).
 * Overloading remind.cancel would make "cancel that" ambiguous in exactly the moment he is
 * trying to clear his list.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { dismissObligation, ensureObligationsTableOnce } from "../lib/obligations-store.js";

export default defineTool({
  description:
    "Close an item on the obligation radar — someone waiting on a reply from Bendik — because " +
    "he told you it's handled, sent, not owed, or to drop it. Pass the thread's id. This never " +
    "sends anything and never touches mail; it only stops that thread from being shown to him " +
    "again. If you are not sure which thread he means, ask rather than guessing — dismissing " +
    "the wrong one silently hides something he still owes.",
  inputSchema: z.object({ threadId: z.string() }),
  async execute({ threadId }) {
    const pool = getPool();
    await ensureObligationsTableOnce(pool);
    const result = await dismissObligation(pool, threadId, new Date());
    // Never "Dismissed" for an update that changed nothing — a stale or reconstructed thread
    // id (the model can no longer see the original brief) updates zero rows and raises
    // nothing, so a naive "done" would leave the item on the radar with no way for Bendik to
    // notice the difference until it reappeared tomorrow.
    if (!result.dismissed) {
      return { dismissed: false, message: "No obligation with that thread id is on the radar — nothing was dismissed." };
    }
    return {
      dismissed: true,
      counterpartyAddress: result.counterpartyAddress || undefined,
      message: result.counterpartyAddress
        ? `Dismissed the thread with ${result.counterpartyAddress} — it will stop showing up on the radar.`
        : "Dismissed — it will stop showing up on the radar.",
    };
  },
});
