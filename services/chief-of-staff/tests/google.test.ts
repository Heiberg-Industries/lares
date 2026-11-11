import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { google } from "googleapis";

import {
  wrapGmailApi, wrapCalendarApi, makeCalendarClient, CalendarEventChangedError,
  googleClients, listEnrolledMailboxes,
  __setTestGmailApiFactory,
} from "../lib/google.js";
import { GoogleConfigError } from "@lares/agent-kit/google-auth";
import { forgetChosenMailbox, useChosenMailbox, useNoChosenMailbox } from "./helpers/chosen-mailbox.js";

/**
 * The Google stack:
 *   - googleClients() serves only the mailbox the agent's owner chose, and refuses plainly when
 *     none is chosen (the choice itself is covered in agent-mailbox*.test.ts)
 *   - wrapGmailApi marshals the googleapis params (userId/q/maxResults/format/raw/…) exactly,
 *     proven against a stub `google.gmail()`-shaped object — no network, no DB
 *   - wrapCalendarApi reads one event with its revision, and makes an update or a delete
 *     conditional on that revision only when one is given (the calendar tools' own request
 *     shapes are covered in tools-calendar.test.ts)
 *
 * The `decryptSecret` and `readTokenEncKey` suites live in
 * `packages/agent-kit/tests/google-auth.test.ts`; what is specific to this service is the
 * mailbox policy and the capability adapter.
 */

// -----------------------------------------------------------------------------------------
// wrapGmailApi — marshals googleapis params exactly. Stub api only;
// no network, no DB.
// -----------------------------------------------------------------------------------------

interface RecordedCall { method: string; params: unknown }

function stubGmailApi(responses: Partial<{
  list: unknown; get: unknown; send: unknown; createDraft: unknown; sendAs: unknown; threadsGet: unknown;
}> = {}) {
  const calls: RecordedCall[] = [];
  const api = {
    users: {
      messages: {
        list: async (params: unknown) => {
          calls.push({ method: "list", params });
          return responses.list ?? { data: { messages: [] } };
        },
        get: async (params: unknown) => {
          calls.push({ method: "get", params });
          return responses.get ?? { data: {} };
        },
        send: async (params: unknown) => {
          calls.push({ method: "send", params });
          return responses.send ?? { data: { id: "m1", threadId: "t1" } };
        },
      },
      drafts: {
        create: async (params: unknown) => {
          calls.push({ method: "createDraft", params });
          return responses.createDraft ?? { data: { id: "d1", message: { id: "m1", threadId: "t1" } } };
        },
      },
      threads: {
        get: async (params: unknown) => {
          calls.push({ method: "threadsGet", params });
          return responses.threadsGet ?? { data: { messages: [] } };
        },
      },
      settings: {
        sendAs: {
          get: async (params: unknown) => {
            calls.push({ method: "getSignature", params });
            return responses.sendAs ?? { data: { signature: "" } };
          },
        },
      },
    },
  };
  return { api: api as unknown as Parameters<typeof wrapGmailApi>[0], calls };
}

describe("wrapGmailApi", () => {
  it("list: userId 'me', q, maxResults — exactly, no pageToken/threadId leakage", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).list({ q: "in:inbox -from:me", maxResults: 25 });
    expect(calls).toEqual([{ method: "list", params: { userId: "me", q: "in:inbox -from:me", maxResults: 25 } }]);
  });

  it("get: userId 'me', id, format 'full'", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).get("msg123");
    expect(calls).toEqual([{ method: "get", params: { userId: "me", id: "msg123", format: "full" } }]);
  });

  it("send: userId 'me', requestBody { raw, threadId }", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).send("BASE64RAW", "thread1");
    expect(calls).toEqual([{ method: "send", params: { userId: "me", requestBody: { raw: "BASE64RAW", threadId: "thread1" } } }]);
  });

  // — outreach_track used to timestamp a send at TRACK time (a separate, later tool
  // call), so a very fast reply could arrive before that recorded time and never match the
  // reply-detection filter. send() now surfaces a `sentAt` the caller can pass straight
  // through to outreach_track.
  describe("send — sentAt", () => {
    it("uses Gmail's own internalDate when the response includes it", async () => {
      const { api } = stubGmailApi({ send: { data: { id: "m1", threadId: "t1", internalDate: "1755331200000" } } });
      const result = await wrapGmailApi(api).send("BASE64RAW", "thread1");
      expect(result.sentAt).toBe(new Date(1755331200000).toISOString());
    });

    it("falls back to the moment the call resolved when internalDate is absent", async () => {
      const { api } = stubGmailApi({ send: { data: { id: "m1", threadId: "t1" } } });
      const before = Date.now();
      const result = await wrapGmailApi(api).send("BASE64RAW", "thread1");
      const parsed = Date.parse(result.sentAt);
      expect(parsed).toBeGreaterThanOrEqual(before);
      expect(parsed).toBeLessThanOrEqual(Date.now());
    });
  });

  it("createDraft: userId 'me', requestBody { message: { raw, threadId } }", async () => {
    const { api, calls } = stubGmailApi();
    await wrapGmailApi(api).createDraft("BASE64RAW", "thread1");
    expect(calls).toEqual([{ method: "createDraft", params: { userId: "me", requestBody: { message: { raw: "BASE64RAW", threadId: "thread1" } } } }]);
  });

  it("getSignature: userId 'me', sendAsEmail", async () => {
    const { api, calls } = stubGmailApi({ sendAs: { data: { signature: "<p>Test Owner</p>" } } });
    const sig = await wrapGmailApi(api).getSignature("owner@owner.example");
    expect(calls).toEqual([{ method: "getSignature", params: { userId: "me", sendAsEmail: "owner@owner.example" } }]);
    expect(sig).toBe("<p>Test Owner</p>");
  });

  // — hasDraftForThread used to be one unpaginated drafts.list(maxResults: 100) page
  // checked for a matching threadId, so dedup silently broke past ~100 total mailbox drafts
  // regardless of relevance. Now scoped to THIS thread via threads.get + a DRAFT label check.
  describe("hasDraftForThread", () => {
    it("true when a message in the thread carries the DRAFT label", async () => {
      const { api, calls } = stubGmailApi({
        threadsGet: { data: { messages: [{ id: "m1", labelIds: ["SENT"] }, { id: "m2", labelIds: ["DRAFT"] }] } },
      });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(true);
      expect(calls).toEqual([{ method: "threadsGet", params: { userId: "me", id: "t1", format: "minimal" } }]);
    });

    it("false when no message in the thread carries the DRAFT label", async () => {
      const { api } = stubGmailApi({
        threadsGet: { data: { messages: [{ id: "m1", labelIds: ["INBOX"] }] } },
      });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(false);
    });

    it("false on a thread with no messages", async () => {
      const { api } = stubGmailApi({ threadsGet: { data: {} } });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(false);
    });

    // The regression this fixes: this exact behavior is INDEPENDENT of how many drafts
    // exist elsewhere in the mailbox — there is no pagination to exhaust, because the call
    // is scoped to the one thread being checked.
    it("is unaffected by how many other drafts exist in the mailbox — no pagination to exceed", async () => {
      const { api } = stubGmailApi({
        threadsGet: { data: { messages: [{ id: "m1", labelIds: ["DRAFT"] }] } },
      });
      await expect(wrapGmailApi(api).hasDraftForThread("t1")).resolves.toBe(true);
    });
  });
});

// -----------------------------------------------------------------------------------------
// wrapCalendarApi — one event read with its revision, and writes that only land if the event
// has not changed. Stub api only; no network, no DB. What Google itself answers to an
// `If-Match` header is settled by tests/live/calendar-event-precondition.live.mts, not here.
// -----------------------------------------------------------------------------------------

/** Every argument each call received, so a test can tell a one-argument call from a call that
 *  also carried per-request options (which is where the `If-Match` header travels). */
interface RecordedCalendarCall { method: string; args: unknown[] }

/** What the googleapis client throws for a non-2xx answer, reduced to the part that is read. */
function httpError(status: number): Error & { response: { status: number } } {
  return Object.assign(new Error(`request failed with status ${status}`), { response: { status } });
}

const ETAG_READ = '"3181161784712000"';
const ETAG_AFTER = '"3181161799999000"';
const PATCH_ANSWER = { data: {
  id: "e1", etag: ETAG_AFTER, updated: "2026-01-02T09:00:00.000Z", summary: "Sync",
  start: { dateTime: "2026-01-01T10:00:00Z" }, end: { dateTime: "2026-01-01T10:30:00Z" },
} };

function stubCalendarApi(responses: Partial<{ get: unknown; patch: unknown; delete: unknown }> = {}) {
  const calls: RecordedCalendarCall[] = [];
  const answer = (method: string, fallback: unknown) => async (...args: unknown[]) => {
    calls.push({ method, args });
    const r = method in responses ? responses[method as keyof typeof responses] : fallback;
    if (r instanceof Error) throw r;
    return r;
  };
  const api = { events: {
    get: answer("get", { data: {} }),
    patch: answer("patch", PATCH_ANSWER),
    delete: answer("delete", { data: {} }),
  } };
  return { api: api as unknown as Parameters<typeof wrapCalendarApi>[0], calls };
}

describe("wrapCalendarApi.getEvent", () => {
  const FOUND = { data: {
    id: "e1", etag: ETAG_READ, updated: "2026-01-01T08:00:00.000Z", status: "confirmed", summary: "Sync",
    start: { dateTime: "2026-01-01T11:00:00+01:00", timeZone: "Europe/Paris" },
    end: { dateTime: "2026-01-01T06:30:00-05:00", timeZone: "America/New_York" },
    attendees: [
      { email: "guest@example.invalid", displayName: "Guest" },
      { email: "second@example.invalid" },
      { email: "room@example.invalid", resource: true },
      { displayName: "No address" },
    ],
  } };

  it("found: calendarId and eventId exactly, and the fields an approval shows and binds", async () => {
    const { api, calls } = stubCalendarApi({ get: FOUND });
    const read = await wrapCalendarApi(api).getEvent("team@example.invalid", "e1");
    expect(calls).toEqual([{ method: "get", args: [{ calendarId: "team@example.invalid", eventId: "e1" }] }]);
    expect(read).toEqual({ outcome: "found", event: {
      id: "e1", status: "confirmed", summary: "Sync",
      start: "2026-01-01T11:00:00+01:00", end: "2026-01-01T06:30:00-05:00",
      startTimeZone: "Europe/Paris", endTimeZone: "America/New_York",
      attendees: [{ email: "guest@example.invalid", displayName: "Guest" }, { email: "second@example.invalid" }],
      revision: { etag: ETAG_READ, updated: "2026-01-01T08:00:00.000Z" },
    } });
  });

  it("an absent or empty calendarId reads the account's own calendar", async () => {
    const { api, calls } = stubCalendarApi({ get: FOUND });
    await wrapCalendarApi(api).getEvent(undefined, "e1");
    await wrapCalendarApi(api).getEvent("", "e1");
    expect(calls.map((c) => c.args)).toEqual([[{ calendarId: "primary", eventId: "e1" }], [{ calendarId: "primary", eventId: "e1" }]]);
  });

  it("an all-day event carries its dates and allDay, and no zones or attendees it does not have", async () => {
    const { api } = stubCalendarApi({ get: { data: {
      id: "e2", etag: ETAG_READ, updated: "2026-01-01T08:00:00.000Z", status: "tentative", summary: "Offsite",
      start: { date: "2026-03-02" }, end: { date: "2026-03-03" },
    } } });
    await expect(wrapCalendarApi(api).getEvent("primary", "e2")).resolves.toEqual({ outcome: "found", event: {
      id: "e2", status: "tentative", summary: "Offsite", start: "2026-03-02", end: "2026-03-03", allDay: true,
      revision: { etag: ETAG_READ, updated: "2026-01-01T08:00:00.000Z" },
    } });
  });

  it("not found (404) is an answer to branch on, not a thrown error", async () => {
    const { api, calls } = stubCalendarApi({ get: httpError(404) });
    await expect(wrapCalendarApi(api).getEvent("primary", "gone")).resolves.toEqual({ outcome: "not_found" });
    expect(calls).toHaveLength(1);
  });

  it("cancelled is its own answer, distinct from not found: a 200 with status cancelled, or a 410", async () => {
    const asStatus = stubCalendarApi({ get: { data: { id: "e1", etag: ETAG_READ, status: "cancelled", summary: "Sync" } } });
    await expect(wrapCalendarApi(asStatus.api).getEvent("primary", "e1")).resolves.toEqual({ outcome: "cancelled" });
    const asGone = stubCalendarApi({ get: httpError(410) });
    await expect(wrapCalendarApi(asGone.api).getEvent("primary", "e1")).resolves.toEqual({ outcome: "cancelled" });
  });

  it("every other failure is thrown unchanged, after one attempt", async () => {
    for (const status of [401, 403, 429, 500]) {
      const failure = httpError(status);
      const { api, calls } = stubCalendarApi({ get: failure });
      await expect(wrapCalendarApi(api).getEvent("primary", "e1")).rejects.toBe(failure);
      expect(calls).toHaveLength(1);
    }
  });

  it("refuses a live event that came back without a revision: there would be nothing to bind to", async () => {
    const { api } = stubCalendarApi({ get: { data: { id: "e1", status: "confirmed", summary: "Sync" } } });
    await expect(wrapCalendarApi(api).getEvent("primary", "e1")).rejects.toThrow("Google returned a calendar event without a revision");
  });

  it("refuses an empty eventId before any request", async () => {
    const { api, calls } = stubCalendarApi({ get: FOUND });
    await expect(wrapCalendarApi(api).getEvent("primary", "")).rejects.toThrow("eventId is required");
    expect(calls).toEqual([]);
  });

  it("never puts event text in what it throws", async () => {
    const { api } = stubCalendarApi({ get: { data: { id: "e1", status: "confirmed", summary: "TEXT-FROM-OUTSIDE" } } });
    const err = await wrapCalendarApi(api).getEvent("primary", "e1").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(JSON.stringify([String(err), (err as Error).message])).not.toContain("TEXT-FROM-OUTSIDE");
  });
});

describe("wrapCalendarApi.updateEvent — expected revision", () => {
  const TODAY_REQUEST = { calendarId: "primary", eventId: "e1", sendUpdates: "all", requestBody: { summary: "Sync" } };

  it("without a revision: the request and the answer are exactly what they were", async () => {
    const { api, calls } = stubCalendarApi();
    const result = await wrapCalendarApi(api).updateEvent({ eventId: "e1", summary: "Sync" });
    // One argument and nothing else: no per-request options, so no If-Match header.
    expect(calls).toEqual([{ method: "patch", args: [TODAY_REQUEST] }]);
    expect(JSON.stringify(calls)).not.toMatch(/if-match/i);
    // Google's answer carries an etag here too; without a revision asked for, it is not passed on.
    expect(result).toEqual({ id: "e1", summary: "Sync", start: "2026-01-01T10:00:00Z", end: "2026-01-01T10:30:00Z" });
    expect(Object.keys(result)).toEqual(["id", "summary", "start", "end"]);
  });

  it("with a matching revision: the same request plus If-Match, and Google's NEW revision comes back", async () => {
    const { api, calls } = stubCalendarApi();
    const result = await wrapCalendarApi(api).updateEvent({ eventId: "e1", summary: "Sync", expectedRevision: ETAG_READ });
    expect(calls).toEqual([{ method: "patch", args: [TODAY_REQUEST, { headers: { "If-Match": ETAG_READ } }] }]);
    expect(result).toEqual({
      id: "e1", summary: "Sync", start: "2026-01-01T10:00:00Z", end: "2026-01-01T10:30:00Z",
      revision: { etag: ETAG_AFTER, updated: "2026-01-02T09:00:00.000Z" },
    });
  });

  it("the revision never leaks into what is sent as the event itself", async () => {
    const { api, calls } = stubCalendarApi();
    await wrapCalendarApi(api).updateEvent({ eventId: "e1", calendarId: "team@example.invalid", notify: false, start: "2026-01-02T10:00:00Z", expectedRevision: ETAG_READ });
    expect(calls[0]!.args[0]).toEqual({ calendarId: "team@example.invalid", eventId: "e1", sendUpdates: "none", requestBody: { start: { dateTime: "2026-01-02T10:00:00Z" } } });
  });

  it("with a stale revision: Google's 412 is 'changed since it was read', after one attempt", async () => {
    const { api, calls } = stubCalendarApi({ patch: httpError(412) });
    const err = await wrapCalendarApi(api).updateEvent({ eventId: "e1", calendarId: "team@example.invalid", summary: "Sync", expectedRevision: ETAG_READ }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalendarEventChangedError);
    expect(err).toMatchObject({ name: "CalendarEventChangedError", outcome: "changed_since_read", calendarId: "team@example.invalid", eventId: "e1" });
    expect(calls).toHaveLength(1);
  });

  it("with a revision, every OTHER failure is thrown unchanged and never retried", async () => {
    for (const status of [400, 403, 404, 409, 410, 429, 500]) {
      const failure = httpError(status);
      const { api, calls } = stubCalendarApi({ patch: failure });
      await expect(wrapCalendarApi(api).updateEvent({ eventId: "e1", summary: "Sync", expectedRevision: ETAG_READ })).rejects.toBe(failure);
      expect(calls).toHaveLength(1);
    }
  });

  it("without a revision, a 412 is thrown unchanged too: nothing about today's failures moved", async () => {
    const failure = httpError(412);
    const { api } = stubCalendarApi({ patch: failure });
    await expect(wrapCalendarApi(api).updateEvent({ eventId: "e1", summary: "Sync" })).rejects.toBe(failure);
  });

  it("an empty revision is refused before any request, never sent and never dropped", async () => {
    const { api, calls } = stubCalendarApi();
    await expect(wrapCalendarApi(api).updateEvent({ eventId: "e1", summary: "Sync", expectedRevision: "" })).rejects.toThrow("nothing was written");
    expect(calls).toEqual([]);
  });
});

describe("wrapCalendarApi.deleteEvent — expected revision", () => {
  const TODAY_REQUEST = { calendarId: "primary", eventId: "e1", sendUpdates: "all" };

  it("without a revision: the request and the answer are exactly what they were", async () => {
    const { api, calls } = stubCalendarApi();
    await expect(wrapCalendarApi(api).deleteEvent({ eventId: "e1" })).resolves.toEqual({ deleted: true });
    expect(calls).toEqual([{ method: "delete", args: [TODAY_REQUEST] }]);
    expect(JSON.stringify(calls)).not.toMatch(/if-match/i);
  });

  it("with a matching revision: the same request plus If-Match", async () => {
    const { api, calls } = stubCalendarApi();
    await expect(wrapCalendarApi(api).deleteEvent({ eventId: "e1", notify: false, expectedRevision: ETAG_READ })).resolves.toEqual({ deleted: true });
    expect(calls).toEqual([{ method: "delete", args: [{ ...TODAY_REQUEST, sendUpdates: "none" }, { headers: { "If-Match": ETAG_READ } }] }]);
  });

  it("with a stale revision: Google's 412 is 'changed since it was read', after one attempt", async () => {
    const { api, calls } = stubCalendarApi({ delete: httpError(412) });
    const err = await wrapCalendarApi(api).deleteEvent({ eventId: "e1", expectedRevision: ETAG_READ }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalendarEventChangedError);
    expect(err).toMatchObject({ outcome: "changed_since_read", calendarId: "primary", eventId: "e1" });
    expect(calls).toHaveLength(1);
  });

  it("with a revision, every OTHER failure is thrown unchanged and never retried", async () => {
    for (const status of [403, 404, 410, 429, 500]) {
      const failure = httpError(status);
      const { api, calls } = stubCalendarApi({ delete: failure });
      await expect(wrapCalendarApi(api).deleteEvent({ eventId: "e1", expectedRevision: ETAG_READ })).rejects.toBe(failure);
      expect(calls).toHaveLength(1);
    }
  });

  it("without a revision, a 412 is thrown unchanged too", async () => {
    const failure = httpError(412);
    const { api } = stubCalendarApi({ delete: failure });
    await expect(wrapCalendarApi(api).deleteEvent({ eventId: "e1" })).rejects.toBe(failure);
  });

  it("an empty revision is refused before any request", async () => {
    const { api, calls } = stubCalendarApi();
    await expect(wrapCalendarApi(api).deleteEvent({ eventId: "e1", expectedRevision: "" })).rejects.toThrow("nothing was written");
    expect(calls).toEqual([]);
  });
});

describe("makeCalendarClient — the read and the revision reach the api client untouched", () => {
  it("getEvent, and updateEvent/deleteEvent with and without a revision", async () => {
    const { api, calls } = stubCalendarApi({ get: httpError(404) });
    const client = makeCalendarClient(wrapCalendarApi(api));
    await expect(client.getEvent("primary", "e1")).resolves.toEqual({ outcome: "not_found" });
    await client.updateEvent({ eventId: "e1", summary: "Sync", expectedRevision: ETAG_READ });
    await client.deleteEvent({ eventId: "e1", expectedRevision: ETAG_AFTER });
    await client.updateEvent({ eventId: "e1", summary: "Sync" });
    await client.deleteEvent({ eventId: "e1" });
    expect(calls.map((c) => [c.method, c.args[1]])).toEqual([
      ["get", undefined],
      ["patch", { headers: { "If-Match": ETAG_READ } }],
      ["delete", { headers: { "If-Match": ETAG_AFTER } }],
      ["patch", undefined],
      ["delete", undefined],
    ]);
  });
});

// The stubs above prove what this file ASKS the googleapis client to do. This suite proves the
// client library then really puts it on the HTTP request: the real `google.calendar` and a real
// OAuth2 client, with only the network replaced. It says nothing about what Google answers.
describe("wrapCalendarApi through the real googleapis client (network replaced)", () => {
  interface Sent { method: string; path: string; ifMatch: string | null; authorized: boolean }

  function realCalendar(answer: (sent: Sent) => { status: number; body?: unknown }) {
    const sent: Sent[] = [];
    const fetchImplementation = async (url: unknown, init?: { method?: string; headers?: unknown }) => {
      const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
      const request = { method: init?.method ?? "GET", path: new URL(String(url)).pathname, ifMatch: headers.get("if-match"), authorized: headers.has("authorization") };
      sent.push(request);
      const { status, body } = answer(request);
      return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
    const auth = new google.auth.OAuth2("client-id", "client-secret");
    auth.setCredentials({ access_token: "access-token", expiry_date: Date.now() + 3_600_000 });
    const api = google.calendar({ version: "v3", auth, fetchImplementation } as unknown as Parameters<typeof google.calendar>[0]);
    return { client: wrapCalendarApi(api as Parameters<typeof wrapCalendarApi>[0]), sent };
  }
  const EVENT = { id: "e1", etag: ETAG_AFTER, updated: "2026-01-02T09:00:00.000Z", status: "confirmed", summary: "Sync",
    start: { dateTime: "2026-01-01T10:00:00Z" }, end: { dateTime: "2026-01-01T10:30:00Z" } };
  const matchOr412 = (s: Sent) => (s.ifMatch === null || s.ifMatch === ETAG_READ
    ? { status: s.method === "DELETE" ? 204 : 200, ...(s.method === "DELETE" ? {} : { body: EVENT }) }
    : { status: 412, body: { error: { code: 412, message: "Precondition Failed" } } });

  it("If-Match is on the PATCH and the DELETE that carry a revision, and on no other request", async () => {
    const { client, sent } = realCalendar(matchOr412);
    await client.getEvent("primary", "e1");
    const updated = await client.updateEvent({ eventId: "e1", summary: "Sync", expectedRevision: ETAG_READ });
    await client.deleteEvent({ eventId: "e1", expectedRevision: ETAG_READ });
    await client.updateEvent({ eventId: "e1", summary: "Sync" });
    await client.deleteEvent({ eventId: "e1" });
    expect(updated.revision).toEqual({ etag: ETAG_AFTER, updated: "2026-01-02T09:00:00.000Z" });
    const path = "/calendar/v3/calendars/primary/events/e1";
    expect(sent).toEqual([
      { method: "GET", path, ifMatch: null, authorized: true },
      { method: "PATCH", path, ifMatch: ETAG_READ, authorized: true },
      { method: "DELETE", path, ifMatch: ETAG_READ, authorized: true },
      { method: "PATCH", path, ifMatch: null, authorized: true },
      { method: "DELETE", path, ifMatch: null, authorized: true },
    ]);
  });

  it("the library's own error for a 412 is recognised, and the request went out once", async () => {
    const { client, sent } = realCalendar(matchOr412);
    await expect(client.updateEvent({ eventId: "e1", summary: "Sync", expectedRevision: '"stale"' })).rejects.toBeInstanceOf(CalendarEventChangedError);
    await expect(client.deleteEvent({ eventId: "e1", expectedRevision: '"stale"' })).rejects.toBeInstanceOf(CalendarEventChangedError);
    expect(sent.map((s) => [s.method, s.ifMatch])).toEqual([["PATCH", '"stale"'], ["DELETE", '"stale"']]);
  });

  it("the library's own errors for 404 and 410 on a read are recognised", async () => {
    const missing = realCalendar(() => ({ status: 404, body: { error: { code: 404, message: "Not Found" } } }));
    await expect(missing.client.getEvent("primary", "e1")).resolves.toEqual({ outcome: "not_found" });
    const gone = realCalendar(() => ({ status: 410, body: { error: { code: 410, message: "Resource has been deleted" } } }));
    await expect(gone.client.getEvent("primary", "e1")).resolves.toEqual({ outcome: "cancelled" });
    expect([missing.sent.length, gone.sent.length]).toEqual([1, 1]);
  });
});

// -----------------------------------------------------------------------------------------
// googleClients — laziness + GoogleUnenrolledError, against a REAL Postgres. Nothing here
// touches Google: __setTestGmailApiFactory means an "enrolled" test never has to.
// -----------------------------------------------------------------------------------------

describe("googleClients", () => {
  beforeEach(() => { useNoChosenMailbox(); });
  afterEach(() => { forgetChosenMailbox(); vi.unstubAllEnvs(); });

  it("is lazy: constructing the client does no I/O at all", () => {
    expect(() => googleClients()).not.toThrow();
  });

  it("with no mailbox chosen, refuses plainly and lists nothing", async () => {
    await expect(googleClients().gmail()).rejects.toThrow(GoogleConfigError);
    await expect(googleClients().gmail()).rejects.toThrow("No mailbox chosen for this agent; choose one on its Access tab");
    await expect(googleClients().calendar()).rejects.toThrow("No mailbox chosen for this agent; choose one on its Access tab");
    await expect(listEnrolledMailboxes()).resolves.toEqual([]);
  });

  it("never falls back to an environment pin or a stored token when nothing is chosen", async () => {
    vi.stubEnv("GOOGLE_PRINCIPAL_ID", "U_owner"); vi.stubEnv("GMAIL_PRIMARY_EMAIL", "owner@owner.example");
    vi.stubEnv("CALENDAR_PRIMARY_EMAIL", "owner@owner.example"); vi.stubEnv("LARES_EMAIL_PRINCIPAL", "U_owner");
    let built = 0;
    __setTestGmailApiFactory(() => { built++; return {} as never; });
    try {
      await expect(googleClients().gmail("owner@owner.example")).rejects.toThrow(/No mailbox chosen/);
      await expect(listEnrolledMailboxes()).resolves.toEqual([]);
      expect(built).toBe(0);
    } finally { __setTestGmailApiFactory(undefined); }
  });

  it("with a mailbox chosen, serves only that mailbox", async () => {
    const { api } = stubGmailApi({ list: { data: { messages: [{ id: "m1", threadId: "t1" }] } } });
    useChosenMailbox({ mailbox: "owner@owner.example", gmailApi: api });
    await expect(listEnrolledMailboxes()).resolves.toEqual(["owner@owner.example"]);
    await expect((await googleClients().gmail()).search("in:inbox", 25)).resolves.toEqual(["m1"]);
    await expect(googleClients().gmail("other@owner.example")).rejects.toThrow(/owner@owner.example only/);
  });
});
