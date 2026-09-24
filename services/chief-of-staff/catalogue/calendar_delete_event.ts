// Delete a calendar event by id. GATED WRITE — requires Bendik to tap Approve on every card (this
// cancels a real event and emails the guests). Ported from hands/calendar.ts's "delete_event"
// action (hands/calendar.ts:38-44,54). The old hand refused a missing/empty eventId ("Guessing
// an id here would cancel someone else's meeting — refuse instead"); here that's enforced by
// the schema itself (`eventId` is required and non-empty) rather than a runtime check.
//
// LAR-59-s4 — `reason` is CARD TEXT, never a Google API field: it is dropped before
// `deleteEvent` is called (see `execute` below) and exists only so the approval card can say WHY
// a deletion is being asked for. It is not itself a decision: something else (LAR-59-s5, not yet
// built) decides whether to pass one at all, and this tool's approval gate and autonomy are
// unchanged either way — the owner still taps Approve on every call, reason or not.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { googleClients } from "../lib/google.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Delete a primary-calendar event by id (requires tapping Approve on the card — this cancels a real event and emails " +
    "the guests). Use list_events first to find the id; never guess one. Pass `account` (an " +
    "email address from identity.my_addresses) to act on that Google account's calendar; omit " +
    "it for the default one. Pass `calendarId` from list_calendars to use a specific calendar " +
    "inside that account (e.g. an Orakel calendar living inside the Heiberg account); omit it " +
    "for that account's own calendar. When removing a stale booking whose cancellation was " +
    "found in mail, pass that evidence sentence verbatim as `reason` — it is shown on the " +
    "approval card, never sent to Google.",
  inputSchema: z.object({
    eventId: z.string().min(1, "eventId is required — guessing one would cancel someone else's meeting"),
    notify: z.boolean().optional(),
    account: z.string().optional(),
    calendarId: z.string().optional(),
    reason: z.string().max(240).optional(),
  }),
  approval: approvalFor("calendar_delete_event"),
  async execute(input, ctx) {
    await assertApproval(ctx, "calendar_delete_event", input);

    // `reason` is deliberately NOT read past this point — it is card text for the approval
    // gate (see the formatter in @lares/agent-kit/approval-summary), never a Google API field.
    const calendar = await googleClients().calendar(input.account);
    return calendar.deleteEvent({
      eventId: input.eventId,
      ...(input.notify !== undefined ? { notify: input.notify } : {}),
      ...(input.calendarId !== undefined ? { calendarId: input.calendarId } : {}),
    });
  },
});
