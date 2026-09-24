/**
 * agent/tools/calendar_list_events.ts — read-only calendar cross-check (Task 11), ported in
 * spirit (no old-Marcel precedent existed — this is new surface, not a port) from
 * `agent/tools/sveip.ts`'s own thin-wrapper convention: all client construction and the
 * scope/enrollment error contract live in `lib/google.ts`'s `calendarClient()`; this file only
 * shapes the `events.list` call and marshals the response into plain, model-safe fields.
 *
 * Same `oauth_tokens` principal/org as Gmail (`GOOGLE_PRINCIPAL_ID`/`GOOGLE_ORG`,
 * `U_bendik`/`heiberg`) — see `lib/google.ts`'s `calendarClient()` doc comment for the
 * scope-check / typed-error contract this tool relies on, and its OPEN QUESTION about whether
 * the real, currently-enrolled token actually carries calendar scope. If it doesn't, this
 * tool's `execute` rejects with `GoogleScopeMissingError` — a clear, typed failure, not a
 * confusing raw Calendar API 403.
 *
 * Boundary (Wave-1 lesson, same as `nearby_places.ts`): the model must NEVER invent an event —
 * only what `events.list` actually returned is real. Fields Google omitted (no `summary`, no
 * `location`, an all-day event with a `date` instead of `dateTime`) are omitted here too,
 * never backfilled with a guess.
 *
 * Admin-DM-only: same tool-local gate as every other tool in this file set that touches
 * personal Google-account data or state (`agent/tools/sveip.ts`, `agent/tools/nytur.ts`,
 * `agent/tools/link_group.ts`, `agent/tools/toggle_kill_switch.ts`) — `sveip.ts`'s own doc
 * comment explains why a channel-level allowlist alone isn't enough: this toolset is NOT
 * scoped per-session, so a group-chat turn (gated by the separate `Gatekeeper`, which can let
 * any group member's message trigger a "speak" turn) could otherwise let the model reach for
 * Bendik's calendar — event titles, times, locations, attendees — from a context no allowlist
 * checked. Flagged as an open review question in the original Task 11 report and resolved:
 * gated the same way the rest of this tool family already is.
 */
import { defineTool } from "eve/tools";
import type { SessionAuth } from "eve/context";
import { z } from "zod";
import type { calendar_v3 } from "googleapis";

import { calendarClient } from "../lib/google.js";
import { isAllowedAdmin } from "../lib/principals.js";

function callerAuth(auth: SessionAuth | undefined) {
  return auth?.current ?? auth?.initiator ?? null;
}

/** Identical shape to `agent/tools/sveip.ts`'s/`agent/tools/nytur.ts`'s own `assertAdminDm` —
 *  duplicated rather than shared, matching this codebase's per-tool-file self-containment
 *  convention (see e.g. `dataRoot()`, duplicated the same way across every tool file that
 *  needs it). Fails closed on anything that isn't unambiguously "the admin, in a private
 *  chat": missing auth, a group/supergroup `chat_type`, or a user id `isAllowedAdmin` doesn't
 *  recognise. */
function assertAdminDm(auth: SessionAuth | undefined): void {
  const caller = callerAuth(auth);
  const chatType = caller?.attributes?.["chat_type"];
  const userId = caller?.attributes?.["user_id"];
  if (chatType !== "private" || typeof userId !== "string" || !isAllowedAdmin(userId)) {
    throw new Error("calendar_list_events: admin-DM only");
  }
}

export interface CalendarEventSummary {
  id: string;
  summary?: string;
  start?: string; // RFC3339 date-time, or a bare YYYY-MM-DD for an all-day event
  end?: string;
  location?: string;
  htmlLink?: string;
}

/** Maps one `googleapis` Calendar event onto the tool's plain output shape. Prefers
 *  `dateTime` (timed events) and falls back to `date` (all-day events) — Google's own
 *  `Schema$Event` never sets both on the same `start`/`end`. Any field Google didn't return is
 *  omitted from the output entirely (never `null`/empty-string filled), matching
 *  `lib/discovery.ts`'s own "omit rather than fabricate" convention for optional fields. */
function marshalEvent(e: calendar_v3.Schema$Event): CalendarEventSummary {
  const start = e.start?.dateTime ?? e.start?.date ?? undefined;
  const end = e.end?.dateTime ?? e.end?.date ?? undefined;
  return {
    id: e.id ?? "",
    ...(e.summary ? { summary: e.summary } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(e.location ? { location: e.location } : {}),
    ...(e.htmlLink ? { htmlLink: e.htmlLink } : {}),
  };
}

export interface CalendarListEventsDeps {
  client(): Promise<calendar_v3.Calendar>;
}

export const defaultCalendarListEventsDeps: CalendarListEventsDeps = { client: calendarClient };

const inputSchema = z.object({
  from: z.string().describe("RFC3339 start of the range, e.g. '2026-08-20T00:00:00Z'"),
  to: z.string().describe("RFC3339 end of the range, e.g. '2026-08-27T00:00:00Z'"),
});

export function createCalendarListEventsTool(deps: CalendarListEventsDeps) {
  return defineTool({
    description:
      "List REAL events on the primary Google Calendar between `from` and `to` (RFC3339 " +
      "timestamps) — admin-DM only. Read-only — never creates, edits, or deletes anything. Use " +
      "this to cross-check a trip's dates against existing commitments before proposing " +
      "bookings. The model must NEVER invent an event, a time, or a location — only what this " +
      "tool returns is real; a field Google didn't set (e.g. no location on an event) is " +
      "simply absent from the result, never guessed.",
    inputSchema,
    async execute({ from, to }, ctx) {
      assertAdminDm(ctx.session.auth);
      const calendar = await deps.client();
      const res = await calendar.events.list({
        calendarId: "primary",
        timeMin: from,
        timeMax: to,
        singleEvents: true,
        orderBy: "startTime",
      });
      return (res.data.items ?? []).map(marshalEvent);
    },
  });
}

export default createCalendarListEventsTool(defaultCalendarListEventsDeps);
