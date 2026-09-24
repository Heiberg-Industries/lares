// List events on a calendar between two RFC-3339 timestamps. Ported from
// services/agent-runtime/lib/adapters/hands/calendar.ts's "list_events" action
// (hands/calendar.ts:34,50) — same timeMin/timeMax/max/account/calendarId marshaling as the
// old hand, now against lib/google.ts's ported adapter.
//
// W3A-s5 — A PROXY, NOT A DETERMINATION. The result (`{id, summary, start, end}`) carries no
// organiser or creator field, so "was this event written by the owner" is not answerable from
// this tool's output. `calendarId`/`account` are the only signal available: naming either is
// treated as somebody else's calendar and taints `third_party`; a bare listing of the owner's
// own primary calendar does not. This errs towards tainting (docs/specs/2026-09-18-origin-model-
// design.md, "The in-turn taint rule") — owner decision A3, .claude/plans/2026-09-18-prelaunch-
// wave-3.md. Previously the agent hook (agent/hooks/origin-taint.ts) tainted every call
// regardless of arguments, because a hook cannot see them; that blanket entry is now dropped and
// this precise check replaces it.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { googleClients } from "../lib/google.js";
import { taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";

export default defineTool({
  description:
    "List calendar events between two RFC-3339 timestamps (timeMin/timeMax) on the primary " +
    "calendar. Returns {id, summary, start, end}. Pass `account` (an email address from " +
    "identity.my_addresses) to act on that Google account's calendar; omit it for the default " +
    "one. Pass `calendarId` from list_calendars to use a specific calendar inside that account " +
    "(e.g. an Orakel calendar living inside the Heiberg account); omit it for that account's " +
    "own calendar.",
  inputSchema: z.object({
    timeMin: z.string(),
    timeMax: z.string(),
    max: z.number().int().positive().max(250).optional(),
    account: z.string().optional(),
    calendarId: z.string().optional(),
  }),
  async execute({ timeMin, timeMax, max, account, calendarId }, ctx) {
    const calendar = await googleClients().calendar(account);
    const result = await calendar.listEvents({
      timeMin, timeMax, max: max ?? 50, ...(calendarId ? { calendarId } : {}),
    });
    if (calendarId !== undefined || account !== undefined) {
      const k = turnKeyFrom(ctx);
      if (k) taintTurn(k, "third_party");
    }
    return result;
  },
});
