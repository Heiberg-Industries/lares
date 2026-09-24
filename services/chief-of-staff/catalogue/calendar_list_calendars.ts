// List the WRITABLE calendars inside a Google account — used to resolve a calendar by NAME
// (e.g. "the Orakel calendar") before creating an event in it. Ported from hands/calendar.ts's
// "list_calendars" action (hands/calendar.ts:45,55), an ORB-46 addition.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { googleClients } from "../lib/google.js";

export default defineTool({
  description:
    "List the WRITABLE calendars inside a Google account (pass `account`, an address from " +
    "identity.my_addresses; omit for the default). Returns [{id, summary, primary}]. Use this " +
    "to resolve a calendar by NAME — e.g. \"the Orakel calendar\" — before creating an event in " +
    "it. Read-only calendars are deliberately excluded: an event cannot be created in one.",
  inputSchema: z.object({ account: z.string().optional() }),
  async execute({ account }) {
    const calendar = await googleClients().calendar(account);
    return calendar.listCalendars();
  },
});
