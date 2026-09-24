/**
 * tests/memory-reads-tools.test.ts — the four read tools record what they opened (W5A-s3).
 *
 * `facts_list` and `agent-kit__vault_read` each fetch a specific remembered thing
 * by id or by path (never a search hit — Owner decision A2) and now call `recordRead`
 * (`lib/memory-reads.ts`, box 075) so a later `memory_used` call can say this turn's answer
 * opened it. `recordRead` itself — never throws, no-ops on an empty ref list, warns once — is
 * `tests/memory-reads.test.ts`'s job; only the CALL SITES are under test here: which kind, which
 * ref, and that a turn that cannot be named records nothing rather than a guess.
 *
 * MOCKING RULE (WAVE-3 note, "Added after W3A-s5/s6"): every `vi.doMock` here is paired with a
 * dynamic `await import(...)` AFTER `vi.resetModules()`, and undone in `afterEach` — a static
 * top-level import would bind to a different module instance than the mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StandingFact } from "../lib/standing-facts.js";
import { configuredOwnerId } from "../lib/identity-client.js";

const fact = (id: number, text: string): StandingFact => ({
  id,
  fact: text,
  category: "preference",
  shelf: "conduct",
  sourceTurn: "t",
  userId: "fixture-owner",
  statedAt: new Date("2026-09-19T09:00:00Z"),
  recordedAt: new Date("2026-09-19T09:00:00Z"),
  retiredAt: null,
  supersededBy: null,
  source: "remember",
  origin: "owner",
});

let dir: string;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../lib/memory-reads.js");
  vi.doUnmock("../lib/standing-facts.js");
  vi.doUnmock("@lares/agent-kit/db");
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env["VAULT_PATH"];
  delete process.env["ATLAS_PATH"];
});

describe("facts_list records what it handed back", () => {
  it("records every id it returned, against this turn", async () => {
    const recorded: Array<{ sessionId: string; turnId: string; owner: string; kind: string; refs: readonly string[] }> = [];
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async (
        _db: unknown,
        r: { sessionId: string; turnId: string; owner: string; kind: string; refs: readonly string[] },
      ) => {
        recorded.push(r);
      },
      resetReadWarningForTests: () => {},
    }));
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => [fact(1, "window seat"), fact(2, "train between offices")],
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const tool = (await import("../catalogue/facts_list.js")).default;
    await tool.execute({}, { session: { id: "s1", turn: { id: "t7" }, auth: null } } as never);

    expect(recorded).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        turnId: "t7",
        owner: configuredOwnerId(),
        kind: "standing_fact",
        refs: ["1", "2"],
      }),
    ]);
  });

  it("records only the ids the category filter actually returned", async () => {
    const recorded: Array<{ refs: readonly string[] }> = [];
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async (_db: unknown, r: { refs: readonly string[] }) => {
        recorded.push(r);
      },
      resetReadWarningForTests: () => {},
    }));
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => [
        { ...fact(1, "window seat"), category: "travel" as const },
        { ...fact(2, "train between offices"), category: "preference" as const },
      ],
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const tool = (await import("../catalogue/facts_list.js")).default;
    await tool.execute(
      { category: "preference" },
      { session: { id: "s1", turn: { id: "t7" }, auth: null } } as never,
    );

    expect(recorded).toEqual([expect.objectContaining({ refs: ["2"] })]);
  });

  it("records nothing at all when the turn cannot be named", async () => {
    const recorded: unknown[] = [];
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async (_db: unknown, r: unknown) => {
        recorded.push(r);
      },
      resetReadWarningForTests: () => {},
    }));
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => [fact(1, "window seat")],
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const tool = (await import("../catalogue/facts_list.js")).default;
    await tool.execute({}, { session: { id: "s1", auth: null } } as never);

    expect(recorded).toHaveLength(0);
  });
});

// ── facts_list retired=true — "what have I retired?" (owner ruling, 2026-09-19 afternoon) ─────

describe("facts_list retired=true", () => {
  it("lists retired facts, mapped to id/text/category/statedAt/retiredAt/supersededBy, and records nothing", async () => {
    const recorded: unknown[] = [];
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async (_db: unknown, r: unknown) => {
        recorded.push(r);
      },
      resetReadWarningForTests: () => {},
    }));
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listRetiredFacts: async () => ({
        cut: false,
        facts: [
          {
            id: 2,
            fact: "gluten free",
            category: "preference",
            statedAt: new Date("2026-09-01T00:00:00Z"),
            retiredAt: new Date("2026-09-10T00:00:00Z"),
            supersededBy: null,
          },
          {
            // No `supersededBy` key at all — the pre-005 fallback shape.
            id: 1,
            fact: "I take the car",
            category: "travel",
            statedAt: new Date("2026-08-01T00:00:00Z"),
            retiredAt: new Date("2026-09-01T00:00:00Z"),
          },
        ],
      }),
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const tool = (await import("../catalogue/facts_list.js")).default;
    const result = await tool.execute(
      { retired: true },
      { session: { id: "s1", turn: { id: "t7" }, auth: null } } as never,
    );

    expect(result.facts).toEqual([
      {
        id: 2,
        text: "gluten free",
        category: "preference",
        statedAt: "2026-09-01T00:00:00.000Z",
        retiredAt: "2026-09-10T00:00:00.000Z",
        supersededBy: null,
      },
      {
        id: 1,
        text: "I take the car",
        category: "travel",
        statedAt: "2026-08-01T00:00:00.000Z",
        retiredAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    // Retired facts never enter the per-session block or the correction note, and this call is
    // not a use of the active facts — recordRead is never called for it.
    expect(recorded).toHaveLength(0);
  });

  it("says when the list was cut at the cap", async () => {
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async () => {},
      resetReadWarningForTests: () => {},
    }));
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listRetiredFacts: async () => ({ cut: true, facts: [] }),
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const tool = (await import("../catalogue/facts_list.js")).default;
    const result = await tool.execute(
      { retired: true },
      { session: { id: "s1", turn: { id: "t7" }, auth: null } } as never,
    );

    expect(result.message).toMatch(/cut|more|limit|50/i);
  });

  it("fails soft with an honest message and never throws when the box cannot list retired facts", async () => {
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async () => {},
      resetReadWarningForTests: () => {},
    }));
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listRetiredFacts: async () => {
        const err = new Error('relation "standing_facts" does not exist') as Error & { code?: string };
        err.code = "42P01";
        throw err;
      },
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const tool = (await import("../catalogue/facts_list.js")).default;
    const result = await tool.execute(
      { retired: true },
      { session: { id: "s1", turn: { id: "t7" }, auth: null } } as never,
    );

    expect(result.facts).toEqual([]);
    expect(result.message).toMatch(/cannot list retired facts on this installation yet/i);
  });

  it("leaves the default (no `retired`) behaviour byte-for-byte the same", async () => {
    const recorded: unknown[] = [];
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async (_db: unknown, r: unknown) => {
        recorded.push(r);
      },
      resetReadWarningForTests: () => {},
    }));
    vi.doMock("../lib/standing-facts.js", async (orig) => ({
      ...(await orig<typeof import("../lib/standing-facts.js")>()),
      listActiveFacts: async () => [fact(1, "window seat")],
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const tool = (await import("../catalogue/facts_list.js")).default;
    const result = await tool.execute(
      {},
      { session: { id: "s1", turn: { id: "t7" }, auth: null } } as never,
    );

    expect(result).toEqual({ facts: [{ id: 1, fact: "window seat", category: "preference" }] });
    expect(recorded).toEqual([
      expect.objectContaining({ sessionId: "s1", turnId: "t7", kind: "standing_fact", refs: ["1"] }),
    ]);
  });
});

// ── agent-kit__vault_read: the path ASKED FOR, never one parsed out of the body ──
//
// W5C-s3: there is ONE read tool now, told which AREA to open, so the separate `atlas_read`
// this block used to drive is gone and both cases below go through
// `catalogue/agent-kit__vault_read.ts` with a different `area`. It is built by the `readTool`
// factory (`@lares/agent-kit/note-tools`) and wires the factory's `onRead` dep to `recordRead`,
// which is what the two cases prove: the same recording shape whichever area was opened.

function seedStore(env: "ATLAS_PATH" | "VAULT_PATH", note: string, body: string): void {
  dir = mkdtempSync(join(tmpdir(), "eve-memory-reads-"));
  const abs = join(dir, note);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  process.env[env] = dir;
}

describe("a vault read records the path it was asked for", () => {
  it("the shared area: the recorded ref is the requested path, not one found in the body", async () => {
    seedStore(
      "ATLAS_PATH",
      "people/ada.md",
      "# Ada\n\nSee also people/decoy.md for the old notes.\n",
    );
    const recorded: Array<{ sessionId: string; turnId: string; kind: string; refs: readonly string[] }> = [];
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async (
        _db: unknown,
        r: { sessionId: string; turnId: string; kind: string; refs: readonly string[] },
      ) => {
        recorded.push(r);
      },
      resetReadWarningForTests: () => {},
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const tool = (await import("../catalogue/agent-kit__vault_read.js")).default;
    await tool.execute(
      { area: "shared", path: "people/ada.md" },
      { session: { id: "s1", turn: { id: "t1" }, auth: null } } as never,
    );

    expect(recorded).toEqual([
      expect.objectContaining({ sessionId: "s1", turnId: "t1", kind: "vault_note", refs: ["people/ada.md"] }),
    ]);
  });

  it("the private area: same shape, same recording", async () => {
    seedStore("VAULT_PATH", "people/ada.md", "# Ada\n\nSee also people/decoy.md.\n");
    const recorded: Array<{ sessionId: string; turnId: string; kind: string; refs: readonly string[] }> = [];
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async (
        _db: unknown,
        r: { sessionId: string; turnId: string; kind: string; refs: readonly string[] },
      ) => {
        recorded.push(r);
      },
      resetReadWarningForTests: () => {},
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const tool = (await import("../catalogue/agent-kit__vault_read.js")).default;
    await tool.execute(
      { area: "private", path: "people/ada.md" },
      { session: { id: "s1", turn: { id: "t1" }, auth: null } } as never,
    );

    expect(recorded).toEqual([
      expect.objectContaining({ sessionId: "s1", turnId: "t1", kind: "vault_note", refs: ["people/ada.md"] }),
    ]);
  });

  it("records nothing when the turn cannot be named, and nothing when the read throws", async () => {
    seedStore("ATLAS_PATH", "people/ada.md", "# Ada\n");
    const recorded: unknown[] = [];
    vi.doMock("../lib/memory-reads.js", () => ({
      READ_KINDS: ["standing_fact", "preference", "vault_note", "agent_note"],
      recordRead: async (_db: unknown, r: unknown) => {
        recorded.push(r);
      },
      resetReadWarningForTests: () => {},
    }));
    vi.doMock("@lares/agent-kit/db", () => ({ getPool: () => ({}) }));

    const tool = (await import("../catalogue/agent-kit__vault_read.js")).default;

    // No turn id on ctx.
    await tool.execute({ area: "shared", path: "people/ada.md" }, { session: { id: "s1", auth: null } } as never);
    expect(recorded).toHaveLength(0);

    // A read that throws (missing note) opened nothing.
    await expect(
      tool.execute(
        { area: "shared", path: "people/missing.md" },
        { session: { id: "s1", turn: { id: "t1" }, auth: null } } as never,
      ),
    ).rejects.toThrow();
    expect(recorded).toHaveLength(0);
  });
});
