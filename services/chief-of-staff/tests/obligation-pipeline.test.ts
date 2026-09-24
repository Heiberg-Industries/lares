import { describe, it, expect, vi } from "vitest";

import type { ThreadMessage } from "../lib/google.js";
import { INTENT_MAX_PER_PASS, intentReason } from "../lib/obligation-intent.js";
import { RESOLUTION_LOOKUP_TIMEOUT_MS, type Resolution } from "../lib/obligation-resolution.js";
import { withTimeout } from "../lib/timeout.js";
import { assignSurfaces, type Obligation, type ThreadSnapshot } from "../lib/brief-content.js";
import {
  dropResolved,
  gatherOpenObligations,
  INTENT_UNREAD_REASON,
  RESOLUTION_PASS_TIMEOUT_MS,
  RESOLUTION_UNVERIFIED_REASON,
  type GatherObligationsDeps,
} from "../lib/obligation-pipeline.js";

/**
 * ORB-209 — the obligation pipeline's own suite, moved VERBATIM out of
 * `tests/brief-content.test.ts` alongside the code it covers (`lib/obligation-pipeline.ts`).
 * Not one assertion was added, removed or reworded in the move; the fixtures below
 * (`threadMessage`, `NOW`) are copies of that file's, which still needs its own.
 */

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────

function threadMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "m-1",
    threadId: "t-1",
    from: "Lars Eriksen <lars@partner.example>",
    to: ["Bendik <owner@owner.example>"],
    subject: "Re: pilot terms",
    bodyText: "body",
    sentAt: "2026-08-10T09:00:00Z",
    messageId: "<m1@partner.example>",
    references: "",
    isCalendarNotice: false,
    headers: {},
    ...overrides,
  };
}

const NOW = new Date("2026-08-12T20:00:00Z"); // 22:00 CEST — an evening pass moment

// ─── gatherOpenObligations (ported from adapters/obligations/gather.ts, minus rank.ts) ─────

describe("gatherOpenObligations", () => {
  it("throws when the identity registry has no addresses — never degrades to []", async () => {
    const deps: GatherObligationsDeps = {
      myAddresses: async () => [],
      gmail: { searchThreadIds: async () => [], readThread: async () => [] },
      dismissed: async () => new Set(),
      upsertSeen: async () => {},
    };
    await expect(gatherOpenObligations(deps, NOW)).rejects.toThrow(/identity registry/);
  });

  it("applies dismissals before selection — a dismissed thread never comes back", async () => {
    const deps: GatherObligationsDeps = {
      myAddresses: async () => ["owner@owner.example"],
      gmail: {
        searchThreadIds: async () => ["t-1"],
        readThread: async () => [threadMessage({ sentAt: "2026-08-01T09:00:00Z" })],
      },
      dismissed: async () => new Set(["t-1"]),
      upsertSeen: async () => {},
    };
    const out = await gatherOpenObligations(deps, NOW);
    expect(out).toEqual([]);
  });

  it("upserts every surfaced candidate exactly once", async () => {
    const seen: string[] = [];
    const deps: GatherObligationsDeps = {
      myAddresses: async () => ["owner@owner.example"],
      gmail: {
        searchThreadIds: async () => ["t-1"],
        readThread: async () => [threadMessage({ sentAt: "2026-08-01T09:00:00Z" })],
      },
      dismissed: async () => new Set(),
      upsertSeen: async (o) => { seen.push(o.threadId); },
    };
    const out = await gatherOpenObligations(deps, NOW);
    expect(out).toHaveLength(1);
    expect(seen).toEqual(["t-1"]);
  });

  // ─── ORB-149: Slack snapshots merge into the Gmail scan before selectObligations ─────────

  function slackSnapshot(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
    return {
      threadId: "slack:im:D1:100.000000",
      subject: "Slack DM",
      counterpartyName: "Nora",
      counterpartyAddress: "slack:U-nora",
      lastMessageAt: new Date(NOW.getTime() - 60 * 3_600_000), // 60h old — clears OWED_AFTER_HOURS
      lastSpeakerIsThem: true,
      addressedToHim: true,
      isAutomated: false,
      theirUnansweredCount: 1,
      source: "slack",
      ...overrides,
    };
  }

  it("merges a Slack snapshot into the Gmail scan — both surface in the returned obligations", async () => {
    const deps: GatherObligationsDeps = {
      myAddresses: async () => ["owner@owner.example"],
      gmail: {
        searchThreadIds: async () => ["t-1"],
        readThread: async () => [threadMessage({ sentAt: "2026-08-01T09:00:00Z" })],
      },
      dismissed: async () => new Set(),
      upsertSeen: async () => {},
      slack: async () => [slackSnapshot()],
    };
    const out = await gatherOpenObligations(deps, NOW);
    expect(out.map((o) => o.threadId).sort()).toEqual(["slack:im:D1:100.000000", "t-1"].sort());
  });

  it("a dismissed Slack thread id is excluded — dismissals apply to Slack too", async () => {
    const deps: GatherObligationsDeps = {
      myAddresses: async () => ["owner@owner.example"],
      gmail: { searchThreadIds: async () => [], readThread: async () => [] },
      dismissed: async () => new Set(["slack:im:D1:100.000000"]),
      upsertSeen: async () => {},
      slack: async () => [slackSnapshot()],
    };
    const out = await gatherOpenObligations(deps, NOW);
    expect(out).toEqual([]);
  });

  it("a throwing Slack source still returns the Gmail obligations, and logs", async () => {
    const errors: unknown[] = [];
    const spy = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const deps: GatherObligationsDeps = {
        myAddresses: async () => ["owner@owner.example"],
        gmail: {
          searchThreadIds: async () => ["t-1"],
          readThread: async () => [threadMessage({ sentAt: "2026-08-01T09:00:00Z" })],
        },
        dismissed: async () => new Set(),
        upsertSeen: async () => {},
        slack: async () => { throw new Error("slack rate limited"); },
      };
      const out = await gatherOpenObligations(deps, NOW);
      expect(out.map((o) => o.threadId)).toEqual(["t-1"]);
      expect(errors.length).toBeGreaterThan(0);
      expect(String(errors[0])).toMatch(/Slack scan failed/);
    } finally {
      console.error = spy;
    }
  });

  it("a Slack source that NEVER RESOLVES still yields the Gmail obligations — review round 2 CRITICAL: a slow scan must not ride the caller's shared timeout to 'no brief at all'", async () => {
    // Mirrors the exact shape morning-brief.ts's buildSlackObligationSource now uses: the
    // underlying scan is wrapped in ITS OWN sub-timeout (withTimeout), so a hung/slow scan
    // rejects on its own clock and lands in gatherOpenObligations' best-effort catch — instead
    // of hanging (or riding a SHARED, caller-side timeout that discards the Gmail results
    // already collected, the bug review round 2 caught).
    const errors: unknown[] = [];
    const spy = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const neverResolves = new Promise<ThreadSnapshot[]>(() => {});
      const deps: GatherObligationsDeps = {
        myAddresses: async () => ["owner@owner.example"],
        gmail: {
          searchThreadIds: async () => ["t-1"],
          readThread: async () => [threadMessage({ sentAt: "2026-08-01T09:00:00Z" })],
        },
        dismissed: async () => new Set(),
        upsertSeen: async () => {},
        slack: () => withTimeout(neverResolves, 30, "test: slack sub-timeout"),
      };
      const start = Date.now();
      const out = await gatherOpenObligations(deps, NOW);
      expect(Date.now() - start).toBeLessThan(1000); // bounded by the 30ms sub-timeout, not a hang
      expect(out.map((o) => o.threadId)).toEqual(["t-1"]);
      expect(errors.length).toBeGreaterThan(0);
      expect(String(errors[0])).toMatch(/Slack scan failed/);
    } finally {
      console.error = spy;
    }
  });

  it("no Slack source at all (evening-brief/reping shape) — still returns Gmail obligations, unchanged", async () => {
    const deps: GatherObligationsDeps = {
      myAddresses: async () => ["owner@owner.example"],
      gmail: {
        searchThreadIds: async () => ["t-1"],
        readThread: async () => [threadMessage({ sentAt: "2026-08-01T09:00:00Z" })],
      },
      dismissed: async () => new Set(),
      upsertSeen: async () => {},
    };
    const out = await gatherOpenObligations(deps, NOW);
    expect(out.map((o) => o.threadId)).toEqual(["t-1"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ORB-45 Task 10 (B5) — the resolve → read → explain stage inside gatherOpenObligations.
//
// Every case here is a FAIL-OPEN case in disguise: the thing being pinned is that a lookup
// that fails, a model that throws, a budget that blows, or a dep that is simply absent all
// leave the obligation ON the radar with a reason that says so — never silently gone. The
// radar going quiet because a dependency broke is the only outcome this stage may not have.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("gatherOpenObligations — resolve, read, explain (ORB-45 Task 10, B5)", () => {
  /** `count` Gmail threads, oldest first: t-0 is the most overdue. */
  function gatherDeps(count: number, extra: Partial<GatherObligationsDeps> = {}): GatherObligationsDeps {
    const ids = Array.from({ length: count }, (_, i) => `t-${i}`);
    return {
      myAddresses: async () => ["owner@owner.example"],
      gmail: {
        searchThreadIds: async () => ids,
        readThread: async (threadId) => {
          const i = Number(threadId.slice(2));
          return [threadMessage({
            threadId,
            // t-0 oldest; each later thread is an hour younger. All clear OWED_AFTER_HOURS.
            sentAt: new Date(Date.parse("2026-08-01T00:00:00Z") + i * 3_600_000).toISOString(),
            bodyText: "so what do you think?",
          })];
        },
      },
      dismissed: async () => new Set(),
      upsertSeen: async () => {},
      ...extra,
    };
  }

  const hit = (via: Resolution["via"] = "gmail"): Resolution => ({
    via,
    at: new Date("2026-08-11T09:00:00Z"),
    evidence: "you emailed them 2026-08-11 11:00",
    consulted: ["gmail", "calendar", "slack", "network"],
    unreadable: [],
  });

  function silenced<T>(fn: () => Promise<T>): Promise<T> {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    return fn().finally(() => { console.log = log; console.error = err; });
  }

  // ─── (a) the resolved() map is compared against the last message, never applied blindly ───

  it("(a) keeps an item whose recorded resolution is OLDER than their last message — they wrote again since", async () => {
    const deps = gatherDeps(1, {
      // t-0's last message is 2026-08-01T00:00Z; this resolution predates it.
      resolved: async () => new Map([["t-0", new Date("2026-07-30T09:00:00Z")]]),
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(out.map((o) => o.threadId)).toEqual(["t-0"]);
  });

  it("(a) drops an item whose recorded resolution is NEWER than their last message", async () => {
    const deps = gatherDeps(1, {
      resolved: async () => new Map([["t-0", new Date("2026-08-02T09:00:00Z")]]),
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(out).toEqual([]);
  });

  // ─── (b) a live resolution hit drops the item and is recorded ─────────────────────────────

  it("(b) a resolution hit drops the item, records it, and logs what cleared it", async () => {
    const marked: Array<{ threadId: string; via: string }> = [];
    const logs: string[] = [];
    const spy = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    try {
      const deps = gatherDeps(1, {
        resolve: async () => ({ resolution: hit("calendar"), unreadable: [] }),
        markResolved: async (o, r) => { marked.push({ threadId: o.threadId, via: r.via }); },
      });
      const out = await gatherOpenObligations(deps, NOW);
      expect(out).toEqual([]);
      expect(marked).toEqual([{ threadId: "t-0", via: "calendar" }]);
      expect(logs.join("\n")).toContain("obligations: resolved elsewhere t-0 via calendar — you emailed them");
    } finally {
      console.log = spy;
    }
  });

  it("(b) upsertSeen runs BEFORE markResolved — markResolved is UPDATE-only and needs the row", async () => {
    const order: string[] = [];
    const deps = gatherDeps(1, {
      upsertSeen: async (o) => { order.push(`upsert:${o.threadId}`); },
      resolve: async () => ({ resolution: hit(), unreadable: [] }),
      markResolved: async (o) => { order.push(`markResolved:${o.threadId}`); },
    });
    await silenced(() => gatherOpenObligations(deps, NOW));
    expect(order).toEqual(["upsert:t-0", "markResolved:t-0"]);
  });

  it("(b) a throwing markResolved still drops the item — the answer elsewhere is a fact, the write is not", async () => {
    const deps = gatherDeps(1, {
      resolve: async () => ({ resolution: hit(), unreadable: [] }),
      markResolved: async () => { throw new Error("db down"); },
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(out).toEqual([]);
  });

  // ─── (c) intent decides whether a survivor is really owed, and says why ───────────────────

  it("(c) intent closes_loop drops the item and logs it", async () => {
    const logs: string[] = [];
    const spy = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    try {
      const deps = gatherDeps(1, { classifyIntent: async () => "closes_loop" });
      const out = await gatherOpenObligations(deps, NOW);
      expect(out).toEqual([]);
      expect(logs.join("\n")).toContain("obligations: dropped t-0 — closes_loop");
    } finally {
      console.log = spy;
    }
  });

  it("(c) intent fyi drops the item too", async () => {
    const out = await silenced(() => gatherOpenObligations(gatherDeps(1, { classifyIntent: async () => "fyi" }), NOW));
    expect(out).toEqual([]);
  });

  it("(c) intent expects_reply keeps the item and carries intentReason onto it", async () => {
    const deps = gatherDeps(1, { classifyIntent: async () => "expects_reply" });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe(intentReason("expects_reply", { isRePing: false }));
  });

  it("(c) intent unreadable keeps the item — an unread message stays on the radar", async () => {
    const deps = gatherDeps(1, { classifyIntent: async () => "unreadable" });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(out.map((o) => o.reason)).toEqual([intentReason("unreadable", { isRePing: false })]);
  });

  // ─── (d) every failure keeps the item, with a reason that admits it ───────────────────────

  it("(d) a throwing intent keeps the item with the could-not-verify reason", async () => {
    const deps = gatherDeps(1, { classifyIntent: async () => { throw new Error("gateway 500"); } });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(out.map((o) => o.reason)).toEqual([RESOLUTION_UNVERIFIED_REASON]);
  });

  it("(d) a throwing resolve keeps the item with the could-not-verify reason, and never spends a model read on it", async () => {
    let intentCalls = 0;
    const deps = gatherDeps(1, {
      resolve: async () => { throw new Error("network replica unreadable"); },
      classifyIntent: async () => { intentCalls++; return "expects_reply"; },
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(out.map((o) => o.reason)).toEqual([RESOLUTION_UNVERIFIED_REASON]);
    expect(intentCalls).toBe(0);
  });

  it("(d) a resolve that hangs mid-pass: what it already RESOLVED stays dropped, the unreached stay owed", async () => {
    vi.useFakeTimers();
    const spy = console.error;
    console.error = () => {};
    const logSpy = console.log;
    console.log = () => {};
    try {
      // t-0 resolves (a positive drop, recorded, `markResolved` already called) and t-2 then
      // hangs forever. Because `mapWithConcurrency` is a barrier, nothing downstream of the
      // resolve pass runs at all — which is exactly why the drop has to be recorded inside it.
      const marked: string[] = [];
      const deps = gatherDeps(4, {
        resolve: async (o) => {
          if (o.threadId === "t-0") return { resolution: hit("calendar"), unreadable: ["network"] };
          if (o.threadId === "t-2") return new Promise<never>(() => {});
          return { resolution: null, unreadable: [] };
        },
        markResolved: async (o) => { marked.push(o.threadId); },
        classifyIntent: async () => "expects_reply",
      });
      const pending = gatherOpenObligations(deps, NOW);
      await vi.advanceTimersByTimeAsync(RESOLUTION_PASS_TIMEOUT_MS + 10);
      const out = await pending;

      // t-0 was RESOLVED and RECORDED before the budget blew, so it stays dropped. Re-adding it
      // would put a thread he demonstrably answered back on his brief, labelled "could not
      // verify" — a false report, arriving as though nothing were known.
      expect(marked).toEqual(["t-0"]);
      expect(out.map((o) => o.threadId)).toEqual(["t-1", "t-2", "t-3"]);
      expect(out.every((o) => o.reason === RESOLUTION_UNVERIFIED_REASON)).toBe(true);
    } finally {
      console.error = spy;
      console.log = logSpy;
      vi.useRealTimers();
    }
  });

  it("(d) an intent read that hangs mid-pass: the verdicts already reached survive the budget", async () => {
    vi.useFakeTimers();
    const spy = console.error;
    console.error = () => {};
    const logSpy = console.log;
    console.log = () => {};
    try {
      // The resolve pass completes for all four. The cache answers t-0 (kept, with a real
      // reason) and t-1 (closes_loop — a positive drop). The model read then hangs on t-2.
      const deps = gatherDeps(4, {
        resolve: async () => ({ resolution: null, unreadable: [] }),
        cachedIntent: async (o) => {
          if (o.threadId === "t-0") return "expects_reply";
          if (o.threadId === "t-1") return "closes_loop";
          return null;
        },
        classifyIntent: () => new Promise<never>(() => {}),
      });
      const pending = gatherOpenObligations(deps, NOW);
      await vi.advanceTimersByTimeAsync(RESOLUTION_PASS_TIMEOUT_MS + 10);
      const out = await pending;

      expect(out.map((o) => o.threadId)).toEqual(["t-0", "t-2", "t-3"]);   // t-1 stayed dropped
      expect(out.map((o) => o.reason)).toEqual([
        intentReason("expects_reply", { isRePing: false }),                // t-0's real verdict
        RESOLUTION_UNVERIFIED_REASON,                                      // never reached
        RESOLUTION_UNVERIFIED_REASON,
      ]);
    } finally {
      console.error = spy;
      console.log = logSpy;
      vi.useRealTimers();
    }
  });

  it("(d) a stage that reaches nothing at all still keeps every candidate", async () => {
    vi.useFakeTimers();
    const spy = console.error;
    console.error = () => {};
    try {
      const deps = gatherDeps(3, { resolve: () => new Promise(() => {}) });
      const pending = gatherOpenObligations(deps, NOW);
      await vi.advanceTimersByTimeAsync(RESOLUTION_PASS_TIMEOUT_MS + 10);
      const out = await pending;
      expect(out.map((o) => o.threadId)).toEqual(["t-0", "t-1", "t-2"]);
      expect(out.every((o) => o.reason === RESOLUTION_UNVERIFIED_REASON)).toBe(true);
    } finally {
      console.error = spy;
      vi.useRealTimers();
    }
  });

  // ─── (e) the model budget is a hard per-pass cap on READS, spent oldest-first ────────────

  it("(e) ten survivors, nothing cached: exactly INTENT_MAX_PER_PASS model reads, oldest FIRST", async () => {
    const read: string[] = [];
    const deps = gatherDeps(10, {
      cachedIntent: async () => null,
      classifyIntent: async (o) => { read.push(o.threadId); return "expects_reply"; },
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(read).toHaveLength(INTENT_MAX_PER_PASS);
    // The ORDER, not the set: t-0 is the most overdue, t-9 the least, and the budget must be
    // spent from the top of that list down — the oldest items are the ones he has stopped seeing.
    expect(read).toEqual(["t-0", "t-1", "t-2", "t-3", "t-4", "t-5", "t-6", "t-7"]);
    expect(out).toHaveLength(10);
    expect(out.filter((o) => o.reason === INTENT_UNREAD_REASON).map((o) => o.threadId)).toEqual(["t-8", "t-9"]);
  });

  it("(e) a cache hit costs NO cap slot — ten items, three cached, and nobody is left unread", async () => {
    const cached = new Set(["t-0", "t-1", "t-2"]);
    const read: string[] = [];
    const deps = gatherDeps(10, {
      cachedIntent: async (o) => (cached.has(o.threadId) ? "expects_reply" : null),
      classifyIntent: async (o) => { read.push(o.threadId); return "expects_reply"; },
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    // Seven uncached items, all under the cap of eight: the three cache hits did not eat it.
    expect(read).toEqual(["t-3", "t-4", "t-5", "t-6", "t-7", "t-8", "t-9"]);
    expect(out).toHaveLength(10);
    expect(out.filter((o) => o.reason === INTENT_UNREAD_REASON)).toEqual([]);
  });

  it("(e) twelve items, two cached: eight reads, and the two left unread are the YOUNGEST", async () => {
    const cached = new Set(["t-0", "t-1"]);
    const read: string[] = [];
    const deps = gatherDeps(12, {
      cachedIntent: async (o) => (cached.has(o.threadId) ? "expects_reply" : null),
      classifyIntent: async (o) => { read.push(o.threadId); return "expects_reply"; },
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(read).toEqual(["t-2", "t-3", "t-4", "t-5", "t-6", "t-7", "t-8", "t-9"]);
    expect(out.filter((o) => o.reason === INTENT_UNREAD_REASON).map((o) => o.threadId)).toEqual(["t-10", "t-11"]);
  });

  it("(e) a cached closes_loop drops the item, exactly as a fresh one does, and spends no read", async () => {
    let reads = 0;
    const deps = gatherDeps(1, {
      cachedIntent: async () => "closes_loop",
      classifyIntent: async () => { reads++; return "expects_reply"; },
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(out).toEqual([]);
    expect(reads).toBe(0);
  });

  it("(e) a throwing cache read is a MISS, not a verdict — the item is still read", async () => {
    const read: string[] = [];
    const deps = gatherDeps(1, {
      cachedIntent: async () => { throw new Error("db down"); },
      classifyIntent: async (o) => { read.push(o.threadId); return "expects_reply"; },
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(read).toEqual(["t-0"]);
    expect(out[0]!.reason).toBe(intentReason("expects_reply", { isRePing: false }));
  });

  it("(e) a HUNG cache read is bounded and counts as a miss — the other survivors keep the verdicts already back", async () => {
    vi.useFakeTimers();
    const spy = console.error;
    console.error = () => {};
    try {
      // t-1's cache read never returns. Its own RESOLUTION_LOOKUP_TIMEOUT_MS ceiling turns that
      // into a miss, so it falls through to the model read — and, crucially, t-0's and t-2's
      // verdicts were applied inside their own callbacks rather than batched behind t-1.
      const read: string[] = [];
      const deps = gatherDeps(4, {
        cachedIntent: (o) => {
          if (o.threadId === "t-1") return new Promise<never>(() => {});
          return Promise.resolve(o.threadId === "t-3" ? null : "expects_reply");
        },
        classifyIntent: async (o) => { read.push(o.threadId); return "unreadable"; },
      });
      const pending = gatherOpenObligations(deps, NOW);
      await vi.advanceTimersByTimeAsync(RESOLUTION_LOOKUP_TIMEOUT_MS + 10);
      const out = await pending;

      // Oldest-first is preserved across the miss: t-1 comes before t-3 in the classify queue.
      expect(read).toEqual(["t-1", "t-3"]);
      expect(out.map((o) => o.reason)).toEqual([
        intentReason("expects_reply", { isRePing: false }),   // t-0, from cache
        intentReason("unreadable", { isRePing: false }),      // t-1, hung cache → read
        intentReason("expects_reply", { isRePing: false }),   // t-2, from cache
        intentReason("unreadable", { isRePing: false }),      // t-3, cache miss → read
      ]);
    } finally {
      console.error = spy;
      vi.useRealTimers();
    }
  });

  it("(e) a hung cache read AND a blown stage budget: the cached verdicts already applied still survive", async () => {
    vi.useFakeTimers();
    const spy = console.error;
    console.error = () => {};
    try {
      // Same shape, but nothing rescues the items that fell through: the classify pass hangs, so
      // the stage budget expires. t-0 and t-2 were applied from cache inside their own callbacks
      // and must come back with those reasons, not "could not verify".
      const deps = gatherDeps(4, {
        cachedIntent: (o) => {
          if (o.threadId === "t-1") return new Promise<never>(() => {});
          return Promise.resolve(o.threadId === "t-3" ? null : "expects_reply");
        },
        classifyIntent: () => new Promise<never>(() => {}),
      });
      const pending = gatherOpenObligations(deps, NOW);
      await vi.advanceTimersByTimeAsync(RESOLUTION_PASS_TIMEOUT_MS + 10);
      const out = await pending;

      expect(out.map((o) => o.reason)).toEqual([
        intentReason("expects_reply", { isRePing: false }),   // t-0, cached before the budget blew
        RESOLUTION_UNVERIFIED_REASON,                          // t-1, never resolved
        intentReason("expects_reply", { isRePing: false }),   // t-2, cached before the budget blew
        RESOLUTION_UNVERIFIED_REASON,                          // t-3, never resolved
      ]);
    } finally {
      console.error = spy;
      vi.useRealTimers();
    }
  });

  it("(e) a cache with no reader behind it applies its hits and keeps the rest, unlabelled", async () => {
    const deps = gatherDeps(2, {
      cachedIntent: async (o) => (o.threadId === "t-0" ? "closes_loop" : null),
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(out.map((o) => o.threadId)).toEqual(["t-1"]);
    expect(out[0]!.reason).toBeUndefined();
  });

  // ─── unreadable sources reach the caller so the brief can admit the gap ──────────────────

  it("reports the unique set of sources no lookup could read", async () => {
    const seen: string[][] = [];
    const deps = gatherDeps(2, {
      resolve: async () => ({ resolution: null, unreadable: ["calendar", "network"] }),
      onUnreadable: (sources) => { seen.push(sources); },
    });
    await silenced(() => gatherOpenObligations(deps, NOW));
    expect(seen).toHaveLength(1);
    expect([...seen[0]!].sort()).toEqual(["calendar", "network"]);
  });

  it("does not call onUnreadable when every lookup was readable", async () => {
    let called = 0;
    const deps = gatherDeps(1, {
      resolve: async () => ({ resolution: null, unreadable: [] }),
      onUnreadable: () => { called++; },
    });
    await silenced(() => gatherOpenObligations(deps, NOW));
    expect(called).toBe(0);
  });

  it("upsertSeen is called for the post-drop candidates ONLY — a thread resolved elsewhere is not re-seen", async () => {
    const seen: string[] = [];
    const deps = gatherDeps(3, {
      // t-1 was answered elsewhere after their last message; t-2's resolution is stale.
      resolved: async () => new Map([
        ["t-1", new Date("2026-08-05T00:00:00Z")],
        ["t-2", new Date("2026-07-01T00:00:00Z")],
      ]),
      upsertSeen: async (o) => { seen.push(o.threadId); },
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(seen).toEqual(["t-0", "t-2"]);
    expect(out.map((o) => o.threadId)).toEqual(["t-0", "t-2"]);
  });

  it("a throwing markResolved that fails SYNCHRONOUSLY is caught too — the pass survives it", async () => {
    const deps = gatherDeps(1, {
      resolve: async () => ({ resolution: hit(), unreadable: [] }),
      markResolved: (() => { throw new Error("pool closed"); }) as GatherObligationsDeps["markResolved"],
    });
    const out = await silenced(() => gatherOpenObligations(deps, NOW));
    expect(out).toEqual([]);
  });

  it("with none of the new deps wired, behaves exactly as before — kept, with no reason", async () => {
    const out = await gatherOpenObligations(gatherDeps(1), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBeUndefined();
  });
});

// ─── dropResolved — the same rule the re-ping lane applies before assignSurfaces ────────────

describe("dropResolved (ORB-45 Task 10, B5)", () => {
  const owed = (threadId: string, lastMessageAt: string, isRePing = true): Obligation => ({
    threadId,
    subject: "Re: pilot terms",
    counterpartyName: "Lars Eriksen",
    counterpartyAddress: "lars@partner.example",
    lastMessageAt: new Date(lastMessageAt),
    ageHours: 60,
    isRePing,
    unansweredCount: isRePing ? 2 : 1,
    source: "gmail",
  });

  it("drops an obligation resolved AFTER their last message", () => {
    const out = dropResolved([owed("t-1", "2026-08-10T09:00:00Z")], new Map([["t-1", new Date("2026-08-11T09:00:00Z")]]));
    expect(out).toEqual([]);
  });

  it("keeps an obligation whose resolution predates their last message", () => {
    const out = dropResolved([owed("t-1", "2026-08-10T09:00:00Z")], new Map([["t-1", new Date("2026-08-09T09:00:00Z")]]));
    expect(out.map((o) => o.threadId)).toEqual(["t-1"]);
  });

  it("keeps everything when the map is empty", () => {
    expect(dropResolved([owed("t-1", "2026-08-10T09:00:00Z")], new Map()).map((o) => o.threadId)).toEqual(["t-1"]);
  });

  // (g) — the re-ping lane's composition: a resolved re-ping must never buy an interrupt.
  it("(g) a resolved re-ping never reaches assignSurfaces' interrupt bucket", () => {
    const items = [owed("t-1", "2026-08-10T09:00:00Z"), owed("t-2", "2026-08-10T09:00:00Z")];
    const resolved = new Map([["t-1", new Date("2026-08-11T09:00:00Z")]]);
    expect(assignSurfaces(items, new Set(), new Map()).interrupt.map((o) => o.threadId)).toEqual(["t-1", "t-2"]);
    const { interrupt } = assignSurfaces(dropResolved(items, resolved), new Set(), new Map());
    expect(interrupt.map((o) => o.threadId)).toEqual(["t-2"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ORB-180 Task 4 — `recordCandidate`: an institutional due notice leaves the pipeline as a
// DEADLINE CANDIDATE and never as an obligation.
//
// The dep is optional and its failure is swallowed, which is the whole fail-open contract: a
// dead `deadline_candidates` table costs the brief one offer line, never his owed replies.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("gatherOpenObligations — deadline candidates (ORB-180 Task 4)", () => {
  const fiken = () =>
    threadMessage({
      threadId: "t-fiken",
      from: "Fiken <post@fiken.no>",
      subject: "MVA-melding for 3. termin forfaller 31.08",
      sentAt: "2026-08-01T09:00:00Z",
    });

  function depsWith(recordCandidate: GatherObligationsDeps["recordCandidate"]): GatherObligationsDeps {
    return {
      myAddresses: async () => ["owner@owner.example"],
      gmail: {
        searchThreadIds: async () => ["t-fiken", "t-1"],
        readThread: async (id) => [id === "t-fiken" ? fiken() : threadMessage({ sentAt: "2026-08-01T09:00:00Z" })],
      },
      dismissed: async () => new Set(),
      upsertSeen: async () => {},
      ...(recordCandidate ? { recordCandidate } : {}),
    };
  }

  it("records the flagged thread, and that thread is ABSENT from the obligations", async () => {
    const recorded: Array<{ threadId: string; subject: string; sender: string; seenAt: Date }> = [];
    const out = await gatherOpenObligations(depsWith(async (c) => { recorded.push(c); }), NOW);

    expect(recorded).toEqual([{
      threadId: "t-fiken",
      subject: "MVA-melding for 3. termin forfaller 31.08",
      sender: "post@fiken.no",
      seenAt: NOW,
    }]);
    // The human thread in the same scan is untouched — this rule narrows, it does not silence.
    expect(out.map((o) => o.threadId)).toEqual(["t-1"]);
  });

  it("is never called for a thread that is not a due notice", async () => {
    const recorded: string[] = [];
    const deps: GatherObligationsDeps = {
      myAddresses: async () => ["owner@owner.example"],
      gmail: {
        searchThreadIds: async () => ["t-1"],
        readThread: async () => [threadMessage({ sentAt: "2026-08-01T09:00:00Z" })],
      },
      dismissed: async () => new Set(),
      upsertSeen: async () => {},
      recordCandidate: async (c) => { recorded.push(c.threadId); },
    };
    await gatherOpenObligations(deps, NOW);
    expect(recorded).toEqual([]);
  });

  it("a THROWING recordCandidate is logged and does not kill the gather", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await gatherOpenObligations(depsWith(async () => { throw new Error("deadline_candidates is gone"); }), NOW);
      expect(out.map((o) => o.threadId)).toEqual(["t-1"]);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("NO recordCandidate wired is the pre-ORB-180 shape — the due notice is still off the radar", async () => {
    const out = await gatherOpenObligations(depsWith(undefined), NOW);
    expect(out.map((o) => o.threadId)).toEqual(["t-1"]);
  });
});

// The dep is typed `Promise<void>`, so a SYNCHRONOUS throw is already a contract violation —
// but "never kill the gather" is the stronger promise, and a synchronous throw is exactly the
// shape that sails past a `.catch()` handler.
describe("gatherOpenObligations — a synchronously-throwing recordCandidate (ORB-180)", () => {
  it("is caught too — his obligations still come back", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps: GatherObligationsDeps = {
        myAddresses: async () => ["owner@owner.example"],
        gmail: {
          searchThreadIds: async () => ["t-fiken", "t-1"],
          readThread: async (id) => [
            id === "t-fiken"
              ? threadMessage({ threadId: "t-fiken", from: "Fiken <post@fiken.no>", subject: "Faktura forfaller 31.08", sentAt: "2026-08-01T09:00:00Z" })
              : threadMessage({ sentAt: "2026-08-01T09:00:00Z" }),
          ],
        },
        dismissed: async () => new Set(),
        upsertSeen: async () => {},
        recordCandidate: (() => { throw new Error("pool is gone"); }) as GatherObligationsDeps["recordCandidate"],
      };
      const out = await gatherOpenObligations(deps, NOW);
      expect(out.map((o) => o.threadId)).toEqual(["t-1"]);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
