// Return busy windows on a calendar between two RFC-3339 timestamps — use to judge
// whether/when to offer a booking link. Ported from hands/calendar.ts's "free_busy" action
// (hands/calendar.ts:35,51).
import { defineTool } from "eve/tools";
import { z } from "zod";

import { googleClients } from "../lib/google.js";

export default defineTool({
  description:
    "Return busy windows on the primary calendar between two RFC-3339 timestamps — use to " +
    "judge whether/when to offer a booking link. Pass `account` (an email address from " +
    "identity.my_addresses) to act on that Google account's calendar; omit it for the default " +
    "one. Pass `calendarId` from list_calendars to use a specific calendar inside that account " +
    "(e.g. an Orakel calendar living inside the Heiberg account); omit it for that account's " +
    "own calendar.",
  inputSchema: z.object({
    timeMin: z.string(),
    timeMax: z.string(),
    account: z.string().optional(),
    calendarId: z.string().optional(),
  }),
  async execute({ timeMin, timeMax, account, calendarId }) {
    const calendar = await googleClients().calendar(account);
    return calendar.freeBusy({ timeMin, timeMax, ...(calendarId ? { calendarId } : {}) });
  },
});
