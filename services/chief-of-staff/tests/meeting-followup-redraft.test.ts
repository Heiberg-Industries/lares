/**
 * `meeting_followup_redraft` (LAR-28) — the "check again" escape hatch. Gated exactly like
 * `meeting_followup_send`: its approval re-derives the series key from the store row (this tool
 * takes only `notionPageId`) and hands it to the SAME `followupApproval` policy, so this suite
 * proves the wiring against a real Postgres rather than re-proving `followupApproval`'s own
 * decision table (tests/meeting-followup-approval.test.ts already owns that).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getPool, closePool } from "@lares/agent-kit/db";
import { claimMeeting, recordSent, recordOutcome, getOutcome } from "../lib/meeting-followup-store.js";
import { KitRatchet } from "@lares/agent-kit/ratchet";
import meetingFollowupRedraft from "../catalogue/meeting_followup_redraft.js";
import { FOLLOWUP_AGENT, FOLLOWUP_CAPABILITY } from "../catalogue/meeting_followup_send.js";

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, "..", "..", "box", "sql");
const sql = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

const BENDIK = "U_EXAMPLE_OWNER";
function ctx(auth: unknown = { authenticator: "slack-webhook", attributes: { user_id: BENDIK } }) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env["DATABASE_URL"] = container.getConnectionUri();
  process.env["SLACK_ALLOWED_USER_IDS"] = BENDIK;
  const pool = getPool();
  await pool.query(sql("027_meeting_followup.sql"));
  await pool.query(sql("048_meeting_followup_denied.sql"));
  await pool.query(sql("008_ratchet.sql")); // `KitRatchet` reads/writes this table
}, 120_000);

afterAll(async () => {
  delete process.env["SLACK_ALLOWED_USER_IDS"];
  await closePool();
  await container.stop();
});

afterEach(async () => {
  const pool = getPool();
  await pool.query("TRUNCATE meeting_followup_sent");
  await pool.query("DELETE FROM ratchet");
});

describe("meeting_followup_redraft — approval shape (LAR-28)", () => {
  it("carries an approval policy — deleting it would let 'check again' bypass Bendik entirely", () => {
    expect(meetingFollowupRedraft.approval).toBeDefined();
  });

  it("asks a human for a one-off meeting (no series recorded at all)", async () => {
    await claimMeeting(getPool(), "page-oneoff", "hash-1");
    await recordOutcome(getPool(), "page-oneoff", "denied");
    const decision = await meetingFollowupRedraft.approval!({ toolInput: { notionPageId: "page-oneoff" } } as never);
    expect(decision).toBe("user-approval");
  });

  it("asks a human for a page with no claim row at all", async () => {
    const decision = await meetingFollowupRedraft.approval!({ toolInput: { notionPageId: "page-never-seen" } } as never);
    expect(decision).toBe("user-approval");
  });

  it("approves without asking when the recorded series is opted into autonomous send", async () => {
    await claimMeeting(getPool(), "page-auto", "hash-1");
    await getPool().query("UPDATE meeting_followup_sent SET series_key = $2 WHERE notion_page_id = $1", ["page-auto", "series-auto"]);
    await new KitRatchet(getPool()).setLevel(FOLLOWUP_AGENT, FOLLOWUP_CAPABILITY, "autonomous", "series-auto", "test");
    const decision = await meetingFollowupRedraft.approval!({ toolInput: { notionPageId: "page-auto" } } as never);
    expect(decision).toBe("approved");
  });

  it("asks a human when the recorded series is merely gated (the default)", async () => {
    await claimMeeting(getPool(), "page-gated", "hash-1");
    await getPool().query("UPDATE meeting_followup_sent SET series_key = $2 WHERE notion_page_id = $1", ["page-gated", "series-gated"]);
    const decision = await meetingFollowupRedraft.approval!({ toolInput: { notionPageId: "page-gated" } } as never);
    expect(decision).toBe("user-approval");
  });
});

describe("meeting_followup_redraft — execute() (LAR-28)", () => {
  it("resets a denied row so the next claim succeeds even with an unchanged hash", async () => {
    await claimMeeting(getPool(), "page-redraft-1", "hash-1");
    await recordOutcome(getPool(), "page-redraft-1", "denied");

    const result = await meetingFollowupRedraft.execute({ notionPageId: "page-redraft-1" }, ctx());
    expect(result).toEqual({ reset: true, notionPageId: "page-redraft-1" });
    expect((await claimMeeting(getPool(), "page-redraft-1", "hash-1")).claimed).toBe(true);
  });

  it("refuses to reset an already-sent row and says why", async () => {
    await claimMeeting(getPool(), "page-redraft-sent", "hash-1");
    await recordSent(getPool(), "page-redraft-sent", "series-x", ["a@x.co"]);

    const result = await meetingFollowupRedraft.execute({ notionPageId: "page-redraft-sent" }, ctx());
    expect(result).toEqual({ reset: false, notionPageId: "page-redraft-sent", reason: "already sent — cannot be undone" });
    expect(await getOutcome(getPool(), "page-redraft-sent")).toBe("sent");
  });

  it("refuses an unrecognised principal, the same as meeting_followup_send", async () => {
    await claimMeeting(getPool(), "page-redraft-stranger", "hash-1");
    await recordOutcome(getPool(), "page-redraft-stranger", "denied");
    await expect(
      meetingFollowupRedraft.execute(
        { notionPageId: "page-redraft-stranger" },
        ctx({ authenticator: "slack-webhook", attributes: { user_id: "U_STRANGER" } }),
      ),
    ).rejects.toThrow();
  });
});
