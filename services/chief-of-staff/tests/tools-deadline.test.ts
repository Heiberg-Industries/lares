/**
 * ORB-180 Task 3 — the six `deadline_*` tools, against a REAL Postgres (testcontainers, the
 * ORB-45 pattern): a fake pool that never executes SQL is forbidden here. Same migration
 * sequence as `tests/deadlines-store.test.ts` (031, then 036 — 036 seeds two heartbeat rows,
 * so 031's table must exist first — then 063, LAR-22-s1's vendor/amount/currency columns and
 * the `'renewal'` source), and the same fake-`ctx` shape `tests/remind-set-clock.test.ts`
 * uses for a gated tool's `assertApprover` check: a Slack auth context inside the allowlist.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getPool, closePool } from "@lares/agent-kit/db";
import { ownerId } from "../lib/principals.js";
import { createDeadline, advanceRung, getDeadline, upsertCandidate } from "../lib/deadlines-store.js";

import deadlineList from "../catalogue/deadline_list.js";
import deadlineAdd from "../catalogue/deadline_add.js";
import deadlineMintStatutory from "../catalogue/deadline_mint_statutory.js";
import deadlineDone from "../catalogue/deadline_done.js";
import deadlineDismiss from "../catalogue/deadline_dismiss.js";
import deadlineReset from "../catalogue/deadline_reset.js";

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "..", "box", "sql");
const sql = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

const BENDIK = "U_EXAMPLE_OWNER";
function ctx(auth: unknown = { authenticator: "slack-webhook", attributes: { user_id: BENDIK } }) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

/** What a SCHEDULED turn runs as — the eve app principal, no human anywhere on the turn. The exact
 *  shape `tests/standing-facts.test.ts` uses for `remember`'s own principal check. */
const APP_AUTH = { authenticator: "app", principalId: "eve:app", principalType: "runtime" };
const appCtx = () => ctx(APP_AUTH);

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env["DATABASE_URL"] = container.getConnectionUri();
  process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK;
  const pool = getPool();
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await pool.query(sql("031_schedule_heartbeat.sql"));
  await pool.query(sql("036_deadlines.sql"));
  await pool.query(sql("063_deadline_renewals.sql"));
}, 120_000);

afterAll(async () => {
  delete process.env["SLACK_ALLOWED_USER_IDS"];
  await closePool();
  await container.stop();
});

beforeEach(() => {
  process.env["OWNER_HOME_TZ"] = "Europe/Oslo";
});

afterEach(async () => {
  const pool = getPool();
  await pool.query(`DELETE FROM deadlines`);
  await pool.query(`DELETE FROM deadline_candidates`);
  await pool.query(`DELETE FROM deadline_settings`);
});

describe("approval shape", () => {
  it("deadline_list, deadline_add and deadline_reset are ungated", () => {
    expect((deadlineList as unknown as { approval?: unknown }).approval).toBeUndefined();
    expect((deadlineAdd as unknown as { approval?: unknown }).approval).toBeUndefined();
    expect((deadlineReset as unknown as { approval?: unknown }).approval).toBeUndefined();
  });
  it("deadline_mint_statutory, deadline_done and deadline_dismiss are gated", () => {
    expect((deadlineMintStatutory as unknown as { approval?: unknown }).approval).toBeDefined();
    expect((deadlineDone as unknown as { approval?: unknown }).approval).toBeDefined();
    expect((deadlineDismiss as unknown as { approval?: unknown }).approval).toBeDefined();
  });
});

describe("deadline_add + deadline_list", () => {
  it("an added deadline shows up in the list with daysToDue", async () => {
    const added = await deadlineAdd.execute(
      { entity: "Heiberg Industries AS", title: "Test filing", dueDate: "2099-01-31", source: "manual" },
      ctx(),
    );
    expect(added.id).toBeDefined();
    expect(added.dueDate).toBe("2099-01-31");
    expect(typeof added.daysToDue).toBe("number");

    const { deadlines } = await deadlineList.execute({}, ctx());
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toMatchObject({
      id: added.id,
      entity: "Heiberg Industries AS",
      title: "Test filing",
      dueDate: "2099-01-31",
      status: "open",
    });
    expect(typeof deadlines[0]!.daysToDue).toBe("number");
  });

  it("refuses a past dueDate with an error naming today's date", async () => {
    await expect(
      deadlineAdd.execute({ entity: "Heiberg Industries AS", title: "Too late", dueDate: "2020-01-01" }, ctx()),
    ).rejects.toThrow(/is in the past.*Today is \d{4}-\d{2}-\d{2}.*recompute/s);
  });

  it("refuses a malformed date before ever touching the database", async () => {
    await expect(
      deadlineAdd.execute({ entity: "Heiberg Industries AS", title: "Bad date", dueDate: "2026-02-30" }, ctx()),
    ).rejects.toThrow(/not a valid/);
  });

  it("a renewal add stores vendor, amount and currency, upper-casing a lower-case currency", async () => {
    const added = await deadlineAdd.execute(
      {
        entity: "Heiberg Industries AS",
        title: "Domain renewal",
        dueDate: "2099-03-03",
        source: "renewal",
        recurrence: "yearly",
        vendor: "Domeneshop",
        amount: 199,
        currency: "nok",
      },
      ctx(),
    );
    expect(added.added).toBe(true);

    const { deadlines } = await deadlineList.execute({}, ctx());
    expect(deadlines[0]).toMatchObject({ vendor: "Domeneshop", amount: 199, currency: "NOK" });
  });

  it("the schema refuses a non-positive amount", () => {
    const base = { entity: "Heiberg Industries AS", title: "Bad amount", dueDate: "2099-03-03", source: "renewal" as const };
    expect(deadlineAdd.inputSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
    expect(deadlineAdd.inputSchema.safeParse({ ...base, amount: -5 }).success).toBe(false);
    expect(deadlineAdd.inputSchema.safeParse({ ...base, amount: 199 }).success).toBe(true);
  });

  it("fromThreadId resolves the mail-scanner candidate as 'added'", async () => {
    const pool = getPool();
    await upsertCandidate(pool, {
      threadId: "cand-1",
      owner: ownerId(),
      subject: "Invoice",
      sender: "billing@x.no",
      seenAt: new Date(),
    });
    await deadlineAdd.execute(
      { entity: "Heiberg Industries AS", title: "Invoice due", dueDate: "2099-02-01", fromThreadId: "cand-1" },
      ctx(),
    );
    const { rows } = await pool.query(`SELECT resolution FROM deadline_candidates WHERE thread_id = 'cand-1'`);
    expect(rows[0].resolution).toBe("added");
  });
});

describe("deadline_mint_statutory", () => {
  // A fiscal year entirely in the future, so nothing is "already past" on any day this suite runs.
  const FUTURE_YEAR = 2099;

  it("mints all 12 NO-AS rows for a fresh year, then reports 0 inserted / 12 skipped on a repeat", async () => {
    const first = await deadlineMintStatutory.execute(
      { entity: "Heiberg Industries AS", fiscalYear: FUTURE_YEAR, jurisdiction: "NO-AS" },
      ctx(),
    );
    expect(first.inserted).toBe(12);
    expect(first.skipped).toBe(0);
    expect(first.skippedPast).toBe(0);
    expect(first.rows).toHaveLength(12);

    const second = await deadlineMintStatutory.execute(
      { entity: "Heiberg Industries AS", fiscalYear: FUTURE_YEAR, jurisdiction: "NO-AS" },
      ctx(),
    );
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(12);

    const { deadlines } = await deadlineList.execute({ status: "all" }, ctx());
    expect(deadlines).toHaveLength(12);
  });

  // ── The already-past skip (review fix, ORB-180) ────────────────────────────────────────────
  //
  // A year long gone is the extreme case of a mid-year mint: EVERY rule is behind today, so an
  // unguarded mint would insert twelve rows that are overdue on arrival — and the brief names an
  // overdue row every single day.
  it("a year already gone mints NOTHING and names what it left out", async () => {
    const r = await deadlineMintStatutory.execute(
      { entity: "Heiberg Industries AS", fiscalYear: 2000, jurisdiction: "NO-AS" },
      ctx(),
    );
    expect(r.inserted).toBe(0);
    expect(r.skippedPast).toBe(12);
    expect(r.skippedPastRows.map((x) => x.ruleKey)).toContain("aarsregnskap");
    expect(r.today).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

    const { deadlines } = await deadlineList.execute({ status: "all" }, ctx());
    expect(deadlines).toHaveLength(0);
  });

  it("includePast: true is the deliberate backfill — the same year mints in full", async () => {
    const r = await deadlineMintStatutory.execute(
      { entity: "Heiberg Industries AS", fiscalYear: 2000, jurisdiction: "NO-AS", includePast: true },
      ctx(),
    );
    expect(r.inserted).toBe(12);
    expect(r.skippedPast).toBe(0);
  });

  it("an unknown omit key throws rather than silently minting the full set", async () => {
    await expect(
      deadlineMintStatutory.execute(
        { entity: "Heiberg Industries AS", fiscalYear: FUTURE_YEAR, jurisdiction: "NO-AS", omit: ["not-a-real-key"] },
        ctx(),
      ),
    ).rejects.toThrow(/unknown rule key/);
  });
});

describe("deadline_done", () => {
  it("closing a yearly row reports the minted successor's date", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, {
      entity: "Heiberg Industries AS",
      title: "Årsregnskap til Regnskapsregisteret",
      source: "statutory",
      dueDate: "2026-07-31",
      recurrence: "yearly",
      consequence: "Forsinkelsesgebyr",
      ruleKey: "aarsregnskap",
      createdBy: "user",
    });

    const result = await deadlineDone.execute({ id: d.id, evidence: "Filed via Altinn" }, ctx());
    expect(result.closed).toBe(true);
    expect(result.nextDueDate).toBe("2027-07-31");
    expect(result.message).toContain("31.07.2027");
  });

  it("closing an already-closed id reports closed: false", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, {
      entity: "Heiberg Industries AS",
      title: "One-off",
      source: "manual",
      dueDate: "2026-09-10",
      createdBy: "user",
    });
    await deadlineDone.execute({ id: d.id, evidence: "done once" }, ctx());
    const second = await deadlineDone.execute({ id: d.id, evidence: "done twice" }, ctx());
    expect(second.closed).toBe(false);
  });
});

describe("deadline_dismiss", () => {
  it("a bad id reports dismissed: false", async () => {
    const result = await deadlineDismiss.execute(
      { id: "00000000-0000-0000-0000-000000000000", reason: "no such row" },
      ctx(),
    );
    expect(result).toEqual({ dismissed: false, message: expect.any(String) });
  });

  it("dismisses a candidate thread as ignored", async () => {
    const pool = getPool();
    await upsertCandidate(pool, {
      threadId: "cand-2",
      owner: ownerId(),
      subject: "Not a deadline",
      sender: "noreply@x.no",
      seenAt: new Date(),
    });
    const result = await deadlineDismiss.execute({ candidateThreadId: "cand-2", reason: "spam" }, ctx());
    expect(result.dismissed).toBe(true);

    const { rows } = await pool.query(`SELECT resolution FROM deadline_candidates WHERE thread_id = 'cand-2'`);
    expect(rows[0].resolution).toBe("ignored");
  });

  it("refuses when both id and candidateThreadId are given, or neither", async () => {
    await expect(deadlineDismiss.execute({ reason: "x" }, ctx())).rejects.toThrow(/exactly one/);
    await expect(
      deadlineDismiss.execute({ id: "a", candidateThreadId: "b", reason: "x" }, ctx()),
    ).rejects.toThrow(/exactly one/);
  });
});

describe("deadline_reset", () => {
  it("reads back rung 0 after advanceRung(2)", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, {
      entity: "Heiberg Industries AS",
      title: "Ladder test",
      source: "manual",
      dueDate: "2026-09-10",
      createdBy: "user",
    });
    await advanceRung(pool, d.id, ownerId(), 2, new Date());

    const result = await deadlineReset.execute({ id: d.id }, ctx());
    expect(result.reset).toBe(true);

    const row = await getDeadline(pool, d.id, ownerId());
    expect(row?.rung).toBe(0);
  });

  it("an unknown id reports reset: false", async () => {
    const result = await deadlineReset.execute({ id: "00000000-0000-0000-0000-000000000000" }, ctx());
    expect(result.reset).toBe(false);
  });
});

/**
 * WHO IS ASKING — the review fix that made `deadline_add` and `deadline_reset` refuse a turn with
 * no human on it.
 *
 * Both are ungated by design (a wrong add costs a line in a brief; a reset only adds noise back),
 * but ungated is not unattributed: the 08:00 brief runs as the APP principal, and its own Frister
 * block prints `legg til (deadline_add fromThreadId …)` beside every candidate — so the model
 * reading that brief was handed the exact call to make, with nobody having asked for it.
 *
 * Both directions, the `remember` precedent: the app principal is refused with NOTHING written,
 * and the allowlisted human still succeeds (a check that refused everyone would pass the first
 * half of this and quietly cost him the tool).
 */
describe("the principal check on the two ungated writes", () => {
  it("deadline_add refuses a scheduled turn and writes NO row", async () => {
    const result = await deadlineAdd.execute(
      { entity: "Heiberg Industries AS", title: "Fra briefen", dueDate: "2099-03-01" },
      appCtx(),
    );
    expect(result.added).toBe(false);
    expect(result.message).toMatch(/running as app/i);

    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM deadlines`);
    expect(rows[0].n).toBe(0);
  });

  it("deadline_add on a scheduled turn does not resolve the candidate either", async () => {
    const pool = getPool();
    await upsertCandidate(pool, {
      threadId: "cand-app",
      owner: ownerId(),
      subject: "Purringen",
      sender: "noreply@skatteetaten.no",
      seenAt: new Date(),
    });

    const result = await deadlineAdd.execute(
      { entity: "Heiberg Industries AS", title: "Fra briefen", dueDate: "2099-03-01", fromThreadId: "cand-app" },
      appCtx(),
    );
    expect(result.added).toBe(false);

    const { rows } = await pool.query(`SELECT resolution FROM deadline_candidates WHERE thread_id = 'cand-app'`);
    expect(rows[0].resolution).toBeNull();
  });

  it("deadline_add still works for the allowlisted human — the gate is the allowlist, not the tool", async () => {
    const result = await deadlineAdd.execute(
      { entity: "Heiberg Industries AS", title: "Han ba om denne", dueDate: "2099-03-01" },
      ctx(),
    );
    expect(result.added).toBe(true);
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM deadlines`);
    expect(rows[0].n).toBe(1);
  });

  it("deadline_reset refuses a scheduled turn and leaves the rung where it was", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, {
      entity: "Heiberg Industries AS",
      title: "Ladder test",
      source: "manual",
      dueDate: "2026-09-10",
      createdBy: "user",
    });
    await advanceRung(pool, d.id, ownerId(), 3, new Date());

    const result = await deadlineReset.execute({ id: d.id }, appCtx());
    expect(result.reset).toBe(false);
    expect(result.message).toMatch(/running as app/i);

    expect((await getDeadline(pool, d.id, ownerId()))?.rung).toBe(3);
  });

  it("deadline_reset still works for the allowlisted human", async () => {
    const pool = getPool();
    const d = await createDeadline(pool, {
      entity: "Heiberg Industries AS",
      title: "Ladder test",
      source: "manual",
      dueDate: "2026-09-10",
      createdBy: "user",
    });
    await advanceRung(pool, d.id, ownerId(), 3, new Date());

    expect((await deadlineReset.execute({ id: d.id }, ctx())).reset).toBe(true);
    expect((await getDeadline(pool, d.id, ownerId()))?.rung).toBe(0);
  });

  it("a turn with no identity at all is refused too — fail-closed, not fail-quiet", async () => {
    // NOT `ctx(undefined)` — that helper's default parameter would hand back Bendik's own auth.
    const noAuth = { session: { id: "wrun_test", auth: { current: null, initiator: null } } } as never;
    const add = await deadlineAdd.execute(
      { entity: "Heiberg Industries AS", title: "Ingen", dueDate: "2099-03-01" },
      noAuth,
    );
    expect(add.added).toBe(false);
    expect(add.message).toMatch(/no identity at all/i);
  });
});
