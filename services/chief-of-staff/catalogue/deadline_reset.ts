// Reset a deadline's escalation ladder back to rung 0. UNGATED — Decision (ORB-180 plan): a
// reset only adds noise back (the ladder may ring again from rung 1), it never silences
// anything or changes what is owed, so a card here would gate something harmless.
//
// UNGATED IS NOT UNATTRIBUTED (review fix, ORB-180), the same rule `remember.ts`'s header states
// and `deadline_add.ts` now carries: "harmless" is measured against a HUMAN asking. Restarting a
// ladder on a scheduled turn is a phone that rings again because a model re-read a brief, so
// `humanTurnRefusal` requires an allowlisted human on this turn before anything moves.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { humanTurnRefusal } from "../lib/approvals.js";
import { resetRung } from "../lib/deadlines-store.js";
import { ownerId } from "../lib/principals.js";

export default defineTool({
  description:
    "Reset a deadline's escalation ladder back to rung 0, so it can ring again from the start " +
    "(rung 1, the day-before nudge). Use this when the owner says a stopped deadline should " +
    "start chasing him again — a new due date usually calls for `deadline_add`/mint instead. " +
    "An unknown id changes nothing; the result says so.",
  inputSchema: z.object({ id: z.string() }),
  async execute({ id }, ctx) {
    const notHim = humanTurnRefusal(
      ctx.session?.auth,
      "A ladder starts chasing again because Bendik asked for it on this turn.",
    );
    if (notHim) return { reset: false as const, message: notHim };

    const reset = await resetRung(getPool(), id, ownerId());
    return { reset };
  },
});
