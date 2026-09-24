import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { createJob, getJob, dueJobs, claimJob, advanceJob, waitJob, waitForEventJob, resumeByEvent, completeJob, failJob, findJobWaitingOnEvent, heartbeatJob, reclaimStalledJobs, startWorkflowForEvent } from "../lib/workflow-jobs.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

let tdb: TestDb;
let db: Pool;

beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });

describe("workflow-jobs: create/get/due/claim", () => {
  it("creates a job that is immediately due and pending", async () => {
    const job = await createJob(db, { agent: "nora", workflowType: "two-step", state: { a: 0 } });
    expect(job.status).toBe("pending");
    expect(job.stepIndex).toBe(0);
    expect(job.state).toEqual({ a: 0 });
    const due = await dueJobs(db, new Date(), "nora");
    expect(due.map((j) => j.id)).toContain(job.id);
  });

  it("dueJobs only returns the given agent's jobs (no cross-agent claiming)", async () => {
    const mine = await createJob(db, { agent: "tyche", workflowType: "market-survey" });
    const theirs = await createJob(db, { agent: "nora", workflowType: "nora-outreach" });
    const tycheDue = (await dueJobs(db, new Date(), "tyche")).map((j) => j.id);
    expect(tycheDue).toContain(mine.id);
    expect(tycheDue).not.toContain(theirs.id);
    const noraDue = (await dueJobs(db, new Date(), "nora")).map((j) => j.id);
    expect(noraDue).toContain(theirs.id);
    expect(noraDue).not.toContain(mine.id);
  });

  it("getJob round-trips state and nullable fields", async () => {
    const job = await createJob(db, { agent: "nora", principal: "U_X", workflowType: "t", state: { k: "v" } });
    const got = await getJob(db, job.id);
    expect(got?.principal).toBe("U_X");
    expect(got?.state).toEqual({ k: "v" });
    expect(got?.waitEvent).toBeNull();
    expect(got?.result).toBeNull();
  });

  it("claimJob wins once and refuses a second claim", async () => {
    const job = await createJob(db, { agent: "nora", workflowType: "t" });
    expect(await claimJob(db, job.id)).toBe(true);
    expect(await claimJob(db, job.id)).toBe(false);
    expect((await getJob(db, job.id))?.status).toBe("running");
  });
});

describe("workflow-jobs: transitions", () => {
  it("advanceJob moves to next step, pending and due now", async () => {
    const job = await createJob(db, { agent: "nora", workflowType: "t", state: { a: 0 } });
    await advanceJob(db, job.id, { a: 1 }, 1);
    const got = await getJob(db, job.id);
    expect(got?.stepIndex).toBe(1);
    expect(got?.status).toBe("pending");
    expect(got?.state).toEqual({ a: 1 });
    // advanceJob uses PostgreSQL now(), so assert due-ness against that clock.
    // JS dates also truncate PostgreSQL microseconds; round the read horizon up
    // after asserting the exact SQL comparison rather than adding an arbitrary sleep.
    const { rows: [clock] } = await db.query<{ due: boolean; now: Date }>(
      "SELECT due_at <= clock_timestamp() AS due, clock_timestamp() AS now FROM workflow_jobs WHERE id=$1",
      [job.id],
    );
    expect(clock!.due).toBe(true);
    expect((await dueJobs(db, new Date(clock!.now.getTime() + 1), "nora")).map((j) => j.id)).toContain(job.id);
  });

  it("waitJob suspends until its resumeAt time", async () => {
    const job = await createJob(db, { agent: "nora", workflowType: "t" });
    const base = new Date("2026-01-01T00:00:00.000Z");
    await waitJob(db, job.id, { slept: true }, new Date(base.getTime() + 50));
    expect((await dueJobs(db, base, "nora")).map((j) => j.id)).not.toContain(job.id);
    expect((await dueJobs(db, new Date(base.getTime() + 100), "nora")).map((j) => j.id)).toContain(job.id);
  });

  it("waitForEventJob suspends; resumeByEvent wakes exactly that job", async () => {
    const job = await createJob(db, { agent: "nora", workflowType: "t" });
    await waitForEventJob(db, job.id, { armed: true }, "reply:thread-7");
    expect((await dueJobs(db, new Date(), "nora")).map((j) => j.id)).not.toContain(job.id);
    const wokenId = await resumeByEvent(db, "nora", "reply:thread-7");
    expect(wokenId).toBe(job.id);
    const got = await getJob(db, job.id);
    expect(got?.status).toBe("pending");
    expect(got?.waitEvent).toBeNull();
    expect(got?.state).toEqual({ armed: true });
  });

  it("resumeByEvent returns null when no job waits on that event", async () => {
    expect(await resumeByEvent(db, "nora", "nope:xyz")).toBeNull();
  });

  it("completeJob and failJob set terminal status", async () => {
    const a = await createJob(db, { agent: "nora", workflowType: "t" });
    await completeJob(db, a.id, { ok: true });
    expect((await getJob(db, a.id))?.status).toBe("done");
    expect((await getJob(db, a.id))?.result).toEqual({ ok: true });
    const b = await createJob(db, { agent: "nora", workflowType: "t" });
    await failJob(db, b.id, "boom");
    expect((await getJob(db, b.id))?.status).toBe("failed");
    expect((await getJob(db, b.id))?.error).toBe("boom");
  });
});

describe("heartbeatJob", () => {
  it("bumps updated_at so the reaper does not reclaim a live long step", async () => {
    const job = await createJob(db, { agent: "nora", workflowType: "t" });
    await claimJob(db, job.id);                                   // status=running, updated_at=now
    // simulate time passing past the lease, then heartbeat
    await db.query("UPDATE workflow_jobs SET updated_at = now() - interval '20 minutes' WHERE id=$1", [job.id]);
    await heartbeatJob(db, job.id);                               // fresh updated_at
    const reclaimed = await reclaimStalledJobs(db, new Date(Date.now() - 15 * 60_000));
    expect((await getJob(db, job.id))?.status).toBe("running");   // NOT reclaimed
    expect(reclaimed).toBe(0);
  });
});

describe("findJobWaitingOnEvent", () => {
  it("returns the id of a job waiting on (agent,event), null otherwise, and does not mutate it", async () => {
    const job = await createJob(db, { agent: "nora", workflowType: "t" });
    await waitForEventJob(db, job.id, { armed: true }, "confirm:abc");
    expect(await findJobWaitingOnEvent(db, "nora", "confirm:abc")).toBe(job.id);
    // unchanged — still waiting, still event-blocked
    const got = await getJob(db, job.id);
    expect(got?.status).toBe("waiting");
    expect(got?.waitEvent).toBe("confirm:abc");
    // wrong agent / wrong event → null
    expect(await findJobWaitingOnEvent(db, "saga", "confirm:abc")).toBeNull();
    expect(await findJobWaitingOnEvent(db, "nora", "confirm:zzz")).toBeNull();
  });
});

describe("startWorkflowForEvent: exactly-once by correlation key", () => {
  it("inserts a job the first time and reports started=true", async () => {
    const r = await startWorkflowForEvent(db, { agent: "saga", workflowType: "email-triage", correlationKey: "owner@owner.example:m1", principal: "U_BENDIK", state: { subject: "Hi" } });
    expect(r.started).toBe(true);
    const job = await getJob(db, r.jobId);
    expect(job?.workflowType).toBe("email-triage");
    expect(job?.state).toEqual({ subject: "Hi" });
    expect(job?.status).toBe("pending");
  });

  it("is idempotent: a second call with the same key does NOT insert and reports started=false with the same id", async () => {
    const a = await startWorkflowForEvent(db, { agent: "saga", workflowType: "email-triage", correlationKey: "owner@owner.example:dup" });
    const b = await startWorkflowForEvent(db, { agent: "saga", workflowType: "email-triage", correlationKey: "owner@owner.example:dup" });
    expect(a.started).toBe(true);
    expect(b.started).toBe(false);
    expect(b.jobId).toBe(a.jobId);
  });

  it("scopes dedupe by (agent, workflow_type, correlation_key) — same key under a different agent/type starts a new job", async () => {
    const k = "owner@owner.example:scoped";
    const s1 = await startWorkflowForEvent(db, { agent: "saga", workflowType: "email-triage", correlationKey: k });
    const s2 = await startWorkflowForEvent(db, { agent: "nora", workflowType: "email-triage", correlationKey: k });
    const s3 = await startWorkflowForEvent(db, { agent: "saga", workflowType: "other-trigger", correlationKey: k });
    expect(s1.started && s2.started && s3.started).toBe(true);
    expect(new Set([s1.jobId, s2.jobId, s3.jobId]).size).toBe(3);
  });

  it("does not collide with legacy createJob rows (NULL correlation_key)", async () => {
    const j1 = await createJob(db, { agent: "saga", workflowType: "email-triage", state: {} });
    const j2 = await createJob(db, { agent: "saga", workflowType: "email-triage", state: {} });
    expect(j1.id).not.toBe(j2.id);   // two NULL-keyed rows coexist (partial index excludes NULL)
  });
});
