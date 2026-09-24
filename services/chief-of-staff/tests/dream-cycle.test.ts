import { describe, it, expect, vi } from "vitest";

import { makeDreamCycle, type DreamCycleBrain, type DreamCyclePromoter, type DreamCycleReflector } from "../lib/dream/cycle.js";
import { serializeFrontmatter } from "@lares/agent-kit/vault-git";
import type { TurnLogEntry } from "../lib/turn-capture.js";
import type { EntryReader } from "../lib/dream/log-reader.js";
import type { Observation } from "../lib/dream/reflect.js";
import type { PromoterResult, Rejection } from "../lib/dream/promote.js";
import type { PreferenceRow } from "../lib/dream/store.js";

/**
 * Coverage for `makeDreamCycle(...).runOnce()` — cursor resolution, reading logs since the
 * cursor, reflect, promote, and writing the dated note. Everything below is a structural fake:
 * no real Postgres, no real LLM, per `lib/dream/cycle.ts`'s own dependency shape.
 *
 * `cycle.ts`'s documented cursor behaviour (its own header comment):
 *   - The prior cursor lives in `_meta/dream/<YYYY-MM-DD>.md` frontmatter as `cursor: <ISO>`.
 *   - The latest dream note (by date filename) is read to get `since`.
 *   - If no dream notes exist, `since = "1970-01-01T00:00:00.000Z"`.
 *   - After every run, cursor is advanced to `now.toISOString()`.
 */

const EPOCH = "1970-01-01T00:00:00.000Z";

/** An in-memory brain whose `commitNote` runs the REAL `serializeFrontmatter` (the same
 *  function `lib/vault-git.ts`'s real `commitNote` uses) so the round-trip in Finding 2's
 *  test exercises real serialization on the write side and `cycle.ts`'s real regex parsing
 *  on the read side — not two separately-mocked halves. */
function fakeBrain(initial: Record<string, string> = {}): DreamCycleBrain & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    list: async () => Object.keys(files),
    read: async (path: string) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    commitNote: async (o: { path: string; frontmatter: Record<string, unknown>; body: string }) => {
      files[o.path] = `${serializeFrontmatter(o.frontmatter)}\n\n${o.body}`;
      return { commit: "deadbeef" };
    },
  };
}

function fakeReflector(
  fn: (entries: unknown[], opts: { since: string }) => Promise<Observation[]> | Observation[] = () => [],
): DreamCycleReflector {
  return { reflect: async (entries, opts) => fn(entries, opts) };
}

function fakePromoter(result: PromoterResult): DreamCyclePromoter {
  return { run: async () => result };
}

const emptyResult: PromoterResult = { promoted: [], superseded: [], held: [], needsConfirm: [], rejected: [], proposed: [] };

/** A `conversation_entries` table with nothing in it — every scenario in this file is about
 *  cursor resolution and note-writing, not the table (that is `dream-modules.test.ts`'s
 *  `readConversationEntries` block, W3B-s3). With an empty table,
 *  `readConversationEntries` falls all the way back to `brain`'s markdown for the whole
 *  window after the cursor — exactly the behaviour these tests already pin. */
const emptyEntries: EntryReader = { since: async () => [] };
const AGENT = "canary";
/** Neutral, caller-supplied label for the fixture below — the reader knows no name of its own
 *  (W3B-s7). */
const AGENT_LABEL = "Helper";

/** Renders a `TurnLogEntry` in the legacy markdown format the retired writer
 *  (`lib/conversation-log.ts`, removed W3B-s8) used to produce — inlined here as a plain
 *  fixture builder (mirrors dream-modules.test.ts's own `renderMd`), since nothing in
 *  production writes this format any more but the reader still parses it for its own
 *  markdown gap-fill. */
function renderLog(e: TurnLogEntry): { relPath: string; text: string } {
  const date = e.at.slice(0, 10);
  const stamp = e.at.replace(/[:.]/g, "-");
  const relPath = `_meta/conversations/${date}/${stamp}-${e.door}.md`;
  const speaker = e.lane ? `${e.lane} (scheduled)` : "Person";
  const text = [
    `---`,
    `at: ${e.at}`,
    `door: ${e.door}`,
    `principal: ${e.principal}`,
    ...(e.lane ? [`lane: ${e.lane}`] : []),
    `proposals: ${e.proposals.join(", ")}`,
    `---`,
    ``,
    `**${speaker}:** ${e.input}`,
    ...(e.reply ? [``, `**${AGENT_LABEL}:** ${e.reply}`, ``] : [``]),
  ].join("\n");
  return { relPath, text };
}

describe("makeDreamCycle(...).runOnce() — the full orchestration path (Finding 1)", () => {
  it("a normal pass reads logs since the cursor, reflects, promotes, and writes a dated note", async () => {
    const entry: TurnLogEntry = {
      at: "2026-08-19T10:00:00.000Z",
      door: "slack",
      principal: "U1",
      input: "I prefer terse replies",
      reply: "noted",
      proposals: [],
    };
    const { relPath, text } = renderLog(entry);
    const brain = fakeBrain({ [relPath]: text });

    const observation: Observation = {
      text: "the owner prefers terse replies",
      kind: "preference",
      subject: "communication style",
      confidence: 0.9,
      evidenceRefs: [entry.at],
      // Required since W4C-s1 and computed by code there; this file fakes the promoter, so the
      // value only has to be present and honest for the fixture — the turn it cites is the
      // owner's own.
      origin: "owner",
    };

    let capturedEntries: TurnLogEntry[] = [];
    let capturedSince: string | undefined;
    const reflector = fakeReflector((entries, opts) => {
      capturedEntries = entries as TurnLogEntry[];
      capturedSince = opts.since;
      return [observation];
    });

    const promotedRow: PreferenceRow = {
      id: "p1",
      text: observation.text,
      kind: observation.kind,
      subject: observation.subject,
      confidence: observation.confidence,
      source: "dream-cycle-2026-08-20",
      origin: "agent",
      valid_from: "2026-08-20T03:00:00.000Z",
      valid_to: null,
      superseded_by: null,
      created_at: "2026-08-20T03:00:00.000Z",
    };
    const result: PromoterResult = { promoted: [promotedRow], superseded: [], held: [], needsConfirm: [], rejected: [], proposed: [] };
    const promoter = fakePromoter(result);

    const clock = () => new Date("2026-08-20T03:00:00.000Z");
    const cycle = makeDreamCycle({
      reflector,
      promoter,
      brain,
      entries: emptyEntries,
      agent: AGENT,
      agentLabel: AGENT_LABEL,
      clock,
    });

    const out = await cycle.runOnce();

    // Cursor resolution: no prior dream notes → epoch.
    expect(out.since).toBe(EPOCH);
    expect(capturedSince).toBe(EPOCH);

    // The one non-scheduled conversation log reached the reflector.
    expect(capturedEntries.map((e) => e.input)).toEqual(["I prefer terse replies"]);

    // The PromoterResult-shaped return is exactly what the fake promoter returned.
    expect(out.result).toEqual(result);

    // The dated note was actually written, with the advanced cursor and promoted text.
    expect(out.notePath).toBe("_meta/dream/2026-08-20.md");
    const note = brain.files[out.notePath];
    expect(note).toBeDefined();
    expect(note).toContain("cursor: 2026-08-20T03:00:00.000Z");
    expect(note).toContain("promoted: 1");
    expect(note).toContain(observation.text);
  });

  it("defaults the cursor to the epoch when no prior dream note exists", async () => {
    const brain = fakeBrain();
    const reflector = fakeReflector();
    const promoter = fakePromoter(emptyResult);
    const clock = () => new Date("2026-08-20T03:00:00.000Z");
    const cycle = makeDreamCycle({
      reflector,
      promoter,
      brain,
      entries: emptyEntries,
      agent: AGENT,
      agentLabel: AGENT_LABEL,
      clock,
    });

    const out = await cycle.runOnce();

    expect(out.since).toBe(EPOCH);
    expect(out.result).toEqual(emptyResult);
    expect(brain.files[out.notePath]).toContain("cursor: 2026-08-20T03:00:00.000Z");
  });

  it("reads the cursor from a prior dream note's frontmatter when one exists", async () => {
    const priorFm = {
      at: "2026-08-19T03:00:00.000Z",
      cursor: "2026-08-19T03:00:00.000Z",
      promoted: 0,
      superseded: 0,
      held: 0,
      needsConfirm: 0,
      scrubbed: 0,
    };
    const brain = fakeBrain({
      "_meta/dream/2026-08-19.md": `${serializeFrontmatter(priorFm)}\n\n_No new observations in this cycle._`,
    });

    let capturedSince: string | undefined;
    const reflector = fakeReflector((_entries, opts) => {
      capturedSince = opts.since;
      return [];
    });
    const promoter = fakePromoter(emptyResult);
    const clock = () => new Date("2026-08-20T03:00:00.000Z");
    const cycle = makeDreamCycle({
      reflector,
      promoter,
      brain,
      entries: emptyEntries,
      agent: AGENT,
      agentLabel: AGENT_LABEL,
      clock,
    });

    const out = await cycle.runOnce();

    expect(out.since).toBe("2026-08-19T03:00:00.000Z");
    expect(capturedSince).toBe("2026-08-19T03:00:00.000Z");
  });
});

describe("resolveCursor's epoch fallback — round-trip and silent-degradation guard (Finding 2)", () => {
  it("round-trips the cursor through commitNote's real frontmatter serialization and cycle's real parsing", async () => {
    const brain = fakeBrain();
    const reflector = fakeReflector();
    const promoter = fakePromoter(emptyResult);

    const cycle1 = makeDreamCycle({
      reflector,
      promoter,
      brain,
      entries: emptyEntries,
      agent: AGENT,
      agentLabel: AGENT_LABEL,
      clock: () => new Date("2026-08-19T03:00:00.000Z"),
    });
    const first = await cycle1.runOnce();
    expect(first.since).toBe(EPOCH);

    // Second cycle shares the SAME brain (same underlying files), so it reads back exactly
    // what the first cycle's real commitNote wrote via the real serializeFrontmatter.
    const cycle2 = makeDreamCycle({
      reflector,
      promoter,
      brain,
      entries: emptyEntries,
      agent: AGENT,
      agentLabel: AGENT_LABEL,
      clock: () => new Date("2026-08-20T03:00:00.000Z"),
    });
    const second = await cycle2.runOnce();

    expect(second.since).toBe("2026-08-19T03:00:00.000Z");
  });

  it("does NOT warn when no dream notes exist yet — the legitimate first-ever run", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const brain = fakeBrain();
      const cycle = makeDreamCycle({
        reflector: fakeReflector(),
        promoter: fakePromoter(emptyResult),
        brain,
        entries: emptyEntries,
        agent: AGENT,
        agentLabel: AGENT_LABEL,
        clock: () => new Date("2026-08-20T03:00:00.000Z"),
      });
      await cycle.runOnce();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns loudly when a prior dream note exists but has no cursor: line", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const brain = fakeBrain({
        "_meta/dream/2026-08-19.md": "---\nat: 2026-08-19T03:00:00.000Z\n---\n\nbody, no cursor field",
      });
      const cycle = makeDreamCycle({
        reflector: fakeReflector(),
        promoter: fakePromoter(emptyResult),
        brain,
        entries: emptyEntries,
        agent: AGENT,
        agentLabel: AGENT_LABEL,
        clock: () => new Date("2026-08-20T03:00:00.000Z"),
      });
      const out = await cycle.runOnce();

      expect(out.since).toBe(EPOCH);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/cursor fell back to EPOCH/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns loudly when the latest dream note has no frontmatter block at all", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const brain = fakeBrain({ "_meta/dream/2026-08-19.md": "just prose, not a real note" });
      const cycle = makeDreamCycle({
        reflector: fakeReflector(),
        promoter: fakePromoter(emptyResult),
        brain,
        entries: emptyEntries,
        agent: AGENT,
        agentLabel: AGENT_LABEL,
        clock: () => new Date("2026-08-20T03:00:00.000Z"),
      });
      const out = await cycle.runOnce();

      expect(out.since).toBe(EPOCH);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/no frontmatter block/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns loudly when the latest dream note is unreadable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const brain: DreamCycleBrain = {
        list: async () => ["_meta/dream/2026-08-19.md"],
        read: async () => {
          throw new Error("EACCES: permission denied");
        },
        commitNote: async () => ({ commit: "deadbeef" }),
      };
      const cycle = makeDreamCycle({
        reflector: fakeReflector(),
        promoter: fakePromoter(emptyResult),
        brain,
        entries: emptyEntries,
        agent: AGENT,
        agentLabel: AGENT_LABEL,
        clock: () => new Date("2026-08-20T03:00:00.000Z"),
      });
      const out = await cycle.runOnce();

      expect(out.since).toBe(EPOCH);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/unreadable note/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─── W4C-s7: one reviewable commit per dream ──────────────────────────────────

/** A committed note, captured RAW — the arguments `runOnce` actually passed to `commitNote`,
 *  not a round-trip through `serializeFrontmatter` (that round-trip is Finding 2's concern; this
 *  one is about what the cycle hands the brain, including `message`, which `fakeBrain` above
 *  does not thread through). No prior dream note, so `since` resolves to EPOCH and every
 *  scenario below writes exactly one note. */
function capturingBrain(
  committed: Array<{ path: string; message?: string; frontmatter: Record<string, unknown>; body: string }>,
): DreamCycleBrain {
  return {
    list: async () => [],
    read: async () => {
      throw new Error("not used in this fixture");
    },
    commitNote: async (o) => {
      committed.push(o);
      return { commit: "deadbeef" };
    },
  };
}

function preferenceRow(id: string): PreferenceRow {
  return {
    id,
    text: `preference ${id}`,
    kind: "preference",
    subject: "s",
    confidence: 0.9,
    source: "dream-cycle-2026-09-18",
    origin: "owner",
    valid_from: "2026-09-18T03:00:00.000Z",
    valid_to: null,
    superseded_by: null,
    created_at: "2026-09-18T03:00:00.000Z",
  };
}

function rejection(reason: Rejection["reason"]): Rejection {
  return {
    observation: { text: "x", kind: "fact", subject: "s", confidence: 0.4, origin: "third_party", evidenceRefs: [] },
    reason,
    say: `not learned: ${reason}`,
  };
}

describe("one commit per run, and what it records", () => {
  it("names the run in the commit message, with no persona name", async () => {
    const committed: Array<{ path: string; message?: string; frontmatter: Record<string, unknown>; body: string }> = [];
    const result: PromoterResult = {
      promoted: [preferenceRow("p1"), preferenceRow("p2")],
      superseded: [{ oldId: "p0", byId: "p1" }],
      held: [],
      needsConfirm: [],
      rejected: [rejection("below-recurrence"), rejection("already-held"), rejection("do-not-learn")],
      proposed: [],
    };
    const cycle = makeDreamCycle({
      reflector: fakeReflector(),
      promoter: fakePromoter(result),
      brain: capturingBrain(committed),
      entries: emptyEntries,
      agent: AGENT,
      agentLabel: AGENT_LABEL,
      clock: () => new Date("2026-09-18T03:00:00.000Z"),
    });

    await cycle.runOnce();

    expect(committed[0]!.message).toBe("learning: 2026-09-18 (2 added, 1 superseded, 3 not learned)");
    expect(committed[0]!.message).not.toMatch(/saga|marcel|calliope|bendik/i);
  });

  it("lists the row ids the run wrote, so the commit is a complete record of it", async () => {
    const committed: Array<{ path: string; message?: string; frontmatter: Record<string, unknown>; body: string }> = [];
    const result: PromoterResult = {
      promoted: [preferenceRow("p1"), preferenceRow("p2")],
      superseded: [{ oldId: "p0", byId: "p1" }],
      held: [],
      needsConfirm: [],
      rejected: [],
      proposed: [],
    };
    const cycle = makeDreamCycle({
      reflector: fakeReflector(),
      promoter: fakePromoter(result),
      brain: capturingBrain(committed),
      entries: emptyEntries,
      agent: AGENT,
      agentLabel: AGENT_LABEL,
      clock: () => new Date("2026-09-18T03:00:00.000Z"),
    });

    await cycle.runOnce();

    expect(committed[0]!.frontmatter["added"]).toEqual(["p1", "p2"]);
    expect(committed[0]!.frontmatter["superseded"]).toEqual(["p0 -> p1"]);
    expect(committed[0]!.frontmatter["proposed"]).toEqual([]);
  });

  it("names the proposals it filed in the note's frontmatter", async () => {
    const committed: Array<{ path: string; message?: string; frontmatter: Record<string, unknown>; body: string }> = [];
    const result: PromoterResult = {
      promoted: [],
      superseded: [],
      held: [],
      needsConfirm: [],
      rejected: [rejection("supersede-awaits-owner")],
      proposed: [{ id: 42, existingId: "p9" }],
    };
    const cycle = makeDreamCycle({
      reflector: fakeReflector(),
      promoter: fakePromoter(result),
      brain: capturingBrain(committed),
      entries: emptyEntries,
      agent: AGENT,
      agentLabel: AGENT_LABEL,
      clock: () => new Date("2026-09-18T03:00:00.000Z"),
    });

    await cycle.runOnce();

    expect(committed[0]!.frontmatter["proposed"]).toEqual([42]);
  });

  it("says in the note itself what reverting the commit does NOT undo", async () => {
    const committed: Array<{ path: string; message?: string; frontmatter: Record<string, unknown>; body: string }> = [];
    const result: PromoterResult = {
      promoted: [preferenceRow("p1")],
      superseded: [],
      held: [],
      needsConfirm: [],
      rejected: [],
      proposed: [],
    };
    const cycle = makeDreamCycle({
      reflector: fakeReflector(),
      promoter: fakePromoter(result),
      brain: capturingBrain(committed),
      entries: emptyEntries,
      agent: AGENT,
      agentLabel: AGENT_LABEL,
      clock: () => new Date("2026-09-18T03:00:00.000Z"),
    });

    await cycle.runOnce();

    expect(committed[0]!.body).toMatch(/reverting this commit removes this note[^.]*not the rows/i);
    expect(committed[0]!.body).toMatch(/memory_resolve_proposal|the Memory page/);
  });

  it("writes exactly one note, and therefore exactly one commit, per run", async () => {
    const committed: Array<{ path: string; message?: string; frontmatter: Record<string, unknown>; body: string }> = [];
    const cycle = makeDreamCycle({
      reflector: fakeReflector(),
      promoter: fakePromoter(emptyResult),
      brain: capturingBrain(committed),
      entries: emptyEntries,
      agent: AGENT,
      agentLabel: AGENT_LABEL,
      clock: () => new Date("2026-09-18T03:00:00.000Z"),
    });

    await cycle.runOnce();

    expect(committed).toHaveLength(1);
  });
});
