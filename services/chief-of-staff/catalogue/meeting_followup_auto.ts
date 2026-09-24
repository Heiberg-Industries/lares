// Grant or revoke autonomous meeting follow-ups for one recurring series, by command
// (ORB-156 Task 12). The Console (Task 11) already lists and revokes these; this tool is the
// spoken-to-Saga path onto the SAME rows.
//
// ALWAYS gated, and that is not redundant with `meeting_followup_send`'s own per-series
// gate: this tool is what SETS the level `meeting_followup_send`'s policy later reads.
// Switching a series to auto-send must itself be a decision Bendik makes deliberately —
// never something a conversational turn can talk Saga into on his behalf.
//
// TWO CAPABILITY NAMES, do not confuse them: this tool is DECLARED under `agent.json`'s
// `autonomy` capability (what THIS tool is allowed to do — change an autonomy level). It
// WRITES ratchet rows whose `capability` COLUMN is `meeting_followup` (what is being granted
// autonomy over) — the same capability `meeting_followup_send.ts`'s `followupApproval` reads
// via `KitRatchet.level(FOLLOWUP_AGENT, FOLLOWUP_CAPABILITY, seriesKey)`.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { KitRatchet } from "@lares/agent-kit/ratchet";
import { AUTONOMY_LEVELS } from "@lares/agent-kit/manifest";
import { assertApproval } from "../lib/approvals.js";
import { configuredOwnerId } from "../lib/identity-client.js";
import { approvalFor } from "../lib/board.js";

// Matches `meeting_followup_send.ts`'s own constants — the row this tool writes is the row
// that tool's policy reads.
export const FOLLOWUP_AGENT = "saga";
export const FOLLOWUP_CAPABILITY = "meeting_followup";

export default defineTool({
  description:
    "Set whether a recurring meeting series' follow-up emails send automatically " +
    "('autonomous'), require Bendik's approval each time ('gated', the default), or never send " +
    "('never'). `seriesKey` is the calendar recurring-event id — never empty; an empty key " +
    "would write the capability-wide DEFAULT row and silently change every meeting series " +
    "at once, so it is refused instead. `meetingName` is shown on the approval card so a " +
    "wrong series is visible before it is confirmed. Requires Bendik's approval on every call — " +
    "granting or revoking autonomy is itself the decision being made here, so this tool is " +
    "gated even when the level being set is 'autonomous'.",
  inputSchema: z.object({
    seriesKey: z.string(),
    level: z.enum(AUTONOMY_LEVELS),
    meetingName: z.string(),
  }),
  approval: approvalFor("meeting_followup_auto"),
  async execute(input, ctx) {
    await assertApproval(ctx, "meeting_followup_auto", input);

    const seriesKey = input.seriesKey.trim();
    if (seriesKey === "") {
      // `action = ''` is the capability-wide default row (`ratchet.ts`'s resolution order,
      // header comment). A typo that silently switched EVERY meeting to autonomous is the
      // worst outcome this tool has available to it — refuse rather than guess.
      throw new Error(
        "meeting_followup_auto: seriesKey must not be empty or whitespace — an empty key " +
          "would write the capability-wide default row, silently changing every meeting series.",
      );
    }

    await new KitRatchet(getPool()).setLevel(
      FOLLOWUP_AGENT,
      FOLLOWUP_CAPABILITY,
      input.level,
      seriesKey,
      // The audit trail records WHO granted it. This is a single-tenant system (One Brain
      // W5, `lib/identity-client.ts`) — `assertApprover` above has already confirmed the
      // caller is the one allowed human, on whichever channel they used — so the canonical
      // identity id is what belongs in the column, not a channel-native address (that trap
      // is `lib/google.ts`'s "PRINCIPAL TRAP" comment, which is about a different table).
      configuredOwnerId(),
    );

    return { seriesKey, level: input.level, meetingName: input.meetingName, updatedBy: configuredOwnerId() };
  },
});
