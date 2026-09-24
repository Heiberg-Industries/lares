import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getPool, closePool } from "@lares/agent-kit/db";
import type { ThreadMessage } from "../lib/google.js";
import {
  isInstitutionalDueNotice,
  scanThreads,
  selectObligations,
  type GmailSourceDeps,
  type Obligation,
  type ThreadSnapshot,
} from "../lib/brief-content.js";
import {
  ensureObligationsTable,
  ensureObligationsTableOnce,
  upsertSeen,
  dismissedThreads,
  dismissObligation,
  announcedRePings,
  markRePingAnnounced,
  markNightBeforeDelivered,
  nightBeforeDelivered,
  resolvedThreads,
  markResolved,
  cachedIntent,
  recordIntent,
} from "../lib/obligations-store.js";

/**
 * Task 12 — lib/obligations-store.ts, the Postgres adapter ported from
 * services/agent-runtime/lib/adapters/obligations/store.ts's makeObligationStore. Table and
 * column names must match services/box/sql/019_obligations.sql exactly — proven here
 * against a REAL, disposable Postgres (testcontainers, the ORB-45 house pattern this repo's
 * own tests/db.test.ts / tests/reminders.test.ts already established), never a fake Pool.
 */
describe("lib/obligations-store.ts", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
    await ensureObligationsTable(getPool());
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  afterEach(async () => {
    await getPool().query(`DELETE FROM obligation_threads`);
  });

  function obligation(overrides: Partial<Obligation> = {}): Obligation {
    return {
      threadId: "t-1",
      subject: "Re: pilot terms",
      counterpartyName: "Lars Eriksen",
      counterpartyAddress: "lars@partner.example",
      lastMessageAt: new Date("2026-08-10T09:00:00Z"),
      ageHours: 60,
      isRePing: false,
      unansweredCount: 1,
      source: "gmail",
      ...overrides,
    };
  }

  it("ensureObligationsTable is idempotent — calling twice raises nothing", async () => {
    await expect(ensureObligationsTable(getPool())).resolves.toBeUndefined();
  });

  it("ensureObligationsTableOnce memoizes — a second call does not re-run the DDL (still succeeds)", async () => {
    await expect(ensureObligationsTableOnce(getPool())).resolves.toBeUndefined();
    await expect(ensureObligationsTableOnce(getPool())).resolves.toBeUndefined();
  });

  it("upsertSeen inserts a new row with no subject/body columns to write to", async () => {
    const pool = getPool();
    await upsertSeen(pool, obligation(), new Date("2026-08-12T20:00:00Z"), "bendik");
    const { rows } = await pool.query(`SELECT * FROM obligation_threads WHERE thread_id = 't-1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      thread_id: "t-1",
      principal: "bendik",
      counterparty_address: "lars@partner.example",
      last_speaker_is_them: true,
      their_unanswered_count: 1,
    });
    // The migration's own banner (sql/019_obligations.sql:3-10): pointers only.
    expect(rows[0]).not.toHaveProperty("subject");
    expect(rows[0]).not.toHaveProperty("body");
  });

  // ─── ORB-45 Task 10 (B1): the in-flight message text never reaches the store ──────────────

  it("upsertSeen never persists lastMessageText — no column holds it, and the row carries no trace of it", async () => {
    const pool = getPool();
    await upsertSeen(
      pool,
      obligation({ threadId: "t-secret", lastMessageText: "SECRET" }),
      new Date("2026-08-12T20:00:00Z"),
      "bendik",
    );
    const { rows } = await pool.query(`SELECT * FROM obligation_threads WHERE thread_id = 't-secret'`);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("SECRET");

    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'obligation_threads'
         AND (column_name ILIKE '%text%' OR column_name ILIKE '%body%' OR column_name ILIKE '%content%')`,
    );
    expect(cols).toEqual([]);
  });

  // ─── ORB-149: `source` written verbatim from Obligation.source (ORB-45 Task 10 B1 added the
  // field; the store no longer derives it from the thread id's `slack:` prefix) ───────────────

  it("upsertSeen stamps source='gmail' for a gmail Obligation", async () => {
    const pool = getPool();
    await upsertSeen(pool, obligation({ threadId: "t-gmail" }), new Date("2026-08-12T20:00:00Z"), "bendik");
    const { rows } = await pool.query(`SELECT source FROM obligation_threads WHERE thread_id = 't-gmail'`);
    expect(rows[0].source).toBe("gmail");
  });

  it("upsertSeen stamps source='slack' for a slack Obligation", async () => {
    const pool = getPool();
    await upsertSeen(
      pool,
      obligation({ threadId: "slack:im:D1:100.000000", counterpartyAddress: "slack:U-nora", source: "slack" }),
      new Date("2026-08-12T20:00:00Z"),
      "bendik",
    );
    const { rows } = await pool.query(`SELECT source FROM obligation_threads WHERE thread_id = 'slack:im:D1:100.000000'`);
    expect(rows[0].source).toBe("slack");
  });

  it("upsertSeen on conflict updates counterparty_address, last_message_at and unanswered count", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    await upsertSeen(pool, obligation(), now, "bendik");
    await upsertSeen(
      pool,
      obligation({ counterpartyAddress: "lars@newdomain.no", unansweredCount: 3, lastMessageAt: new Date("2026-08-12T21:00:00Z") }),
      now,
      "bendik",
    );
    const { rows } = await pool.query(`SELECT * FROM obligation_threads WHERE thread_id = 't-1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].counterparty_address).toBe("lars@newdomain.no");
    expect(rows[0].their_unanswered_count).toBe(3);
  });

  it("dismissedThreads returns only threads with dismissed_at set", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    await upsertSeen(pool, obligation({ threadId: "t-open" }), now, "bendik");
    await upsertSeen(pool, obligation({ threadId: "t-dismissed" }), now, "bendik");
    await dismissObligation(pool, "t-dismissed", now);

    const dismissed = await dismissedThreads(pool);
    expect(dismissed.has("t-dismissed")).toBe(true);
    expect(dismissed.has("t-open")).toBe(false);
  });

  it("dismissObligation reports dismissed:true and the counterparty address for a real row", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    await upsertSeen(pool, obligation({ threadId: "t-1", counterpartyAddress: "lars@partner.example" }), now, "bendik");
    const result = await dismissObligation(pool, "t-1", now);
    expect(result).toEqual({ dismissed: true, counterpartyAddress: "lars@partner.example" });
  });

  it("dismissObligation reports dismissed:false for a thread id not in the table — never a false positive", async () => {
    const result = await dismissObligation(getPool(), "does-not-exist", new Date());
    expect(result).toEqual({ dismissed: false, counterpartyAddress: "" });
  });

  it("announcedRePings maps thread id to the unanswered count recorded at announce time", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    await markRePingAnnounced(pool, "t-bump", { now, principal: "bendik", unansweredCount: 2 });
    const announced = await announcedRePings(pool);
    expect(announced.get("t-bump")).toBe(2);
  });

  it("markRePingAnnounced writes a '' placeholder address, healed by a later upsertSeen", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    await markRePingAnnounced(pool, "t-bump", { now, principal: "bendik", unansweredCount: 2 });
    let row = (await pool.query(`SELECT counterparty_address FROM obligation_threads WHERE thread_id='t-bump'`)).rows[0];
    expect(row.counterparty_address).toBe("");

    await upsertSeen(pool, obligation({ threadId: "t-bump", counterpartyAddress: "lars@partner.example" }), now, "bendik");
    row = (await pool.query(`SELECT counterparty_address FROM obligation_threads WHERE thread_id='t-bump'`)).rows[0];
    expect(row.counterparty_address).toBe("lars@partner.example");
  });

  it("markNightBeforeDelivered + nightBeforeDelivered round-trip, scoped to the exact day", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    await markNightBeforeDelivered(pool, "t-covered", { day: "2026-08-13", principal: "bendik", now });

    const forThatDay = await nightBeforeDelivered(pool, "2026-08-13");
    expect(forThatDay.has("t-covered")).toBe(true);

    // A mark for one day must never suppress a DIFFERENT day's brief.
    const forAnotherDay = await nightBeforeDelivered(pool, "2026-08-14");
    expect(forAnotherDay.has("t-covered")).toBe(false);
  });

  // ─── ORB-45 Task 10 (B4): resolution + intent as pointers (box sql 030) ───────────────────

  it("upsertSeen writes source from the Obligation, not derived from the thread id", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    // threadId has no slack: prefix, but source is explicitly 'slack' — proves the store reads
    // o.source rather than re-deriving it from the id.
    await upsertSeen(pool, obligation({ threadId: "t-explicit-source", source: "slack" }), now, "bendik");
    const { rows } = await pool.query(`SELECT source FROM obligation_threads WHERE thread_id = 't-explicit-source'`);
    expect(rows[0].source).toBe("slack");
  });

  it("markResolved + resolvedThreads: threadId maps to resolved_elsewhere_at as a Date", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    const resolvedAt = new Date("2026-08-15T14:02:00Z");
    await upsertSeen(pool, obligation({ threadId: "t-resolved" }), now, "bendik");
    await markResolved(pool, "t-resolved", { via: "gmail", evidence: "you emailed her 2026-08-15 14:02", at: resolvedAt });

    const resolved = await resolvedThreads(pool);
    expect(resolved.get("t-resolved")).toEqual(resolvedAt);
    expect(resolved.has("t-open")).toBe(false);
  });

  it("markResolved truncates evidence defensively at 200 chars", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    const longEvidence = "x".repeat(500);
    await upsertSeen(pool, obligation({ threadId: "t-long-evidence" }), now, "bendik");
    await markResolved(pool, "t-long-evidence", { via: "gmail", evidence: longEvidence, at: now });

    const { rows } = await pool.query(
      `SELECT resolution_evidence FROM obligation_threads WHERE thread_id = 't-long-evidence'`,
    );
    expect(rows[0].resolution_evidence).toHaveLength(200);
  });

  it("upsertSeen after markResolved leaves the five new columns intact", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    const resolvedAt = new Date("2026-08-15T14:02:00Z");
    await upsertSeen(pool, obligation({ threadId: "t-preserve" }), now, "bendik");
    await markResolved(pool, "t-preserve", { via: "gmail", evidence: "you emailed her 2026-08-15 14:02", at: resolvedAt });
    await recordIntent(pool, "t-preserve", "expects_reply", new Date("2026-08-10T09:00:00Z"));

    // A later upsertSeen (they wrote again — a new sighting pass) must not touch any of the
    // five resolution/intent columns.
    await upsertSeen(
      pool,
      obligation({ threadId: "t-preserve", lastMessageAt: new Date("2026-08-16T09:00:00Z") }),
      new Date("2026-08-16T09:00:00Z"),
      "bendik",
    );

    const { rows } = await pool.query(`SELECT * FROM obligation_threads WHERE thread_id = 't-preserve'`);
    expect(rows[0].resolved_elsewhere_at).toEqual(resolvedAt);
    expect(rows[0].resolution_via).toBe("gmail");
    expect(rows[0].resolution_evidence).toBe("you emailed her 2026-08-15 14:02");
    expect(rows[0].intent).toBe("expects_reply");
    expect(rows[0].intent_for_message_at).toEqual(new Date("2026-08-10T09:00:00Z"));
  });

  it("cachedIntent returns the stored intent when lastMessageAt matches exactly", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    const lastMessageAt = new Date("2026-08-10T09:00:00.123Z");
    await upsertSeen(pool, obligation({ threadId: "t-intent" }), now, "bendik");
    await recordIntent(pool, "t-intent", "closes_loop", lastMessageAt);

    const intent = await cachedIntent(pool, "t-intent", lastMessageAt);
    expect(intent).toBe("closes_loop");
  });

  it("cachedIntent returns null when lastMessageAt has moved forward (they wrote again)", async () => {
    const pool = getPool();
    const now = new Date("2026-08-12T20:00:00Z");
    const lastMessageAt = new Date("2026-08-10T09:00:00Z");
    await upsertSeen(pool, obligation({ threadId: "t-intent-stale" }), now, "bendik");
    await recordIntent(pool, "t-intent-stale", "fyi", lastMessageAt);

    const laterMessageAt = new Date("2026-08-11T09:00:00Z");
    const intent = await cachedIntent(pool, "t-intent-stale", laterMessageAt);
    expect(intent).toBeNull();
  });

  it("cachedIntent returns null for a thread with no recorded intent", async () => {
    const pool = getPool();
    const intent = await cachedIntent(getPool(), "does-not-exist", new Date());
    expect(intent).toBeNull();
  });

  it("recordIntent on a thread id with no existing row is a no-op", async () => {
    const pool = getPool();
    await expect(
      recordIntent(pool, "t-never-seen", "expects_reply", new Date("2026-08-10T09:00:00Z")),
    ).resolves.toBeUndefined();
    const { rows } = await pool.query(`SELECT * FROM obligation_threads WHERE thread_id = 't-never-seen'`);
    expect(rows).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ORB-180 Task 4, Workstream B — institutional due-notice mail is a DEADLINE, never an owed
// reply.
//
// The misfiling this band exists for, verbatim from the ticket: a Fiken VAT reminder rode the
// morning brief as an OWED REPLY. Nobody at Fiken is waiting for Bendik to write back; the mail
// is a due notice, and the only honest thing to do with it is to offer it as a deadline
// candidate once and then be quiet.
//
// BOTH DIRECTIONS are asserted here, deliberately. The leak (a due notice becoming an
// obligation) and the over-rejection (a PERSON whose subject happens to carry the word "frist"
// being silenced) are the two ways this rule can be wrong, and a fix for one has broken the
// other more than once in this repo's history.
//
// Pure logic — no container, no pool. It lives in this file because the radar's misfiling is
// what it is about, and the rule that produces it belongs beside the store that used to carry
// the wrong row.
// ═══════════════════════════════════════════════════════════════════════════════════════════

function mail(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "m-1",
    threadId: "t-1",
    from: "Lars Eriksen <lars@partner.example>",
    to: ["Bendik <owner@owner.example>"],
    subject: "Re: pilot terms",
    bodyText: "body",
    sentAt: "2026-08-10T09:00:00Z",
    messageId: "<m1@partner.example>",
    references: "",
    isCalendarNotice: false,
    headers: {},
    ...overrides,
  };
}

/** Well past OWED_AFTER_HOURS from every fixture above — so anything that does NOT appear as an
 *  obligation was excluded by a RULE, never merely by being too young. */
const RADAR_NOW = new Date("2026-08-14T09:00:00Z");

async function scanOne(msg: ThreadMessage): Promise<ThreadSnapshot> {
  const deps: GmailSourceDeps = {
    searchThreadIds: async () => [msg.threadId],
    readThread: async () => [msg],
  };
  const { snapshots } = await scanThreads(deps, ["owner@owner.example"]);
  return snapshots[0]!;
}

describe("isInstitutionalDueNotice (ORB-180 Workstream B)", () => {
  it("Workstream B: a Fiken VAT reminder is a deadline candidate, never an owed reply", async () => {
    const msg = mail({
      from: "Fiken <post@fiken.no>",
      subject: "MVA-melding for 3. termin forfaller 31.08",
    });
    expect(isInstitutionalDueNotice(msg.from, msg.subject, msg.headers)).toBe(true);

    const snap = await scanOne(msg);
    expect(snap.isDeadlineCandidate).toBe(true);
    expect(selectObligations([snap], RADAR_NOW)).toEqual([]);
  });

  it("a subdomain of an institutional domain counts — mail.fiken.no is still Fiken", () => {
    expect(isInstitutionalDueNotice("Fiken <post@mail.fiken.no>", "Kvittering", {})).toBe(true);
  });

  it("a lookalike domain does NOT count — notfiken.no is not fiken.no", () => {
    expect(isInstitutionalDueNotice("X <post@notfiken.no>", "Kvittering", {})).toBe(false);
  });

  it("THE OTHER DIRECTION: a person's 'Frist for tilbud 15. mai?' from partner.example stays an obligation", async () => {
    const msg = mail({
      from: "Lars Eriksen <lars@partner.example>",
      subject: "Frist for tilbud 15. mai?",
    });
    expect(isInstitutionalDueNotice(msg.from, msg.subject, msg.headers)).toBe(false);

    const snap = await scanOne(msg);
    expect(snap.isDeadlineCandidate).toBe(false);
    expect(selectObligations([snap], RADAR_NOW).map((o) => o.threadId)).toEqual(["t-1"]);
  });

  it("an automated mailer with a due word AND a date is a candidate even off the domain list", async () => {
    const msg = mail({
      from: "Invoices <noreply@invoice-service.example>",
      subject: "Faktura 1042 forfaller 10.09",
    });
    expect(isInstitutionalDueNotice(msg.from, msg.subject, msg.headers)).toBe(true);
    expect((await scanOne(msg)).isDeadlineCandidate).toBe(true);
  });

  it("an automated sender with a due word but NO date is NOT a candidate — a newsletter stays a plain automated exclusion", async () => {
    const msg = mail({
      from: "Nyhetsbrev <hei@example.com>",
      subject: "Fristen nærmer seg",
      headers: { "List-Unsubscribe": "<mailto:x@example.com>" },
    });
    expect(isInstitutionalDueNotice(msg.from, msg.subject, msg.headers)).toBe(false);

    const snap = await scanOne(msg);
    expect(snap.isDeadlineCandidate).toBe(false);
    // Still off the radar — but as an AUTOMATED sender, which is the pre-existing rule.
    expect(snap.isAutomated).toBe(true);
    expect(selectObligations([snap], RADAR_NOW)).toEqual([]);
  });

  it("a HUMAN on an institutional domain is still a due notice — the domain decides, not the mailer", () => {
    // Nobody at Skatteetaten is waiting for a reply to a personal address on this thread either;
    // the whole point of the domain list is that it does not depend on how the mail was sent.
    expect(isInstitutionalDueNotice("Skatteetaten <navn.navnesen@skatteetaten.no>", "Om saken din", {})).toBe(true);
  });
});
