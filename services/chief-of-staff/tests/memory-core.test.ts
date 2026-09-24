/**
 * tests/memory-core.test.ts — the per-session memory core (W4B-s2).
 *
 * Three properties are under test, and they are the whole point of the slice:
 *
 *   1. BYTE-STABILITY. The same fact set renders the same bytes, and a session's block is built
 *      ONCE — even when the table changes underneath it. eve merges every dynamic instruction
 *      into one system message with a single cache breakpoint, so a block that changes its bytes
 *      re-bills the whole system prompt (see packages/agent-kit/src/clock.ts's header).
 *   2. NOTHING THE OWNER SAID GOES MISSING SILENTLY. The budget is in characters, and it does not
 *      cut while this service has no tool that can list the omitted facts back.
 *   3. FAIL SOFT. A slow or absent database costs the block, never the turn.
 *
 * No container: `buildFactsCore` is pure and the resolver is driven directly, the way
 * `tests/origin-taint-hook.test.ts` drives `makeOriginTaint()`. The store itself is covered
 * against a real Postgres in `tests/standing-facts.test.ts`.
 *
 * MOCKING RULE (WAVE-3 note, "Added after W3A-s5/s6"): every `vi.doMock` here is paired with a
 * dynamic `await import(...)` AFTER `vi.resetModules()`. A static top-level import of the
 * resolver would bind to a different module instance and the mock would never be seen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { guarded } from "@lares/agent-kit/memory-core";

import {
  FACT_LOOKUP_TOOL,
  STANDING_FACTS_BUDGET_CHARS,
  buildFactsCore,
  buildFactsCorrection,
  factsCoreFingerprint,
  standingFactLine,
  standingFactsMarkdown,
  type StandingFact,
} from "../lib/standing-facts.js";

const fact = (id: number, text: string): StandingFact => ({
  id,
  fact: text,
  category: "travel",
  shelf: "conduct",
  sourceTurn: "t",
  userId: "fixture-owner",
  statedAt: new Date("2026-09-18T09:00:00Z"),
  recordedAt: new Date("2026-09-18T09:00:00Z"),
  retiredAt: null,
  supersededBy: null,
  source: "remember",
  origin: "owner",
});

/** What a real box actually holds: a handful of short sentences across the five categories. */
const REALISTIC: StandingFact[] = [
  { ...fact(11, "an intro call with no venue is remote"), category: "schedule", shelf: "conduct" },
  { ...fact(9, "I take the train between the two offices"), category: "travel", shelf: "conduct" },
  { ...fact(7, "window seat on anything over two hours"), category: "preference", shelf: "conduct" },
  { ...fact(4, "the north site is run out of the coastal office"), category: "places", shelf: "world" },
  { ...fact(2, "the finance lead answers on Thursdays only"), category: "people", shelf: "world" },
];

/** Drives the resolver's `session.started` handler the way eve does. */
type Resolver = { events: Record<string, (event: unknown, ctx: unknown) => Promise<{ markdown: string }>> };

async function loadResolver(): Promise<Resolver> {
  return (await import("../agent/instructions/standing-facts.js")).default as unknown as Resolver;
}

describe("buildFactsCore", () => {
  it("renders the same bytes for the same facts, every time", () => {
    const facts = [fact(1, "one"), fact(2, "two")];
    expect(buildFactsCore(facts).markdown).toBe(buildFactsCore(facts).markdown);
  });

  it("names no person and no persona", () => {
    const md = buildFactsCore([fact(1, "one")]).markdown;
    expect(md).not.toMatch(/bendik|saga|marcel|calliope/i);
    expect(md).toMatch(/^## What I have been told/m);
  });

  it("is empty for an empty set — never a heading over nothing", () => {
    expect(buildFactsCore([]).markdown).toBe("");
    expect(buildFactsCore([]).included).toBe(0);
    expect(buildFactsCore([]).omitted).toBe(0);
  });

  it("keeps the offered order — the caller decides what is most recent, not this function", () => {
    const core = buildFactsCore([fact(9, "newest"), fact(1, "oldest")]);
    expect(core.markdown.indexOf("newest")).toBeLessThan(core.markdown.indexOf("oldest"));
  });

  it("includes only owner-origin facts, whatever it is handed", () => {
    const tainted = { ...fact(2, "planted"), origin: "third_party" as const };
    const core = buildFactsCore([fact(1, "real"), tainted]);
    expect(core.markdown).toContain("real");
    expect(core.markdown).not.toContain("planted");
    expect(core.included).toBe(1);
  });

  // ── the budget ──────────────────────────────────────────────────────────────
  //
  // The rule this slice will not break: a fact the owner stated never disappears from the block
  // with no way for the agent to get it back. Nothing in this service lists standing facts today
  // (`remember` writes, `forget` retires by id), so the budget REPORTS and does not cut.

  it("a realistic box renders exactly the facts it renders today — the budget changes nothing", () => {
    const core = buildFactsCore(REALISTIC);
    expect(core.markdown.length).toBeLessThan(STANDING_FACTS_BUDGET_CHARS);
    expect(core.included).toBe(REALISTIC.length);
    expect(core.omitted).toBe(0);
    expect(core.overBudget).toBe(false);
    // The fact lines are the SAME lines, in the same order, as the unbudgeted render.
    expect(core.markdown.split("\n").filter((l) => l.startsWith("- ["))).toEqual(
      REALISTIC.map(standingFactLine),
    );
    expect(core.markdown).toBe(standingFactsMarkdown(REALISTIC));
    expect(core.markdown).not.toMatch(/not shown here/);
  });

  it("cuts at the character budget BY DEFAULT now that facts_list can list the rest back", () => {
    // facts_list ships in this slice, so the default lookup is no longer null — the budget cuts
    // without a caller having to name the tool explicitly. (Passing `null` explicitly is still
    // the no-cut path — see the "stops at the character budget…" test below for the cutting
    // shape, exercised here through the DEFAULT parameter instead of an explicit third argument.)
    expect(FACT_LOOKUP_TOOL).toBe("facts_list");
    const long = Array.from({ length: 60 }, (_, i) => fact(i + 1, "x".repeat(200)));
    const core = buildFactsCore(long);
    expect(core.included).toBeGreaterThan(0);
    expect(core.included).toBeLessThan(long.length);
    expect(core.omitted).toBe(long.length - core.included);
    expect(core.overBudget).toBe(false);
    expect(core.markdown.length).toBeLessThanOrEqual(STANDING_FACTS_BUDGET_CHARS);
    expect(core.markdown).toContain("facts_list");
  });

  it("stops at the character budget and says how many it left out, once a tool can list them", () => {
    const long = Array.from({ length: 60 }, (_, i) => fact(i + 1, "x".repeat(200)));
    const core = buildFactsCore(long, STANDING_FACTS_BUDGET_CHARS, "facts_list");
    expect(core.markdown.length).toBeLessThanOrEqual(STANDING_FACTS_BUDGET_CHARS);
    expect(core.included).toBeGreaterThan(0);
    expect(core.omitted).toBe(long.length - core.included);
    // No `\b` before the digits: the line opens with markdown's italic `_`, which is itself a
    // word character, so there is no boundary between it and the count.
    expect(core.markdown).toMatch(/\d+ older ones are not shown here\b/);
    expect(core.markdown).toContain("facts_list");
    // Newest first is the rule, and the cut takes from the END of the offered order.
    expect(core.markdown).toContain("[1]");
    expect(core.markdown).not.toContain(`[${long.length}]`);
  });

  it("renders the same bytes for the same facts when it does cut", () => {
    const long = Array.from({ length: 60 }, (_, i) => fact(i + 1, "x".repeat(200)));
    expect(buildFactsCore(long, 2_000, "facts_list").markdown).toBe(
      buildFactsCore(long, 2_000, "facts_list").markdown,
    );
  });
});

describe("factsCoreFingerprint", () => {
  it("is the same for the same ids and retirement state", () => {
    expect(factsCoreFingerprint([fact(1, "a"), fact(2, "b")])).toBe(
      factsCoreFingerprint([fact(1, "a-reworded"), fact(2, "b")]),
    );
  });

  it("changes when a fact is added, and when one is retired", () => {
    const base = [fact(1, "a")];
    expect(factsCoreFingerprint([...base, fact(2, "b")])).not.toBe(factsCoreFingerprint(base));
    expect(factsCoreFingerprint([{ ...fact(1, "a"), retiredAt: new Date() }])).not.toBe(
      factsCoreFingerprint(base),
    );
  });

  it("carries no fact text — it travels beside a prompt, so it must not be readable as one", () => {
    expect(factsCoreFingerprint([fact(1, "a secret the owner stated")])).not.toContain("secret");
  });
});

describe("guarded", () => {
  it("answers with an empty block instead of throwing, and logs one line", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const provider = guarded(
        { forSession: async () => { throw new Error("db down"); } },
        { timeoutMs: 50, label: "test: memory core" },
      );
      expect(await provider.forSession("s")).toBe("");
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toContain("test: memory core");
    } finally {
      error.mockRestore();
    }
  });

  it("answers with an empty block when the provider stalls, inside the bound", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const provider = guarded(
        { forSession: () => new Promise<string>(() => {}) },
        { timeoutMs: 50, label: "test: memory core" },
      );
      const startedAt = Date.now();
      expect(await provider.forSession("s")).toBe("");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      error.mockRestore();
    }
  });

  it("passes a working provider's block through unchanged", async () => {
    const provider = guarded({ forSession: async () => "## block" }, { timeoutMs: 500, label: "t" });
    expect(await provider.forSession("s")).toBe("## block");
  });
});

describe("the resolver", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../lib/standing-facts.js");
    vi.doUnmock("../lib/identity-client.js");
    vi.doUnmock("@lares/agent-kit/db");
    vi.restoreAllMocks();
  });

  // ── W5I-s5b: the owner-key/register check is fired here, but never waited on ──────────────
  it("kicks off the owner-key/register check once per process, without ever awaiting it", async () => {
    let checkCalls = 0;
    vi.doMock("../lib/identity-client.js", async (orig) => ({
      ...(await orig<typeof import("../lib/identity-client.js")>()),
      // Never resolves within the test's lifetime — if the resolver awaited this, the assertion
      // below on elapsed time (and on the resolver returning at all) would fail.
      checkOwnerKeyAgreement: vi.fn(() => {
        checkCalls++;
        return new Promise<never>(() => {});
      }),
    }));
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => [fact(1, "one")],
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const mod = await loadResolver();
    const startedAt = Date.now();
    const first = await mod.events["session.started"]!({}, { session: { id: "s-owner-key-1" } });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(first.markdown).toContain("one");

    // A second session in the same process must not fire the check again — once per PROCESS,
    // not once per session.
    await mod.events["session.started"]!({}, { session: { id: "s-owner-key-2" } });
    expect(checkCalls).toBe(1);
  });

  it("a throwing owner-key check changes nothing about the turn", async () => {
    vi.doMock("../lib/identity-client.js", async (orig) => ({
      ...(await orig<typeof import("../lib/identity-client.js")>()),
      checkOwnerKeyAgreement: vi.fn(() => Promise.reject(new Error("register unreachable"))),
    }));
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => [fact(1, "one")],
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const mod = await loadResolver();
    const out = await mod.events["session.started"]!({}, { session: { id: "s-owner-key-throw" } });
    expect(out.markdown).toContain("one");
  });

  it("subscribes to session.started and turn.started (W4B-s3 adds the second)", async () => {
    const mod = await loadResolver();
    expect(Object.keys(mod.events).sort()).toEqual(["session.started", "turn.started"]);
  });

  it("reads the store once per session, however many turns run", async () => {
    const read = vi.fn().mockResolvedValue([fact(1, "one")]);
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: read,
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));
    const mod = await loadResolver();
    const ctx = { session: { id: "s1" } };
    const a = await mod.events["session.started"]!({}, ctx);
    const b = await mod.events["session.started"]!({}, ctx);
    expect(read).toHaveBeenCalledTimes(1);
    expect(a.markdown).toBe(b.markdown);
    expect(a.markdown).toContain("one");
  });

  it("renders the identical bytes for a second turn with the table CHANGED in between", async () => {
    // The cache-stability claim, stated as the thing that would break it: the block a session
    // was built with does not follow the table. (What DOES honour a mid-session change is the
    // turn-scoped addendum — W4B-s3, not this slice.)
    let answer: StandingFact[] = [fact(1, "one")];
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => answer,
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));
    const mod = await loadResolver();
    const ctx = { session: { id: "s-stable" } };
    const first = await mod.events["session.started"]!({}, ctx);
    answer = [fact(2, "stated after the block was built"), fact(1, "one")];
    const second = await mod.events["session.started"]!({}, ctx);
    expect(second.markdown).toBe(first.markdown);
    expect(second.markdown).not.toContain("stated after the block was built");

    // A DIFFERENT session does see the change — the block is per session, not per process.
    const fresh = await mod.events["session.started"]!({}, { session: { id: "s-stable-2" } });
    expect(fresh.markdown).toContain("stated after the block was built");
  });

  it("answers with an empty block rather than throwing when the store is unreachable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => {
        throw new Error("db down");
      },
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));
    const mod = await loadResolver();
    const out = await mod.events["session.started"]!({}, { session: { id: "s2" } });
    expect(out.markdown).toBe("");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("does not remember a session it failed to build a block for — a later one picks it up", async () => {
    // What W4B-s3 will diff against must never be a block the model was not shown.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => {
        if (fail) throw new Error("db down");
        return [fact(1, "one")];
      },
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));
    const mod = await loadResolver();
    expect((await mod.events["session.started"]!({}, { session: { id: "s3" } })).markdown).toBe("");
    fail = false;
    expect((await mod.events["session.started"]!({}, { session: { id: "s4" } })).markdown).toContain("one");
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("buildFactsCorrection", () => {
  const a = fact(1, "I take the train");
  const b = fact(2, "an intro call with no venue is remote");

  it("is empty when nothing has changed — the case that must cost nothing", () => {
    expect(buildFactsCorrection([a, b], [a, b])).toBe("");
    expect(buildFactsCorrection([], [])).toBe("");
  });

  it("names a fact retired since the session began, so it stops applying on the next turn", () => {
    const retired = { ...a, retiredAt: new Date("2026-09-18T10:00:00Z") };
    const out = buildFactsCorrection([a, b], [retired, b]);
    expect(out).toMatch(/^## Since this conversation began/m);
    expect(out).toContain("no longer applies");
    expect(out).toContain("I take the train");
    expect(out).not.toContain("an intro call");
  });

  it("names a fact added since the session began", () => {
    const out = buildFactsCorrection([a], [a, b]);
    expect(out).toContain("an intro call with no venue is remote");
    expect(out).toMatch(/also been told/i);
  });

  it("reports a retirement and an addition in one block, retirements first", () => {
    const retired = { ...a, retiredAt: new Date() };
    const out = buildFactsCorrection([a], [retired, b]);
    expect(out.indexOf("no longer applies")).toBeLessThan(out.indexOf("also been told"));
  });

  it("ignores a reworded fact with the same id — text is not what makes a change", () => {
    expect(buildFactsCorrection([a], [{ ...a, fact: "reworded" }])).toBe("");
  });
});

describe("the resolver's turn-scoped half", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../lib/standing-facts.js");
    vi.doUnmock("@lares/agent-kit/db");
    vi.restoreAllMocks();
  });

  it("subscribes to both events and emits nothing on an unchanged turn", async () => {
    const facts = [fact(1, "one")];
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => facts,
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));
    const mod = (await import("../agent/instructions/standing-facts.js")).default as never;
    const events = (mod as { events: Record<string, (e: unknown, c: unknown) => Promise<{ markdown: string }>> }).events;
    expect(Object.keys(events).sort()).toEqual(["session.started", "turn.started"]);
    const ctx = { session: { id: "s3" } } as never;
    await events["session.started"]!({}, ctx);
    expect((await events["turn.started"]!({}, ctx)).markdown).toBe("");
  });

  it("emits nothing for a turn whose session it never built a block for", async () => {
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));
    const mod = (await import("../agent/instructions/standing-facts.js")).default as never;
    const events = (mod as { events: Record<string, (e: unknown, c: unknown) => Promise<{ markdown: string }>> }).events;
    expect((await events["turn.started"]!({}, { session: { id: "never-seen" } } as never)).markdown).toBe("");
  });
});

// ── W5A-s2: the session block writes down what it showed ──────────────────────
//
// `memory_use` (073) says a fact has ever been used; `memory_reads` (075) says which SESSION's
// block used it, so `recordRead` is what makes the answer to "which memories did this answer
// use" possible at all. Only the recorder's OWN behaviour is under test here — `recordRead`
// itself (never throws, no-ops on empty refs, warns once) is `tests/memory-reads.test.ts`'s job.
describe("the session block writes down what it showed", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../lib/standing-facts.js");
    vi.doUnmock("../lib/memory-reads.js");
    vi.doUnmock("../lib/agent-notes.js");
    vi.doUnmock("@lares/agent-kit/db");
    vi.restoreAllMocks();
  });

  it("records the included fact ids under turn_id '', and not the ones the budget cut", async () => {
    const recorded: Array<{ turnId: string; kind: string; refs: readonly string[] }> = [];
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async (
        _db: unknown,
        r: { turnId: string; kind: string; refs: readonly string[] },
      ) => {
        recorded.push({ turnId: r.turnId, kind: r.kind, refs: r.refs });
      },
      resetReadWarningForTests: () => {},
    }));
    // Long enough that buildFactsCore's default (facts_list-backed) budget cuts some of them —
    // the same fixture shape as the "cuts at the character budget" test above.
    const long = Array.from({ length: 60 }, (_, i) => fact(i + 1, "x".repeat(200)));
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => long,
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const mod = await loadResolver();
    await mod.events["session.started"]!({}, { session: { id: "session-1" } });

    const core = buildFactsCore(long);
    expect(core.omitted).toBeGreaterThan(0); // the fixture must actually exercise a cut
    const facts = recorded.find((r) => r.kind === "standing_fact")!;
    expect(facts.turnId).toBe("");
    expect(facts.refs).toEqual(long.slice(0, core.included).map((f) => String(f.id)));
  });

  it("records the notes the correction block surfaced, under the same session and turn_id ''", async () => {
    const recorded: Array<{ turnId: string; kind: string; refs: readonly string[] }> = [];
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async (
        _db: unknown,
        r: { turnId: string; kind: string; refs: readonly string[] },
      ) => {
        recorded.push({ turnId: r.turnId, kind: r.kind, refs: r.refs });
      },
      resetReadWarningForTests: () => {},
    }));
    const facts = [fact(1, "one")];
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => facts,
    }));
    // One note safe to surface (agent-origin), one that must never re-enter the prompt
    // (third_party) — the recorder must claim only the one the correction block actually shows.
    vi.doMock("../lib/agent-notes.js", () => ({
      notesForSession: async () => [
        {
          id: 5,
          owner: "fixture-owner",
          agent: "test-agent",
          kind: "working",
          note: "a safe note",
          origin: "agent",
          sessionId: "session-1",
          turnId: "t1",
          at: new Date("2026-09-19T09:00:00Z"),
        },
        {
          id: 6,
          owner: "fixture-owner",
          agent: "test-agent",
          kind: "working",
          note: "a planted note",
          origin: "third_party",
          sessionId: "session-1",
          turnId: "t1",
          at: new Date("2026-09-19T09:00:00Z"),
        },
      ],
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const mod = await loadResolver();
    const ctx = { session: { id: "session-1" } };
    await mod.events["session.started"]!({}, ctx);
    await mod.events["turn.started"]!({}, ctx);

    const notesRecord = recorded.find((r) => r.kind === "agent_note")!;
    expect(notesRecord.turnId).toBe("");
    expect(notesRecord.refs).toContain("5");
    expect(notesRecord.refs).not.toContain("6");
  });

  it("does not change the session block's bytes — recording is a side effect, not a rendering step", async () => {
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async () => {},
      resetReadWarningForTests: () => {},
    }));
    const facts = REALISTIC;
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => facts,
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const mod = await loadResolver();
    const out = await mod.events["session.started"]!({}, { session: { id: "session-bytes" } });
    expect(out.markdown).toBe(buildFactsCore(facts).markdown);
  });
});
