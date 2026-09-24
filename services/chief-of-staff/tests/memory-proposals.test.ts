import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { getPool, closePool } from "@lares/agent-kit/db";
import {
  insertMemoryProposal,
  getOpenMemoryProposals,
  resolveMemoryProposal,
  getUnannouncedMemoryProposals,
  markMemoryProposalAnnounced,
  memoryApproveConsequence,
  memoryRejectConsequence,
} from "../lib/proposals-store.js";

/**
 * W4C-s4 — the memory proposal store, against a REAL Postgres (testcontainer, ORB-45 pattern).
 * `memory_proposals` already exists on the box's shared `lares_state` database
 * (services/box/sql/072_memory_proposals.sql, altered by services/box/sql/074_memory_proposal_add.sql),
 * replicated here for the disposable test instance, matching the mirror-not-import convention
 * `tests/proposals.test.ts` and `tests/reminders.test.ts` already use for a box-owned table.
 *
 * This slice wires nothing yet: nothing here inserts a proposal from a real dream run, and
 * nothing applies one. It only proves the queue itself — insert, list, the guarded resolve,
 * the per-row dedupe, the text/action CHECK, the consequence sentences, and the announce
 * ledger.
 *
 * W5X-s1 (sql/074) added the `add` action: `ref`/`kind` columns, the origin/text/action CHECKs
 * widened conditionally (supersede/retire keep their exact 072 guarantees), and the single open
 * index split into one for supersede/retire and one for add (deduped on `ref`, not
 * `existing_id`). The mirror below is the POST-074 shape.
 */
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

// Hoisted to file scope (not inside a single describe) so both "memory proposals" and
// "the add action (sql/074)" below share one container/pool for the whole file, rather than
// the second describe finding the pool already closed by the first describe's own afterAll.
let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = getPool({ DATABASE_URL: container.getConnectionUri() } as NodeJS.ProcessEnv);
  await pool.query(MEMORY_PROPOSALS_SCHEMA);
}, 120_000);

afterAll(async () => {
  await closePool();
  await container.stop();
});

afterEach(async () => {
  await getPool().query("DELETE FROM memory_proposals");
});

describe("memory proposals", () => {
  const input = {
    action: "supersede" as const, existingId: "p1", existingText: "I take the train",
    proposedText: "I drive now", subject: "travel", origin: "owner" as const,
    source: "dream-cycle-2026-09-18", ref: "", kind: "",
  };

  it("queues a change and lists it as open", async () => {
    const id = await insertMemoryProposal(getPool(), input);
    const [row] = await getOpenMemoryProposals(getPool());
    expect(row!.id).toBe(id);
    expect(row!.state).toBe("pending");
    expect(row!.action).toBe("supersede");
  });

  it("refuses a second open proposal for the same standing row", async () => {
    await insertMemoryProposal(getPool(), input);
    await expect(insertMemoryProposal(getPool(), { ...input, proposedText: "or maybe the bus" }))
      .rejects.toThrow(/memory_proposals_open_idx/);
  });

  it("refuses a supersede with nothing to put in its place, and a retire that smuggles one", async () => {
    await expect(insertMemoryProposal(getPool(), { ...input, proposedText: "" }))
      .rejects.toThrow(/memory_proposals_text_check/);
    await expect(insertMemoryProposal(getPool(), { ...input, action: "retire" }))
      .rejects.toThrow(/memory_proposals_text_check/);
  });

  it("refuses a proposal backed by anything other than owner-origin evidence", async () => {
    await expect(insertMemoryProposal(getPool(), { ...input, origin: "agent" as never }))
      .rejects.toThrow(/memory_proposals_origin_check/);
  });

  it("resolves exactly once — a second decision on the same id throws", async () => {
    const id = await insertMemoryProposal(getPool(), input);
    expect((await resolveMemoryProposal(getPool(), id, "approve")).state).toBe("approved");
    await expect(resolveMemoryProposal(getPool(), id, "reject"))
      .rejects.toThrow(/no open memory proposal with id/);
  });

  it("states the consequence of each decision in one sentence per action", () => {
    expect(memoryApproveConsequence({ action: "supersede" })).toMatch(/replaced/i);
    expect(memoryApproveConsequence({ action: "retire" })).toMatch(/stops applying/i);
    expect(memoryRejectConsequence({ action: "supersede" })).toMatch(/left exactly as it is/i);
    for (const s of [
      memoryApproveConsequence({ action: "supersede" }),
      memoryRejectConsequence({ action: "retire" }),
    ]) expect(s).not.toMatch(/bendik|saga/i);
  });

  it("announces a pending proposal once", async () => {
    const id = await insertMemoryProposal(getPool(), input);
    expect((await getUnannouncedMemoryProposals(getPool())).map((r) => r.id)).toEqual([id]);
    await markMemoryProposalAnnounced(getPool(), id);
    expect(await getUnannouncedMemoryProposals(getPool())).toEqual([]);
  });
});

describe("the add action (sql/074)", () => {
  it("still refuses an agent-origin supersede", async () => {
    await expect(
      getPool().query(
        `INSERT INTO memory_proposals (action, existing_id, existing_text, proposed_text, subject, origin, source)
         VALUES ('supersede', 'p1', 'old', 'new', 's', 'agent', 'test')`,
      ),
    ).rejects.toThrow(/memory_proposals_origin_check/);
  });

  it("refuses an owner-origin add — an owner-origin observation is promoted, never put to them", async () => {
    await expect(
      getPool().query(
        `INSERT INTO memory_proposals (action, existing_id, existing_text, proposed_text, subject, origin, source, ref, kind)
         VALUES ('add', '', '', 'x', 's', 'owner', 'test', 'identity-1', 'preference')`,
      ),
    ).rejects.toThrow(/memory_proposals_origin_check/);
  });

  it("refuses a third_party add at any wording", async () => {
    await expect(
      getPool().query(
        `INSERT INTO memory_proposals (action, existing_id, existing_text, proposed_text, subject, origin, source, ref, kind)
         VALUES ('add', '', '', 'x', 's', 'third_party', 'test', 'identity-2', 'preference')`,
      ),
    ).rejects.toThrow(/memory_proposals_origin_check/);
  });

  it("refuses an add that names an existing row, or carries no ref or no kind", async () => {
    for (const bad of [
      `('add', 'p1', '',    'x', 's', 'agent', 't', 'identity-3', 'preference')`,
      `('add', '',   'old', 'x', 's', 'agent', 't', 'identity-3', 'preference')`,
      `('add', '',   '',    'x', 's', 'agent', 't', '',           'preference')`,
      `('add', '',   '',    'x', 's', 'agent', 't', 'identity-3', '')`,
    ]) {
      await expect(
        getPool().query(
          `INSERT INTO memory_proposals (action, existing_id, existing_text, proposed_text, subject, origin, source, ref, kind) VALUES ${bad}`,
        ),
      ).rejects.toThrow(/memory_proposals_text_check/);
    }
  });

  it("lets two different adds stay open at once, and refuses the same one twice", async () => {
    const ins = (ref: string) =>
      getPool().query(
        `INSERT INTO memory_proposals (action, existing_id, existing_text, proposed_text, subject, origin, source, ref, kind)
         VALUES ('add', '', '', 'x', 's', 'agent', 't', $1, 'preference')`,
        [ref],
      );
    await ins("identity-aaa");
    await ins("identity-bbb");
    await expect(ins("identity-aaa")).rejects.toThrow(/memory_proposals_add_open_idx/);
  });

  it("keeps one-open-proposal-per-standing-row for supersede, unaffected by any add", async () => {
    const ins = () =>
      getPool().query(
        `INSERT INTO memory_proposals (action, existing_id, existing_text, proposed_text, subject, origin, source)
         VALUES ('supersede', 'p9', 'old', 'new', 's', 'owner', 't')`,
      );
    await ins();
    await expect(ins()).rejects.toThrow(/memory_proposals_open_idx/);
  });

  it("says what approving and rejecting an add do, in the owner's terms", () => {
    expect(memoryApproveConsequence({ action: "add" })).toBe(
      "this is kept as a standing preference from now on, recorded as something you confirmed",
    );
    expect(memoryRejectConsequence({ action: "add" })).toBe(
      "nothing is kept, and this observation is not raised again unless something new is observed",
    );
  });

  it("round-trips an add through insert and read", async () => {
    const id = await insertMemoryProposal(getPool(), {
      action: "add", existingId: "", existingText: "", proposedText: "prefers short replies",
      subject: "tone", origin: "agent", source: "dream-cycle-2026-09-19",
      ref: "identity-deadbeef", kind: "preference",
    });
    const [row] = await getOpenMemoryProposals(getPool());
    expect(row).toMatchObject({
      id, action: "add", ref: "identity-deadbeef", kind: "preference", origin: "agent",
    });
  });
});
