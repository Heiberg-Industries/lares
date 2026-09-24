import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeEmailTriageTick, freshState, renderDossierForDraft, draftDossierLookup, type EmailTriageDeps } from "../agent/schedules/email-triage.js";
import type { TriageResult } from "../lib/email-triage.js";
import type { MailMessage, ThreadMessage } from "../lib/google.js";
import type { TriageOutcome, ClaimResult } from "../lib/email-triage-store.js";
import type { PersonDossier, PersonSources } from "../lib/person/gather.js";

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "m1", threadId: "t1", from: "a@b.com", to: ["x@y.com"], subject: "s", bodyText: "b",
    sentAt: "2026-08-16", messageId: "<m1@b.com>", references: "", isCalendarNotice: false,
    ...overrides,
  };
}

function claimed(attempt = 1): ClaimResult { return { claimed: true, attempt, isFinalAttempt: false }; }
function claimedFinal(attempt: number): ClaimResult { return { claimed: true, attempt, isFinalAttempt: true }; }
function notClaimed(): ClaimResult { return { claimed: false, attempt: 0, isFinalAttempt: false }; }

function harness(overrides: Partial<EmailTriageDeps> = {}) {
  const claims: Array<[string, string]> = [];
  const outcomes: Array<{ mailbox: string; id: string; outcome: TriageOutcome }> = [];
  const notified: string[] = [];
  const dropped: Array<{ mailbox: string; id: string }> = [];
  let pruned = false;
  const deps: EmailTriageDeps = {
    mailboxes: async () => ["owner@project.example"],
    searchCandidates: async () => ["m1"],
    readMessage: async () => message(),
    readThread: async (): Promise<ThreadMessage[]> => [],
    claim: async (mailbox, id) => { claims.push([mailbox, id]); return claimed(); },
    triage: async (): Promise<TriageResult> => ({ outcome: "fyi", from: "a@b.com", subject: "s" }),
    recordOutcome: async (mailbox, id, outcome) => { outcomes.push({ mailbox, id, outcome }); },
    notify: async (text) => { notified.push(text); },
    reportDropped: async (mailbox, id) => { dropped.push({ mailbox, id }); },
    prune: async () => { pruned = true; },
    ...overrides,
  };
  return { deps, claims, outcomes, notified, dropped, prunedRef: () => pruned };
}

describe("makeEmailTriageTick", () => {
  it("skips a message already claimed (exactly-once)", async () => {
    const { deps, outcomes } = harness({ claim: async () => notClaimed() });
    await makeEmailTriageTick(deps).tick();
    expect(outcomes).toHaveLength(0);
  });

  it("claims, triages, records the outcome, and prunes on a normal pass", async () => {
    const { deps, claims, outcomes, prunedRef } = harness();
    await makeEmailTriageTick(deps).tick();
    expect(claims).toEqual([["owner@project.example", "m1"]]);
    expect(outcomes).toEqual([{ mailbox: "owner@project.example", id: "m1", outcome: "fyi" }]);
    expect(prunedRef()).toBe(true);
  });

  // ORB-175 fix round 1 — the heartbeat schedule stamps only when tick() resolves true.
  it("resolves true on a completed pass, even with zero candidates", async () => {
    const { deps } = harness({ searchCandidates: async () => [] });
    await expect(makeEmailTriageTick(deps).tick()).resolves.toBe(true);
  });

  it("resolves true even when a per-item failure is caught inside the loop", async () => {
    const { deps, dropped } = harness({ readMessage: async () => { throw new Error("gmail 500"); } });
    await expect(makeEmailTriageTick(deps).tick()).resolves.toBe(true);
    expect(dropped).toHaveLength(0); // not the final attempt — the per-item catch swallows it
  });

  it("maps 'draft-pending' to the stored outcome 'drafted'", async () => {
    const { deps, outcomes } = harness({
      triage: async (): Promise<TriageResult> => ({ outcome: "draft-pending", from: "a@b.com", subject: "s", account: "owner@project.example" }),
    });
    await makeEmailTriageTick(deps).tick();
    expect(outcomes).toEqual([{ mailbox: "owner@project.example", id: "m1", outcome: "drafted" }]);
  });

  it("pings Slack only for drafted/draft-pending outcomes, not fyi/automated", async () => {
    const { deps: fyiDeps, notified: fyiNotified } = harness();
    await makeEmailTriageTick(fyiDeps).tick();
    expect(fyiNotified).toHaveLength(0);

    const { deps: draftDeps, notified: draftNotified } = harness({
      triage: async (): Promise<TriageResult> => ({ outcome: "drafted", from: "a@b.com", subject: "s", account: "owner@project.example" }),
    });
    await makeEmailTriageTick(draftDeps).tick();
    expect(draftNotified).toHaveLength(1);
    expect(draftNotified[0]).toContain("Drafted a reply");
  });

  it("a null message (deleted between search and read), not the final attempt: leaves the seeded 'error', no report", async () => {
    const { deps, outcomes, dropped } = harness({ readMessage: async () => null });
    await makeEmailTriageTick(deps).tick();
    expect(outcomes).toHaveLength(0); // recordOutcome is never called — claimMessage already seeded 'error'
    expect(dropped).toHaveLength(0);
  });

  it("a null message on the FINAL attempt reports it loudly", async () => {
    const { deps, dropped } = harness({ readMessage: async () => null, claim: async () => claimedFinal(3) });
    await makeEmailTriageTick(deps).tick();
    expect(dropped).toEqual([{ mailbox: "owner@project.example", id: "m1" }]);
  });

  // ORB-92 — a candidate whose thread Bendik already answered manually (e.g. while this
  // schedule was down) must be skipped before any billed triage call, recorded as 'fyi'
  // (handled, not an error), and never notified about.
  it("skips a thread Bendik already replied to manually — no billed call, no notify", async () => {
    const triageCalls: string[] = [];
    const { deps, outcomes, notified } = harness({
      readMessage: async () => message({ sentAt: "2026-08-16T09:00:00Z" }),
      readThread: async (): Promise<ThreadMessage[]> => [
        { ...message({ sentAt: "2026-08-16T10:00:00Z" }), from: "owner@project.example", headers: {} },
      ],
      triage: async () => { triageCalls.push("called"); return { outcome: "fyi", from: "a@b.com", subject: "s" }; },
    });
    await makeEmailTriageTick(deps).tick();
    expect(triageCalls).toHaveLength(0);
    expect(outcomes).toEqual([{ mailbox: "owner@project.example", id: "m1", outcome: "fyi" }]);
    expect(notified).toHaveLength(0);
  });

  it("does NOT skip when the thread's only other messages are from the counterpart, not Bendik", async () => {
    const triageCalls: string[] = [];
    const { deps } = harness({
      readMessage: async () => message({ sentAt: "2026-08-16T09:00:00Z" }),
      readThread: async (): Promise<ThreadMessage[]> => [
        { ...message({ sentAt: "2026-08-16T08:00:00Z" }), from: "a@b.com", headers: {} },
      ],
      triage: async () => { triageCalls.push("called"); return { outcome: "fyi", from: "a@b.com", subject: "s" }; },
    });
    await makeEmailTriageTick(deps).tick();
    expect(triageCalls).toHaveLength(1);
  });

  // ORB-147 Task 4 — the tick already fetches the thread (for hasHumanReplyAfter); it must
  // pass that SAME array down to triage() rather than discarding it, and must not fetch it
  // a second time.
  it("passes the already-fetched thread through to triage, and calls readThread exactly once for that message", async () => {
    let readThreadCalls = 0;
    const theThread: ThreadMessage[] = [
      { ...message({ sentAt: "2026-08-16T08:00:00Z" }), from: "a@b.com", headers: {} },
    ];
    let receivedThread: ThreadMessage[] | undefined;
    const { deps } = harness({
      readMessage: async () => message({ sentAt: "2026-08-16T09:00:00Z" }),
      readThread: async (): Promise<ThreadMessage[]> => { readThreadCalls++; return theThread; },
      triage: async (_mailbox, _msg, thread) => { receivedThread = thread; return { outcome: "fyi", from: "a@b.com", subject: "s" }; },
    });
    await makeEmailTriageTick(deps).tick();
    expect(readThreadCalls).toBe(1);
    expect(receivedThread).toBe(theThread);
  });

  // ORB-92 — first-tick/post-outage backfill safety: a burst of candidates must not each
  // fire a billed triage call unboundedly.
  it("caps billed triage calls per tick and leaves the rest unclaimed for next tick", async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `m${i}`);
    const triaged: string[] = [];
    const claimedIds: string[] = [];
    let readThreadCalls = 0;
    const deps: EmailTriageDeps = {
      mailboxes: async () => ["owner@project.example"],
      searchCandidates: async () => ids,
      readMessage: async (_mailbox, id) => message({ id, threadId: id }),
      readThread: async (): Promise<ThreadMessage[]> => { readThreadCalls++; return []; },
      claim: async (_mailbox, id) => { claimedIds.push(id); return claimed(); },
      triage: async (_mailbox, msg) => { triaged.push(msg.id); return { outcome: "fyi", from: "a@b.com", subject: "s" }; },
      recordOutcome: async () => {},
      notify: async () => {},
      reportDropped: async () => {},
      prune: async () => {},
    };
    await makeEmailTriageTick(deps).tick();
    expect(triaged).toHaveLength(10); // TRIAGE_CEILING_PER_TICK
    expect(claimedIds).toHaveLength(10); // the rest were never even claimed — free to retry next tick
    // ORB-147 Task 4 review (Minor 2): "exactly once per message" is only earned across MORE
    // than one message — one readThread call for each of the 10 messages that actually got
    // processed, never a second call for any of them, and never a call for the 5 left unclaimed.
    expect(readThreadCalls).toBe(10);
  });

  it("a triage failure for one message does not block the rest of the batch, and leaves the seeded 'error' outcome in place — cost-safety", async () => {
    const outcomes: Array<{ mailbox: string; id: string; outcome: TriageOutcome }> = [];
    const claimedIds: string[] = [];
    const deps: EmailTriageDeps = {
      mailboxes: async () => ["owner@project.example"],
      searchCandidates: async () => ["bad", "good"],
      readMessage: async (_mailbox, id) => message({ id }),
      readThread: async (): Promise<ThreadMessage[]> => [],
      claim: async (_mailbox, id) => { claimedIds.push(id); return claimed(); },
      triage: async (_mailbox, msg) => {
        if (msg.id === "bad") throw new Error("gateway down");
        return { outcome: "fyi", from: "a@b.com", subject: "s" };
      },
      // recordOutcome is only called for messages that DON'T throw during triage — the
      // schedule never gets to call it for "bad", leaving claim()'s seeded 'error' standing.
      recordOutcome: async (mailbox, id, outcome) => { outcomes.push({ mailbox, id, outcome }); },
      notify: async () => {},
      reportDropped: async () => {},
      prune: async () => {},
    };
    await makeEmailTriageTick(deps).tick();
    expect(claimedIds).toEqual(["bad", "good"]); // both claimed — "bad" is now permanently spent
    expect(outcomes).toEqual([{ mailbox: "owner@project.example", id: "good", outcome: "fyi" }]); // only "good" got a real outcome recorded
  });

  it("a triage failure on the FINAL attempt reports it loudly instead of only logging", async () => {
    const dropped: Array<{ mailbox: string; id: string }> = [];
    const deps: EmailTriageDeps = {
      mailboxes: async () => ["owner@project.example"],
      searchCandidates: async () => ["m1"],
      readMessage: async () => message(),
      readThread: async (): Promise<ThreadMessage[]> => [],
      claim: async () => claimedFinal(3),
      triage: async () => { throw new Error("gateway down, for the third time"); },
      recordOutcome: async () => {},
      notify: async () => {},
      reportDropped: async (mailbox, id) => { dropped.push({ mailbox, id }); },
      prune: async () => {},
    };
    await makeEmailTriageTick(deps).tick();
    expect(dropped).toEqual([{ mailbox: "owner@project.example", id: "m1" }]);
  });

  it("a mailbox-scan failure does not block the other mailboxes", async () => {
    const outcomes: Array<{ mailbox: string; id: string; outcome: TriageOutcome }> = [];
    const deps: EmailTriageDeps = {
      mailboxes: async () => ["broken@x.com", "owner@project.example"],
      searchCandidates: async (mailbox) => { if (mailbox === "broken@x.com") throw new Error("Gmail down"); return ["m1"]; },
      readMessage: async () => message(),
      readThread: async (): Promise<ThreadMessage[]> => [],
      claim: async () => claimed(),
      triage: async (): Promise<TriageResult> => ({ outcome: "fyi", from: "a@b.com", subject: "s" }),
      recordOutcome: async (mailbox, id, outcome) => { outcomes.push({ mailbox, id, outcome }); },
      notify: async () => {},
      reportDropped: async () => {},
      prune: async () => {},
    };
    await makeEmailTriageTick(deps).tick();
    expect(outcomes).toEqual([{ mailbox: "owner@project.example", id: "m1", outcome: "fyi" }]);
  });

  it("single-flight: a second tick while one is running is a no-op", async () => {
    let resolveFirst: () => void = () => {};
    const gate = new Promise<void>((r) => { resolveFirst = r; });
    let calls = 0;
    const deps: EmailTriageDeps = {
      mailboxes: async () => { calls += 1; await gate; return []; },
      searchCandidates: async () => [],
      readMessage: async () => null,
      readThread: async (): Promise<ThreadMessage[]> => [],
      claim: async () => claimed(),
      triage: async (): Promise<TriageResult> => ({ outcome: "fyi", from: "a", subject: "s" }),
      recordOutcome: async () => {},
      notify: async () => {},
      reportDropped: async () => {},
      prune: async () => {},
    };
    const state = freshState();
    const tick = makeEmailTriageTick(deps, state);
    const first = tick.tick();
    const second = await tick.tick();
    expect(second).toBe(false); // overlap guard — not this tick's own completed pass
    resolveFirst();
    await first;
    expect(calls).toBe(1);
  });

  // ORB-175 fix round 1 (controller ruling) — a tick whose OUTER catch swallowed the whole pass
  // is a FAILED pass and must not stamp the heartbeat; only a per-item failure inside the loop
  // still counts as completed (see the "per-item failure" case above).
  it("a tick-level failure (mailboxes() throws) does not throw out of tick(), and resolves false", async () => {
    const deps: EmailTriageDeps = {
      mailboxes: async () => { throw new Error("Postgres is down"); },
      searchCandidates: async () => [],
      readMessage: async () => null,
      readThread: async (): Promise<ThreadMessage[]> => [],
      claim: async () => claimed(),
      triage: async (): Promise<TriageResult> => ({ outcome: "fyi", from: "a", subject: "s" }),
      recordOutcome: async () => {},
      notify: async () => {},
      reportDropped: async () => {},
      prune: async () => {},
    };
    await expect(makeEmailTriageTick(deps).tick()).resolves.toBe(false);
  });
});

// ORB-147 Task 4 review (Important finding) — renderDossier's `ambiguous`/`unknown` branches
// are second-person instructions written for Saga-the-conversationalist ("ask him which one",
// "you have no search tool, only read_url.fetch"), not facts about the counterpart. Feeding
// them verbatim into a reply-drafting prompt risks a draft that leaks tool names or CRM
// references to an external third party. Only a RESOLVED dossier may reach the drafter.
describe("renderDossierForDraft", () => {
  const blank = {
    fresh: { mail: [], meetings: [], transcripts: [] },
    history: { mail: [], meetings: [], transcripts: [] },
    owed: [],
  };
  const emptySources = {
    crm: { status: "empty" as const, source: "crm" },
    pulse: { status: "empty" as const, source: "pulse" },
    mail: { status: "empty" as const, source: "mail" },
    meetings: { status: "empty" as const, source: "meetings" },
    transcripts: { status: "empty" as const, source: "transcripts" },
    company: { status: "empty" as const, source: "company" },
    // ORB-166 — the organisation stage. Empty here on purpose: this suite is about which dossier
    // SHAPES may reach the drafter, and a populated org block would change what it asserts.
    organisation: { status: "empty" as const, source: "organisation" },
    identity: { status: "found" as const, source: "identity", data: ["owner@project.example"] },
  };

  /**
   * ORB-166 fix round 1, Finding 3 — the leak this suite exists to prevent, arriving through the
   * new stage. A RESOLVED dossier DOES reach the drafter, and the organisation block carries
   * internal vault paths, a CRM org number and an instruction to go and read them, into a prompt
   * that writes a reply to an external counterparty. `bounded` drops it; this is the guard that
   * says so on the drafter's own function rather than on the renderer.
   */
  it("a populated Organisation block NEVER reaches the outbound drafter", () => {
    const person = { source: "twenty", sourceId: "1", displayName: "Lars Eriksen", emails: ["lars@partner.example"] };
    const d: PersonDossier = {
      query: { email: "lars@partner.example" },
      resolution: { kind: "resolved", person, alsoSeenIn: [], setAside: [] },
      anchor: null,
      ...blank,
      sources: {
        ...emptySources,
        organisation: {
          status: "found" as const, source: "organisation",
          data: {
            asked: { name: "Nomono", domain: "partner.example" },
            notes: [
              { store: "brain" as const, path: "companies/nomono.md" },
              { store: "atlas" as const, path: "ventures/orakel/nomono-pilot.md" },
            ],
            crm: { name: "Nomono AS", domain: "partner.example", orgNumber: "999" },
          },
        },
      },
    };
    const out = renderDossierForDraft(d);
    expect(out).not.toBeNull();
    expect(out).toContain("PERSON LOOKUP: Lars Eriksen");
    expect(out).not.toContain("ORGANISATION — ");
    expect(out).not.toContain("companies/nomono.md");
    expect(out).not.toContain("ventures/orakel/nomono-pilot.md");
    expect(out).not.toContain("org no 999");
    expect(out).not.toContain("These are NOTES, not findings");
    // The audit line still survives — it names no path and hides no outage.
    expect(out).toContain("- organisation: read OK");
  });

  it("returns null for an UNKNOWN dossier — no ## Person section reaches the drafter", () => {
    const d: PersonDossier = {
      query: { email: "cold@stranger.com" },
      resolution: { kind: "unknown" },
      anchor: null,
      ...blank,
      sources: emptySources,
    };
    expect(renderDossierForDraft(d)).toBeNull();
  });

  it("returns null for an AMBIGUOUS dossier", () => {
    const candidate = { source: "twenty", sourceId: "1", displayName: "Lars Eriksen", emails: ["lars@a.com"] };
    const d: PersonDossier = {
      query: { name: "Lars" },
      resolution: { kind: "ambiguous", candidates: [candidate], question: "Which Lars?" },
      anchor: null,
      ...blank,
      sources: emptySources,
    };
    expect(renderDossierForDraft(d)).toBeNull();
  });

  it("returns the rendered dossier text for a RESOLVED dossier", () => {
    const person = { source: "twenty", sourceId: "1", displayName: "Lars Eriksen", emails: ["lars@a.com"] };
    const d: PersonDossier = {
      query: { email: "lars@a.com" },
      resolution: { kind: "resolved", person, alsoSeenIn: [], setAside: [] },
      anchor: null,
      ...blank,
      sources: emptySources,
    };
    const out = renderDossierForDraft(d);
    expect(out).not.toBeNull();
    expect(out).toContain("PERSON LOOKUP: Lars Eriksen");
    // The instructional "Ask him"/"read_url.fetch" language only ever appears on the
    // unresolved branches — a resolved render never carries it, but pin it here too so a
    // future change to render.ts's resolved branch can't silently reintroduce it.
    expect(out).not.toContain("read_url.fetch");
    expect(out).not.toContain("Ask him");
  });

  // ORB-147 fix wave, Finding 3: a failed source collapsing into "unknown" (indistinguishable
  // from a genuinely never-seen sender) must still be logged — the function's RETURN VALUE
  // stays null either way (this never blocks the draft), but the outage must leave a trace.
  describe("logging a non-resolved dossier (Finding 3)", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { errorSpy = vi.spyOn(console, "error").mockImplementation(() => {}); });
    afterEach(() => { errorSpy.mockRestore(); });

    it("logs and names the failed source when a CRM read actually failed, still returns null", () => {
      const d: PersonDossier = {
        query: { email: "cold@stranger.com" },
        resolution: { kind: "unknown" },
        anchor: null,
        ...blank,
        sources: {
          ...emptySources,
          crm: { status: "failed" as const, source: "crm", reason: "Twenty 401" },
        },
      };
      const out = renderDossierForDraft(d);
      expect(out).toBeNull();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = errorSpy.mock.calls[0]!.join(" ");
      expect(logged).toContain("unknown");
      expect(logged).toContain("crm (Twenty 401)");
    });

    it("logs (with no failed source named) for a genuinely unknown/ambiguous sender, still returns null", () => {
      const d: PersonDossier = {
        query: { email: "cold@stranger.com" },
        resolution: { kind: "unknown" },
        anchor: null,
        ...blank,
        sources: emptySources,
      };
      const out = renderDossierForDraft(d);
      expect(out).toBeNull();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = errorSpy.mock.calls[0]!.join(" ");
      expect(logged).toContain("unknown");
      expect(logged).not.toContain("failed source");
    });
  });
});

/**
 * ORB-166 review fix, Finding 2 — the TRIAGE PATH specifically. `renderDossierForDraft` renders
 * `bounded`, which drops the ORGANISATION section from every draft, so gathering it was pure
 * cost: up to six synchronous full-note-store walks plus a Twenty call, per inbound message, per
 * tick, on the same event loop that serves Telegram webhooks and the morning Slack scan.
 *
 * This asserts the wiring the schedule actually uses, not the option in isolation: `dossierFor`
 * in `run()` returns exactly this function, so a future edit that drops the option fails here.
 */
describe("draftDossierLookup — the drafter never asks the organisation sources", () => {
  function sourcesWithSpy() {
    const calls: string[] = [];
    const sources = {
      myAddresses: async () => ["owner@project.example"],
      crm: async () => [{ source: "twenty", sourceId: "p1", displayName: "Lars Eriksen", emails: ["lars@partner.example"] }],
      pulse: async () => [],
      mail: async () => [],
      meetings: async () => [],
      transcripts: async () => [],
      company: async () => null,
      organisation: async () => { calls.push("organisation"); return null; },
    } as unknown as PersonSources;
    return { calls, sources };
  }

  it("resolves a dossier for the draft without calling the organisation source once", async () => {
    const { calls, sources } = sourcesWithSpy();
    const out = await draftDossierLookup(sources)("lars@partner.example");

    expect(calls).toEqual([]);
    // Still a real, usable dossier — the skip removes I/O, not the drafter's context.
    expect(out).toContain("PERSON");
    expect(out).not.toContain("ORGANISATION — ");
  });

  it("reports the source as NOT CONSULTED, so a skipped stage never reads as a quiet one", async () => {
    const { sources } = sourcesWithSpy();
    const out = await draftDossierLookup(sources)("lars@partner.example");

    expect(out).toContain("- organisation: not searchable this way (not consulted");
    expect(out).not.toContain("- organisation: nothing found");
  });
});
