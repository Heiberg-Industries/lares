/**
 * Raw Twenty client for the CRM routing engine's scan/classify loop.
 *
 * Ported from `services/agent-runtime/lib/adapters/twenty-client.ts`'s activity-read and
 * opportunity endpoints (verified against crm.owner.example 2026-06-20). This is deliberately
 * separate from the gated `agent/tools/twenty_*.ts` files: `bin/saga.ts`'s own comment on the
 * old routing tick explains why — "the route engine is bin-specific orchestration that
 * legitimately needs a RAW Twenty client (not a hand)". The routing schedule reads
 * participants/messages/events/opportunities to CLASSIFY a signal; it never writes — the
 * actual write, once Bendik approves, goes through the already-gated
 * `twenty_create_opportunity`/`twenty_set_stage` tools (Task 5).
 *
 * Uses `lib/twenty-client.ts`'s generic `twentyGet` verb, so a genuine Twenty failure surfaces
 * as the same typed `TwentyUnavailableError`/`TwentyNotFoundError` every other Twenty read in
 * this service throws.
 */
import { twentyGet, TwentyNotFoundError } from "./twenty-client.js";

export interface RouteMessageParticipant {
  personId: string | null;
  messageId: string;
  handle: string;
  role: string;
  createdAt: string;
}

export interface RouteCalendarParticipant {
  personId: string | null;
  calendarEventId: string;
  handle: string;
  isOrganizer: boolean;
  createdAt: string;
}

export interface RouteMessage {
  subject: string;
  text: string;
  receivedAt: string;
}

export interface RouteCalendarEvent {
  title: string;
  description: string;
  startsAt: string;
}

export interface RouteOpportunity {
  id: string;
  name: string;
  stage: string;
  brand: string;
}

/** List message participants created after `sinceIso`. Default limit 100. */
export async function listRecentMessageParticipants(sinceIso: string, limit = 100): Promise<RouteMessageParticipant[]> {
  const path = `/messageParticipants?filter=createdAt[gt]:${encodeURIComponent(sinceIso)}&orderBy=createdAt[AscNullsLast]&limit=${limit}`;
  const res = await twentyGet<{ data?: { messageParticipants?: any[] } }>(path);
  return (res?.data?.messageParticipants ?? []).map((r) => ({
    personId: r?.personId ?? null,
    messageId: r?.messageId ?? "",
    handle: r?.handle ?? "",
    role: r?.role ?? "",
    createdAt: r?.createdAt ?? "",
  }));
}

/** List calendar event participants created after `sinceIso`. Default limit 100. */
export async function listRecentCalendarParticipants(sinceIso: string, limit = 100): Promise<RouteCalendarParticipant[]> {
  const path = `/calendarEventParticipants?filter=createdAt[gt]:${encodeURIComponent(sinceIso)}&orderBy=createdAt[AscNullsLast]&limit=${limit}`;
  const res = await twentyGet<{ data?: { calendarEventParticipants?: any[] } }>(path);
  return (res?.data?.calendarEventParticipants ?? []).map((r) => ({
    personId: r?.personId ?? null,
    calendarEventId: r?.calendarEventId ?? "",
    handle: r?.handle ?? "",
    isOrganizer: r?.isOrganizer ?? false,
    createdAt: r?.createdAt ?? "",
  }));
}

/** Fetch a single message by id. */
export async function getMessage(id: string): Promise<RouteMessage> {
  const res = await twentyGet<{ data?: { message?: any } }>(`/messages/${id}`);
  const m = res?.data?.message ?? {};
  return { subject: m?.subject ?? "", text: m?.text ?? "", receivedAt: m?.receivedAt ?? "" };
}

/** Fetch a single calendar event by id. */
export async function getCalendarEvent(id: string): Promise<RouteCalendarEvent> {
  const res = await twentyGet<{ data?: { calendarEvent?: any } }>(`/calendarEvents/${id}`);
  const e = res?.data?.calendarEvent ?? {};
  return { title: e?.title ?? "", description: e?.description ?? "", startsAt: e?.startsAt ?? "" };
}

/** List opportunities where this person is the point of contact. */
export async function listOpportunitiesForPerson(personId: string, limit = 50): Promise<RouteOpportunity[]> {
  const path = `/opportunities?filter=pointOfContactId[eq]:${encodeURIComponent(personId)}&limit=${limit}`;
  const res = await twentyGet<{ data?: { opportunities?: any[] } }>(path);
  return (res?.data?.opportunities ?? []).map((r) => ({
    id: r?.id ?? "",
    name: r?.name ?? "",
    stage: r?.stage ?? "",
    brand: r?.brand ?? "",
  }));
}

/** Fetch a person's display name ("First Last"), or null when the person is missing or has
 *  no name — the engine falls back to the email handle in that case. A 404 (person deleted
 *  between the participant scan and this read) is "no name", not a scan-aborting failure. */
export async function getPersonName(personId: string): Promise<string | null> {
  let res: { data?: { person?: { name?: { firstName?: string; lastName?: string } } } };
  try {
    res = await twentyGet(`/people/${personId}`);
  } catch (err) {
    if (err instanceof TwentyNotFoundError) return null;
    throw err;
  }
  const name = res?.data?.person?.name;
  const full = [name?.firstName, name?.lastName].filter(Boolean).join(" ").trim();
  return full === "" ? null : full;
}

/** Bundles the six read calls the route engine needs into the shape `makeRouteEngine`
 *  expects — a thin object, not a class, so tests can substitute individual functions. */
export function makeRouteTwentyClient() {
  return {
    listRecentMessageParticipants,
    listRecentCalendarParticipants,
    getMessage,
    getCalendarEvent,
    listOpportunitiesForPerson,
    getPersonName,
  };
}
