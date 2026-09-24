/**
 * `meeting_followup_record_denial` (LAR-28) — the resumed model turn's ONLY way to say "the
 * approval card came back declined". Ungated by design (see the tool's own header): it changes
 * nothing a human can see, so this suite proves it against a REAL Postgres, the same
 * testcontainers pattern `tests/tools-deadline.test.ts` uses, rather than a mock.
 *
 * LAR-28 review fix round 1: the tool calls the NARROW `recordDenial` store function
 * (lib/meeting-followup-store.ts), not a bare `recordOutcome`, precisely because this tool is
 * ungated and model-callable — a confused or prompt-injected turn must not be able to flip a
 * `'skipped'` or already-`'denied'` row just by naming its page id. This file proves all five
 * starting states `recordDenial` must tell apart, plus "no such page".
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getPool, closePool } from "@lares/agent-kit/db";
import { claimMeeting, recordSent, recordOutcome, getOutcome } from "../lib/meeting-followup-store.js";
import meetingFollowupRecordDenial from "../catalogue/meeting_followup_record_denial.js";

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "..", "box", "sql");
const sql = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env["DATABASE_URL"] = container.getConnectionUri();
  const pool = getPool();
  await pool.query(sql("027_meeting_followup.sql"));
  await pool.query(sql("048_meeting_followup_denied.sql"));
}, 120_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

afterEach(async () => {
  await getPool().query("TRUNCATE meeting_followup_sent");
});

describe("meeting_followup_record_denial", () => {
  it("is ungated — the resumed turn must be able to call it without a second approval", () => {
    expect((meetingFollowupRecordDenial as unknown as { approval?: unknown }).approval).toBeUndefined();
  });

  it("records 'denied' for a genuinely QUEUED row (the ordinary case)", async () => {
    await claimMeeting(getPool(), "page-queued", "hash-1");
    await recordOutcome(getPool(), "page-queued", "queued");
    const result = await meetingFollowupRecordDenial.execute({ notionPageId: "page-queued" }, {} as never);
    expect(result).toEqual({ recorded: true, notionPageId: "page-queued" });
    expect(await getOutcome(getPool(), "page-queued")).toBe("denied");
  });

  it("records 'denied' for the in-flight ERROR sentinel (an instant policy denial, resolved before post-send bookkeeping ran)", async () => {
    // claimMeeting always leaves a fresh claim as 'error' — the "claimed, not yet decided"
    // sentinel — until the tick decides sent/queued/skipped/error. A `level: 'never'` policy
    // denial resolves inside the SAME turn, so the resumed-turn call can land while the row is
    // still in exactly this state.
    await claimMeeting(getPool(), "page-inflight", "hash-1");
    expect(await getOutcome(getPool(), "page-inflight")).toBe("error");
    const result = await meetingFollowupRecordDenial.execute({ notionPageId: "page-inflight" }, {} as never);
    expect(result).toEqual({ recorded: true, notionPageId: "page-inflight" });
    expect(await getOutcome(getPool(), "page-inflight")).toBe("denied");
  });

  it("never turns a SENT row into denied — sent is terminal, always", async () => {
    await claimMeeting(getPool(), "page-sent", "hash-1");
    await recordSent(getPool(), "page-sent", "series-2", ["a@x.co"]);
    const result = await meetingFollowupRecordDenial.execute({ notionPageId: "page-sent" }, {} as never);
    expect(result).toEqual({ recorded: false, notionPageId: "page-sent" });
    expect(await getOutcome(getPool(), "page-sent")).toBe("sent");
  });

  it("never turns a SKIPPED (internal-only) row into denied — a confused or injected call must be a no-op", async () => {
    await claimMeeting(getPool(), "page-skipped", "hash-1");
    await recordOutcome(getPool(), "page-skipped", "skipped");
    const result = await meetingFollowupRecordDenial.execute({ notionPageId: "page-skipped" }, {} as never);
    expect(result).toEqual({ recorded: false, notionPageId: "page-skipped" });
    expect(await getOutcome(getPool(), "page-skipped")).toBe("skipped");
  });

  it("is a harmless no-op on a row already DENIED — never double-counted, never re-triggers anything", async () => {
    await claimMeeting(getPool(), "page-already-denied", "hash-1");
    await recordOutcome(getPool(), "page-already-denied", "denied");
    const result = await meetingFollowupRecordDenial.execute({ notionPageId: "page-already-denied" }, {} as never);
    expect(result).toEqual({ recorded: false, notionPageId: "page-already-denied" });
    expect(await getOutcome(getPool(), "page-already-denied")).toBe("denied");
  });

  it("is a harmless no-op for a page with no claim row at all — it never creates one", async () => {
    const result = await meetingFollowupRecordDenial.execute({ notionPageId: "page-never-claimed" }, {} as never);
    expect(result).toEqual({ recorded: false, notionPageId: "page-never-claimed" });
    expect(await getOutcome(getPool(), "page-never-claimed")).toBeNull();
  });
});
