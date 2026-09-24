import { describe, it, expect } from "vitest";
import {
  makeOutreachReplyWatchTick,
  freshState,
  type OutreachReplyWatchDeps,
} from "../agent/schedules/outreach-reply-watch.js";
import type { OutreachThread } from "../lib/outreach-store.js";
import type { ThreadMessage } from "../lib/google.js";

// buildReplyTriagePrompt (the full-tool-session prompt) is retired — ORB-91 replaced it with
// the think-only classify/draft + fixed-act-prompt pipeline in lib/outreach-reply-triage.ts,
// tested in tests/outreach-reply-triage.test.ts (including the hostile-fixture containment
// tests). onReply's wiring of that pipeline is exercised below via OutreachReplyWatchDeps.
//
// isDuePoll is retired (ORB-93) — the schedule's cron config now owns the 15-minute cadence
// natively instead of firing every minute and self-filtering on a wall-clock modulo, which
// could be starved entirely by a systematic offset between actual fire times and true
// 15-minute boundaries. Nothing left in this file to unit-test; the cron string itself is the
// fix.

describe("makeOutreachReplyWatchTick", () => {
  function thread(overrides: Partial<OutreachThread> = {}): OutreachThread {
    return {
      id: "row-1", threadId: "th1", account: "x@example.com", personId: null,
      status: "awaiting_reply", sentAt: new Date("2026-08-01T10:00:00Z"),
      ...overrides,
    };
  }
  const NOW = new Date("2026-08-16T10:00:00Z");
  const reply = { from: "them@x.com", sentAt: "2026-08-15T12:00:00Z", isCalendarNotice: false } as ThreadMessage;

  it("does nothing when no threads are being tracked", async () => {
    const deps: OutreachReplyWatchDeps = {
      awaitingThreads: async () => [],
      readThread: async () => [],
      beginTriage: async () => { throw new Error("must not be called"); },
      onReply: async () => { throw new Error("must not be called"); },
      onStale: async () => { throw new Error("must not be called"); },
    };
    await expect(makeOutreachReplyWatchTick(deps).tick(NOW)).resolves.toBe(true);
  });

  it("calls onReply when a genuine reply is found and beginTriage grants the checkpoint", async () => {
    const t = thread({ sentAt: new Date("2026-08-15T10:00:00Z") });
    const replied: OutreachThread[] = [];
    const deps: OutreachReplyWatchDeps = {
      awaitingThreads: async () => [t],
      readThread: async () => [reply],
      beginTriage: async () => true,
      onReply: async (thread) => { replied.push(thread); },
      onStale: async () => { throw new Error("must not be called — a reply was found"); },
    };
    await makeOutreachReplyWatchTick(deps).tick(NOW);
    expect(replied).toEqual([t]);
  });

  // ORB-93 — the checkpoint that closes the duplicate-triage/double-send race: a restart or
  // DB hiccup between detecting a reply and markReplied used to mean the very next poll
  // re-detected the SAME reply and started an entirely independent second triage. beginTriage
  // gates that: false means another attempt is still within its retry window.
  it("skips onReply when beginTriage reports another attempt is already in flight", async () => {
    const t = thread({ sentAt: new Date("2026-08-15T10:00:00Z") });
    const deps: OutreachReplyWatchDeps = {
      awaitingThreads: async () => [t],
      readThread: async () => [reply],
      beginTriage: async () => false,
      onReply: async () => { throw new Error("must not be called — triage already in flight"); },
      onStale: async () => { throw new Error("must not be called — a reply was found"); },
    };
    await expect(makeOutreachReplyWatchTick(deps).tick(NOW)).resolves.toBe(true);
  });

  it("calls onStale once a thread has aged past 30 days with no reply", async () => {
    const t = thread({ sentAt: new Date("2026-07-01T10:00:00Z") }); // >30 days before NOW
    const stale: OutreachThread[] = [];
    const deps: OutreachReplyWatchDeps = {
      awaitingThreads: async () => [t],
      readThread: async () => [],
      beginTriage: async () => { throw new Error("must not be called — no reply"); },
      onReply: async () => { throw new Error("must not be called — no reply"); },
      onStale: async (thread) => { stale.push(thread); },
    };
    await makeOutreachReplyWatchTick(deps).tick(NOW);
    expect(stale).toEqual([t]);
  });

  it("neither fires when a thread is recent with no reply yet", async () => {
    const t = thread({ sentAt: new Date("2026-08-15T10:00:00Z") });
    const deps: OutreachReplyWatchDeps = {
      awaitingThreads: async () => [t],
      readThread: async () => [],
      beginTriage: async () => { throw new Error("must not be called"); },
      onReply: async () => { throw new Error("must not be called"); },
      onStale: async () => { throw new Error("must not be called — not stale yet"); },
    };
    await expect(makeOutreachReplyWatchTick(deps).tick(NOW)).resolves.toBe(true);
  });

  it("a per-thread failure does not block checking the rest of the batch", async () => {
    const good = thread({ threadId: "th-good", sentAt: new Date("2026-08-15T10:00:00Z") });
    const bad = thread({ threadId: "th-bad", sentAt: new Date("2026-08-15T10:00:00Z") });
    const replied: OutreachThread[] = [];
    const deps: OutreachReplyWatchDeps = {
      awaitingThreads: async () => [bad, good],
      readThread: async (_account, threadId) => {
        if (threadId === "th-bad") throw new Error("Gmail API error");
        return [reply];
      },
      beginTriage: async () => true,
      onReply: async (t) => { replied.push(t); },
      onStale: async () => {},
    };
    await makeOutreachReplyWatchTick(deps).tick(NOW);
    expect(replied).toEqual([good]);
  });

  it("single-flight: a second tick while one is running is a no-op", async () => {
    let resolveFirst: () => void = () => {};
    const gate = new Promise<void>((r) => { resolveFirst = r; });
    let calls = 0;
    const deps: OutreachReplyWatchDeps = {
      awaitingThreads: async () => { calls += 1; await gate; return []; },
      readThread: async () => [],
      beginTriage: async () => true,
      onReply: async () => {},
      onStale: async () => {},
    };
    const state = freshState();
    const tick = makeOutreachReplyWatchTick(deps, state);
    const first = tick.tick(NOW);
    const second = await tick.tick(NOW); // fires while `first` is still in-flight
    expect(second).toBe(false); // overlap guard — not this tick's own completed pass
    resolveFirst();
    await first;
    expect(calls).toBe(1);
  });

  it("a tick-level failure (awaitingThreads throws) does not throw out of tick(), and resolves false — ORB-175 fix round 1: the caller must not stamp the heartbeat", async () => {
    const deps: OutreachReplyWatchDeps = {
      awaitingThreads: async () => { throw new Error("Postgres is down"); },
      readThread: async () => [],
      beginTriage: async () => true,
      onReply: async () => {},
      onStale: async () => {},
    };
    await expect(makeOutreachReplyWatchTick(deps).tick(NOW)).resolves.toBe(false);
  });
});
