// Update an existing calendar event by id. GATED WRITE — requires Bendik to tap Approve on every card.
// Ported from hands/calendar.ts's "update_event" action (hands/calendar.ts:37,53). Attendees
// are emailed about the change unless notify is false — same sendUpdates threading as
// calendar_create_event.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { googleClients } from "../lib/google.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Update an existing primary-calendar event by id (requires tapping Approve on the card). Pass only the fields to " +
    "change; start/end are RFC-3339 timestamps. Attendees are emailed about the change unless " +
    "notify is false. Pass `account` (an email address from identity.my_addresses) to act on " +
    "that Google account's calendar; omit it for the default one. Pass `calendarId` from " +
    "list_calendars to use a specific calendar inside that account (e.g. an Orakel calendar " +
    "living inside the Heiberg account); omit it for that account's own calendar.",
  inputSchema: z.object({
    eventId: z.string(),
    summary: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    description: z.string().optional(),
    notify: z.boolean().optional(),
    account: z.string().optional(),
    calendarId: z.string().optional(),
  }),
  approval: approvalFor("calendar_update_event"),
  async execute(input, ctx) {
    await assertApproval(ctx, "calendar_update_event", input);

    const calendar = await googleClients().calendar(input.account);
    return calendar.updateEvent({
      eventId: input.eventId,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.start !== undefined ? { start: input.start } : {}),
      ...(input.end !== undefined ? { end: input.end } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.notify !== undefined ? { notify: input.notify } : {}),
      ...(input.calendarId !== undefined ? { calendarId: input.calendarId } : {}),
    });
  },
});
