import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { claimMessage, recordOutcome, pruneOldRecords, recordDraft, findDraft, MAX_ATTEMPTS } from "../lib/email-triage-store.js";

describe("email-triage-store", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    for (const file of ["../../box/sql/022_email_triage.sql", "../../box/sql/024_email_triage_retry.sql", "../../box/sql/034_email_triage_draft_id.sql"]) {
      await pool.query(readFileSync(join(import.meta.dirname, file), "utf8"));
    }
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE email_triage_processed");
  });

  /** Simulates "a full tick has passed" without sleeping — the staleness gate needs
   *  `processed_at` old enough to distinguish "stale, retry it" from "possibly still
   *  in flight, leave it alone" (see claimMessage's RETRY_ELIGIBLE_AFTER). */
  async function backdate(mailbox: string, id: string) {
    await pool.query(
      `UPDATE email_triage_processed SET processed_at = now() - interval '5 minutes'
       WHERE mailbox = $1 AND gmail_message_id = $2`,
      [mailbox, id],
    );
  }

  describe("claimMessage", () => {
    it("claims the first time, as attempt 1 of MAX_ATTEMPTS — not yet final", async () => {
      await expect(claimMessage(pool, "owner@project.example", "m1")).resolves.toEqual({
        claimed: true, attempt: 1, isFinalAttempt: false,
      });
    });

    it("does not re-claim once the real outcome has been recorded — the exactly-once guarantee", async () => {
      await claimMessage(pool, "owner@project.example", "m1");
      await recordOutcome(pool, "owner@project.example", "m1", "drafted");
      await backdate("owner@project.example", "m1"); // even once it's old, a real outcome is never re-claimed
      await expect(claimMessage(pool, "owner@project.example", "m1")).resolves.toEqual({
        claimed: false, attempt: 0, isFinalAttempt: false,
      });
    });

    it("does NOT re-claim a row that was claimed moments ago — closes the concurrent-claim race", async () => {
      await claimMessage(pool, "owner@project.example", "m1"); // attempt 1, still fresh
      await expect(claimMessage(pool, "owner@project.example", "m1")).resolves.toEqual({
        claimed: false, attempt: 0, isFinalAttempt: false,
      });
    });

    it("re-claims a still-'error' row as the next attempt once it's stale, up to MAX_ATTEMPTS", async () => {
      await claimMessage(pool, "owner@project.example", "m1"); // attempt 1
      await backdate("owner@project.example", "m1");
      await expect(claimMessage(pool, "owner@project.example", "m1")).resolves.toEqual({
        claimed: true, attempt: 2, isFinalAttempt: false,
      }); // attempt 2 — a later tick
      await backdate("owner@project.example", "m1");
      await expect(claimMessage(pool, "owner@project.example", "m1")).resolves.toEqual({
        claimed: true, attempt: MAX_ATTEMPTS, isFinalAttempt: true,
      }); // attempt 3 = MAX_ATTEMPTS — the caller's last shot
    });

    it("refuses to claim past MAX_ATTEMPTS — a permanently-failing message is not retried forever", async () => {
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await claimMessage(pool, "owner@project.example", "m1");
        await backdate("owner@project.example", "m1");
      }
      await expect(claimMessage(pool, "owner@project.example", "m1")).resolves.toEqual({
        claimed: false, attempt: 0, isFinalAttempt: false,
      });
    });

    it("the SAME message id under a DIFFERENT mailbox is a separate claim", async () => {
      await claimMessage(pool, "owner@project.example", "m1");
      await expect(claimMessage(pool, "owner@owner.example", "m1")).resolves.toMatchObject({ claimed: true, attempt: 1 });
    });

    it("survives concurrent claims on a brand-new message — only one wins", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => claimMessage(pool, "owner@project.example", "concurrent")),
      );
      expect(results.filter((r) => r.claimed)).toHaveLength(1);
    });
  });

  describe("recordOutcome", () => {
    it("overwrites the seeded 'error' outcome with the real one", async () => {
      await claimMessage(pool, "owner@project.example", "m1");
      await recordOutcome(pool, "owner@project.example", "m1", "drafted");
      const { rows } = await pool.query("SELECT outcome FROM email_triage_processed WHERE gmail_message_id = 'm1'");
      expect(rows[0].outcome).toBe("drafted");
    });

    it("a crash between claim and recordOutcome leaves the honest 'error' outcome", async () => {
      await claimMessage(pool, "owner@project.example", "m1");
      const { rows } = await pool.query("SELECT outcome FROM email_triage_processed WHERE gmail_message_id = 'm1'");
      expect(rows[0].outcome).toBe("error");
    });
  });

  describe("pruneOldRecords", () => {
    it("drops records older than the retention window, keeps recent ones", async () => {
      await pool.query(
        `INSERT INTO email_triage_processed (principal, mailbox, gmail_message_id, outcome, processed_at)
         VALUES ('fixture-owner', 'x','ancient','drafted', now() - interval '60 days'),
                ('fixture-owner','x','recent','drafted', now())`,
      );
      await pruneOldRecords(pool);
      const { rows } = await pool.query("SELECT gmail_message_id FROM email_triage_processed");
      expect(rows.map((r) => r.gmail_message_id)).toEqual(["recent"]);
    });
  });

  // 2026-09-08 (sql/034): "the reply to Stefan" must resolve to a Gmail draft so its recipients
  // can be changed by telling Saga. The row that already records the triage outcome carries the
  // draft id and thread id; findDraft returns the latest draft for a thread, or null.
  it("recordDraft/findDraft remember which Gmail draft belongs to which thread", async () => {
    await claimMessage(pool, "owner@owner.example", "m-draft");
    await recordOutcome(pool, "owner@owner.example", "m-draft", "drafted");
    await recordDraft(pool, "owner@owner.example", "m-draft", { draftId: "r123", threadId: "t-abc" });
    expect(await findDraft(pool, "owner@owner.example", { threadId: "t-abc" }))
      .toEqual({ draftId: "r123", threadId: "t-abc", gmailMessageId: "m-draft" });
    expect(await findDraft(pool, "owner@owner.example", { threadId: "nope" })).toBeNull();
    // another mailbox's draft on the same thread id is not this mailbox's
    expect(await findDraft(pool, "owner@project.example", { threadId: "t-abc" })).toBeNull();
  });
});
