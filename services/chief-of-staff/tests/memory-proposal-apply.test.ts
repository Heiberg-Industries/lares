/**
 * W4C-s5 — an unattended edit becomes a proposal, and only a 👍 applies it (ADR-0018 rule 2).
 *
 * Against a REAL Postgres (a testcontainer, the pattern `tests/memory-proposals.test.ts`
 * already uses), because every property this slice claims is a property of a transaction:
 * re-reading a row inside the write, refusing when it moved, applying exactly once.
 *
 * `memory_proposals` lives on the box's shared `lares_state` database
 * (services/box/sql/072_memory_proposals.sql) and is mirrored here rather than imported, the
 * same convention as `tests/proposals.test.ts`. The dream tables are created by the role's own
 * `ensureDreamTables`, which is where they are created in production too.
 *
 * WHAT THIS FILE IS FOR, in one line: proving that nothing between the reflector and the
 * standing preference can change what the owner believes without the owner saying so.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getPool, closePool } from "@lares/agent-kit/db";
import { resetTaintForTests, taintTurn } from "@lares/agent-kit/origin-taint";
import {
  getOpenMemoryProposals,
  insertMemoryProposal,
  resolveMemoryProposal,
  type MemoryProposalInput,
} from "../lib/proposals-store.js";
import {
  applyMemoryProposal,
  memoryProposalSource,
  ProposalNoLongerApplies,
} from "../lib/memory-proposal-apply.js";
import {
  MEMORY_PROPOSAL_OPEN_CAP,
  makePromoter,
  makeProposeSupersede,
  resetProposeWarningForTests,
  type ProposeOutcome,
} from "../lib/dream/promote.js";
import { ensureDreamTables, makeDreamStore } from "../lib/dream/store.js";
import { UnauthorizedApproverError } from "../lib/approvals.js";

/** Mirrors services/box/sql/072_memory_proposals.sql — see this file's header. */
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

const OWNER_TELEGRAM_ID = "fixture-owner-telegram";

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
  resetTaintForTests();
});

const store = () => makeDreamStore(getPool(), "fixture-owner");

/** A standing preference the OWNER put there — the class the gate refuses to overwrite. */
async function standingPreference(text = "I take the train", subject = "travel") {
  return store().addPreference({
    text, kind: "preference", subject, confidence: 1, origin: "owner",
  });
}

const proposalOn = (existingId: string, over: Partial<MemoryProposalInput> = {}): MemoryProposalInput => ({
  action: "supersede",
  existingId,
  existingText: "I take the train",
  proposedText: "I drive now",
  subject: "travel",
  origin: "owner",
  source: "dream-cycle-2026-09-18",
  ref: "",
  kind: "",
  ...over,
});

// ── 1. A nightly run may propose, never apply ─────────────────────────────────────────────

describe("a nightly run may propose, never apply", () => {
  it("queues a proposal instead of closing an owner-origin preference", async () => {
    const standing = await standingPreference();

    const promoter = makePromoter({ store: store() });
    const obs = (text: string) => ({
      text, kind: "preference", subject: "travel", confidence: 0.9,
      origin: "owner" as const, evidenceRefs: ["2026-09-16T08:00:00.000Z"],
    });
    const result = await promoter.run([obs("I drive now"), obs("I drive now")], {
      source: "dream-cycle-test",
    });

    // Nothing applied.
    const active = await store().activePreferences();
    expect(active.map((p) => p.text)).toContain("I take the train");
    expect(active.map((p) => p.text)).not.toContain("I drive now");
    expect(result.superseded).toEqual([]);
    expect(result.promoted).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toContain("supersede-awaits-owner");

    // One proposal waiting, carrying the LITERAL before and after.
    const [p] = await getOpenMemoryProposals(getPool());
    expect(p!.action).toBe("supersede");
    expect(p!.existingId).toBe(standing.id);
    expect(p!.existingText).toBe("I take the train");
    expect(p!.proposedText).toBe("I drive now");
    expect(p!.origin).toBe("owner");
  });

  it("a second night proposing the same change is held, not an error", async () => {
    const standing = await standingPreference();
    const seen: ProposeOutcome[] = [];
    const propose = makeProposeSupersede(getPool(), { onOutcome: (o) => seen.push(o) });
    const obs = {
      text: "I drive now", kind: "preference", subject: "travel", confidence: 0.9,
      origin: "owner" as const, evidenceRefs: [],
    };

    await propose(standing.id, obs);
    await expect(propose(standing.id, obs)).resolves.toBeNull();

    expect(seen).toEqual(["recorded", "already-waiting"]);
    expect(await getOpenMemoryProposals(getPool())).toHaveLength(1);
  });

  it("stops queueing once the owner has stopped answering, rather than growing without limit", async () => {
    for (let i = 0; i < MEMORY_PROPOSAL_OPEN_CAP; i++) {
      await insertMemoryProposal(getPool(), proposalOn(`older-${i}`));
    }
    const standing = await standingPreference();
    const seen: ProposeOutcome[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await makeProposeSupersede(getPool(), { onOutcome: (o) => seen.push(o) })(standing.id, {
        text: "I drive now", kind: "preference", subject: "travel", confidence: 0.9,
        origin: "owner", evidenceRefs: [],
      });
    } finally {
      warn.mockRestore();
    }

    expect(seen).toEqual(["queue-full"]);
    expect(await getOpenMemoryProposals(getPool())).toHaveLength(MEMORY_PROPOSAL_OPEN_CAP);
  });

  it("carries on with one plain warning when this installation has no queue at all", async () => {
    const standing = await standingPreference();
    const seen: ProposeOutcome[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await getPool().query("DROP TABLE memory_proposals");
    try {
      await expect(
        makeProposeSupersede(getPool(), { onOutcome: (o) => seen.push(o) })(standing.id, {
          text: "I drive now", kind: "preference", subject: "travel", confidence: 0.9,
          origin: "owner", evidenceRefs: [],
        }),
      ).resolves.toBeNull();
      expect(seen).toEqual(["not-installed"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("072_memory_proposals.sql");
      // And nothing was applied on the way past.
      expect((await store().activePreferences()).map((p) => p.text)).toEqual(["I take the train"]);
    } finally {
      warn.mockRestore();
      await getPool().query(MEMORY_PROPOSALS_SCHEMA);
    }
  });
});

// ── 2. applyMemoryProposal ────────────────────────────────────────────────────────────────

describe("applyMemoryProposal", () => {
  it("closes the old row and adds the new one, only after an approval", async () => {
    const standing = await standingPreference();
    const id = await insertMemoryProposal(getPool(), proposalOn(standing.id));

    await expect(applyMemoryProposal(getPool(), id)).rejects.toBeInstanceOf(ProposalNoLongerApplies);
    expect((await store().activePreferences()).map((p) => p.text)).toEqual(["I take the train"]);

    await resolveMemoryProposal(getPool(), id, "approve");
    const out = await applyMemoryProposal(getPool(), id);
    expect(out.applied).toBe(true);

    const active = await store().activePreferences();
    expect(active.map((p) => p.text)).toEqual(["I drive now"]);
    // CLOSED AND LINKED, never deleted.
    const { rows } = await getPool().query<{ valid_to: Date | null; superseded_by: string | null; source: string }>(
      "SELECT valid_to, superseded_by, source FROM dream_preferences WHERE id = $1", [standing.id],
    );
    expect(rows[0]!.valid_to).not.toBeNull();
    expect(rows[0]!.superseded_by).toBe(active[0]!.id);
    // And the replacement says which approval put it there, and carries the OWNER's class.
    expect(active[0]!.source).toBe(memoryProposalSource(id));
    expect(active[0]!.origin).toBe("owner");
  });

  it("applies the STORED words, not anything a caller could have been told", async () => {
    const standing = await standingPreference();
    // The row says one thing; nothing but its id ever reaches the apply step.
    const id = await insertMemoryProposal(
      getPool(), proposalOn(standing.id, { proposedText: "I cycle now" }),
    );
    await resolveMemoryProposal(getPool(), id, "approve");
    await applyMemoryProposal(getPool(), id);
    expect((await store().activePreferences()).map((p) => p.text)).toEqual(["I cycle now"]);
  });

  it("refuses when the standing row was already closed since the card was rendered", async () => {
    const standing = await standingPreference();
    const other = await standingPreference("I fly now", "travel-other");
    const id = await insertMemoryProposal(getPool(), proposalOn(standing.id));
    await resolveMemoryProposal(getPool(), id, "approve");

    await store().supersede(standing.id, other.id); // it moved under us

    await expect(applyMemoryProposal(getPool(), id)).rejects.toBeInstanceOf(ProposalNoLongerApplies);
    const { rows } = await getPool().query<{ state: string }>(
      "SELECT state FROM memory_proposals WHERE id = $1", [id],
    );
    expect(rows[0]!.state).toBe("superseded"); // recorded, not silently dropped
    // The row it might have been applied to instead is untouched.
    expect((await store().activePreferences()).map((p) => p.text)).toEqual(["I fly now"]);
  });

  it("applies exactly once, even if called twice", async () => {
    const standing = await standingPreference();
    const id = await insertMemoryProposal(getPool(), proposalOn(standing.id));
    await resolveMemoryProposal(getPool(), id, "approve");
    await applyMemoryProposal(getPool(), id);
    await expect(applyMemoryProposal(getPool(), id)).rejects.toBeInstanceOf(ProposalNoLongerApplies);
    expect(await store().activePreferences()).toHaveLength(1);
  });

  it("a rejection changes nothing at all", async () => {
    const standing = await standingPreference();
    const id = await insertMemoryProposal(getPool(), proposalOn(standing.id));
    await resolveMemoryProposal(getPool(), id, "reject");
    const active = await store().activePreferences();
    expect(active.map((p) => p.text)).toEqual(["I take the train"]);
    await expect(applyMemoryProposal(getPool(), id)).rejects.toBeInstanceOf(ProposalNoLongerApplies);
  });

  it("a retire closes the row and puts nothing in its place", async () => {
    const standing = await standingPreference();
    const id = await insertMemoryProposal(
      getPool(), proposalOn(standing.id, { action: "retire", proposedText: "" }),
    );
    await resolveMemoryProposal(getPool(), id, "approve");
    const out = await applyMemoryProposal(getPool(), id);
    expect(out.applied).toBe(true);
    expect(await store().activePreferences()).toEqual([]);
  });

  it("a proposal naming a row that is not a standing preference at all is refused, not guessed at", async () => {
    const id = await insertMemoryProposal(getPool(), proposalOn("not-a-row-id"));
    await resolveMemoryProposal(getPool(), id, "approve");
    await expect(applyMemoryProposal(getPool(), id)).rejects.toBeInstanceOf(ProposalNoLongerApplies);
  });
});

// ── 2b. An approved `add` — the owner's tap is what makes it theirs ───────────────────────
//
// An add closes nothing, so none of the "the row may have moved" reasoning above applies to it.
// What these tests pin instead: the inference is stored as an AGENT-origin proposal, the row it
// becomes is stamped `owner` because the owner tapped for it, it is traceable back to the exact
// approval, it lands exactly once, and it leaves every other standing preference alone.

const addProposal = (over: Partial<MemoryProposalInput> = {}): MemoryProposalInput => ({
  action: "add",
  existingId: "",
  existingText: "",
  proposedText: "prefers short replies",
  subject: "tone",
  origin: "agent",
  source: "dream-cycle-2026-09-19",
  ref: "identity-deadbeef",
  kind: "preference",
  ...over,
});

/** File one and have the owner approve it, so each test starts from "approved, not yet applied". */
async function approvedAdd(over: Partial<MemoryProposalInput> = {}): Promise<number> {
  const id = await insertMemoryProposal(getPool(), addProposal(over));
  await resolveMemoryProposal(getPool(), id, "approve");
  return id;
}

describe("an approved add", () => {
  it("an approved add inserts a standing preference stamped owner, and nothing else", async () => {
    const id = await insertMemoryProposal(getPool(), addProposal());
    await resolveMemoryProposal(getPool(), id, "approve");
    const { applied, message } = await applyMemoryProposal(getPool(), id);
    expect(applied).toBe(true);
    expect(message).toContain("prefers short replies");

    const { rows } = await getPool().query<{
      text: string; origin: string; kind: string; source: string; valid_to: Date | null;
    }>("SELECT text, origin, kind, source, valid_to FROM dream_preferences");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      text: "prefers short replies",
      origin: "owner",
      kind: "preference",
      source: memoryProposalSource(id),
      valid_to: null,
    });
    const { rows: p } = await getPool().query<{ state: string }>(
      "SELECT state FROM memory_proposals WHERE id = $1", [id],
    );
    expect(p[0]!.state).toBe("applied");
  });

  it("writes the row's words, never a caller's", async () => {
    // the only argument applyMemoryProposal takes is an id; this pins that no second
    // parameter was added while the branch was written.
    expect(applyMemoryProposal.length).toBe(2);
  });

  it("the row is recorded as an inference the owner confirmed, not as something they said", async () => {
    // The proposal itself stays `agent`: that is what it is, and the table's CHECK enforces it.
    // Only the row the approval writes carries the owner's class — and it carries it in
    // dream_preferences, never in standing_facts, whose CHECK (origin = 'owner') is reserved for
    // words the owner actually said (owner decision X2).
    const id = await approvedAdd();
    await applyMemoryProposal(getPool(), id);
    const { rows } = await getPool().query<{ origin: string; source: string }>(
      "SELECT origin, source FROM memory_proposals WHERE id = $1", [id],
    );
    expect(rows[0]!.origin).toBe("agent");
    expect(rows[0]!.source).toBe("dream-cycle-2026-09-19");
    // And the standing row names the approval that put it there, so "who decided this" is
    // answerable from the row alone.
    const active = await store().activePreferences();
    expect(active.map((p) => p.source)).toEqual([memoryProposalSource(id)]);
  });

  it("applies an add exactly once", async () => {
    const id = await approvedAdd();
    await applyMemoryProposal(getPool(), id);
    await expect(applyMemoryProposal(getPool(), id)).rejects.toThrow(ProposalNoLongerApplies);
    const { rows } = await getPool().query("SELECT 1 FROM dream_preferences");
    expect(rows).toHaveLength(1);
  });

  it("never touches an existing preference on an add, whatever the subject", async () => {
    const id = await approvedAdd();
    await getPool().query(
      `INSERT INTO dream_preferences (text, kind, subject, confidence, source, origin)
       VALUES ('an older thing', 'preference', 'tone', 0, 'seed', 'owner')`,
    );
    await applyMemoryProposal(getPool(), id);
    const { rows } = await getPool().query<{ valid_to: Date | null }>(
      "SELECT valid_to FROM dream_preferences WHERE source = 'seed'",
    );
    expect(rows[0]!.valid_to).toBeNull();
  });

  it("a rejected add is never applied, and puts nothing anywhere", async () => {
    const id = await insertMemoryProposal(getPool(), addProposal());
    await resolveMemoryProposal(getPool(), id, "reject");
    await expect(applyMemoryProposal(getPool(), id)).rejects.toBeInstanceOf(ProposalNoLongerApplies);
    expect(await store().activePreferences()).toEqual([]);
  });

  it("an add that was only proposed, never approved, applies nothing", async () => {
    const id = await insertMemoryProposal(getPool(), addProposal());
    await expect(applyMemoryProposal(getPool(), id)).rejects.toBeInstanceOf(ProposalNoLongerApplies);
    expect(await store().activePreferences()).toEqual([]);
    const { rows } = await getPool().query<{ state: string }>(
      "SELECT state FROM memory_proposals WHERE id = $1", [id],
    );
    // Still waiting — an apply attempt on an unanswered proposal must not close it.
    expect(rows[0]!.state).toBe("pending");
  });

  it("carries the proposal's own kind, not one guessed at apply time", async () => {
    const id = await approvedAdd({ kind: "style", ref: "identity-cafebabe" });
    await applyMemoryProposal(getPool(), id);
    const { rows } = await getPool().query<{ kind: string; subject: string; confidence: number }>(
      "SELECT kind, subject, confidence FROM dream_preferences",
    );
    expect(rows[0]).toMatchObject({ kind: "style", subject: "tone", confidence: 0 });
  });
});

// ── 3. Only a 👍 applies, and only through one door ───────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(here, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules" || name === "tests" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Source with every comment removed. The scan below is about what the CODE reaches, and this
 *  tree comments heavily — a header that names the apply path in prose (as `lib/dream/promote.ts`
 *  does, to say it must never call it) is the opposite of a finding. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("only a 👍 applies a memory change", () => {
  it("exactly one module in this service calls the apply function", () => {
    const callers = sourceFiles(SERVICE)
      .filter((f) => /\bapplyMemoryProposal\b/.test(code(f)))
      .map((f) => relative(SERVICE, f))
      .sort();
    // The lib that defines it, and the ONE gated tool that calls it. A new name in this list is
    // a new way for something the owner did not approve to change what the agent believes —
    // which is the whole point of the slice, so it fails here until someone looks at it.
    expect(callers).toEqual([
      "catalogue/memory_resolve_proposal.ts",
      "lib/memory-proposal-apply.ts",
    ]);
  });

  it("the dream cycle's own route can only record — it does not import the apply path", () => {
    const promote = code(join(SERVICE, "lib/dream/promote.ts"));
    expect(promote).not.toMatch(/memory-proposal-apply/);
    expect(promote).not.toMatch(/\bsupersedeFact\b/);
  });
});

// ── 4. The two tools ──────────────────────────────────────────────────────────────────────

const telegramAuth = (userId = OWNER_TELEGRAM_ID) => ({
  current: {
    // eve's own string for this channel — `AUTHENTICATOR_FOR.telegram` in lib/principals.ts.
    authenticator: "telegram-webhook",
    principalId: userId,
    principalType: "user",
    attributes: { user_id: userId },
  },
});

const turnCtx = (auth: unknown, turn = "t1") =>
  ({ session: { id: "s1", turn: { id: turn }, auth } }) as never;

describe("the two tools", () => {
  beforeEach(() => {
    process.env["TELEGRAM_PRINCIPAL_ID"] = OWNER_TELEGRAM_ID;
  });
  afterEach(() => {
    delete process.env["TELEGRAM_PRINCIPAL_ID"];
  });

  it("the list tool is read-only and the decision tool carries the board's gate", async () => {
    const list = (await import("../catalogue/memory_proposals.js")).default;
    const resolve = (await import("../catalogue/memory_resolve_proposal.js")).default;
    expect(list.approval).toBeUndefined();
    expect(resolve.approval).toBeDefined();
    // Two arguments, and neither of them is any of the WORDS being applied: the apply step
    // re-reads those from the row (lib/memory-proposal-apply.ts).
    expect(Object.keys(resolve.inputSchema.shape).sort()).toEqual(["decision", "id"]);
  });

  it("both are named in the always-ask table, so the build cannot ship one unclassified", async () => {
    const { categoriesOf } = await import("@lares/agent-kit/always-ask");
    expect(categoriesOf("memory_proposals")).toEqual([]);
    expect(categoriesOf("memory_resolve_proposal")).toEqual([]);
  });

  it("the list tool shows the literal before and after, straight off the row", async () => {
    const standing = await standingPreference();
    const id = await insertMemoryProposal(getPool(), proposalOn(standing.id));
    const list = (await import("../catalogue/memory_proposals.js")).default;
    const out = (await list.execute({}, turnCtx(telegramAuth()))) as {
      proposals: Array<Record<string, unknown>>;
    };
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({
      id,
      action: "supersede",
      standingNow: "I take the train",
      wouldBecome: "I drive now",
    });
    expect(String(out.proposals[0]!["approveConsequence"])).toContain("replaced");
  });

  it("an approval applies the change and says what happened, in plain words", async () => {
    const standing = await standingPreference();
    const id = await insertMemoryProposal(getPool(), proposalOn(standing.id));
    const resolve = (await import("../catalogue/memory_resolve_proposal.js")).default;

    const out = (await resolve.execute({ id, decision: "approve" }, turnCtx(telegramAuth()))) as {
      applied: boolean; consequence: string;
    };
    expect(out.applied).toBe(true);
    expect(out.consequence).toContain("I drive now");
    expect((await store().activePreferences()).map((p) => p.text)).toEqual(["I drive now"]);
  });

  it("a rejection applies nothing, and the same change is not raised again on its own", async () => {
    const standing = await standingPreference();
    const id = await insertMemoryProposal(getPool(), proposalOn(standing.id));
    const resolve = (await import("../catalogue/memory_resolve_proposal.js")).default;

    const out = (await resolve.execute({ id, decision: "reject" }, turnCtx(telegramAuth()))) as {
      applied: boolean; consequence: string;
    };
    expect(out.applied).toBe(false);
    expect((await store().activePreferences()).map((p) => p.text)).toEqual(["I take the train"]);

    // The rejected row is no longer open, so the per-row index no longer blocks a new one — but
    // the run that would write it only reaches this route on a FRESH owner-origin observation,
    // which is the rule the slice leaves in place. What must not happen is the rejected row
    // coming back to life.
    expect(await getOpenMemoryProposals(getPool())).toEqual([]);
    const { rows } = await getPool().query<{ state: string }>(
      "SELECT state FROM memory_proposals WHERE id = $1", [id],
    );
    expect(rows[0]!.state).toBe("rejected");
  });

  it("a decision on an id that is not open changes nothing and says so", async () => {
    const standing = await standingPreference();
    const id = await insertMemoryProposal(getPool(), proposalOn(standing.id));
    const resolve = (await import("../catalogue/memory_resolve_proposal.js")).default;
    await resolve.execute({ id, decision: "reject" }, turnCtx(telegramAuth()));
    await expect(
      resolve.execute({ id, decision: "approve" }, turnCtx(telegramAuth())),
    ).rejects.toThrow(/no open memory proposal/);
    expect((await store().activePreferences()).map((p) => p.text)).toEqual(["I take the train"]);
  });

  it("refuses a turn nobody allowlisted pressed anything on — an unattended run included", async () => {
    const standing = await standingPreference();
    const id = await insertMemoryProposal(getPool(), proposalOn(standing.id));
    const resolve = (await import("../catalogue/memory_resolve_proposal.js")).default;

    // A schedule-opened session: the app, with no declared approver chat.
    const appAuth = {
      current: null,
      initiator: { authenticator: "app", principalId: "role-under-test", principalType: "app" },
    };
    await expect(
      resolve.execute({ id, decision: "approve" }, turnCtx(appAuth)),
    ).rejects.toBeInstanceOf(UnauthorizedApproverError);
    // Not even the state moved.
    const { rows } = await getPool().query<{ state: string }>(
      "SELECT state FROM memory_proposals WHERE id = $1", [id],
    );
    expect(rows[0]!.state).toBe("pending");
    expect((await store().activePreferences()).map((p) => p.text)).toEqual(["I take the train"]);
  });

  it("refuses a turn that has already read somebody else's words", async () => {
    const standing = await standingPreference();
    const id = await insertMemoryProposal(getPool(), proposalOn(standing.id));
    const resolve = (await import("../catalogue/memory_resolve_proposal.js")).default;

    taintTurn({ sessionId: "s1", turnId: "t1" }, "third_party");
    const out = (await resolve.execute({ id, decision: "approve" }, turnCtx(telegramAuth()))) as {
      applied: boolean; consequence: string;
    };
    expect(out.applied).toBe(false);
    expect(out.consequence).toMatch(/someone else/i);
    // Nothing decided and nothing applied — the proposal is still there to answer properly.
    const { rows } = await getPool().query<{ state: string }>(
      "SELECT state FROM memory_proposals WHERE id = $1", [id],
    );
    expect(rows[0]!.state).toBe("pending");
    expect((await store().activePreferences()).map((p) => p.text)).toEqual(["I take the train"]);
  });
});
