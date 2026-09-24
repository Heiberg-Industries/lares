// services/notion-sync/lib/adapters/calendar-oauth.ts
// The attendee resolver: decrypt one Google refresh token per enrolled mailbox and hand back a
// READ-ONLY calendar client (events.list only). Rehomed here from the retired agent-runtime
// (ORB-178) — this was the ONE module notion-sync still took from that image. Reuses the SAME
// oauth_tokens rows the agents use (one Google grant covers gmail + calendar), decrypted through
// @lares/agent-box's injected-db reader, because this job connects with PG* env + the db secret
// file, not DATABASE_URL. The write half (insert/patch/delete/freebusy) stayed with the agents.
//
// Not in the shared agent kit on purpose: it keeps `googleapis` out of its module graph
// (its src/google-auth.ts explains the eve-build heap limit), and this resolver
// has exactly one consumer. eve-saga carries its own `wrapCalendarApi` twin (lib/google.ts).
import { google } from "googleapis";
import { listDecryptedRefreshTokens, type Queryable } from "@lares/agent-box";
import type { CalAttendee } from "../attendees.js";

export interface CalendarOrgConfig { orgId: string; clientId: string; clientSecret: string; redirectUri: string }

export interface CalendarReadClient {
  listEvents(params: { timeMin: string; timeMax: string; maxResults: number; calendarId?: string }): Promise<{
    items: Array<{ id: string; summary: string; start: string; end: string; attendees?: CalAttendee[]; recurringEventId?: string }>;
  }>;
}

const calFor = (calendarId: string | undefined): string => calendarId || "primary";

/** When EGRESS_PROXY_URL is set, route the OAuth client's traffic (token refresh AND every API
 *  call — both go through gaxios' transporter) via the box's domain-allow-list proxy. Unset ⇒
 *  direct. Verbatim from the runtime's google-proxy.ts. */
function applyEgressProxy(auth: unknown): void {
  const proxy = process.env["EGRESS_PROXY_URL"];
  if (!proxy) return;
  const t = (auth as { transporter?: { defaults?: Record<string, unknown> } }).transporter;
  if (t?.defaults) t.defaults.proxy = proxy;
}

export function wrapCalendarApi(api: ReturnType<typeof google.calendar>): CalendarReadClient {
  return {
    async listEvents(params) {
      const res = await api.events.list({ calendarId: calFor(params.calendarId), timeMin: params.timeMin, timeMax: params.timeMax, maxResults: params.maxResults, singleEvents: true, orderBy: "startTime" });
      const items = (res.data.items ?? []).map((e) => {
        const attendees = (e.attendees ?? [])
          .filter((a) => a.resource !== true && typeof a.email === "string" && a.email !== "")
          .map((a) => ({
            email: a.email as string,
            ...(a.displayName ? { displayName: a.displayName } : {}),
            // ORB-156. Spread conditionally, never `responseStatus: a.responseStatus` — an
            // explicit `undefined` is a PRESENT key, and every downstream `in` check and
            // deep-equality assertion would see a field that Google never sent.
            ...(a.responseStatus ? { responseStatus: a.responseStatus as CalAttendee["responseStatus"] } : {}),
          }));
        return {
          id: e.id ?? "",
          summary: e.summary ?? "",
          start: e.start?.dateTime ?? e.start?.date ?? "",
          end: e.end?.dateTime ?? e.end?.date ?? "",
          ...(attendees.length > 0 ? { attendees } : {}),
          ...(e.recurringEventId ? { recurringEventId: e.recurringEventId } : {}),
        };
      });
      return { items };
    },
  };
}

/** Build an auto-refreshing googleapis calendar client from an org config + refresh token. */
export function buildAuthedCalendar(cfg: CalendarOrgConfig, refreshToken: string): ReturnType<typeof google.calendar> {
  const auth = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
  applyEgressProxy(auth);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth });
}

export function makeCalendarResolver(deps: {
  db: Queryable; keyHex: string; orgs: CalendarOrgConfig[];
  calendarFactory?: (cfg: CalendarOrgConfig, refreshToken: string) => ReturnType<typeof google.calendar>;
}) {
  const factory = deps.calendarFactory ?? buildAuthedCalendar;
  const orgFor = (orgId: string) => {
    const org = deps.orgs.find((o) => o.orgId === orgId);
    if (!org) throw new Error(`no OAuth client config for org '${orgId}'`);
    return org;
  };
  return {
    async resolveAll(principal: string): Promise<Array<{ emailAddress: string; orgId: string; client: CalendarReadClient }>> {
      const toks = await listDecryptedRefreshTokens(deps.db, deps.keyHex, principal, "google");
      // Skip mailboxes whose org has no OAuth client config on this host (warn, not fatal) — one
      // un-configurable account must not sink enumeration of the others.
      const out: Array<{ emailAddress: string; orgId: string; client: CalendarReadClient }> = [];
      for (const t of toks) {
        const org = deps.orgs.find((o) => o.orgId === t.orgId);
        if (!org) {
          console.warn(`calendar resolveAll: skipping ${t.emailAddress} — no OAuth client config for org '${t.orgId}'`);
          continue;
        }
        out.push({ emailAddress: t.emailAddress, orgId: t.orgId, client: wrapCalendarApi(factory(org, t.token)) });
      }
      return out;
    },
    async resolveForEmail(principal: string, emailAddress: string): Promise<CalendarReadClient | null> {
      const toks = await listDecryptedRefreshTokens(deps.db, deps.keyHex, principal, "google");
      const t = toks.find((x) => x.emailAddress === emailAddress);
      if (!t) return null;
      return wrapCalendarApi(factory(orgFor(t.orgId), t.token));
    },
  };
}
