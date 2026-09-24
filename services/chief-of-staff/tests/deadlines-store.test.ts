import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getPool, closePool } from "@lares/agent-kit/db";
import { configuredOwnerId } from "../lib/identity-client.js";
import {
  createDeadline,
  listDeadlines,
  getDeadline,
  closeDeadline,
  advanceRung,
  resetRung,
  readLadderEnabled,
  writeLadderEnabled,
  upsertCandidate,
  unsurfacedCandidates,
  markCandidatesSurfaced,
  resolveCandidate,
  type NewDeadline,
} from "../lib/deadlines-store.js";
import { readMarketsSettings, MARKETS_ENGINE } from "../lib/markets-settings-store.js";

/**
 * ORB-180 Task 2 — the deadlines/candidates/settings tables (sql/036) and the two stores that
 * read/write them, against a REAL Postgres (testcontainers, the ORB-45 pattern): a fake pool
 * that never executes SQL is forbidden here.
 *
 * One container for the whole file (matches `tests/reminders.test.ts`): `036_deadlines.sql` is
 * applied verbatim from disk, on top of `031_schedule_heartbeat.sql` (036 seeds two heartbeat
 * rows, so 031's table must exist first) — exercising the migration itself before the box ever
 * sees it. `063_deadline_renewals.sql` (LAR-22-s1: vendor/amount/currency, and the `'renewal'`
 * source) applies straight after 036, the same order it will run in on the box.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "..", "box", "sql");
const sql = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

function mkDeadline(overrides: Partial<NewDeadline> = {}): NewDeadline {
  return {
    entity: "Heiberg Industries AS",
    title: "Test deadline",
    source: "manual",
    dueDate: "2026-09-10",
    createdBy: "user",
    ...overrides,
  };
}

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await pool.query(sql("031_schedule_heartbeat.sql"));
  await pool.query(sql("036_deadlines.sql"));
  await pool.query(sql("063_deadline_renewals.sql"));
}, 120_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

afterEach(async () => {
  const pool = getPool();
  await pool.query(`DELETE FROM deadlines`);
  await pool.query(`DELETE FROM deadline_candidates`);
  await pool.query(`DELETE FROM deadline_settings`);
  await pool.query(`DELETE FROM markets_settings`);
});

describe("036_deadlines.sql", () => {
  it("is idempotent and ships both heartbeat rows", async () => {
    const pool = getPool();
    await pool.query(sql("036_deadlines.sql"));
    const { rows } = await pool.query(
      `SELECT agent FROM heartbeat WHERE agent IN ('saga/deadlines', 'saga/market-refresh') ORDER BY agent`,
    );
    expect(rows.map((r) => r.agent)).toEqual(["saga/deadlines", "saga/market-refresh"]);
  });
});

describe("063_deadline_renewals.sql", () => {
  it("applies twice without error", async () => {
    await expect(getPool().query(sql("063_deadline_renewals.sql"))).resolves.toBeDefined();
  });

  it("leaves a pre-existing row's new columns NULL", async () => {
    const pool = getPool();
    const before = await createDeadline(pool, mkDeadline());
    await pool.query(sql("063_deadline_renewals.sql"));
    const after = await getDeadline(pool, before.id, configuredOwnerId());
    expect(after?.vendor).toBeNull();
    expect(after?.amount).toBeNull();
    expect(after?.currency).toBeNull();
  });

  it("source: 'renewal' inserts", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, mkDeadline({ source: "renewal" }));
    expect(d.source).toBe("renewal");
  });

  it("rejects a lower-case currency", async () => {
    await expect(
      getPool().query(
        `INSERT INTO deadlines (owner, entity, title, source, due_date, created_by, currency) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [configuredOwnerId(), "Heiberg Industries AS", "Bad currency", "renewal", "2027-01-01", "user", "nok"],
      ),
    ).rejects.toThrow();
  });

  it("still rejects an unknown source", async () => {
    await expect(
      getPool().query(
        `INSERT INTO deadlines (owner, entity, title, source, due_date, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [configuredOwnerId(), "Heiberg Industries AS", "Bad source", "madeup", "2027-01-01", "user"],
      ),
    ).rejects.toThrow();
  });

  it("amount round-trips as a number, not the string pg returns for numeric(12,2)", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, mkDeadline({ source: "renewal", vendor: "Domeneshop", amount: 199, currency: "NOK" }));
    expect(d.amount).toBe(199);
    expect(typeof d.amount).toBe("number");

    const fetched = await getDeadline(pool, d.id, configuredOwnerId());
    expect(fetched?.vendor).toBe("Domeneshop");
    expect(fetched?.amount).toBe(199);
    expect(fetched?.currency).toBe("NOK");
  });

  it("closing a yearly renewal mints a successor with the same vendor, amount and currency", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, {
      entity: "Heiberg Industries AS",
      title: "Domain renewal",
      source: "renewal",
      dueDate: "2026-09-10",
      recurrence: "yearly",
      vendor: "Domeneshop",
      amount: 199,
      currency: "NOK",
      createdBy: "user",
    });

    const result = await closeDeadline(pool, d.id, configuredOwnerId(), "done", "paid", new Date("2026-09-01T00:00:00Z"));
    expect(result.minted?.dueDate).toBe("2027-09-10");
    expect(result.minted?.vendor).toBe("Domeneshop");
    expect(result.minted?.amount).toBe(199);
    expect(result.minted?.currency).toBe("NOK");
  });
});

describe("deadlines-store", () => {
  it("creates a deadline defaulting owner to the canonical user id", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, mkDeadline());
    expect(d.owner).toBe(configuredOwnerId());
    expect(d.status).toBe("open");
    expect(d.rung).toBe(0);
    expect(d.recurrence).toBe("none");
  });

  it("round-trips due_date with no timezone shift — 2026-08-31 in reads back as 2026-08-31", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, mkDeadline({ dueDate: "2026-08-31" }));
    expect(d.dueDate).toBe("2026-08-31");

    const fetched = await getDeadline(pool, d.id, configuredOwnerId());
    expect(fetched?.dueDate).toBe("2026-08-31");

    const [listed] = await listDeadlines(pool, configuredOwnerId());
    expect(listed?.dueDate).toBe("2026-08-31");
  });

  it("listDeadlines defaults to open rows, closest due first", async () => {
    const pool = getPool();
    const far = await createDeadline(pool, mkDeadline({ dueDate: "2026-12-01" }));
    const near = await createDeadline(pool, mkDeadline({ dueDate: "2026-09-10" }));
    const mid = await createDeadline(pool, mkDeadline({ dueDate: "2026-10-15" }));

    const list = await listDeadlines(pool, configuredOwnerId());
    expect(list.map((r) => r.id)).toEqual([near.id, mid.id, far.id]);
  });

  it("listDeadlines excludes closed rows by default, but status: 'all' includes them", async () => {
    const pool = getPool();
    const open = await createDeadline(pool, mkDeadline({ dueDate: "2026-09-10" }));
    const done = await createDeadline(pool, mkDeadline({ dueDate: "2026-09-11" }));
    await closeDeadline(pool, done.id, configuredOwnerId(), "done", "filed", new Date("2026-09-01T00:00:00Z"));

    expect((await listDeadlines(pool, configuredOwnerId())).map((r) => r.id)).toEqual([open.id]);
    expect((await listDeadlines(pool, configuredOwnerId(), { status: "all" })).map((r) => r.id).sort()).toEqual(
      [open.id, done.id].sort(),
    );
  });

  it("dueWithinDays excludes a row 40 days out and includes an overdue one", async () => {
    const pool = getPool();
    const now = new Date("2026-09-08T10:00:00Z"); // owner day 2026-09-08 in Europe/Oslo
    const overdue = await createDeadline(pool, mkDeadline({ dueDate: "2026-08-20" }));
    const soon = await createDeadline(pool, mkDeadline({ dueDate: "2026-09-20" })); // 12 days out
    const far = await createDeadline(pool, mkDeadline({ dueDate: "2026-10-18" })); // 40 days out

    const ids = (await listDeadlines(pool, configuredOwnerId(), { dueWithinDays: 30, now, tz: "Europe/Oslo" })).map(
      (r) => r.id,
    );
    expect(ids).toContain(overdue.id);
    expect(ids).toContain(soon.id);
    expect(ids).not.toContain(far.id);
  });

  it("getDeadline returns null for an unknown id or the wrong owner", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, mkDeadline());
    expect(await getDeadline(pool, "00000000-0000-0000-0000-000000000000", configuredOwnerId())).toBeNull();
    expect(await getDeadline(pool, d.id, "someone-else")).toBeNull();
  });

  it("closeDeadline(done) on a yearly row mints the next occurrence as created_by: recurrence, rung 0, same entity/title/consequence/rule_key", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, {
      entity: "Heiberg Industries AS",
      title: "Årsregnskap til Regnskapsregisteret",
      source: "statutory",
      dueDate: "2026-08-31",
      recurrence: "yearly",
      consequence: "Forsinkelsesgebyr",
      ruleKey: "aarsregnskap",
      createdBy: "user",
    });

    const result = await closeDeadline(pool, d.id, configuredOwnerId(), "done", "filed", new Date("2026-08-25T09:00:00Z"));
    expect(result.closed).toBe(true);
    expect(result.minted).not.toBeNull();
    expect(result.minted?.dueDate).toBe("2027-08-31");
    expect(result.minted?.createdBy).toBe("recurrence");
    expect(result.minted?.rung).toBe(0);
    expect(result.minted?.status).toBe("open");
    expect(result.minted?.entity).toBe(d.entity);
    expect(result.minted?.title).toBe(d.title);
    expect(result.minted?.consequence).toBe(d.consequence);
    expect(result.minted?.evidenceRule).toBe(d.evidenceRule);
    expect(result.minted?.ruleKey).toBe("aarsregnskap");

    const closedRow = await getDeadline(pool, d.id, configuredOwnerId());
    expect(closedRow?.status).toBe("done");
    expect(closedRow?.statusReason).toBe("filed");
    expect(closedRow?.resolvedAt).not.toBeNull();

    // The minted row is now itself open and listed.
    const openIds = (await listDeadlines(pool, configuredOwnerId())).map((r) => r.id);
    expect(openIds).toEqual([result.minted!.id]);
  });

  it("closeDeadline(dismissed) mints nothing and stores the reason, even on a recurring row", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, mkDeadline({ dueDate: "2026-09-10", recurrence: "yearly" }));

    const result = await closeDeadline(
      pool,
      d.id,
      configuredOwnerId(),
      "dismissed",
      "not applicable this year",
      new Date("2026-09-01T00:00:00Z"),
    );
    expect(result).toEqual({ closed: true, minted: null });

    const row = await getDeadline(pool, d.id, configuredOwnerId());
    expect(row?.status).toBe("dismissed");
    expect(row?.statusReason).toBe("not applicable this year");
  });

  it("closeDeadline(done) on a non-recurring row mints nothing", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, mkDeadline({ dueDate: "2026-09-10" })); // recurrence: "none"
    const result = await closeDeadline(pool, d.id, configuredOwnerId(), "done", "paid", new Date("2026-09-01T00:00:00Z"));
    expect(result).toEqual({ closed: true, minted: null });
  });

  it("closing an already-closed deadline returns closed: false and mints nothing", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, mkDeadline({ dueDate: "2026-09-10", recurrence: "yearly" }));
    await closeDeadline(pool, d.id, configuredOwnerId(), "done", "first close", new Date("2026-09-01T00:00:00Z"));

    const second = await closeDeadline(pool, d.id, configuredOwnerId(), "done", "second close", new Date("2026-09-02T00:00:00Z"));
    expect(second).toEqual({ closed: false, minted: null });

    // Only ONE minted successor exists, from the first close — a second close must not double-mint.
    const all = await listDeadlines(pool, configuredOwnerId(), { status: "all" });
    expect(all).toHaveLength(2); // the original (closed) + the one successor
  });

  it("advanceRung then resetRung round-trips", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, mkDeadline({ dueDate: "2026-09-10" }));
    const movedAt = new Date("2026-09-09T15:00:00Z");
    await advanceRung(pool, d.id, configuredOwnerId(), 1, movedAt);

    let row = await getDeadline(pool, d.id, configuredOwnerId());
    expect(row?.rung).toBe(1);
    expect(row?.rungMovedAt?.toISOString()).toBe(movedAt.toISOString());

    const reset = await resetRung(pool, d.id, configuredOwnerId());
    expect(reset).toBe(true);

    row = await getDeadline(pool, d.id, configuredOwnerId());
    expect(row?.rung).toBe(0);
    expect(row?.rungMovedAt).toBeNull();
  });

  it("resetRung on an unknown id returns false", async () => {
    const pool = getPool();
    expect(await resetRung(pool, "00000000-0000-0000-0000-000000000000", configuredOwnerId())).toBe(false);
  });

  it("readLadderEnabled is false with no row, true after writeLadderEnabled", async () => {
    const pool = getPool();
    expect(await readLadderEnabled(pool, configuredOwnerId())).toBe(false);

    await writeLadderEnabled(pool, configuredOwnerId(), true, "user");
    expect(await readLadderEnabled(pool, configuredOwnerId())).toBe(true);

    await writeLadderEnabled(pool, configuredOwnerId(), false, "user");
    expect(await readLadderEnabled(pool, configuredOwnerId())).toBe(false);
  });

  it("upsertCandidate twice keeps the first seen_at (and first subject) — the first sighting stands", async () => {
    const pool = getPool();
    const first = new Date("2026-09-01T09:00:00Z");
    const second = new Date("2026-09-05T09:00:00Z");
    await upsertCandidate(pool, { threadId: "t-1", owner: configuredOwnerId(), subject: "Invoice", sender: "billing@x.no", seenAt: first });
    await upsertCandidate(pool, { threadId: "t-1", owner: configuredOwnerId(), subject: "Invoice v2", sender: "billing@x.no", seenAt: second });

    const list = await unsurfacedCandidates(pool, configuredOwnerId());
    expect(list).toHaveLength(1);
    expect(list[0]?.subject).toBe("Invoice");
    expect(list[0]?.seenAt.toISOString()).toBe(first.toISOString());
  });

  it("unsurfacedCandidates excludes surfaced and resolved rows", async () => {
    const pool = getPool();
    await upsertCandidate(pool, { threadId: "t-surfaced", owner: configuredOwnerId(), subject: "s", sender: "a@x.no", seenAt: new Date("2026-09-01T00:00:00Z") });
    await upsertCandidate(pool, { threadId: "t-resolved", owner: configuredOwnerId(), subject: "s", sender: "a@x.no", seenAt: new Date("2026-09-01T00:00:00Z") });
    await upsertCandidate(pool, { threadId: "t-open", owner: configuredOwnerId(), subject: "s", sender: "a@x.no", seenAt: new Date("2026-09-01T00:00:00Z") });

    await markCandidatesSurfaced(pool, configuredOwnerId(), ["t-surfaced"], new Date("2026-09-02T00:00:00Z"));
    await resolveCandidate(pool, configuredOwnerId(), "t-resolved", "ignored");

    const list = await unsurfacedCandidates(pool, configuredOwnerId());
    expect(list.map((c) => c.threadId)).toEqual(["t-open"]);
  });

  it("markCandidatesSurfaced with an empty id list is a no-op", async () => {
    const pool = getPool();
    await upsertCandidate(pool, { threadId: "t-1", owner: configuredOwnerId(), subject: "s", sender: "a@x.no", seenAt: new Date("2026-09-01T00:00:00Z") });
    await expect(markCandidatesSurfaced(pool, configuredOwnerId(), [], new Date())).resolves.toBeUndefined();
    expect(await unsurfacedCandidates(pool, configuredOwnerId())).toHaveLength(1);
  });

  it("resolveCandidate on an unknown thread returns false", async () => {
    const pool = getPool();
    expect(await resolveCandidate(pool, configuredOwnerId(), "no-such-thread", "ignored")).toBe(false);
  });
});

describe("markets-settings-store", () => {
  it("defaults to { refreshEnabled: false, watchlistMax: 100 } with no row", async () => {
    expect(await readMarketsSettings(getPool(), configuredOwnerId())).toEqual({ refreshEnabled: false, watchlistMax: 100 });
  });

  it("the CHECK constraint refuses a watchlist_max above the engine ceiling", async () => {
    await expect(
      getPool().query(`INSERT INTO markets_settings (owner, watchlist_max) VALUES ($1, $2)`, [configuredOwnerId(), 500]),
    ).rejects.toThrow();
  });

  it("a row at the engine ceiling (150) reads back unclamped", async () => {
    await getPool().query(
      `INSERT INTO markets_settings (owner, refresh_enabled, watchlist_max) VALUES ($1, true, $2)`,
      [configuredOwnerId(), MARKETS_ENGINE.watchlistMax],
    );
    expect(await readMarketsSettings(getPool(), configuredOwnerId())).toEqual({ refreshEnabled: true, watchlistMax: 150 });
  });
});
