import { describe, it, expect, vi } from "vitest";
import { makeFollowupTick, type FollowupDeps } from "../agent/schedules/meeting-followup.js";
import { hashSummaryBlock } from "../lib/meeting-followup.js";

const NOW = new Date("2026-08-24T11:00:00.000Z");

function meetingRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    pageId: "page-1",
    title: "Folkepuls",
    startsAt: "2026-08-24T10:00:00.000+02:00",
    series: "fixture-recurring-event",
    attendees: "Stefan <sam@example.com>, bendik <owner@owner.example>",
    summaryBlock: "### Handlingspunkter\n- Stefan: domener",
    actionItems: "- Stefan: sjekker domener",
    ...over,
  };
}

function deps(
  over: Partial<FollowupDeps> = {},
): {
  impl: FollowupDeps; sent: unknown[]; composed: number; notified: string[];
  outcomes: Array<[string, string]>; dropped: Array<[string, string]>;
  autonomousFailures: Array<[string, string, string | null]>;
} {
  const sent: unknown[] = [];
  const notified: string[] = [];
  const outcomes: Array<[string, string]> = [];
  const dropped: Array<[string, string]> = [];
  const autonomousFailures: Array<[string, string, string | null]> = [];
  let composed = 0;
  const impl: FollowupDeps = {
    listMeetings: async () => [meetingRow()],
    claim: async () => ({ claimed: true, attempt: 1, isFinalAttempt: false }),
    compose: async () => { composed += 1; return { subject: "Oppsummering — Folkepuls", bodyText: "..." }; },
    send: async (payload) => { sent.push(payload); },
    // Defaults to "sent" — matters only for a test that opts into an autonomous send
    // (`send` returning `{ autonomous: true }`); every other test's `send()` returns void,
    // so `getOutcome` is never consulted for it (finding 1's read-back only runs on the
    // autonomous pre-check path).
    getOutcome: async () => "sent",
    // Captures every call so a test can assert WHICH outcome string landed — this is the
    // thing ORB-156 fix round 2 exists to get right: "queued" after a dispatched turn,
    // never "sent" (only the tool itself may ever claim that — see meeting-followup.ts's
    // module header).
    recordOutcome: async (pageId, outcome) => { outcomes.push([pageId, outcome]); },
    reportAutonomousSendFailed: async (pageId, title, outcome) => { autonomousFailures.push([pageId, title, outcome]); },
    reportDropped: async (pageId, title) => { dropped.push([pageId, title]); },
    notify: async (m) => { notified.push(m); },
    selfEmails: ["owner@owner.example"],
    ...over,
  };
  return { impl, sent, get composed() { return composed; }, notified, outcomes, dropped, autonomousFailures };
}

describe("makeFollowupTick (ORB-156)", () => {
  it("composes and queues one follow-up for a summarised, matched meeting", async () => {
    const d = deps();
    const res = await makeFollowupTick(d.impl).tick(NOW);
    expect(res).toMatchObject({ composed: 1, queued: 1 });
    expect(d.sent).toHaveLength(1);
  });

  it("addresses the participants and never Bendik himself", async () => {
    const d = deps();
    await makeFollowupTick(d.impl).tick(NOW);
    expect((d.sent[0] as { to: string[] }).to).toEqual(["sam@example.com"]);
  });

  it("passes the series key through, so the ratchet has something to key on", async () => {
    const d = deps();
    await makeFollowupTick(d.impl).tick(NOW);
    expect((d.sent[0] as { seriesKey: string }).seriesKey).toBe("fixture-recurring-event");
  });

  it("carries a non-empty `from` — the tool's send() call requires it", async () => {
    const d = deps();
    await makeFollowupTick(d.impl).tick(NOW);
    const from = (d.sent[0] as { from: string }).from;
    expect(from).toBeTypeOf("string");
    expect(from.length).toBeGreaterThan(0);
  });

  it("records 'queued' after a successful turn, and NEVER 'sent' — only the tool may claim that", async () => {
    // The critical fix (ORB-156 fix round 2): to(...).send() resolving means the model's turn
    // ended, not that mail left. A first-of-series send renders a card that may be declined
    // or never clicked — recording "sent" here would mark that meeting done forever with no
    // retry, no error, no signal. Only meeting_followup_send's own execute() may write "sent".
    const d = deps();
    await makeFollowupTick(d.impl).tick(NOW);
    expect(d.outcomes).toContainEqual(["page-1", "queued"]);
    expect(d.outcomes.some(([, outcome]) => outcome === "sent")).toBe(false);
  });

  it("skips a meeting with no summary yet — the trigger has not fired", async () => {
    const d = deps({ listMeetings: async () => [meetingRow({ summaryBlock: "" })] });
    const res = await makeFollowupTick(d.impl).tick(NOW);
    expect(res).toMatchObject({ composed: 0, queued: 0 });
  });

  it("skips a meeting with no attendees — ORB-155 has not matched it", async () => {
    const d = deps({ listMeetings: async () => [meetingRow({ attendees: "" })] });
    const res = await makeFollowupTick(d.impl).tick(NOW);
    expect(res).toMatchObject({ composed: 0, queued: 0 });
  });

  it("skips an internal-only meeting entirely", async () => {
    // Bendik is a solo founder; an internal-only meeting is him and a recording. There is
    // nobody to follow up with, and a second template for that population would be dead code.
    const d = deps({ listMeetings: async () => [meetingRow({ attendees: "bendik <owner@owner.example>" })] });
    const res = await makeFollowupTick(d.impl).tick(NOW);
    expect(res).toMatchObject({ composed: 0, queued: 0, skipped: 1 });
  });

  it("never composes for a page it could not claim", async () => {
    // The claim is what stops two ticks both billing a compose call for one meeting.
    const d = deps({ claim: async () => ({ claimed: false, attempt: 0, isFinalAttempt: false }) });
    const res = await makeFollowupTick(d.impl).tick(NOW);
    expect(res.composed).toBe(0);
  });

  it("stops composing at the per-tick ceiling — exactly 5, not merely at most 5", async () => {
    // The Aug 14/15 lesson: a backfill must not fire one billed call per row with no limit.
    // toBe(5), not toBeLessThanOrEqual(5): the looser assertion would also pass an
    // implementation that composes zero (coordinator review, fix round 2).
    const many = Array.from({ length: 12 }, (_, n) => meetingRow({ pageId: `page-${n}` }));
    const d = deps({ listMeetings: async () => many });
    const res = await makeFollowupTick(d.impl).tick(NOW);
    expect(res.composed).toBe(5);
  });

  it("does not let permanently-unready rows ahead of the queue starve the ready ones behind them", async () => {
    // ORB-156 fix round 3, Important: a row whose Summary property is filled but whose
    // <summary> block can never be extracted (isReady=false forever) must not occupy a
    // ceiling slot — the engine's own isReady filter runs BEFORE the ceiling loop, so 3 such
    // rows sorted ahead of 6 genuinely-ready ones must still leave room for 5 composes.
    //
    // Post-fix-round-4 review (Important): these MUST sit inside FOLLOWUP_MAX_AGE_DAYS, not
    // outside it — dated outside the window (the original Aug 20/21/22 fixture), the engine's
    // OWN age gate deletes them before `isReady` is ever consulted, and this test's stated
    // concern (isReady ordering vs. the ceiling) is never actually exercised. 60/45/30 minutes
    // before NOW keeps them recent AND still older than every `ready` row below (max 5 minutes
    // before NOW), so they still sort first and still have to be excluded by readiness, not age.
    const unready = Array.from({ length: 3 }, (_, n) => meetingRow({
      pageId: `unready-${n}`,
      startsAt: new Date(NOW.getTime() - (60 - n * 15) * 60 * 1000).toISOString(), // 60/45/30 min before NOW
      summaryBlock: "", // the contradiction case: extraction failed, never becomes ready
    }));
    // Minutes-before-NOW, strictly ascending (n=0 oldest .. n=5 most recent) — kept inside
    // FOLLOWUP_MAX_FUTURE_SLACK_MINUTES's forward ceiling (unlike the original hours-ahead-
    // of-NOW fixture, which the post-fix future bound correctly started excluding).
    const ready = Array.from({ length: 6 }, (_, n) => meetingRow({
      pageId: `ready-${n}`,
      startsAt: new Date(NOW.getTime() - (5 - n) * 60 * 1000).toISOString(),
    }));
    const d = deps({ listMeetings: async () => [...unready, ...ready] });
    const res = await makeFollowupTick(d.impl).tick(NOW);
    expect(res.composed).toBe(5);
    expect(res.queued).toBe(5);
  });

  it("records the outcome and keeps going when one send fails", async () => {
    let calls = 0;
    const d = deps({
      listMeetings: async () => [meetingRow({ pageId: "a" }), meetingRow({ pageId: "b" })],
      send: async () => { calls += 1; if (calls === 1) throw new Error("gmail 500"); },
    });
    const res = await makeFollowupTick(d.impl).tick(NOW);
    expect(res).toMatchObject({ errored: 1, queued: 1 });
    expect(d.outcomes).toContainEqual(["a", "error"]);
    expect(d.outcomes).toContainEqual(["b", "queued"]);
  });

  it("posts a 'what I did' line only for a send that needed no approval", async () => {
    const d = deps({ send: async () => ({ autonomous: true }) });
    await makeFollowupTick(d.impl).tick(NOW);
    expect(d.notified.join(" ")).toContain("Folkepuls");
  });

  describe("finding 1 (CRITICAL) — a failed autonomous send must not be reported as sent", () => {
    it("the happy autonomous path posts exactly one success line", async () => {
      const d = deps({ send: async () => ({ autonomous: true }), getOutcome: async () => "sent" });
      const res = await makeFollowupTick(d.impl).tick(NOW);
      expect(d.notified).toHaveLength(1);
      expect(d.notified[0]).toContain("Folkepuls");
      expect(res.errored).toBe(0);
    });

    it("an autonomous send whose tool execute() failed posts no success line, counts as errored, and signals", async () => {
      // The turn dispatched fine (send() resolves, pre-check said autonomous) but the tool's
      // own execute() threw — Gmail 5xx, an expired token, a blocked egress call — and eve
      // handed that error back to the MODEL rather than rejecting this schedule's promise, so
      // the row was never recorded 'sent'. Before the fix this was reported as a success.
      const d = deps({ send: async () => ({ autonomous: true }), getOutcome: async () => "error" });
      const res = await makeFollowupTick(d.impl).tick(NOW);
      expect(d.notified).toHaveLength(0);
      expect(res).toMatchObject({ errored: 1, queued: 0 });
      expect(d.autonomousFailures).toHaveLength(1);
      expect(d.autonomousFailures[0]?.[1]).toBe("Folkepuls");
    });

    it("also treats a missing send-log row (getOutcome returns null) as a failure, not a success", async () => {
      const d = deps({ send: async () => ({ autonomous: true }), getOutcome: async () => null });
      const res = await makeFollowupTick(d.impl).tick(NOW);
      expect(d.notified).toHaveLength(0);
      expect(res.errored).toBe(1);
    });
  });

  describe("finding 3 (Important) — the final claim attempt's failure is reported loudly", () => {
    it("emits a dropped-signal when a send fails on the final allowed attempt", async () => {
      const d = deps({
        claim: async () => ({ claimed: true, attempt: 3, isFinalAttempt: true }),
        send: async () => { throw new Error("gmail 500"); },
      });
      const res = await makeFollowupTick(d.impl).tick(NOW);
      expect(res.errored).toBe(1);
      expect(d.dropped).toHaveLength(1);
      expect(d.dropped[0]).toEqual(["page-1", "Folkepuls"]);
    });

    it("does not emit a dropped-signal when a send fails on an earlier attempt", async () => {
      const d = deps({
        claim: async () => ({ claimed: true, attempt: 1, isFinalAttempt: false }),
        send: async () => { throw new Error("gmail 500"); },
      });
      const res = await makeFollowupTick(d.impl).tick(NOW);
      expect(res.errored).toBe(1);
      expect(d.dropped).toHaveLength(0);
    });
  });

  describe("LAR-28 — the hash passed to claim, the attempt passed to send, and the reclaim log", () => {
    it("claims with the hash of the row's OWN summary block, not the Summary property or anything else", async () => {
      const claimSpy = vi.fn(async () => ({ claimed: true, attempt: 1, isFinalAttempt: false }));
      const d = deps({ claim: claimSpy });
      await makeFollowupTick(d.impl).tick(NOW);
      expect(claimSpy).toHaveBeenCalledWith("page-1", hashSummaryBlock("### Handlingspunkter\n- Stefan: domener"));
    });

    it("passes claimResult.attempt through to send() — the proactivity key's #<attempt> suffix", async () => {
      const sendSpy = vi.fn(async () => {});
      const d = deps({
        claim: async () => ({ claimed: true, attempt: 2, isFinalAttempt: false }),
        send: sendSpy,
      });
      await makeFollowupTick(d.impl).tick(NOW);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy.mock.calls[0]?.[1]).toBe(2);
    });

    it("logs one line when a claim reclaims a denied/queued row after a change, and none otherwise", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const reclaimed = deps({ claim: async () => ({ claimed: true, attempt: 2, isFinalAttempt: false, reclaimedAfterChange: true }) });
        await makeFollowupTick(reclaimed.impl).tick(NOW);
        expect(logSpy.mock.calls.some((c) => String(c[0]).includes("re-claimed"))).toBe(true);

        logSpy.mockClear();
        const fresh = deps({ claim: async () => ({ claimed: true, attempt: 1, isFinalAttempt: false }) });
        await makeFollowupTick(fresh.impl).tick(NOW);
        expect(logSpy.mock.calls.some((c) => String(c[0]).includes("re-claimed"))).toBe(false);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe("LAR-35-s3 — the precheck runs before compose, not merely before send", () => {
    it("a held precheck means compose is never called, held=1, composed stays 0, and no outcome is recorded", async () => {
      const composeSpy = vi.fn(async () => ({ subject: "s", bodyText: "b" }));
      const sendSpy = vi.fn(async () => {});
      const d = deps({
        compose: composeSpy,
        send: sendSpy,
        precheck: async () => ({ held: true }),
      });
      const res = await makeFollowupTick(d.impl).tick(NOW);
      expect(res).toMatchObject({ held: 1, composed: 0, queued: 0 });
      expect(composeSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
      expect(d.outcomes).toEqual([]);
    });

    it("passes claimResult.attempt through to precheck() — the same attempt send() would get", async () => {
      const precheckSpy = vi.fn(async () => ({ held: false }));
      const d = deps({
        claim: async () => ({ claimed: true, attempt: 2, isFinalAttempt: false }),
        precheck: precheckSpy,
      });
      await makeFollowupTick(d.impl).tick(NOW);
      expect(precheckSpy).toHaveBeenCalledWith("page-1", 2);
    });

    it("an unheld precheck lets compose and send run exactly as if no precheck existed", async () => {
      const d = deps({ precheck: async () => ({ held: false }) });
      const res = await makeFollowupTick(d.impl).tick(NOW);
      expect(res).toMatchObject({ composed: 1, queued: 1, held: 0 });
    });

    it("a precheck that throws fails OPEN — composes anyway, same posture as the real gate", async () => {
      const d = deps({ precheck: async () => { throw new Error("db unreachable"); } });
      const res = await makeFollowupTick(d.impl).tick(NOW);
      expect(res).toMatchObject({ composed: 1, queued: 1, held: 0 });
    });

    it("with no precheck supplied, the tick behaves exactly as it always has", async () => {
      const d = deps(); // no `precheck` key at all
      const res = await makeFollowupTick(d.impl).tick(NOW);
      expect(res).toMatchObject({ composed: 1, queued: 1, held: 0 });
    });
  });
});

// ─── ORB-176 — the language evidence gatherer ──────────────────────────────────────────────
import { priorCorrespondenceText } from "../lib/meeting-followup.js";

describe("priorCorrespondenceText (ORB-176)", () => {
  const msg = (bodyText: string) => ({ bodyText });

  it("gathers Bendik's own prior mail to the recipients, capped", async () => {
    const gmail = {
      search: async (q: string) => (q.includes("connor@") ? ["m1", "m2"] : []),
      read: async (id: string) => msg(`english body ${id}`),
    };
    const text = await priorCorrespondenceText(gmail, ["connor@atcyrus.com", "other@x.com"], 2);
    expect(text).toContain("english body m1");
    expect(text).toContain("english body m2");
  });

  it("a gmail failure degrades to empty — the caller falls back to the note, with a warning not silence", async () => {
    const gmail = {
      search: async () => { throw new Error("invalid_grant"); },
      read: async () => null,
    };
    await expect(priorCorrespondenceText(gmail, ["a@b.com"])).resolves.toBe("");
  });

  it("no prior mail means empty, never an invented sample", async () => {
    const gmail = { search: async () => [], read: async () => null };
    await expect(priorCorrespondenceText(gmail, ["new@person.com"])).resolves.toBe("");
  });
});
