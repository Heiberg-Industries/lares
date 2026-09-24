/**
 * W5X-s4 — the dream FILES its confirmations instead of shouting them.
 *
 * Until this slice a run's `needsConfirm` items were announced in one combined reminder and
 * could not be answered by any code path: `lib/dream/surface.ts`'s `resolve()` takes the
 * observation OBJECT, there was no durable row, no id in the notice and no route that could
 * look one up. Now each shown item becomes a `memory_proposals` row with action `add`, which
 * is the one lane that already has an id, a guarded decision, an apply pass, a list tool and
 * an announcement schedule. The dream sends nothing at all.
 *
 * WHAT THIS FILE IS FOR, in one line: proving that an unattended inference reaches the owner
 * exactly once, as something they can answer, and never floods them.
 *
 * The five properties, and where each is proven below:
 *   1. the owner is never flooded — the per-run cap on how many adds may be FILED, and the
 *      whole-queue `MEMORY_PROPOSAL_OPEN_CAP` counted across supersede + add together; what is
 *      held back is counted and returned, never dropped;
 *   2. the same inference is not re-filed night after night — the dedup key is `deriveRef`,
 *      a deterministic hash of the observation's subject + text;
 *   3. a REJECTED add is not raised again unless something new is observed, which is exactly
 *      what `memoryRejectConsequence({action: "add"})` promises the owner in words;
 *   4. a run whose agent inferences were filed is NOT an all-rejected run;
 *   5. only an `agent`-origin observation becomes an add — somebody else's words are rejected
 *      `not-owner-origin` by the gate and never reach the queue at all.
 *
 * `memory_proposals` lives on the box's shared `lares_state` database
 * (services/box/sql/072_memory_proposals.sql, altered by 074_memory_proposal_add.sql) and is
 * mirrored here rather than imported, the same convention as `tests/memory-proposals.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getPool, closePool } from "@lares/agent-kit/db";
import {
  getOpenMemoryProposals,
  insertMemoryProposal,
  memoryRejectConsequence,
  resolveMemoryProposal,
  type MemoryProposalInput,
} from "../lib/proposals-store.js";
import {
  MEMORY_PROPOSAL_OPEN_CAP,
  makePromoter,
  makeProposeAdd,
  resetProposeWarningForTests,
  type ProposeAddOutcome,
} from "../lib/dream/promote.js";
import { applyMemoryProposal } from "../lib/memory-proposal-apply.js";
import { deriveRef, DREAM_CONFIRM_MAX_PER_RUN } from "../lib/dream/surface.js";
import { everythingRejected } from "../lib/dream/cycle.js";
import { fileConfirmations } from "../agent/schedules/dream.js";
import { ensureDreamTables, makeDreamStore } from "../lib/dream/store.js";
import type { Observation } from "../lib/dream/reflect.js";

/** Mirrors services/box/sql/072 as 074 leaves it — see this file's header. */
const MEMORY_PROPOSALS_SCHEMA = `
CREATE TABLE memory_proposals (
  id            bigserial   PRIMARY KEY,
  action        text        NOT NULL,
  existing_id   text        NOT NULL,
  existing_text text        NOT NULL,
  proposed_text text        NOT NULL DEFAULT '',
  subject       text        NOT NULL DEFAULT '',
  origin        text        NOT NULL,
  source        text        NOT NULL,
  state         text        NOT NULL DEFAULT 'pending',
  ref           text        NOT NULL DEFAULT '',
  kind          text        NOT NULL DEFAULT '',
  announced_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_proposals_action_check CHECK (action IN ('supersede', 'retire', 'add')),
  CONSTRAINT memory_proposals_state_check
    CHECK (state IN ('pending', 'approved', 'rejected', 'applied', 'superseded')),
  CONSTRAINT memory_proposals_origin_check CHECK (
    (action IN ('supersede', 'retire') AND origin = 'owner') OR
    (action = 'add'                    AND origin = 'agent')
  ),
  CONSTRAINT memory_proposals_text_check CHECK (
    (action = 'supersede' AND length(proposed_text) > 0) OR
    (action = 'retire'    AND proposed_text = '')        OR
    (action = 'add' AND length(proposed_text) > 0 AND existing_text = '' AND existing_id = ''
                   AND length(ref) > 0 AND length(kind) > 0)
  )
);
CREATE UNIQUE INDEX memory_proposals_open_idx
  ON memory_proposals (existing_id) WHERE state IN ('pending', 'approved') AND action <> 'add';
CREATE UNIQUE INDEX memory_proposals_add_open_idx
  ON memory_proposals (ref) WHERE state IN ('pending', 'approved') AND action = 'add';
`;

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
  await pool.query(MEMORY_PROPOSALS_SCHEMA);
  await ensureDreamTables(pool);
}, 180_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

beforeEach(async () => {
  await getPool().query("DELETE FROM memory_proposals");
  await getPool().query("DELETE FROM dream_preferences");
  await getPool().query("DELETE FROM dream_observations");
  resetProposeWarningForTests();
});

/** A neutral agent-origin inference — the only class that may become an `add`. The owner id in
 *  this service's fixtures is "fixture-owner"; nothing on this path reads one. */
function inference(over: Partial<Observation> = {}): Observation {
  return {
    text: "prefers short replies",
    kind: "preference",
    subject: "tone",
    confidence: 0.4,
    evidenceRefs: ["2026-09-18T09:00:00.000Z"],
    origin: "agent",
    ...over,
  };
}

const fiveObservations = Array.from({ length: 5 }, (_, i) =>
  inference({ text: `fixture inference ${i}`, subject: `fixture-subject-${i}` }),
);

const store = () => makeDreamStore(getPool(), "fixture-owner");

const supersedeProposal = (existingId: string): MemoryProposalInput => ({
  action: "supersede",
  existingId,
  existingText: "I take the train",
  proposedText: "I drive now",
  subject: "travel",
  origin: "owner",
  source: "dream-cycle-2026-09-18",
  ref: "",
  kind: "",
});

// ── 1. The ref — why the same inference maps to the same row ──────────────────────────────

describe("deriveRef — the dedup key an add is filed under", () => {
  it("the same subject and text give the same ref, whatever the spacing or case", () => {
    expect(deriveRef({ subject: "tone", text: "prefers short replies" })).toBe(
      deriveRef({ subject: " Tone ", text: "  Prefers Short Replies " }),
    );
  });

  it("a different observation gives a different ref — that is what 'something new' means", () => {
    const base = deriveRef({ subject: "tone", text: "prefers short replies" });
    expect(deriveRef({ subject: "tone", text: "prefers long replies" })).not.toBe(base);
    expect(deriveRef({ subject: "format", text: "prefers short replies" })).not.toBe(base);
  });
});

// ── 2. fileConfirmations — the cap, and the silence ───────────────────────────────────────

describe("fileConfirmations — what a run may file, and what it says about the rest", () => {
  it("files at most DREAM_CONFIRM_MAX_PER_RUN proposals and reports the rest as held back", async () => {
    const filedRefs: string[] = [];
    const { filed, heldBack } = await fileConfirmations(fiveObservations, {
      propose: async (o) => {
        filedRefs.push(deriveRef(o));
        return filedRefs.length;
      },
    });
    expect(DREAM_CONFIRM_MAX_PER_RUN).toBe(3);
    expect(filed).toEqual([1, 2, 3]);
    expect(heldBack).toBe(2);
    expect(new Set(filedRefs).size).toBe(3);
  });

  it("sends nothing itself — the announcement lane owns the message", async () => {
    const sends: string[] = [];
    await fileConfirmations(fiveObservations, { propose: async () => 1 });
    expect(sends).toHaveLength(0);
  });

  it("nothing to confirm ⇒ nothing filed and nothing proposed", async () => {
    let calls = 0;
    const out = await fileConfirmations([], {
      propose: async () => {
        calls += 1;
        return 1;
      },
    });
    expect(out).toEqual({ filed: [], heldBack: 0 });
    expect(calls).toBe(0);
  });

  it("an item the queue would not take is simply not in `filed` — and never counted as held back", async () => {
    const { filed, heldBack } = await fileConfirmations(fiveObservations, {
      max: 5,
      propose: async (o) => (o.text.endsWith("2") ? 42 : null),
    });
    expect(filed).toEqual([42]);
    expect(heldBack).toBe(0);
  });

  it("one proposal blowing up does not cost the run the others", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { filed } = await fileConfirmations(fiveObservations, {
        propose: async (o) => {
          if (o.text.endsWith("1")) throw new Error("pool exhausted");
          return 7;
        },
      });
      expect(filed).toEqual([7, 7]);
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });
});

// ── 3. The schedule itself sends nothing for a confirmation ───────────────────────────────

describe("the dream schedule no longer shouts", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../agent/schedules/dream.ts", import.meta.url)),
    "utf8",
  );

  it("files the run's confirmations instead of enqueuing a notice", () => {
    expect(src).toContain("fileConfirmations(result.needsConfirm");
    // The reminder send is gone outright — not merely unreachable. `proposals-watch` is the one
    // lane that tells the owner about a memory proposal now; two senders is the defect this
    // slice exists to prevent.
    expect(src).not.toContain("createReminder");
    // The old function is gone, not merely uncalled — prose naming it (this file's own history)
    // is the opposite of a finding, so this looks for a declaration or a call, not the word.
    expect(src).not.toMatch(/\bfunction sendConfirmationNotice\b/);
    expect(src).not.toMatch(/\bsendConfirmationNotice\(/);
    expect(src).not.toMatch(/\bbuildConfirmationNotice\b/);
  });
});

// ── 4. makeProposeAdd — the durable row ───────────────────────────────────────────────────

describe("makeProposeAdd — an inference becomes a row the owner can answer", () => {
  it("files the observation's own words, under its ref, as an agent-origin add", async () => {
    const outcomes: ProposeAddOutcome[] = [];
    const propose = makeProposeAdd(getPool(), { onOutcome: (o) => outcomes.push(o) });
    const obs = inference();
    const id = await propose(obs);

    expect(id).toBeTypeOf("number");
    expect(outcomes).toEqual(["recorded"]);
    const [row] = await getOpenMemoryProposals(getPool());
    expect(row).toMatchObject({
      id,
      action: "add",
      existingId: "",
      existingText: "",
      proposedText: "prefers short replies",
      subject: "tone",
      kind: "preference",
      ref: deriveRef(obs),
      origin: "agent",
      state: "pending",
    });
    expect(row!.source).toMatch(/^dream-cycle-\d{4}-\d{2}-\d{2}$/);
  });

  it("the same inference on a later night files nothing new", async () => {
    const outcomes: ProposeAddOutcome[] = [];
    const propose = makeProposeAdd(getPool(), { onOutcome: (o) => outcomes.push(o) });
    const first = await propose(inference());
    const second = await propose({ ...inference() });

    expect(first).toBeTypeOf("number");
    expect(second).toBe(null);
    expect(outcomes).toEqual(["recorded", "already-waiting"]);
    expect(await getOpenMemoryProposals(getPool())).toHaveLength(1);
  });

  it("a REJECTED add is not raised again — which is what the owner was promised in words", async () => {
    expect(memoryRejectConsequence({ action: "add" })).toContain(
      "not raised again unless something new is observed",
    );

    const outcomes: ProposeAddOutcome[] = [];
    const propose = makeProposeAdd(getPool(), { onOutcome: (o) => outcomes.push(o) });
    const id = await propose(inference());
    await resolveMemoryProposal(getPool(), id!, "reject");

    expect(await propose(inference())).toBe(null);
    expect(outcomes).toEqual(["recorded", "already-waiting"]);
    const { rows } = await getPool().query("SELECT id FROM memory_proposals");
    expect(rows).toHaveLength(1); // no second row, ever — the rejection stands
  });

  it("…unless something new is observed: a different wording is a different ref, and files", async () => {
    const propose = makeProposeAdd(getPool());
    await propose(inference());
    const id = await propose(inference({ text: "prefers short replies in the morning" }));
    expect(id).toBeTypeOf("number");
    expect(await getOpenMemoryProposals(getPool())).toHaveLength(2);
  });

  it("an add the owner already accepted is not proposed back to them", async () => {
    const propose = makeProposeAdd(getPool());
    const id = await propose(inference());
    await resolveMemoryProposal(getPool(), id!, "approve");
    await applyMemoryProposal(getPool(), id!);

    expect(await propose(inference())).toBe(null);
    expect((await store().activePreferences()).map((p) => p.text)).toEqual([
      "prefers short replies",
    ]);
  });

  it("counts an add against the same open-proposal cap as a supersede", async () => {
    for (let i = 0; i < MEMORY_PROPOSAL_OPEN_CAP; i++) {
      await insertMemoryProposal(getPool(), supersedeProposal(`older-${i}`));
    }
    const outcomes: ProposeAddOutcome[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const propose = makeProposeAdd(getPool(), { onOutcome: (o) => outcomes.push(o) });
      expect(await propose(inference())).toBe(null);
    } finally {
      warn.mockRestore();
    }
    expect(outcomes).toContain("queue-full");
    expect(await getOpenMemoryProposals(getPool())).toHaveLength(MEMORY_PROPOSAL_OPEN_CAP);
  });

  it("holds rather than files when the table has not been migrated", async () => {
    await getPool().query(
      "ALTER TABLE memory_proposals DROP CONSTRAINT memory_proposals_action_check",
    );
    await getPool().query(
      "ALTER TABLE memory_proposals ADD CONSTRAINT memory_proposals_action_check " +
        "CHECK (action IN ('supersede','retire'))",
    );
    const outcomes: ProposeAddOutcome[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const propose = makeProposeAdd(getPool(), { onOutcome: (o) => outcomes.push(o) });
      await expect(propose(inference())).resolves.toBe(null);
      expect(outcomes).toEqual(["not-installed"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("074_memory_proposal_add.sql");
    } finally {
      warn.mockRestore();
      await getPool().query(
        "ALTER TABLE memory_proposals DROP CONSTRAINT memory_proposals_action_check",
      );
      await getPool().query(
        "ALTER TABLE memory_proposals ADD CONSTRAINT memory_proposals_action_check " +
          "CHECK (action IN ('supersede','retire','add'))",
      );
    }
  });

  it("carries on when this installation has no queue at all", async () => {
    const outcomes: ProposeAddOutcome[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await getPool().query("DROP TABLE memory_proposals");
    try {
      const propose = makeProposeAdd(getPool(), { onOutcome: (o) => outcomes.push(o) });
      await expect(propose(inference())).resolves.toBe(null);
      expect(outcomes).toEqual(["not-installed"]);
    } finally {
      warn.mockRestore();
      await getPool().query(MEMORY_PROPOSALS_SCHEMA);
    }
  });

  it("refuses to file anything that is not the agent's own inference", async () => {
    const outcomes: ProposeAddOutcome[] = [];
    const propose = makeProposeAdd(getPool(), { onOutcome: (o) => outcomes.push(o) });
    for (const origin of ["third_party", "synced", "system", "owner"] as const) {
      expect(await propose(inference({ origin }))).toBe(null);
    }
    expect(outcomes).toEqual(Array(4).fill("not-agent-origin"));
    expect(await getOpenMemoryProposals(getPool())).toEqual([]);
  });
});

// ── 5. The gate above it: whose words may become a confirmation at all ────────────────────

describe("only the agent's own inference is ever put to the owner", () => {
  it("somebody else's words are rejected not-owner-origin and never reach the queue", async () => {
    const filed: string[] = [];
    const promoter = makePromoter({ store: store() });
    const result = await promoter.run(
      [inference({ origin: "third_party" }), inference({ origin: "synced", subject: "format" })],
      { source: "dream-cycle-test" },
    );

    expect(result.needsConfirm).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "not-owner-origin",
      "not-owner-origin",
    ]);

    const out = await fileConfirmations(result.needsConfirm as Observation[], {
      propose: async (o) => {
        filed.push(deriveRef(o));
        return 1;
      },
    });
    expect(out).toEqual({ filed: [], heldBack: 0 });
    expect(filed).toEqual([]);
    expect(await getOpenMemoryProposals(getPool())).toEqual([]);
  });

  it("a run whose inferences were FILED is not an all-rejected run", async () => {
    const promoter = makePromoter({ store: store() });
    const result = await promoter.run([inference()], { source: "dream-cycle-test" });

    // The gate both holds it for confirmation and reports it as not learned — the counts add up.
    expect(result.needsConfirm).toHaveLength(1);
    expect(result.rejected.map((r) => r.reason)).toEqual(["agent-inference"]);

    const { filed } = await fileConfirmations(result.needsConfirm, {
      propose: makeProposeAdd(getPool()),
    });
    expect(filed).toHaveLength(1);
    // The alarm is for a gate that lets nothing through at all. A night that asked the owner a
    // question is not that night, and filing the question must not change the meaning.
    expect(everythingRejected(result)).toBe(false);
  });
});
