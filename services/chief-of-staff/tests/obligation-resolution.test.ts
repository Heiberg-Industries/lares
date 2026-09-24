import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Obligation } from "../lib/brief-content.js";
import { resolveElsewhere, RESOLUTION_LOOKUP_TIMEOUT_MS, type ResolutionDeps } from "../lib/obligation-resolution.js";

// node:sqlite, not better-sqlite3 — network-client.ts (the module under test for `networkOutboundAfter`)
// opens the replica with node:sqlite's DatabaseSync (see its header comment for why), so the seed
// db has to be written with the same driver to prove the real read path, not a cross-driver file
// compatibility accident.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * ORB-45 Task 10, B2 — resolveElsewhere: four best-effort metadata lookups (Gmail sent, calendar
 * ended, Slack own messages, network-replica outbound), any hit clears an obligation. Cases
 * (a)-(f) exercise the resolver itself against fake ResolutionDeps; (g) exercises the real
 * `networkOutboundAfter` query against a real (temporary) sqlite file built with the network
 * package's current (v5) schema.
 */

const NOW = new Date("2026-08-20T12:00:00Z");

function obligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    threadId: "t-1",
    subject: "Re: pilot terms",
    counterpartyName: "Angela Berg",
    counterpartyAddress: "angela@example.com",
    lastMessageAt: new Date("2026-08-10T09:00:00Z"),
    ageHours: 60,
    isRePing: false,
    unansweredCount: 1,
    source: "gmail",
    counterpartyEmails: ["angela@example.com"],
    counterpartySlackUserId: "U123ANGELA",
    ...overrides,
  };
}

function deps(overrides: Partial<ResolutionDeps> = {}): ResolutionDeps {
  return {
    gmailSentAfter: async () => null,
    calendarEndedWith: async () => null,
    slackOwnMessageAfter: () => null,
    networkOutboundAfter: () => null,
    ...overrides,
  };
}

describe("resolveElsewhere", () => {
  it("(a) no hits from any source — resolution is null, all 4 consulted, none unreadable", async () => {
    const result = await resolveElsewhere(obligation(), deps(), NOW);
    expect(result.resolution).toBeNull();
    expect(result.consulted).toEqual(["gmail", "calendar", "slack", "network"]);
    expect(result.unreadable).toEqual([]);
  });

  it("(b) a Gmail message sent to them AFTER `since` resolves via gmail, with the date in the evidence", async () => {
    const o = obligation({ lastMessageAt: new Date("2026-08-10T09:00:00Z") });
    const sentAt = new Date("2026-08-15T14:02:00Z"); // 16:02 Oslo (CEST, UTC+2 in August)
    const d = deps({
      gmailSentAfter: async (_addrs, since) => (sentAt > since ? sentAt : null),
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution).not.toBeNull();
    expect(result.resolution!.via).toBe("gmail");
    expect(result.resolution!.at).toEqual(sentAt);
    expect(result.resolution!.evidence).toBe("you emailed them 2026-08-15 16:02");
    // Resolution carries the same consulted/unreadable lists as the outer result.
    expect(result.resolution!.consulted).toEqual(result.consulted);
    expect(result.resolution!.unreadable).toEqual(result.unreadable);
  });

  it("(c) a Gmail message sent BEFORE `since` is not a hit", async () => {
    const o = obligation({ lastMessageAt: new Date("2026-08-10T09:00:00Z") });
    const sentAt = new Date("2026-08-05T09:00:00Z"); // before lastMessageAt
    const d = deps({
      gmailSentAfter: async (_addrs, since) => (sentAt > since ? sentAt : null),
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution).toBeNull();
    expect(result.unreadable).toEqual([]);
  });

  it("(d) a calendar event with an attendee match that ENDED resolves via calendar", async () => {
    const o = obligation({ lastMessageAt: new Date("2026-08-10T09:00:00Z") });
    const meeting = { at: new Date("2026-08-13T11:00:00Z"), summary: "Bendik Heiberg and Angela Berg" }; // 13:00 Oslo
    const d = deps({
      calendarEndedWith: async (_addrs, since, now) => (meeting.at > since && meeting.at <= now ? meeting : null),
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution!.via).toBe("calendar");
    expect(result.resolution!.at).toEqual(meeting.at);
    expect(result.resolution!.evidence).toBe("you met 2026-08-13 13:00: Bendik Heiberg and Angela Berg");
  });

  it("(d) a calendar event that has NOT ended (its end is after `now`) is not a hit", async () => {
    const o = obligation({ lastMessageAt: new Date("2026-08-10T09:00:00Z") });
    const meeting = { at: new Date("2026-08-25T11:00:00Z"), summary: "future meeting" }; // after NOW
    const d = deps({
      calendarEndedWith: async (_addrs, since, now) => (meeting.at > since && meeting.at <= now ? meeting : null),
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution).toBeNull();
  });

  it("(e) a dep that throws lands in `unreadable`; the others still decide the resolution", async () => {
    const o = obligation();
    const sentAt = new Date("2026-08-15T14:02:00Z");
    const d = deps({
      gmailSentAfter: async () => sentAt,
      calendarEndedWith: async () => {
        throw new Error("calendar API 500");
      },
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.unreadable).toEqual(["calendar"]);
    expect(result.resolution!.via).toBe("gmail");
  });

  it("(f) a dep that hangs times out — lands in `unreadable`, real wall time stays well under 6s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const start = Date.now();
      const hang = new Promise<Date | null>(() => {
        /* never resolves */
      });
      const o = obligation();
      const d = deps({ gmailSentAfter: () => hang });

      const pending = resolveElsewhere(o, d, NOW);
      await vi.advanceTimersByTimeAsync(RESOLUTION_LOOKUP_TIMEOUT_MS + 50);
      const result = await pending;

      expect(result.unreadable).toEqual(["gmail"]);
      expect(result.resolution).toBeNull();
      expect(Date.now() - start).toBeLessThan(6000); // real wall clock — Date wasn't faked
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the LATEST hit when multiple sources hit", async () => {
    const o = obligation();
    const earlier = new Date("2026-08-14T09:00:00Z");
    const later = new Date("2026-08-16T09:00:00Z");
    const d = deps({
      gmailSentAfter: async () => earlier,
      slackOwnMessageAfter: () => later,
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution!.via).toBe("slack");
    expect(result.resolution!.at).toEqual(later);
  });

  it("ties break by fixed source order (gmail, calendar, slack, network)", async () => {
    const o = obligation();
    const sameTime = new Date("2026-08-16T09:00:00Z");
    const d = deps({
      slackOwnMessageAfter: () => sameTime,
      gmailSentAfter: async () => sameTime,
    });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution!.via).toBe("gmail"); // gmail precedes slack in SOURCES order
  });

  it("network hit via an outbound iMessage produces the imessage evidence sentence", async () => {
    const o = obligation();
    const at = new Date("2026-08-16T08:30:00Z"); // 10:30 Oslo
    const d = deps({ networkOutboundAfter: () => ({ channel: "imessage", at }) });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution!.via).toBe("imessage");
    expect(result.resolution!.evidence).toBe("you messaged them 2026-08-16 10:30");
  });

  it("network hit via an answered outbound call produces the call evidence sentence", async () => {
    const o = obligation();
    const at = new Date("2026-08-16T08:30:00Z");
    const d = deps({ networkOutboundAfter: () => ({ channel: "call", at }) });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution!.via).toBe("call");
    expect(result.resolution!.evidence).toBe("you called them 2026-08-16 10:30");
  });

  it("Slack own-message hit produces the slack evidence sentence", async () => {
    const o = obligation();
    const at = new Date("2026-08-16T08:30:00Z");
    const d = deps({ slackOwnMessageAfter: () => at });

    const result = await resolveElsewhere(o, d, NOW);
    expect(result.resolution!.via).toBe("slack");
    expect(result.resolution!.evidence).toBe("you wrote to them on Slack 2026-08-16 10:30");
  });
});

// ── (g) networkOutboundAfter against a real, temporary sqlite replica ───────────────────────

describe("networkOutboundAfter", () => {
  let dir: string;

  afterEach(() => {
    delete process.env["NETWORK_DB_PATH"];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Mirrors the CREATE TABLE statements for contacts/identities/interactions in
  // services/network/lib/db.ts's current (v5, post-migrateV4toV5) schema — the shapes with
  // 'slack_user' admitted into identities.kind and 'slack' into interactions.channel — built
  // directly with node:sqlite (not the better-sqlite3-backed openDb helper) so this test
  // exercises the exact driver/schema pairing network-client.ts uses in production.
  function seed(path: string, opts: { emailValue?: string; slackUserValue?: string } = {}): void {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE contacts (
        id                   INTEGER PRIMARY KEY,
        display_name         TEXT NOT NULL,
        company              TEXT,
        title                TEXT,
        source               TEXT NOT NULL,
        resolved             INTEGER NOT NULL DEFAULT 1,
        notes                TEXT,
        twenty_id_cache      TEXT,
        twenty_strength      TEXT,
        twenty_last_contacted TEXT,
        twenty_synced_at     TEXT
      );
      CREATE TABLE identities (
        id         INTEGER PRIMARY KEY,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('email','phone','linkedin_url','twenty_id','instagram','meta_name','slack_user')),
        value      TEXT NOT NULL,
        source     TEXT NOT NULL,
        UNIQUE (kind, value)
      );
      CREATE INDEX idx_identities_contact ON identities(contact_id);
      CREATE TABLE interactions (
        id          INTEGER PRIMARY KEY,
        contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        channel     TEXT NOT NULL CHECK (channel IN ('linkedin','linkedin_invite','imessage','call','instagram','facebook','slack')),
        direction   TEXT CHECK (direction IN ('inbound','outbound')),
        at          TEXT NOT NULL,
        content     TEXT,
        external_id TEXT NOT NULL,
        answered    INTEGER,
        UNIQUE (channel, external_id)
      );
      CREATE INDEX idx_interactions_contact ON interactions(contact_id, at);
    `);
    db.prepare(`INSERT INTO contacts (id, display_name, source) VALUES (1, 'Angela Berg', 'test')`).run();
    if (opts.emailValue) {
      db.prepare(`INSERT INTO identities (contact_id, kind, value, source) VALUES (1, 'email', ?, 'test')`).run(opts.emailValue);
    }
    if (opts.slackUserValue) {
      db.prepare(`INSERT INTO identities (contact_id, kind, value, source) VALUES (1, 'slack_user', ?, 'test')`).run(
        opts.slackUserValue,
      );
    }
    db.close();
  }

  function insert(
    path: string,
    row: { channel: string; direction: string | null; at: string; externalId: string; answered?: number | null },
  ): void {
    const db = new DatabaseSync(path);
    db.prepare(
      `INSERT INTO interactions (contact_id, channel, direction, at, content, external_id, answered) VALUES (1, ?, ?, ?, NULL, ?, ?)`,
    ).run(row.channel, row.direction, row.at, row.externalId, row.answered ?? null);
    db.close();
  }

  async function freshNetworkClient(): Promise<typeof import("../lib/network-client.js")> {
    // network-client.ts reads NETWORK_DB_PATH from process.env PER CALL (not at module scope —
    // see its own comment), so a single import works across every case below; no re-import needed.
    return import("../lib/network-client.js");
  }

  const since = new Date("2026-08-10T00:00:00Z");

  it("outbound imessage after `since` is a hit", async () => {
    dir = mkdtempSync(join(tmpdir(), "obligation-resolution-net-"));
    const dbPath = join(dir, "network.db");
    seed(dbPath, { emailValue: "angela@example.com" });
    insert(dbPath, { channel: "imessage", direction: "outbound", at: "2026-08-16T10:00:00Z", externalId: "m1" });
    process.env["NETWORK_DB_PATH"] = dbPath;

    const { networkOutboundAfter } = await freshNetworkClient();
    const hit = networkOutboundAfter({ emails: ["angela@example.com"] }, since);
    expect(hit).toEqual({ channel: "imessage", at: new Date("2026-08-16T10:00:00Z") });
  });

  it("an inbound-only imessage is NOT a hit", async () => {
    dir = mkdtempSync(join(tmpdir(), "obligation-resolution-net-"));
    const dbPath = join(dir, "network.db");
    seed(dbPath, { emailValue: "angela@example.com" });
    insert(dbPath, { channel: "imessage", direction: "inbound", at: "2026-08-16T10:00:00Z", externalId: "m1" });
    process.env["NETWORK_DB_PATH"] = dbPath;

    const { networkOutboundAfter } = await freshNetworkClient();
    expect(networkOutboundAfter({ emails: ["angela@example.com"] }, since)).toBeNull();
  });

  it("an unanswered outbound call is NOT a hit", async () => {
    dir = mkdtempSync(join(tmpdir(), "obligation-resolution-net-"));
    const dbPath = join(dir, "network.db");
    seed(dbPath, { emailValue: "angela@example.com" });
    insert(dbPath, { channel: "call", direction: "outbound", at: "2026-08-16T10:00:00Z", externalId: "c1", answered: 0 });
    process.env["NETWORK_DB_PATH"] = dbPath;

    const { networkOutboundAfter } = await freshNetworkClient();
    expect(networkOutboundAfter({ emails: ["angela@example.com"] }, since)).toBeNull();
  });

  it("an ANSWERED outbound call IS a hit", async () => {
    dir = mkdtempSync(join(tmpdir(), "obligation-resolution-net-"));
    const dbPath = join(dir, "network.db");
    seed(dbPath, { emailValue: "angela@example.com" });
    insert(dbPath, { channel: "call", direction: "outbound", at: "2026-08-16T10:00:00Z", externalId: "c1", answered: 1 });
    process.env["NETWORK_DB_PATH"] = dbPath;

    const { networkOutboundAfter } = await freshNetworkClient();
    expect(networkOutboundAfter({ emails: ["angela@example.com"] }, since)).toEqual({
      channel: "call",
      at: new Date("2026-08-16T10:00:00Z"),
    });
  });

  it("an interaction AT or BEFORE `since` is not a hit", async () => {
    dir = mkdtempSync(join(tmpdir(), "obligation-resolution-net-"));
    const dbPath = join(dir, "network.db");
    seed(dbPath, { emailValue: "angela@example.com" });
    insert(dbPath, { channel: "imessage", direction: "outbound", at: since.toISOString(), externalId: "m1" });
    process.env["NETWORK_DB_PATH"] = dbPath;

    const { networkOutboundAfter } = await freshNetworkClient();
    expect(networkOutboundAfter({ emails: ["angela@example.com"] }, since)).toBeNull();
  });

  it("email identities match case-insensitively on both sides", async () => {
    dir = mkdtempSync(join(tmpdir(), "obligation-resolution-net-"));
    const dbPath = join(dir, "network.db");
    seed(dbPath, { emailValue: "Angela@Example.COM" });
    insert(dbPath, { channel: "imessage", direction: "outbound", at: "2026-08-16T10:00:00Z", externalId: "m1" });
    process.env["NETWORK_DB_PATH"] = dbPath;

    const { networkOutboundAfter } = await freshNetworkClient();
    expect(networkOutboundAfter({ emails: ["angela@example.com"] }, since)).toEqual({
      channel: "imessage",
      at: new Date("2026-08-16T10:00:00Z"),
    });
  });

  it("slack_user identities match exactly, case-sensitively (not normalized)", async () => {
    dir = mkdtempSync(join(tmpdir(), "obligation-resolution-net-"));
    const dbPath = join(dir, "network.db");
    seed(dbPath, { slackUserValue: "U123ANGELA" });
    insert(dbPath, { channel: "imessage", direction: "outbound", at: "2026-08-16T10:00:00Z", externalId: "m1" });
    process.env["NETWORK_DB_PATH"] = dbPath;

    const { networkOutboundAfter } = await freshNetworkClient();
    expect(networkOutboundAfter({ emails: [], slackUserId: "U123ANGELA" }, since)).toEqual({
      channel: "imessage",
      at: new Date("2026-08-16T10:00:00Z"),
    });
    expect(networkOutboundAfter({ emails: [], slackUserId: "u123angela" }, since)).toBeNull();
  });

  it("no email and no slackUserId given returns null (no identity to match on, no interactions query issued)", async () => {
    dir = mkdtempSync(join(tmpdir(), "obligation-resolution-net-"));
    const dbPath = join(dir, "network.db");
    seed(dbPath, { emailValue: "angela@example.com" });
    insert(dbPath, { channel: "imessage", direction: "outbound", at: "2026-08-16T10:00:00Z", externalId: "m1" });
    process.env["NETWORK_DB_PATH"] = dbPath;

    const { networkOutboundAfter } = await freshNetworkClient();
    expect(networkOutboundAfter({ emails: [] }, since)).toBeNull();
  });
});
