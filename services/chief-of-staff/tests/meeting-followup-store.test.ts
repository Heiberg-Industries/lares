import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  claimMeeting, releaseClaim, recordSent, recordOutcome, getOutcome, lastRecipientsFingerprint,
  fingerprintRecipients, MAX_ATTEMPTS, resetClaimForRedraft, seriesKeyFor, recordDenial,
} from "../lib/meeting-followup-store.js";
import { makeFollowupTick, type FollowupDeps, type MeetingRow } from "../agent/schedules/meeting-followup.js";

describe("meeting-followup-store", () => {
  let container: StartedPostgreSqlContainer;
  let db: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    db = new Pool({ connectionString: container.getConnectionUri() });
    // LAR-28: 027 creates the table, 048 adds `summary_hash` and the `denied` outcome — applied
    // in order, exactly as the box will apply them by hand.
    for (const file of ["../../box/sql/027_meeting_followup.sql", "../../box/sql/048_meeting_followup_denied.sql"]) {
      await db.query(readFileSync(join(import.meta.dirname, file), "utf8"));
    }
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE meeting_followup_sent");
  });

  it("claims a page once, then refuses until the attempt goes stale", async () => {
    const first = await claimMeeting(db, "page-a", "hash-1");
    expect(first).toMatchObject({ claimed: true, attempt: 1 });
    // A second claim in the same tick must lose — otherwise two ticks racing on a new
    // meeting would each compose and each send, and the guest gets the email twice.
    expect((await claimMeeting(db, "page-a", "hash-1")).claimed).toBe(false);
  });

  it("refuses to re-claim a page whose outcome was recorded", async () => {
    await claimMeeting(db, "page-b", "hash-1");
    await recordSent(db, "page-b", "series-1", ["a@x.co", "b@y.co"]);
    expect((await claimMeeting(db, "page-b", "hash-1")).claimed).toBe(false);
  });

  it("fingerprints recipients order- and case-insensitively", () => {
    // The pause-and-ask rule must not fire because Google returned the same three people
    // in a different order, or because someone's address arrived capitalised.
    expect(fingerprintRecipients(["B@x.co", "a@Y.co"]))
      .toBe(fingerprintRecipients(["a@y.co", "b@x.co"]));
    expect(fingerprintRecipients(["a@y.co"]))
      .not.toBe(fingerprintRecipients(["a@y.co", "c@z.co"]));
  });

  it("returns the most recent sent fingerprint for a series, and null when there is none", async () => {
    expect(await lastRecipientsFingerprint(db, "series-unknown")).toBeNull();
    await claimMeeting(db, "page-c", "hash-1");
    await recordSent(db, "page-c", "series-2", ["a@x.co"]);
    expect(await lastRecipientsFingerprint(db, "series-2"))
      .toBe(fingerprintRecipients(["a@x.co"]));
  });

  it("never reports a fingerprint from a one-off meeting as a series' history", async () => {
    // series_key '' is "no series". Letting that key accumulate would make every one-off
    // meeting's recipient list look like the previous send of one enormous shared series.
    await claimMeeting(db, "page-d", "hash-1");
    await recordSent(db, "page-d", "", ["a@x.co"]);
    expect(await lastRecipientsFingerprint(db, "")).toBeNull();
  });

  it("never lets recordOutcome downgrade a row already recorded as sent (ORB-156 fix round 3)", async () => {
    // The exact bug: an auto-approved send's execute() calls recordSent INSIDE the same turn
    // the schedule's to(...).send() is awaiting, so by the time that call resolves the row is
    // already 'sent'. The schedule then unconditionally called recordOutcome(pageId, "queued")
    // — this is the guard that makes that impossible now, in the store rather than at the
    // call site, so no future caller can reintroduce it.
    await claimMeeting(db, "page-e", "hash-1");
    await recordSent(db, "page-e", "series-3", ["a@x.co", "b@y.co"]);
    const fingerprintBefore = await lastRecipientsFingerprint(db, "series-3");
    expect(fingerprintBefore).not.toBeNull();

    await recordOutcome(db, "page-e", "queued");

    const { rows } = await db.query<{ outcome: string; recipients_fingerprint: string }>(
      "SELECT outcome, recipients_fingerprint FROM meeting_followup_sent WHERE notion_page_id = $1",
      ["page-e"],
    );
    expect(rows[0]?.outcome).toBe("sent");
    expect(rows[0]?.recipients_fingerprint).toBe(fingerprintBefore);
    // The pause-and-ask read must still see this as a genuine sent history, not have lost it
    // to the clobber this guard exists to prevent.
    expect(await lastRecipientsFingerprint(db, "series-3")).toBe(fingerprintBefore);
  });

  it("creates the row on a page with NO prior claim (finding 2) — the conversational send path", async () => {
    // meeting_followup_send is reachable conversationally, not only from the schedule: ask
    // Saga directly to send a follow-up and it runs with a notionPageId that has NO claim
    // row (only the schedule's claimMeeting ever INSERTs one). A bare UPDATE would touch zero
    // rows and log nothing — the poller would later claim this page and send the SAME
    // follow-up again, and the recipient-change safety valve for this series would stay
    // disarmed forever (lastRecipientsFingerprint returning null). recordSent must create the
    // row itself when there isn't one.
    expect(await getOutcome(db, "page-g")).toBeNull();

    await recordSent(db, "page-g", "series-conversational", ["a@x.co", "b@y.co"]);

    expect(await getOutcome(db, "page-g")).toBe("sent");
    expect(await lastRecipientsFingerprint(db, "series-conversational"))
      .toBe(fingerprintRecipients(["a@x.co", "b@y.co"]));
  });

  // ─── ORB-193 fix round 1: a HOLD is not an attempt ───────────────────────────────────────

  it("releaseClaim leaves the row claimable with its attempt budget unspent — three holds in a row", async () => {
    // The bug this closes: a follow-up composed at 21:30 under the DEFAULT quiet hours
    // (21:00–07:00) was held by the proactivity gate on every one of its three claim attempts and
    // dropped for good by ~22:30 — hours before the gate would have let it through. A hold means
    // nothing was tried: no turn, no model call, nothing said. So it may not spend an attempt.
    for (let i = 0; i < 3; i++) {
      const claim = await claimMeeting(db, "page-held", "hash-1");
      expect(claim, `hold ${i + 1} must still be able to claim`).toMatchObject({ claimed: true, attempt: 1 });
      expect(claim.isFinalAttempt, "a hold must never look like the last chance").toBe(false);
      await releaseClaim(db, "page-held");
      const { rows } = await db.query<{ attempts: number; outcome: string }>(
        "SELECT attempts, outcome FROM meeting_followup_sent WHERE notion_page_id = $1", ["page-held"],
      );
      expect(rows[0]?.attempts, "the budget must be handed back").toBe(0);
      expect(rows[0]?.outcome).toBe("error"); // still non-terminal, so the poller re-serves it
    }

    // …and the send that finally goes through behaves exactly as a first attempt would.
    expect((await claimMeeting(db, "page-held", "hash-1"))).toMatchObject({ claimed: true, attempt: 1 });
    await recordSent(db, "page-held", "series-held", ["a@x.co"]);
    expect(await getOutcome(db, "page-held")).toBe("sent");
  });

  it("releaseClaim never resurrects a row that was already sent", async () => {
    // Ordering safety: `meeting_followup_send`'s own execute() may write 'sent' inside the very
    // turn the schedule is awaiting, so a release racing that write must be a no-op, not a way to
    // make a sent follow-up claimable (and re-sendable) again.
    await claimMeeting(db, "page-sent-race", "hash-1");
    await recordSent(db, "page-sent-race", "series-race", ["a@x.co"]);
    await releaseClaim(db, "page-sent-race");
    expect(await getOutcome(db, "page-sent-race")).toBe("sent");
    expect((await claimMeeting(db, "page-sent-race", "hash-1")).claimed).toBe(false);
  });

  it("a genuine FAILURE still spends its attempts — the budget is intact for what it is for", async () => {
    // The mirror of the case above: releasing on a hold must not accidentally make the retry budget
    // unbounded for pages that keep failing, which is the thing MAX_ATTEMPTS exists to stop.
    await db.query(
      `INSERT INTO meeting_followup_sent (principal, notion_page_id, outcome, attempts, processed_at)
       VALUES ('fixture-owner', $1, 'error', $2, now() - interval '1 hour')`,
      ["page-exhausted", MAX_ATTEMPTS],
    );
    expect((await claimMeeting(db, "page-exhausted", "hash-1")).claimed).toBe(false);
  });

  it("still lets recordOutcome move a non-sent row between non-terminal/error states", async () => {
    // The guard is specifically "never downgrade FROM sent" — every other transition (error,
    // queued, skipped) must keep working exactly as before.
    await claimMeeting(db, "page-f", "hash-1");
    await recordOutcome(db, "page-f", "queued");
    let { rows } = await db.query<{ outcome: string }>(
      "SELECT outcome FROM meeting_followup_sent WHERE notion_page_id = $1", ["page-f"],
    );
    expect(rows[0]?.outcome).toBe("queued");

    await recordOutcome(db, "page-f", "error");
    ({ rows } = await db.query<{ outcome: string }>(
      "SELECT outcome FROM meeting_followup_sent WHERE notion_page_id = $1", ["page-f"],
    ));
    expect(rows[0]?.outcome).toBe("error");
  });

  // ─── LAR-28: denied, summary_hash, and the hash-diff reclaim rules ───────────────────────

  describe("the denied/queued hash-diff reclaim (LAR-28)", () => {
    it("does NOT re-claim a denied row when the live summary hash is unchanged", async () => {
      await claimMeeting(db, "page-denied-same", "hash-1");
      await recordOutcome(db, "page-denied-same", "denied");
      expect((await claimMeeting(db, "page-denied-same", "hash-1")).claimed).toBe(false);
    });

    it("re-claims a denied row once the live summary hash differs — a NEW attempt, not the first", async () => {
      await claimMeeting(db, "page-denied-diff", "hash-1");
      await recordOutcome(db, "page-denied-diff", "denied");
      const reclaim = await claimMeeting(db, "page-denied-diff", "hash-2");
      expect(reclaim).toMatchObject({ claimed: true, attempt: 2, reclaimedAfterChange: true });
      // The sentinel every claim uses for "in flight, not yet decided" — the same one a
      // brand-new page gets — so releaseClaim/recordOutcome need no special-casing for it.
      const { rows } = await db.query<{ outcome: string; summary_hash: string }>(
        "SELECT outcome, summary_hash FROM meeting_followup_sent WHERE notion_page_id = $1",
        ["page-denied-diff"],
      );
      expect(rows[0]?.outcome).toBe("error");
      expect(rows[0]?.summary_hash).toBe("hash-2");
    });

    it("re-claims a queued row (still pending an answer) once the live hash differs", async () => {
      // The spec explicitly includes 'queued', not only 'denied': a page corrected WHILE its
      // first card is still pending must also get a fresh one, not wait for a decision on a
      // card that describes a meeting note that no longer exists.
      await claimMeeting(db, "page-queued-diff", "hash-1");
      await recordOutcome(db, "page-queued-diff", "queued");
      const reclaim = await claimMeeting(db, "page-queued-diff", "hash-2");
      expect(reclaim).toMatchObject({ claimed: true, reclaimedAfterChange: true });
    });

    it("never re-claims a SENT row, even when the live hash differs — sent is terminal, always", async () => {
      await claimMeeting(db, "page-sent-diff", "hash-1");
      await recordSent(db, "page-sent-diff", "series-sent-diff", ["a@x.co"]);
      expect((await claimMeeting(db, "page-sent-diff", "hash-2")).claimed).toBe(false);
      expect(await getOutcome(db, "page-sent-diff")).toBe("sent");
    });

    it("an ordinary 'error' retry is unaffected by summary_hash — the old retry-window rule still governs it", async () => {
      // A row still inside the retry window must stay un-claimable even if the hash also
      // differs — hash-diff is a NEW path for denied/queued, not a way to skip the existing
      // error-retry window.
      await claimMeeting(db, "page-error-window", "hash-1");
      expect((await claimMeeting(db, "page-error-window", "hash-2")).claimed).toBe(false);
    });

    it("caps a hash-diff reclaim at the existing MAX_ATTEMPTS, the same budget every path shares", async () => {
      await claimMeeting(db, "page-denied-capped", "hash-0");
      await recordOutcome(db, "page-denied-capped", "denied");
      // Attempt 2, 3 — each a hash-diff reclaim of a denied row.
      for (let hash = 1; hash < MAX_ATTEMPTS; hash++) {
        const r = await claimMeeting(db, "page-denied-capped", `hash-${hash}`);
        expect(r.claimed).toBe(true);
        await recordOutcome(db, "page-denied-capped", "denied");
      }
      // Attempt budget is now spent (MAX_ATTEMPTS reached) — a further hash change must not
      // reclaim it again, however many more times the page is corrected.
      expect((await claimMeeting(db, "page-denied-capped", "hash-final")).claimed).toBe(false);
    });

    it("a fresh page's first claim carries an empty reclaimedAfterChange, never true", async () => {
      const first = await claimMeeting(db, "page-brand-new", "hash-1");
      expect(first.reclaimedAfterChange).toBeFalsy();
    });

    it("refuses an empty summaryHash outright — no caller may store a placeholder", async () => {
      await expect(claimMeeting(db, "page-empty-hash", "")).rejects.toThrow(/summaryHash must not be empty/);
    });
  });

  // ─── LAR-28 review fix round 1: a legacy NULL/'' hash is "unknown", never "changed" ──────────

  describe("the legacy NULL/'' summary_hash deploy hazard (LAR-28 review fix round 1)", () => {
    /** Simulates a row that pre-dates 048 (or any row inserted by something other than
     *  `claimMeeting`) — `summary_hash` genuinely NULL, never touched by this migration's own
     *  code. Direct INSERT, not `claimMeeting`, is the only way to produce this shape in a test:
     *  every `claimMeeting` call always writes a real hash. */
    async function insertLegacyRow(pageId: string, outcome: "denied" | "queued" | "sent" | "error"): Promise<void> {
      await db.query(
        `INSERT INTO meeting_followup_sent (principal, notion_page_id, outcome, attempts, processed_at, summary_hash)
         VALUES ('fixture-owner', $1, $2, 1, now() - interval '1 hour', NULL)`,
        [pageId, outcome],
      );
    }

    it("does NOT re-claim a legacy 'denied' row on first sight — it adopts the live hash instead", async () => {
      await insertLegacyRow("page-legacy-denied", "denied");
      const first = await claimMeeting(db, "page-legacy-denied", "hash-live");
      expect(first.claimed).toBe(false);

      const { rows } = await db.query<{ outcome: string; summary_hash: string; attempts: number }>(
        "SELECT outcome, summary_hash, attempts FROM meeting_followup_sent WHERE notion_page_id = $1",
        ["page-legacy-denied"],
      );
      // Adopted the hash; outcome/attempts untouched — this was NOT a claim.
      expect(rows[0]?.summary_hash).toBe("hash-live");
      expect(rows[0]?.outcome).toBe("denied");
      expect(rows[0]?.attempts).toBe(1);
    });

    it("still does not re-claim on the SECOND call with the same (now-adopted) hash", async () => {
      await insertLegacyRow("page-legacy-denied-2", "denied");
      await claimMeeting(db, "page-legacy-denied-2", "hash-live");
      // The adoption call above set summary_hash = 'hash-live'; a second call with the SAME
      // hash must behave exactly like any other unchanged denied row — not claimed.
      expect((await claimMeeting(db, "page-legacy-denied-2", "hash-live")).claimed).toBe(false);
    });

    it("DOES re-claim once a genuinely different hash arrives after adoption", async () => {
      await insertLegacyRow("page-legacy-denied-3", "denied");
      await claimMeeting(db, "page-legacy-denied-3", "hash-live"); // adopts, does not claim
      const reclaim = await claimMeeting(db, "page-legacy-denied-3", "hash-changed");
      expect(reclaim).toMatchObject({ claimed: true, reclaimedAfterChange: true });
    });

    it("the same three behaviours hold for a legacy 'queued' row", async () => {
      await insertLegacyRow("page-legacy-queued", "queued");
      const first = await claimMeeting(db, "page-legacy-queued", "hash-live");
      expect(first.claimed).toBe(false);
      expect((await claimMeeting(db, "page-legacy-queued", "hash-live")).claimed).toBe(false);
      expect((await claimMeeting(db, "page-legacy-queued", "hash-changed")).claimed).toBe(true);
    });

    it("a legacy NULL-hash 'error' row past the retry window is reclaimed exactly as before — unaffected by the adoption logic", async () => {
      await insertLegacyRow("page-legacy-error", "error");
      const claim = await claimMeeting(db, "page-legacy-error", "hash-live");
      expect(claim).toMatchObject({ claimed: true, attempt: 2 });
    });

    it("a legacy NULL-hash 'sent' row is never touched by the adoption UPDATE — its hash stays NULL", async () => {
      await insertLegacyRow("page-legacy-sent", "sent");
      expect((await claimMeeting(db, "page-legacy-sent", "hash-live")).claimed).toBe(false);
      const { rows } = await db.query<{ summary_hash: string | null; outcome: string }>(
        "SELECT summary_hash, outcome FROM meeting_followup_sent WHERE notion_page_id = $1",
        ["page-legacy-sent"],
      );
      expect(rows[0]?.summary_hash).toBeNull();
      expect(rows[0]?.outcome).toBe("sent");
    });
  });

  describe("resetClaimForRedraft (LAR-28, 'check again')", () => {
    it("resets a denied row so the very next claim succeeds even with the SAME hash", async () => {
      await claimMeeting(db, "page-redraft-denied", "hash-1");
      await recordOutcome(db, "page-redraft-denied", "denied");
      // Unlike the automatic path, the hash has not changed here — this is the "check again
      // right now" escape hatch, not a hash-diff reclaim.
      expect((await claimMeeting(db, "page-redraft-denied", "hash-1")).claimed).toBe(false);

      const result = await resetClaimForRedraft(db, "page-redraft-denied");
      expect(result).toEqual({ reset: true, alreadySent: false });
      expect((await claimMeeting(db, "page-redraft-denied", "hash-1")).claimed).toBe(true);
    });

    it("refuses to reset a SENT row, and says so", async () => {
      await claimMeeting(db, "page-redraft-sent", "hash-1");
      await recordSent(db, "page-redraft-sent", "series-redraft-sent", ["a@x.co"]);
      const result = await resetClaimForRedraft(db, "page-redraft-sent");
      expect(result).toEqual({ reset: false, alreadySent: true });
      expect(await getOutcome(db, "page-redraft-sent")).toBe("sent");
    });

    it("is a harmless no-op for a page with no claim row at all", async () => {
      const result = await resetClaimForRedraft(db, "page-never-seen");
      expect(result).toEqual({ reset: false, alreadySent: false });
    });
  });

  describe("seriesKeyFor (LAR-28 — meeting_followup_redraft's approval gate)", () => {
    it("returns the recorded series key for a claimed page", async () => {
      await claimMeeting(db, "page-series-lookup", "hash-1");
      await recordOutcome(db, "page-series-lookup", "queued");
      await db.query("UPDATE meeting_followup_sent SET series_key = $2 WHERE notion_page_id = $1", ["page-series-lookup", "series-x"]);
      expect(await seriesKeyFor(db, "page-series-lookup")).toBe("series-x");
    });

    it("returns null for a page with no claim row", async () => {
      expect(await seriesKeyFor(db, "page-no-row")).toBeNull();
    });
  });
});

describe("makeFollowupTick against the real store (ORB-156 fix round 3)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    db = new Pool({ connectionString: container.getConnectionUri() });
    for (const file of ["../../box/sql/027_meeting_followup.sql", "../../box/sql/048_meeting_followup_denied.sql"]) {
      await db.query(readFileSync(join(import.meta.dirname, file), "utf8"));
    }
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE meeting_followup_sent");
  });

  it("an auto-approved send leaves the row 'sent' — the schedule's own recordOutcome never downgrades it", async () => {
    // This is the schedule-level proof of the fix round 3 guard: `send` here simulates
    // exactly what meeting_followup_send's execute() does for an autonomous (no-card)
    // approval — it calls the REAL recordSent, inside the same call the schedule is
    // awaiting, before the schedule's own recordOutcome("queued") ever runs. Without the
    // store-level guard, that recordOutcome call would clobber 'sent' back to 'queued'.
    const NOW = new Date("2026-08-24T11:00:00.000Z");
    const row: MeetingRow = {
      pageId: "page-auto",
      title: "Folkepuls",
      startsAt: "2026-08-24T10:00:00.000+02:00",
      series: "series-auto",
      attendees: "Stefan <sam@example.com>, bendik <owner@owner.example>",
      summaryBlock: "### Handlingspunkter\n- Stefan: domener",
      actionItems: "- Stefan: sjekker domener",
    };
    const deps: FollowupDeps = {
      listMeetings: async () => [row],
      claim: (pageId, summaryHash) => claimMeeting(db, pageId, summaryHash),
      compose: async () => ({ subject: "Oppsummering — Folkepuls", bodyText: "..." }),
      send: async (payload) => {
        await recordSent(db, payload.notionPageId, payload.seriesKey, payload.to);
        return { autonomous: true };
      },
      getOutcome: (pageId) => getOutcome(db, pageId),
      recordOutcome: (pageId, outcome) => recordOutcome(db, pageId, outcome),
      reportAutonomousSendFailed: async () => {},
      reportDropped: async () => {},
      notify: async () => {},
      selfEmails: ["owner@owner.example"],
    };

    const res = await makeFollowupTick(deps).tick(NOW);
    expect(res.queued).toBe(1);

    const { rows } = await db.query<{ outcome: string }>(
      "SELECT outcome FROM meeting_followup_sent WHERE notion_page_id = $1", ["page-auto"],
    );
    expect(rows[0]?.outcome).toBe("sent");
  });

  // ORB-193 fix round 1 — the tick half of "a hold is not an attempt". The store half (that
  // `releaseClaim` hands the attempt back) is proven above; this proves the tick records NOTHING on a
  // hold, so the row stays exactly the non-terminal 'error' the claim seeded and a later tick picks
  // it up. The live wiring is what calls `releaseClaim`, right where the hold is detected
  // (`makeLiveSend`), so this case's row keeps the attempt the claim took.
  it("a held-back send records no outcome, counts as held, and leaves the row re-claimable", async () => {
    const NOW = new Date("2026-08-24T11:00:00.000Z");
    const row: MeetingRow = {
      pageId: "page-held-tick",
      title: "Folkepuls",
      startsAt: "2026-08-24T10:00:00.000+02:00",
      series: "series-held",
      attendees: "Stefan <sam@example.com>, bendik <owner@owner.example>",
      summaryBlock: "### Handlingspunkter\n- Stefan: domener",
      actionItems: "- Stefan: sjekker domener",
    };
    const dropped: string[] = [];
    const notified: string[] = [];
    const deps: FollowupDeps = {
      listMeetings: async () => [row],
      claim: (pageId, summaryHash) => claimMeeting(db, pageId, summaryHash),
      compose: async () => ({ subject: "Oppsummering — Folkepuls", bodyText: "..." }),
      // What `makeLiveSend` returns when the proactivity gate holds the send-turn back.
      send: async () => ({ autonomous: false, held: true }),
      getOutcome: (pageId) => getOutcome(db, pageId),
      recordOutcome: (pageId, outcome) => recordOutcome(db, pageId, outcome),
      reportAutonomousSendFailed: async () => {},
      reportDropped: async (pageId) => { dropped.push(pageId); },
      notify: async (text) => { notified.push(text); },
      selfEmails: ["owner@owner.example"],
    };

    const res = await makeFollowupTick(deps).tick(NOW);
    expect(res).toMatchObject({ composed: 1, held: 1, queued: 0, errored: 0 });
    // Not an error, not a drop, and above all not a message: nothing was said to anyone.
    expect(dropped).toEqual([]);
    expect(notified).toEqual([]);
    const { rows } = await db.query<{ outcome: string }>(
      "SELECT outcome FROM meeting_followup_sent WHERE notion_page_id = $1", ["page-held-tick"],
    );
    expect(rows[0]?.outcome, "still non-terminal, so a later tick re-serves it").toBe("error");
  });
});
