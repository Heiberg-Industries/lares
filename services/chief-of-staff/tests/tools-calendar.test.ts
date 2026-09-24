import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import calendarListEvents from "../catalogue/calendar_list_events.js";
import calendarFreeBusy from "../catalogue/calendar_free_busy.js";
import calendarListCalendars from "../catalogue/calendar_list_calendars.js";
import calendarCreateEvent from "../catalogue/calendar_create_event.js";
import calendarUpdateEvent from "../catalogue/calendar_update_event.js";
import calendarDeleteEvent from "../catalogue/calendar_delete_event.js";
import { __setTestCalendarApiFactory, wrapCalendarApi, GoogleUnenrolledError } from "../lib/google.js";
import { UnauthorizedApproverError } from "../lib/approvals.js";
import { getPool, closePool } from "@lares/agent-kit/db";

/**
 * Task 7 — the six calendar tools, end to end against a REAL Postgres (oauth_tokens, matching
 * tests/tools-gmail.test.ts's convention) with a STUBBED googleapis client
 * (`__setTestCalendarApiFactory`) standing in for Google itself. Proves:
 *   - create_event/update_event/delete_event refuse without a valid approver, BEFORE any DB
 *     lookup or googleapis call (same rigor as tests/tools-gmail.test.ts's write tools: zero
 *     calls on refusal, even when the stub is enrolled and live)
 *   - list_events/free_busy/list_calendars marshal the exact googleapis request shape (via
 *     wrapCalendarApi, already ported from calendar-oauth.ts) end to end through the tool +
 *     adapter
 *   - create_event/update_event/delete_event thread `notify` to `sendUpdates` exactly as
 *     lib/google.ts's `sendUpdatesFor` does: true -> "all", false -> "none", omitted -> "all"
 *     (ORB-46: "invites now actually SEND")
 *   - an unenrolled principal surfaces `GoogleUnenrolledError` only when a tool's execute()
 *     actually runs — never at import/registration time
 *   - delete_event's schema refuses a missing/empty eventId outright (the idiomatic
 *     equivalent of the old hand's "guessing an id here would cancel someone else's meeting"
 *     runtime check)
 */

const BENDIK = "U_EXAMPLE_OWNER";
const SOMEONE_ELSE = "U0BADBADBAD";

function slackAuth(userId: string) {
  return {
    attributes: { user_id: userId, channel_id: "D123", thread_ts: "1.0" },
    authenticator: "slack-webhook",
    principalId: `slack:T1:${userId}`,
    principalType: "user",
  };
}

function ctx(auth: unknown) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

const READ_CTX = {} as never;

interface RecordedCall { method: string; params: unknown }

function stubCalendarApi(responses: Partial<{
  list: unknown; insert: unknown; patch: unknown; delete: unknown; freebusy: unknown; calendarList: unknown;
}> = {}) {
  const calls: RecordedCall[] = [];
  const api = {
    events: {
      list: async (params: unknown) => { calls.push({ method: "list", params }); return responses.list ?? { data: { items: [] } }; },
      insert: async (params: unknown) => {
        calls.push({ method: "insert", params });
        return responses.insert ?? { data: { id: "e1", summary: "Sync", start: { dateTime: "2026-01-01T10:00:00Z" }, end: { dateTime: "2026-01-01T10:30:00Z" } } };
      },
      patch: async (params: unknown) => {
        calls.push({ method: "patch", params });
        return responses.patch ?? { data: { id: "e1", summary: "Sync (updated)", start: { dateTime: "2026-01-01T10:00:00Z" }, end: { dateTime: "2026-01-01T10:30:00Z" } } };
      },
      delete: async (params: unknown) => { calls.push({ method: "delete", params }); return responses.delete ?? { data: {} }; },
    },
    freebusy: {
      query: async (params: unknown) => { calls.push({ method: "freebusy", params }); return responses.freebusy ?? { data: { calendars: { primary: { busy: [] } } } }; },
    },
    calendarList: {
      list: async (params: unknown) => { calls.push({ method: "calendarList", params }); return responses.calendarList ?? { data: { items: [] } }; },
    },
  };
  return { api: api as unknown as Parameters<typeof wrapCalendarApi>[0], calls };
}

function encryptForTest(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

let container: StartedPostgreSqlContainer;
let keyDir: string;
let testKeyHex: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env["DATABASE_URL"] = container.getConnectionUri();
  await getPool().query(`
    CREATE TABLE oauth_tokens (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal          text        NOT NULL,
      provider           text        NOT NULL,
      org_id             text        NOT NULL,
      email_address      text        NOT NULL,
      refresh_token_enc  text        NOT NULL,
      scopes             text[]      NOT NULL DEFAULT '{}',
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT oauth_tokens_principal_provider_email_uk UNIQUE (principal, provider, email_address)
    )
  `);
}, 120_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

beforeEach(async () => {
  keyDir = mkdtempSync(join(tmpdir(), "calendar-tools-key-"));
  testKeyHex = randomBytes(32).toString("hex");
  writeFileSync(join(keyDir, "token-enc-key"), testKeyHex);
  writeFileSync(join(keyDir, "client-id"), "test-client-id");
  writeFileSync(join(keyDir, "client-secret"), "test-client-secret");
  process.env["TOKEN_ENC_KEY_FILE"] = join(keyDir, "token-enc-key");
  process.env["GOOGLE_CLIENT_ID_HEIBERG_FILE"] = join(keyDir, "client-id");
  process.env["GOOGLE_CLIENT_SECRET_HEIBERG_FILE"] = join(keyDir, "client-secret");
  process.env["GOOGLE_PRINCIPAL_ID"] = "U_bendik";
  process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK;
});

afterEach(async () => {
  rmSync(keyDir, { recursive: true, force: true });
  delete process.env["TOKEN_ENC_KEY_FILE"];
  delete process.env["GOOGLE_CLIENT_ID_HEIBERG_FILE"];
  delete process.env["GOOGLE_CLIENT_SECRET_HEIBERG_FILE"];
  delete process.env["GOOGLE_PRINCIPAL_ID"];
  delete process.env["SLACK_ALLOWED_USER_IDS"];
  __setTestCalendarApiFactory(undefined);
  await getPool().query(`DELETE FROM oauth_tokens`);
});

/** Seeds one enrolled mailbox for U_bendik and installs a stub googleapis factory. Returns
 *  the recorded calls array so a test can assert on it. */
async function enroll(responses: Parameters<typeof stubCalendarApi>[0] = {}): Promise<RecordedCall[]> {
  const enc = encryptForTest("refresh-token-real", testKeyHex);
  await getPool().query(
    `INSERT INTO oauth_tokens (principal, provider, org_id, email_address, refresh_token_enc, scopes) VALUES ($1,$2,$3,$4,$5,$6)`,
    ["U_bendik", "google", "heiberg", "owner@example.invalid", enc, ["calendar"]],
  );
  const { api, calls } = stubCalendarApi(responses);
  __setTestCalendarApiFactory(() => api);
  return calls;
}

// -----------------------------------------------------------------------------------------
// Reads — free, no approval required
// -----------------------------------------------------------------------------------------

describe("calendar_list_events", () => {
  it("marshals timeMin/timeMax/max to a single events.list call and returns items", async () => {
    const calls = await enroll({
      list: { data: { items: [{ id: "e1", summary: "Standup", start: { dateTime: "2026-01-01T10:00:00Z" }, end: { dateTime: "2026-01-01T10:30:00Z" } }] } },
    });
    const result = await calendarListEvents.execute({ timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-01-02T00:00:00Z", max: 10 }, READ_CTX);
    expect(result).toEqual([{ id: "e1", summary: "Standup", start: "2026-01-01T10:00:00Z", end: "2026-01-01T10:30:00Z" }]);
    expect(calls).toEqual([{
      method: "list",
      params: { calendarId: "primary", timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-01-02T00:00:00Z", maxResults: 10, singleEvents: true, orderBy: "startTime" },
    }]);
  });

  it("defaults max to 50 when omitted", async () => {
    const calls = await enroll();
    await calendarListEvents.execute({ timeMin: "t1", timeMax: "t2" }, READ_CTX);
    expect((calls[0]!.params as { maxResults: number }).maxResults).toBe(50);
  });

  it("passes calendarId through when given; defaults to primary when omitted", async () => {
    const calls = await enroll();
    await calendarListEvents.execute({ timeMin: "t1", timeMax: "t2", calendarId: "orakel@group.calendar.google.com" }, READ_CTX);
    expect((calls[0]!.params as { calendarId: string }).calendarId).toBe("orakel@group.calendar.google.com");
  });

  it("throws GoogleUnenrolledError only once execute() actually runs, not at import time", async () => {
    // Deliberately no enroll() — no oauth_tokens row for U_bendik.
    await expect(calendarListEvents.execute({ timeMin: "t1", timeMax: "t2" }, READ_CTX)).rejects.toThrow(GoogleUnenrolledError);
  });
});

describe("calendar_free_busy", () => {
  it("marshals timeMin/timeMax to a freebusy.query call and returns busy windows", async () => {
    const calls = await enroll({ freebusy: { data: { calendars: { primary: { busy: [{ start: "2026-01-01T09:00:00Z", end: "2026-01-01T10:00:00Z" }] } } } } });
    const result = await calendarFreeBusy.execute({ timeMin: "t1", timeMax: "t2" }, READ_CTX);
    expect(result).toEqual([{ start: "2026-01-01T09:00:00Z", end: "2026-01-01T10:00:00Z" }]);
    expect(calls).toEqual([{ method: "freebusy", params: { requestBody: { timeMin: "t1", timeMax: "t2", items: [{ id: "primary" }] } } }]);
  });

  it("queries the given calendarId instead of primary when supplied", async () => {
    const calls = await enroll({ freebusy: { data: { calendars: { "orakel@group.calendar.google.com": { busy: [] } } } } });
    await calendarFreeBusy.execute({ timeMin: "t1", timeMax: "t2", calendarId: "orakel@group.calendar.google.com" }, READ_CTX);
    expect((calls[0]!.params as { requestBody: { items: { id: string }[] } }).requestBody.items).toEqual([{ id: "orakel@group.calendar.google.com" }]);
  });
});

describe("calendar_list_calendars", () => {
  it("lists only writable/primary calendars", async () => {
    const calls = await enroll({
      calendarList: {
        data: {
          items: [
            { id: "primary", summary: "Bendik", accessRole: "owner", primary: true },
            { id: "orakel@group.calendar.google.com", summary: "Orakel", accessRole: "writer" },
            { id: "readonly@x", summary: "Read-only calendar", accessRole: "reader" },
          ],
        },
      },
    });
    const result = await calendarListCalendars.execute({}, READ_CTX);
    expect(result).toEqual([
      { id: "primary", summary: "Bendik", primary: true },
      { id: "orakel@group.calendar.google.com", summary: "Orakel", primary: false },
    ]);
    expect(calls).toEqual([{ method: "calendarList", params: { maxResults: 250, showHidden: false } }]);
  });
});

// -----------------------------------------------------------------------------------------
// Writes — GATED. Refuse before any DB lookup or googleapis call; issue the right call once
// approved; thread `notify` to `sendUpdates` exactly as lib/google.ts's `sendUpdatesFor` does.
// -----------------------------------------------------------------------------------------

describe("calendar_create_event", () => {
  const INPUT = { summary: "Sync", start: "2026-01-01T10:00:00Z", end: "2026-01-01T10:30:00Z" };

  it("declares approval: always()", () => {
    expect(calendarCreateEvent.approval).toBeTypeOf("function");
  });

  it("refuses a present-but-unidentified approver context, before any DB lookup or googleapis call", async () => {
    // Enrolled anyway (the stub is live and would happily answer) — the point is that the
    // refusal happens before resolution even starts, not that resolution would have failed.
    const calls = await enroll();
    await expect(calendarCreateEvent.execute(INPUT, ctx({}))).rejects.toThrow(UnauthorizedApproverError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a wrong/cross-channel approver, before any googleapis call", async () => {
    const calls = await enroll();
    await expect(calendarCreateEvent.execute(INPUT, ctx(slackAuth(SOMEONE_ELSE)))).rejects.toThrow(UnauthorizedApproverError);
    expect(calls).toHaveLength(0);
  });

  it("on a valid approver, creates the event", async () => {
    const calls = await enroll();
    const result = await calendarCreateEvent.execute(INPUT, ctx(slackAuth(BENDIK)));
    expect(result).toEqual({ id: "e1", summary: "Sync", start: "2026-01-01T10:00:00Z", end: "2026-01-01T10:30:00Z" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("insert");
  });

  it("surfaces GoogleUnenrolledError once approval passes, not before", async () => {
    // No enroll() — the approval gate must pass first (a valid approver), THEN resolution
    // hits the real "no oauth_tokens row" outcome.
    await expect(calendarCreateEvent.execute(INPUT, ctx(slackAuth(BENDIK)))).rejects.toThrow(GoogleUnenrolledError);
  });

  describe("sendUpdates threading (ORB-46: notify unless explicitly told not to)", () => {
    it("notify: true -> sendUpdates 'all'", async () => {
      const calls = await enroll();
      await calendarCreateEvent.execute({ ...INPUT, notify: true }, ctx(slackAuth(BENDIK)));
      expect((calls[0]!.params as { sendUpdates: string }).sendUpdates).toBe("all");
    });

    it("notify: false -> sendUpdates 'none'", async () => {
      const calls = await enroll();
      await calendarCreateEvent.execute({ ...INPUT, notify: false }, ctx(slackAuth(BENDIK)));
      expect((calls[0]!.params as { sendUpdates: string }).sendUpdates).toBe("none");
    });

    it("notify omitted -> sendUpdates 'all' (never silently 'none')", async () => {
      const calls = await enroll();
      await calendarCreateEvent.execute(INPUT, ctx(slackAuth(BENDIK)));
      expect((calls[0]!.params as { sendUpdates: string }).sendUpdates).toBe("all");
    });
  });
});

describe("calendar_update_event", () => {
  const INPUT = { eventId: "e1", summary: "Sync (moved)" };

  it("declares approval: always()", () => {
    expect(calendarUpdateEvent.approval).toBeTypeOf("function");
  });

  it("refuses a present-but-unidentified approver context, before any DB lookup or googleapis call", async () => {
    const calls = await enroll();
    await expect(calendarUpdateEvent.execute(INPUT, ctx({}))).rejects.toThrow(UnauthorizedApproverError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a wrong/cross-channel approver, before any googleapis call", async () => {
    const calls = await enroll();
    await expect(calendarUpdateEvent.execute(INPUT, ctx(slackAuth(SOMEONE_ELSE)))).rejects.toThrow(UnauthorizedApproverError);
    expect(calls).toHaveLength(0);
  });

  it("on a valid approver, updates the event by id", async () => {
    const calls = await enroll();
    const result = await calendarUpdateEvent.execute(INPUT, ctx(slackAuth(BENDIK)));
    expect(result).toEqual({ id: "e1", summary: "Sync (updated)", start: "2026-01-01T10:00:00Z", end: "2026-01-01T10:30:00Z" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("patch");
    expect((calls[0]!.params as { eventId: string }).eventId).toBe("e1");
  });

  describe("sendUpdates threading", () => {
    it("notify: true -> sendUpdates 'all'", async () => {
      const calls = await enroll();
      await calendarUpdateEvent.execute({ ...INPUT, notify: true }, ctx(slackAuth(BENDIK)));
      expect((calls[0]!.params as { sendUpdates: string }).sendUpdates).toBe("all");
    });

    it("notify: false -> sendUpdates 'none'", async () => {
      const calls = await enroll();
      await calendarUpdateEvent.execute({ ...INPUT, notify: false }, ctx(slackAuth(BENDIK)));
      expect((calls[0]!.params as { sendUpdates: string }).sendUpdates).toBe("none");
    });

    it("notify omitted -> sendUpdates 'all'", async () => {
      const calls = await enroll();
      await calendarUpdateEvent.execute(INPUT, ctx(slackAuth(BENDIK)));
      expect((calls[0]!.params as { sendUpdates: string }).sendUpdates).toBe("all");
    });
  });
});

describe("calendar_delete_event", () => {
  const INPUT = { eventId: "e1" };

  it("declares approval: always()", () => {
    expect(calendarDeleteEvent.approval).toBeTypeOf("function");
  });

  it("schema refuses a missing or empty eventId outright — guessing one would cancel someone else's meeting", () => {
    expect(calendarDeleteEvent.inputSchema.safeParse({}).success).toBe(false);
    expect(calendarDeleteEvent.inputSchema.safeParse({ eventId: "" }).success).toBe(false);
    expect(calendarDeleteEvent.inputSchema.safeParse({ eventId: "e1" }).success).toBe(true);
  });

  // LAR-59-s4 — `reason` is card text for the approval gate (formatted by
  // @lares/agent-kit/approval-summary), never a Google API field.
  describe("reason (LAR-59-s4) — card text only, never sent to Google", () => {
    it("schema accepts a reason up to 240 characters and refuses a longer one", () => {
      expect(calendarDeleteEvent.inputSchema.safeParse({ eventId: "e1", reason: "x".repeat(240) }).success).toBe(true);
      expect(calendarDeleteEvent.inputSchema.safeParse({ eventId: "e1", reason: "x".repeat(241) }).success).toBe(false);
    });

    it("execute() never passes reason to Google's deleteEvent call", async () => {
      const calls = await enroll();
      await calendarDeleteEvent.execute(
        { eventId: "e1", reason: "Cancellation mail from The Standard, 18 Aug 2026." },
        ctx(slackAuth(BENDIK)),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.params).not.toHaveProperty("reason");
    });

    it("the googleapis call is byte-identical whether or not a reason was given", async () => {
      const calls = await enroll();
      await calendarDeleteEvent.execute({ eventId: "e1" }, ctx(slackAuth(BENDIK)));
      expect(calls[0]!.params).not.toHaveProperty("reason");
      // Same shape as the "on a valid approver, deletes the event by id" case above.
      expect((calls[0]!.params as { eventId: string }).eventId).toBe("e1");
    });
  });

  it("refuses a present-but-unidentified approver context, before any DB lookup or googleapis call", async () => {
    const calls = await enroll();
    await expect(calendarDeleteEvent.execute(INPUT, ctx({}))).rejects.toThrow(UnauthorizedApproverError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a wrong/cross-channel approver, before any googleapis call", async () => {
    const calls = await enroll();
    await expect(calendarDeleteEvent.execute(INPUT, ctx(slackAuth(SOMEONE_ELSE)))).rejects.toThrow(UnauthorizedApproverError);
    expect(calls).toHaveLength(0);
  });

  it("on a valid approver, deletes the event by id", async () => {
    const calls = await enroll();
    const result = await calendarDeleteEvent.execute(INPUT, ctx(slackAuth(BENDIK)));
    expect(result).toEqual({ deleted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("delete");
    expect((calls[0]!.params as { eventId: string }).eventId).toBe("e1");
  });

  describe("sendUpdates threading", () => {
    it("notify: true -> sendUpdates 'all'", async () => {
      const calls = await enroll();
      await calendarDeleteEvent.execute({ ...INPUT, notify: true }, ctx(slackAuth(BENDIK)));
      expect((calls[0]!.params as { sendUpdates: string }).sendUpdates).toBe("all");
    });

    it("notify: false -> sendUpdates 'none'", async () => {
      const calls = await enroll();
      await calendarDeleteEvent.execute({ ...INPUT, notify: false }, ctx(slackAuth(BENDIK)));
      expect((calls[0]!.params as { sendUpdates: string }).sendUpdates).toBe("none");
    });

    it("notify omitted -> sendUpdates 'all'", async () => {
      const calls = await enroll();
      await calendarDeleteEvent.execute(INPUT, ctx(slackAuth(BENDIK)));
      expect((calls[0]!.params as { sendUpdates: string }).sendUpdates).toBe("all");
    });
  });
});
