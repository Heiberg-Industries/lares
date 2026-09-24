// services/atlas/tests/apply.test.ts
// Where a decision becomes a file. Real Postgres via the house testcontainer harness
// (same as atlas-proposals.test.ts) — the interesting behaviour here is a guarded UPDATE's
// interaction with a real unique index and NULL handling, which a fake DB proves nothing
// about. The writer is the fake from tests/helpers/fake-writer.ts, shared with
// migrate-okf.test.ts rather than forked.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";
import {
  upsertAtlasNote, insertAtlasProposal, resolveAtlasProposal, getAtlasNotes,
  type AtlasProposalInput,
} from "@lares/agent-box";
import { startTestDb, type TestDb } from "@lares/agent-box/tests/helpers/pg.js";
import { runApply } from "../lib/apply.js";
import { parseNote } from "../lib/frontmatter.js";
import { bodyHash } from "../lib/fingerprint.js";
import { fakeWriter } from "./helpers/fake-writer.js";
import { makeTickDeps } from "./helpers/tick-deps.js";
import { readOriginFrontmatter } from "@lares/vault-format/origin";

let tdb: TestDb;
let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });
beforeEach(async () => { await db.query("TRUNCATE atlas_proposals, atlas_notes"); });

const NOTE_PATH = "_projects/soma.md";

const ORIGINAL_RAW = `---
type: venture
brand: soma
---

## What it is

Old text.
`;

const PROPOSED_RAW = `---
type: venture
brand: soma
---

## What it is

New text.
`;

const proposalInput = (over: Partial<AtlasProposalInput> = {}): AtlasProposalInput => ({
  notePath: NOTE_PATH,
  proposedNote: PROPOSED_RAW,
  baseBodyHash: bodyHash(parseNote(ORIGINAL_RAW).body),
  sourcesHash: "src-1",
  diffPreview: "- Old text.\n+ New text.",
  ...over,
});

async function seedNote(rawForHash: string): Promise<void> {
  await upsertAtlasNote(db, { notePath: NOTE_PATH, brand: "soma", bodyHash: bodyHash(parseNote(rawForHash).body) });
}

async function stateOf(id: number): Promise<string> {
  const res = await db.query<{ state: string }>("SELECT state FROM atlas_proposals WHERE id=$1", [id]);
  return res.rows[0]!.state;
}

async function resolvedAtOf(id: number): Promise<Date | null> {
  const res = await db.query<{ resolved_at: Date | null }>("SELECT resolved_at FROM atlas_proposals WHERE id=$1", [id]);
  return res.rows[0]!.resolved_at;
}

describe("runApply", () => {
  it("writes the proposed note on an APPROVE, then closes the proposal", async () => {
    await seedNote(ORIGINAL_RAW);
    const id = await insertAtlasProposal(db, proposalInput());
    await resolveAtlasProposal(db, id, "approve");

    const w = fakeWriter({ [NOTE_PATH]: ORIGINAL_RAW });
    const summary = await runApply(makeTickDeps(db, w));

    expect(summary).toEqual({ applied: 1, rejected: 0, superseded: 0 });
    expect(w.files[NOTE_PATH]).toContain("New text.");
    expect(await stateOf(id)).toBe("applied");
    expect(await resolvedAtOf(id)).not.toBeNull();
  });

  it("accounts for the sources on an APPROVE, so the next tick proposes nothing", async () => {
    await seedNote(ORIGINAL_RAW);
    const id = await insertAtlasProposal(db, proposalInput());
    await resolveAtlasProposal(db, id, "approve");

    const w = fakeWriter({ [NOTE_PATH]: ORIGINAL_RAW });
    await runApply(makeTickDeps(db, w));

    expect((await getAtlasNotes(db)).get(NOTE_PATH)?.accountedSourcesHash).toBe("src-1");
  });

  it("writes NOTHING on a REJECT — the note is left exactly as it was", async () => {
    await seedNote(ORIGINAL_RAW);
    const id = await insertAtlasProposal(db, proposalInput());
    await resolveAtlasProposal(db, id, "reject");

    const w = fakeWriter({ [NOTE_PATH]: ORIGINAL_RAW });
    const summary = await runApply(makeTickDeps(db, w));

    expect(summary).toEqual({ applied: 0, rejected: 1, superseded: 0 });
    expect(w.files[NOTE_PATH]).toBe(ORIGINAL_RAW);
    expect(w.commits.length).toBe(0);
  });

  it("STILL accounts for the sources on a REJECT — a declined draft must not come back", async () => {
    // The single most important assertion in this file. Without it the next tick sees a
    // fingerprint that differs from `accounted`, drafts the same text, and asks again —
    // daily, forever.
    await seedNote(ORIGINAL_RAW);
    const id = await insertAtlasProposal(db, proposalInput());
    await resolveAtlasProposal(db, id, "reject");

    const w = fakeWriter({ [NOTE_PATH]: ORIGINAL_RAW });
    await runApply(makeTickDeps(db, w));

    expect((await getAtlasNotes(db)).get(NOTE_PATH)?.accountedSourcesHash).toBe("src-1");
    expect(await stateOf(id)).toBe("rejected");
    expect(await resolvedAtOf(id)).not.toBeNull();
  });

  it("SUPERSEDES a stale approval whose note moved underneath it, and says so", async () => {
    // base_body_hash no longer matches the file: someone (a human, or the mechanical pass)
    // changed the note between propose and approve. Writing the proposed bytes would
    // silently discard that change.
    await seedNote(ORIGINAL_RAW);
    const id = await insertAtlasProposal(db, proposalInput());
    await resolveAtlasProposal(db, id, "approve");

    const changedRaw = `---
type: venture
brand: soma
---

## What it is

A human edited this by hand, after approving the original draft.
`;
    const w = fakeWriter({ [NOTE_PATH]: changedRaw });
    const deps = makeTickDeps(db, w);
    const summary = await runApply(deps);

    expect(summary).toEqual({ applied: 0, rejected: 0, superseded: 1 });
    expect(await stateOf(id)).toBe("superseded");
    expect(await resolvedAtOf(id)).not.toBeNull();
    expect(w.files[NOTE_PATH]).toBe(changedRaw);
    expect(deps.notifications.join("\n")).toMatch(/changed after you approved/i);
    // Task 15: a stale-approval supersede is routine, not source-health — it stays
    // data-quality/info (no key), unlike the source-health transition notice in run.ts.
    expect(deps.notifyCalls.find((c) => /changed after you approved/i.test(c.message))?.opts).toBeUndefined();
  });

  it("leaves the proposal OPEN when the write throws, so the next tick retries", async () => {
    await seedNote(ORIGINAL_RAW);
    const id = await insertAtlasProposal(db, proposalInput());
    await resolveAtlasProposal(db, id, "approve");

    const w = fakeWriter({ [NOTE_PATH]: ORIGINAL_RAW });
    const throwingWriter = { ...w, writeNotes: async () => { throw new Error("disk full"); } };
    await runApply(makeTickDeps(db, throwingWriter));

    expect(await stateOf(id)).toBe("approved");
    expect(await resolvedAtOf(id)).toBeNull();
    expect(w.files[NOTE_PATH]).toBe(ORIGINAL_RAW); // never written
  });

  it("stamps a newly-applied note lares_origin: synced — this write IS the sync job's own 👍 gate", async () => {
    await seedNote(ORIGINAL_RAW);
    const id = await insertAtlasProposal(db, proposalInput());
    await resolveAtlasProposal(db, id, "approve");

    const w = fakeWriter({ [NOTE_PATH]: ORIGINAL_RAW });
    await runApply(makeTickDeps(db, w));

    expect(readOriginFrontmatter(w.files[NOTE_PATH]!)).toBe("synced");
  });

  it("never downgrades a note that already carries a lares_origin — checked against the FRESH read, not the stale proposal", async () => {
    // The note picked up its own stamp (an owner hand-editing it) between propose and
    // apply, without the body changing — so the stale-approval guard (body hash only)
    // does not catch it. The write must still never clobber the stamp already on disk.
    const ownerStamped = `---
type: venture
brand: soma
lares_origin: owner
---

## What it is

Old text.
`;
    await seedNote(ORIGINAL_RAW);
    const id = await insertAtlasProposal(db, proposalInput());
    await resolveAtlasProposal(db, id, "approve");

    const w = fakeWriter({ [NOTE_PATH]: ownerStamped });
    await runApply(makeTickDeps(db, w));

    expect(readOriginFrontmatter(w.files[NOTE_PATH]!)).toBe("owner");
  });

  it("does not close a proposal whose accounted-for stamp failed", async () => {
    // recordAtlasSourcesAccounted throws when the note has no row. Closing anyway would
    // lose the decision entirely. Deliberately no seedNote() call here — the note has no
    // atlas_notes row at all.
    const id = await insertAtlasProposal(db, proposalInput());
    await resolveAtlasProposal(db, id, "reject");

    const w = fakeWriter({ [NOTE_PATH]: ORIGINAL_RAW });
    await runApply(makeTickDeps(db, w));

    expect(await resolvedAtOf(id)).toBeNull();
    expect(await stateOf(id)).toBe("rejected"); // resolveAtlasProposal already set this; apply never got to close it
  });
});
