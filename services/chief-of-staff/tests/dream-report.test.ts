import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  makeDreamCycle,
  everythingRejected,
  shouldRaiseAllRejectedSignal,
  buildAllRejectedSignalDetail,
  DREAM_ALL_REJECTED_EVENT,
  DREAM_ALL_REJECTED_SIGNAL_AT,
  type DreamCycleBrain,
  type DreamCyclePromoter,
  type DreamCycleReflector,
} from "../lib/dream/cycle.js";
import { serializeFrontmatter } from "@lares/agent-kit/vault-git";
import type { EntryReader } from "../lib/dream/log-reader.js";
import type { Observation } from "../lib/dream/reflect.js";
import type { PromoterResult, Rejection } from "../lib/dream/promote.js";

/**
 * W4C-s6 — the dream note names what was REJECTED and why (ADR-0018 rule 6), and a run that
 * rejects every candidate raises a signal instead of reading as a quiet zero, the way OpenClaw's
 * own provenance gate did for weeks (report 10, issue #121232).
 *
 * The rejected observation's TEXT is never written into the note or the signal: it is, by
 * definition, sometimes third-party content, and both the note (committed to the vault) and the
 * signal (sent off-box) would otherwise become a second laundering path for exactly the words
 * the promotion gate refused to trust.
 *
 * FOLLOW-UP (controller review): a single all-rejected night is not yet a problem — tonight's
 * strict gate makes that ordinary (a one-off owner remark is `below-recurrence`; the agent's own
 * inference is `agent-inference`). The alarm only fires once the SAME failure holds for
 * `DREAM_ALL_REJECTED_SIGNAL_AT` consecutive nights, and then every 7 nights beyond that — kept
 * as a streak in the vault note's own frontmatter (`all_rejected_streak`), which is why it
 * survives a restart with no new table.
 */

const AGENT_LABEL = "Agent";

/** A brain that never has a prior note — every scenario here that doesn't care about the
 *  streak's cross-run persistence uses this. */
function fakeBrain(committed: { body: string; frontmatter: Record<string, unknown> }[] = []): DreamCycleBrain {
  return {
    list: async () => [],
    read: async () => {
      throw new Error("not used in this fixture");
    },
    commitNote: async (o) => {
      committed.push({ body: o.body, frontmatter: o.frontmatter });
      return { commit: "deadbeef" };
    },
  };
}

/** A brain that DOES persist what it's told to commit, and serves it back through `list`/`read`
 *  — the same shape `dream-cycle.test.ts`'s own `fakeBrain(initial)` uses, needed here to drive
 *  several sequential `runOnce()` calls and prove the streak carries across them the way it
 *  would across restarts of the real process. */
function persistentFakeBrain(initial: Record<string, string> = {}): DreamCycleBrain & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    list: async () => Object.keys(files),
    read: async (path: string) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    commitNote: async (o) => {
      files[o.path] = `${serializeFrontmatter(o.frontmatter)}\n\n${o.body}`;
      return { commit: "deadbeef" };
    },
  };
}

const emptyEntries: EntryReader = { since: async () => [] };
const noopReflector: DreamCycleReflector = { reflect: async () => [] };

const rejection = (reason: Rejection["reason"], text: string): Rejection => ({
  observation: {
    text,
    kind: "fact",
    subject: "s",
    confidence: 0.4,
    origin: "third_party",
    evidenceRefs: [],
  } as Observation,
  reason,
  say: `not learned: ${reason}`,
});

const allRejectedResult = (): PromoterResult => ({
  promoted: [],
  superseded: [],
  held: [],
  needsConfirm: [],
  rejected: [rejection("not-owner-origin", "x")],
});

const quietResult = (): PromoterResult => ({
  promoted: [],
  superseded: [],
  held: [],
  needsConfirm: [],
  rejected: [],
});

/** "Something got through" — here, a held (below-recurrence) observation, deliberately: it
 *  proves the reset applies even when the thing that got through is a hold, not a promotion. */
const somethingGotThroughResult = (): PromoterResult => ({
  promoted: [],
  superseded: [],
  held: [{ text: "h", kind: "preference", subject: "s", confidence: 0.5, evidenceRefs: [], origin: "owner" }],
  needsConfirm: [],
  rejected: [rejection("below-recurrence", "h")],
});

function cycleOn(brain: DreamCycleBrain, result: PromoterResult, day: string) {
  return makeDreamCycle({
    reflector: noopReflector,
    promoter: { run: async () => result },
    brain,
    entries: emptyEntries,
    agent: "role-under-test",
    agentLabel: AGENT_LABEL,
    clock: () => new Date(`2026-09-${day}T03:00:00Z`),
  });
}

describe("the dream note names what was rejected", () => {
  it("lists a count per reason, and the reason in words", async () => {
    const committed: { body: string; frontmatter: Record<string, unknown> }[] = [];
    const result: PromoterResult = {
      promoted: [],
      superseded: [],
      held: [],
      needsConfirm: [],
      rejected: [
        rejection("not-owner-origin", "billing@vendor.example says he agreed"),
        rejection("not-owner-origin", "the same email again"),
        rejection("below-recurrence", "he might prefer the coast road"),
      ],
    };
    const promoter: DreamCyclePromoter = { run: async () => result };
    const cycle = makeDreamCycle({
      reflector: noopReflector,
      promoter,
      brain: fakeBrain(committed),
      entries: emptyEntries,
      agent: "role-under-test",
      agentLabel: AGENT_LABEL,
      clock: () => new Date("2026-09-18T03:00:00Z"),
    });

    await cycle.runOnce();
    const body = committed[0]!.body;
    expect(body).toMatch(/### Not learned/);
    expect(body).toMatch(/2 .*somebody else/i);
    expect(body).toMatch(/1 .*said once so far/i);
    // The rejected TEXT is never quoted into the note: it is third-party content, and the note
    // is committed to git. The count and the reason are the whole record.
    expect(body).not.toContain("billing@vendor.example");
    expect(body).not.toContain("the same email again");
    expect(body).not.toContain("he might prefer the coast road");
    expect(committed[0]!.frontmatter["rejected"]).toBe(3);
  });

  it("says so plainly when there was nothing to consider — not the same as rejecting everything", async () => {
    const committed: { body: string; frontmatter: Record<string, unknown> }[] = [];
    const emptyResult: PromoterResult = {
      promoted: [],
      superseded: [],
      held: [],
      needsConfirm: [],
      rejected: [],
    };
    const cycle = makeDreamCycle({
      reflector: noopReflector,
      promoter: { run: async () => emptyResult },
      brain: fakeBrain(committed),
      entries: emptyEntries,
      agent: "role-under-test",
      agentLabel: AGENT_LABEL,
      clock: () => new Date("2026-09-18T03:00:00Z"),
    });

    await cycle.runOnce();
    expect(committed[0]!.body).toMatch(/No new observations in this cycle/);
    expect(committed[0]!.body).not.toMatch(/### Not learned/);
  });

  it("a broken rejection entry cannot stop the note from being committed (reporting must not break the dream)", async () => {
    const committed: { body: string; frontmatter: Record<string, unknown> }[] = [];
    const brokenResult: PromoterResult = {
      promoted: [],
      superseded: [],
      held: [],
      needsConfirm: [],
      // Deliberately malformed — a future reason value, or a corrupt object — to prove the
      // report's own rendering can never cost the run the note it is supposed to explain.
      rejected: [null as unknown as Rejection],
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cycle = makeDreamCycle({
        reflector: noopReflector,
        promoter: { run: async () => brokenResult },
        brain: fakeBrain(committed),
        entries: emptyEntries,
        agent: "role-under-test",
        agentLabel: AGENT_LABEL,
        clock: () => new Date("2026-09-18T03:00:00Z"),
      });

      await cycle.runOnce();

      // The note still committed — the real work (the commit) survives a broken report section.
      expect(committed).toHaveLength(1);
      expect(committed[0]!.frontmatter["rejected"]).toBe(1);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0]?.[0]).toMatch(/failed to render the rejection summary/);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("everythingRejected", () => {
  it("is true when candidates existed and none survived", () => {
    expect(
      everythingRejected({
        promoted: [],
        superseded: [],
        held: [],
        needsConfirm: [],
        rejected: [rejection("not-owner-origin", "x")],
      } as PromoterResult),
    ).toBe(true);
  });

  it("is false when the run had nothing to consider at all", () => {
    expect(
      everythingRejected({
        promoted: [],
        superseded: [],
        held: [],
        needsConfirm: [],
        rejected: [],
      } as PromoterResult),
    ).toBe(false);
  });

  it("is false when a rejection itself proves the owner's words get through the gate", () => {
    for (const reason of ["already-held", "supersede-awaits-owner"] as const) {
      expect(
        everythingRejected({
          promoted: [],
          superseded: [],
          held: [],
          needsConfirm: [],
          rejected: [rejection("not-owner-origin", "x"), rejection(reason, "y")],
        } as PromoterResult),
      ).toBe(false);
    }
  });

  it("is false when anything at all got through, including a hold", () => {
    for (const key of ["promoted", "held", "needsConfirm"] as const) {
      expect(
        everythingRejected({
          promoted: [],
          superseded: [],
          held: [],
          needsConfirm: [],
          rejected: [rejection("not-owner-origin", "x")],
          [key]: [{}],
        } as unknown as PromoterResult),
      ).toBe(false);
    }
  });
});

describe("resolveCursor's round-trip still carries the new fields", () => {
  it("serializes and can be read back without throwing (frontmatter shape only)", () => {
    const fm = {
      at: "x", cursor: "x", promoted: 0, superseded: 0, held: 0, needsConfirm: 0, rejected: 2,
      all_rejected: false, all_rejected_streak: 0, scrubbed: 0,
    };
    expect(serializeFrontmatter(fm)).toContain("rejected: 2");
    expect(serializeFrontmatter(fm)).toContain("all_rejected_streak: 0");
  });
});

// ─── The all-rejected streak (kept in the note; survives a restart) ───────────

describe("the all-rejected streak", () => {
  it("increments on each consecutive all-rejected run: 0 -> 1 -> 2", async () => {
    const brain = persistentFakeBrain();
    const out1 = await cycleOn(brain, allRejectedResult(), "17").runOnce();
    expect(out1.allRejectedStreak).toBe(1);
    const out2 = await cycleOn(brain, allRejectedResult(), "18").runOnce();
    expect(out2.allRejectedStreak).toBe(2);
  });

  it("a run with no candidates at all carries the streak forward unchanged (2 -> quiet -> 3)", async () => {
    const brain = persistentFakeBrain();
    await cycleOn(brain, allRejectedResult(), "17").runOnce();
    const out2 = await cycleOn(brain, allRejectedResult(), "18").runOnce();
    expect(out2.allRejectedStreak).toBe(2);

    const out3 = await cycleOn(brain, quietResult(), "19").runOnce();
    expect(out3.allRejectedStreak).toBe(2); // carried forward, not incremented
    expect(brain.files["_meta/dream/2026-09-19.md"]).toContain("all_rejected: false");

    const out4 = await cycleOn(brain, allRejectedResult(), "20").runOnce();
    expect(out4.allRejectedStreak).toBe(3);
  });

  it("a run where something got through resets the streak to 0, and a later all-rejected run starts again at 1", async () => {
    const brain = persistentFakeBrain();
    await cycleOn(brain, allRejectedResult(), "17").runOnce();
    const out2 = await cycleOn(brain, allRejectedResult(), "18").runOnce();
    expect(out2.allRejectedStreak).toBe(2);

    const out3 = await cycleOn(brain, somethingGotThroughResult(), "19").runOnce();
    expect(out3.allRejectedStreak).toBe(0);

    const out4 = await cycleOn(brain, allRejectedResult(), "20").runOnce();
    expect(out4.allRejectedStreak).toBe(1);
  });

  it("a previous note with no streak keys behaves as 0", async () => {
    const brain = persistentFakeBrain({
      "_meta/dream/2026-09-17.md": `${serializeFrontmatter({
        at: "2026-09-17T03:00:00.000Z", cursor: "2026-09-17T03:00:00.000Z",
        promoted: 0, superseded: 0, held: 0, needsConfirm: 0, rejected: 0, scrubbed: 0,
      })}\n\n_No new observations in this cycle._`,
    });
    const out = await cycleOn(brain, allRejectedResult(), "18").runOnce();
    expect(out.allRejectedStreak).toBe(1);
  });

  it("a failure reading the previous note's streak fails soft to 0, with one log line, and never stops the cycle", async () => {
    const brain = persistentFakeBrain({
      "_meta/dream/2026-09-17.md": `${serializeFrontmatter({
        at: "2026-09-17T03:00:00.000Z", cursor: "2026-09-17T03:00:00.000Z",
        promoted: 0, superseded: 0, held: 0, needsConfirm: 0, rejected: 1,
        all_rejected: true, all_rejected_streak: "banana", scrubbed: 0,
      })}\n\n### Not learned`,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await cycleOn(brain, allRejectedResult(), "18").runOnce();
      expect(out.allRejectedStreak).toBe(1); // fell back to 0, then this run's own +1
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).match(/could not read the prior all-rejected streak/)),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("shouldRaiseAllRejectedSignal — the third consecutive night, then every 7 beyond it", () => {
  it("never below the threshold", () => {
    expect(DREAM_ALL_REJECTED_SIGNAL_AT).toBe(3);
    expect(shouldRaiseAllRejectedSignal(0)).toBe(false);
    expect(shouldRaiseAllRejectedSignal(1)).toBe(false);
    expect(shouldRaiseAllRejectedSignal(2)).toBe(false);
  });

  it("raises exactly at the threshold", () => {
    expect(shouldRaiseAllRejectedSignal(3)).toBe(true);
  });

  it("stays quiet on every streak between multiples of 7 past the threshold", () => {
    for (const n of [4, 5, 6, 7, 8, 9]) expect(shouldRaiseAllRejectedSignal(n)).toBe(false);
  });

  it("raises again at each further multiple of 7 beyond the threshold", () => {
    expect(shouldRaiseAllRejectedSignal(10)).toBe(true);
    expect(shouldRaiseAllRejectedSignal(17)).toBe(true);
    expect(shouldRaiseAllRejectedSignal(24)).toBe(true);
  });
});

describe("buildAllRejectedSignalDetail", () => {
  it("names the streak and the per-reason counts, and never the observation text", () => {
    const detail = buildAllRejectedSignalDetail(
      [rejection("not-owner-origin", "billing@vendor.example"), rejection("below-recurrence", "x")],
      3,
    );
    expect(detail).toMatch(/not-owner-origin: 1/);
    expect(detail).toMatch(/below-recurrence: 1/);
    expect(detail).toMatch(/3 runs in a row/);
    expect(detail).not.toContain("billing@vendor.example");
  });

  it("adds the origin-stamping check only when EVERY rejection this run is not-owner-origin", () => {
    const allNotOwnerOrigin = buildAllRejectedSignalDetail(
      [rejection("not-owner-origin", "a"), rejection("not-owner-origin", "b")],
      3,
    );
    expect(allNotOwnerOrigin).toMatch(/owner origin/i);

    const mixed = buildAllRejectedSignalDetail(
      [rejection("not-owner-origin", "a"), rejection("below-recurrence", "b")],
      3,
    );
    expect(mixed).not.toMatch(/owner origin/i);
  });
});

// ─── The schedule raises a signal on a total rejection ────────────────────────

/**
 * `runDreamCycle` is exercised end-to-end here (no Docker: every dependency that would touch
 * Postgres, the filesystem vault, or the model gateway is replaced). `thisAgent`,
 * `lib/dream/reflect.ts` and `lib/llm-complete.ts` are left REAL: with no conversation entries
 * (`makeConversationRecord` faked to an empty `since`) and no markdown files, `reflect()`
 * short-circuits on an empty entry list before it ever calls the model — proving, structurally,
 * that this report costs no extra model call.
 *
 * `node:fs`'s `readFileSync` is partially mocked (via `importOriginal`, so every OTHER real `fs`
 * export is untouched) to serve an in-memory `files` map — the smallest way to give
 * `makeDreamBrain`'s `read` a prior note to find, so a test can start a run already partway
 * through a streak, the same way a real restart would.
 */
function mockDreamRunDeps(
  promoterResult: PromoterResult,
  opts: { priorNote?: { path: string; content: string } } = {},
): void {
  const files: Record<string, string> = {};
  if (opts.priorNote) files[opts.priorNote.path] = opts.priorNote.content;

  vi.doMock("../lib/dream/store.js", () => ({
    ensureDreamTables: async () => {},
    makeDreamStore: () => ({}),
  }));
  vi.doMock("../lib/dream/promote.js", () => ({
    makePromoter: () => ({ run: async () => promoterResult }),
    // W5X-s4 — the schedule builds one of these per run to file the run's `needsConfirm` items
    // as memory proposals. A fake that files nothing keeps this report's tests about the report:
    // what a real one does is `tests/dream-confirmation-notice.test.ts`, against a real Postgres.
    makeProposeAdd: () => async () => null,
  }));
  vi.doMock("@lares/agent-kit/notes-store", () => ({
    storeRoot: () => "/fake-brain-root",
    listNotes: () => Object.keys(files),
    resolveInStore: (p: string) => p,
  }));
  vi.doMock("@lares/agent-kit/vault-git", () => ({
    commitNote: async () => ({ commit: "deadbeef" }),
  }));
  vi.doMock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
      ...actual,
      readFileSync: (p: string, enc?: unknown) => {
        if (p in files) return files[p];
        return (actual.readFileSync as (path: string, encoding?: unknown) => string)(p, enc);
      },
    };
  });
  vi.doMock("@lares/agent-kit/conversation-record", () => ({
    makeConversationRecord: () => ({ since: async () => [] }),
  }));
  vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));
}

/** A prior dream note already `streak` nights into an all-rejected run — the fixture the
 *  schedule-level tests use to start a run partway through the streak, without needing several
 *  real sequential `runDreamCycle()` calls through the mocked vault. */
function priorNoteWithStreak(streak: number, day = "17"): { path: string; content: string } {
  return {
    path: `_meta/dream/2026-09-${day}.md`,
    content: `${serializeFrontmatter({
      at: `2026-09-${day}T03:00:00.000Z`,
      cursor: `2026-09-${day}T03:00:00.000Z`,
      promoted: 0, superseded: 0, held: 0, needsConfirm: 0, rejected: 1,
      all_rejected: true, all_rejected_streak: streak, scrubbed: 0,
    })}\n\n### Not learned`,
  };
}

describe("the schedule raises a signal on a total rejection", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("../lib/dream/store.js");
    vi.doUnmock("../lib/dream/promote.js");
    vi.doUnmock("@lares/agent-kit/notes-store");
    vi.doUnmock("@lares/agent-kit/vault-git");
    vi.doUnmock("@lares/agent-kit/conversation-record");
    vi.doUnmock("@lares/agent-kit/db");
    vi.doUnmock("node:fs");
    vi.doUnmock("../lib/signal-emit.js");
    vi.resetModules();
  });

  it("does not emit on the first consecutive all-rejected night", async () => {
    const emit = vi.fn();
    vi.doMock("../lib/signal-emit.js", () => ({ emitSignal: emit }));
    mockDreamRunDeps({
      promoted: [], superseded: [], held: [], needsConfirm: [],
      rejected: [rejection("not-owner-origin", "x")],
    });

    const { runDreamCycle } = await import("../agent/schedules/dream.js");
    await runDreamCycle();

    expect(emit).not.toHaveBeenCalled();
  });

  it("emits once it reaches the third consecutive all-rejected night, naming the run, the streak and the counts", async () => {
    const emit = vi.fn();
    vi.doMock("../lib/signal-emit.js", () => ({ emitSignal: emit }));
    mockDreamRunDeps(
      {
        promoted: [], superseded: [], held: [], needsConfirm: [],
        rejected: [
          rejection("not-owner-origin", "billing@vendor.example says he agreed"),
          rejection("below-recurrence", "he might prefer the coast road"),
        ],
      },
      { priorNote: priorNoteWithStreak(2) },
    );

    const { runDreamCycle } = await import("../agent/schedules/dream.js");
    await runDreamCycle();

    expect(emit).toHaveBeenCalledWith(
      DREAM_ALL_REJECTED_EVENT,
      expect.stringMatching(/every candidate was rejected/i),
      expect.stringMatching(/not-owner-origin/),
    );
    expect(emit.mock.calls[0]![2]).toMatch(/3 runs in a row/);
    expect(emit.mock.calls[0]![2]).not.toContain("billing@vendor.example");
    expect(emit.mock.calls[0]![2]).not.toContain("he might prefer the coast road");
  });

  it("does not emit when something got through, even alongside rejections", async () => {
    const emit = vi.fn();
    vi.doMock("../lib/signal-emit.js", () => ({ emitSignal: emit }));
    mockDreamRunDeps(
      {
        promoted: [
          {
            id: "p1",
            text: "x",
            kind: "preference",
            subject: "s",
            confidence: 0.9,
            source: null,
            origin: "owner",
            valid_from: "2026-09-18T03:00:00.000Z",
            valid_to: null,
            superseded_by: null,
            created_at: "2026-09-18T03:00:00.000Z",
          },
        ],
        superseded: [],
        held: [],
        needsConfirm: [],
        rejected: [rejection("not-owner-origin", "x")],
      },
      { priorNote: priorNoteWithStreak(2) },
    );

    const { runDreamCycle } = await import("../agent/schedules/dream.js");
    await runDreamCycle();

    expect(emit).not.toHaveBeenCalled();
  });

  it("does not re-raise on a quiet run that merely carries an already-crossed streak forward", async () => {
    const emit = vi.fn();
    vi.doMock("../lib/signal-emit.js", () => ({ emitSignal: emit }));
    mockDreamRunDeps(
      { promoted: [], superseded: [], held: [], needsConfirm: [], rejected: [] }, // quiet
      { priorNote: priorNoteWithStreak(3) },
    );

    const { runDreamCycle } = await import("../agent/schedules/dream.js");
    await runDreamCycle();

    expect(emit).not.toHaveBeenCalled();
  });

  it("reporting must never break the dream: a broken rejected entry at the raising streak is caught and logged, and the cycle still returns", async () => {
    const emit = vi.fn();
    vi.doMock("../lib/signal-emit.js", () => ({ emitSignal: emit }));
    mockDreamRunDeps(
      { promoted: [], superseded: [], held: [], needsConfirm: [], rejected: [null as unknown as Rejection] },
      { priorNote: priorNoteWithStreak(2) },
    );

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { runDreamCycle } = await import("../agent/schedules/dream.js");
      const out = await runDreamCycle();

      expect(out.notePath).toMatch(/_meta\/dream\/\d{4}-\d{2}-\d{2}\.md/);
      expect(out.counts["rejected"]).toBe(1);
      // The signal never went out with a broken reason, but the run still completed.
      expect(emit).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled();
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).match(/failed to raise the all-rejected signal/)),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
