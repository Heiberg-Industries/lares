// Create a calendar event. GATED WRITE — requires Bendik to tap Approve on every card (this puts a
// real event on the calendar). Ported from hands/calendar.ts's "create_event" action
// (hands/calendar.ts:36,52). Attendees ARE emailed an invitation unless notify is false —
// lib/google.ts's `sendUpdatesFor` (ORB-46: "invites now actually SEND") threads `notify`
// through to sendUpdates verbatim: notify unless explicitly told not to.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { googleClients } from "../lib/google.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Create a calendar event on the primary calendar (requires tapping Approve on the card — this puts a real event on " +
    "the calendar). start/end are RFC-3339 timestamps. Optionally set description and " +
    "attendees (email addresses). Attendees ARE emailed an invitation unless notify is false — " +
    "use notify:false only for a private, self-only event. Pass `account` (an email address " +
    "from identity.my_addresses) to act on that Google account's calendar; omit it for the " +
    "default one. Pass `calendarId` from list_calendars to use a specific calendar inside that " +
    "account (e.g. an Orakel calendar living inside the Heiberg account); omit it for that " +
    "account's own calendar.",
  inputSchema: z.object({
    summary: z.string(),
    start: z.string(),
    end: z.string(),
    description: z.string().optional(),
    attendees: z.array(z.string()).optional(),
    notify: z.boolean().optional(),
    account: z.string().optional(),
    calendarId: z.string().optional(),
  }),
  approval: approvalFor("calendar_create_event"),
  async execute(input, ctx) {
    await assertApproval(ctx, "calendar_create_event", input);

    const calendar = await googleClients().calendar(input.account);
    return calendar.insertEvent({
      summary: input.summary,
      start: input.start,
      end: input.end,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.attendees !== undefined ? { attendees: input.attendees } : {}),
      ...(input.notify !== undefined ? { notify: input.notify } : {}),
      ...(input.calendarId !== undefined ? { calendarId: input.calendarId } : {}),
    });
  },
});
