// The Atlas sync job's proposal queue — the rows behind Bendik's 👍 on a re-derived
// note. Modeled on notion-proposals-closed.test.ts: a real Postgres via the house
// testcontainer harness (tests/helpers/pg.ts), not a fake — the interesting behaviour
// here is what a guarded UPDATE's WHERE clause admits, and a fake that answers what the
// test author expects proves nothing about what the database will do under a real race.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";
import {
  insertAtlasProposal, getOpenAtlasProposals, resolveAtlasProposal, completeAtlasProposal,
  supersedeAtlasProposal, getAtlasProposalsAwaitingApply,
  getUnannouncedAtlasProposals, markAtlasProposalAnnounced,
  upsertAtlasNote, getAtlasNotes, recordAtlasSourcesAccounted, setAtlasNoteState,
} from "../lib/atlas-proposals.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

let tdb: TestDb;
let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });

beforeEach(async () => { await db.query("TRUNCATE atlas_proposals, atlas_notes"); });

const input = (over: Partial<Parameters<typeof insertAtlasProposal>[1]> = {}) => ({
  notePath: "_projects/soma.md",
  proposedNote: "---\ntype: venture\n---\n\n## What it is\n\nNew text.\n",
  baseBodyHash: "body-1",
  sourcesHash: "src-1",
  diffPreview: "- old\n+ new",
  ...over,
});

/** Reads state and resolved_at straight from the table — never through the code under test. */
const rowOf = async (id: number): Promise<{ state: string; resolved_at: string | null }> =>
  (await db.query("SELECT state, resolved_at FROM atlas_proposals WHERE id=$1", [id])).rows[0];

describe("the proposal queue", () => {
  it("inserts and lists an open proposal", async () => {
    const id = await insertAtlasProposal(db, input());
    const open = await getOpenAtlasProposals(db);
    expect(open.map((p) => [p.id, p.notePath, p.state, p.sourcesHash]))
      .toEqual([[id, "_projects/soma.md", "pending", "src-1"]]);
  });

  it("refuses a SECOND open proposal for the same note", async () => {
    await insertAtlasProposal(db, input());
    await expect(insertAtlasProposal(db, input({ sourcesHash: "src-2" }))).rejects.toThrow();
  });

  it("allows a new proposal once the previous one is superseded", async () => {
    const first = await insertAtlasProposal(db, input());
    await resolveAtlasProposal(db, first, "approve");
    await supersedeAtlasProposal(db, first);
    await expect(insertAtlasProposal(db, input({ sourcesHash: "src-2" }))).resolves.toBeGreaterThan(first);
  });
});

describe("resolveAtlasProposal — the ONE guarded transition", () => {
  it("approves an open proposal and returns the row", async () => {
    const id = await insertAtlasProposal(db, input());
    const row = await resolveAtlasProposal(db, id, "approve");
    expect(row.state).toBe("approved");
    expect(row.notePath).toBe("_projects/soma.md");
    expect(row.proposedNote).toContain("New text.");
  });

  it("rejects an open proposal", async () => {
    const id = await insertAtlasProposal(db, input());
    expect((await resolveAtlasProposal(db, id, "reject")).state).toBe("rejected");
  });

  it("leaves resolved_at NULL on BOTH decisions — the apply pass's work queue", async () => {
    const a = await insertAtlasProposal(db, input());
    await resolveAtlasProposal(db, a, "approve");
    const b = await insertAtlasProposal(db, input({ notePath: "_projects/murmur.md" }));
    await resolveAtlasProposal(db, b, "reject");
    expect((await getAtlasProposalsAwaitingApply(db)).map((p) => p.id).sort()).toEqual([a, b].sort());
  });

  it("REFUSES a proposal the engine already closed — no silent second write", async () => {
    const id = await insertAtlasProposal(db, input());
    await resolveAtlasProposal(db, id, "approve");
    await completeAtlasProposal(db, id, "approved");
    await expect(resolveAtlasProposal(db, id, "approve")).rejects.toThrow(/no open atlas proposal/i);
  });

  it("refuses an id that never existed", async () => {
    await expect(resolveAtlasProposal(db, 999_999, "reject")).rejects.toThrow(/no open atlas proposal/i);
  });

  it("stamps resolved_at as it moves an approve to 'applied' — both, or neither", async () => {
    // THE REGRESSION TEST. The previous two-statement close could not stamp at all (its
    // guard required a state the preceding statement had already moved away from), and the
    // old version of this test hid that by writing resolved_at itself with raw SQL before
    // asserting anything. Nothing here writes resolved_at but the function under test.
    const id = await insertAtlasProposal(db, input());
    await resolveAtlasProposal(db, id, "approve");
    await completeAtlasProposal(db, id, "approved");
    expect(await rowOf(id)).toMatchObject({ state: "applied" });
    expect((await rowOf(id)).resolved_at).not.toBeNull();
    // …and it therefore leaves the apply pass's work queue.
    expect(await getAtlasProposalsAwaitingApply(db)).toEqual([]);
  });

  it("stamps a REJECT too, leaving it 'rejected' — terminal already, but still owed a stamp", async () => {
    const id = await insertAtlasProposal(db, input());
    await resolveAtlasProposal(db, id, "reject");
    await completeAtlasProposal(db, id, "rejected");
    expect(await rowOf(id)).toMatchObject({ state: "rejected" });
    expect((await rowOf(id)).resolved_at).not.toBeNull();
    expect(await getAtlasProposalsAwaitingApply(db)).toEqual([]);
  });

  it("refuses a second close and never moves the timestamp", async () => {
    const id = await insertAtlasProposal(db, input());
    await resolveAtlasProposal(db, id, "approve");
    await completeAtlasProposal(db, id, "approved");
    // Pin to a known, distinctly-past value so a second stamp cannot hide in clock noise:
    // two consecutive round trips can land in the same millisecond, and a weak "compare two
    // fresh timestamps" assertion would pass even with no guard at all.
    await db.query("UPDATE atlas_proposals SET resolved_at = '2020-01-01T00:00:00Z' WHERE id=$1", [id]);
    await expect(completeAtlasProposal(db, id, "approved")).rejects.toThrow(/no longer 'approved'/i);
    const stamped = (await rowOf(id)).resolved_at;
    expect(stamped).not.toBeNull();
    expect(new Date(stamped!).toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("REFUSES to close a proposal nobody has decided yet", async () => {
    const id = await insertAtlasProposal(db, input());
    await expect(completeAtlasProposal(db, id, "approved")).rejects.toThrow(/no longer 'approved'/i);
    expect(await rowOf(id)).toMatchObject({ state: "pending", resolved_at: null });
    // …and the proposal is therefore still decidable and still executable — the bug this
    // guards against is a resolved_at stamped on a still-pending row, which makes a LATER
    // approval invisible to the apply pass (it filters on resolved_at IS NULL).
    await resolveAtlasProposal(db, id, "approve");
    expect((await getAtlasProposalsAwaitingApply(db)).map((p) => p.id)).toEqual([id]);
  });

  it("REFUSES to stamp 'applied' onto a decision the human flipped mid-tick", async () => {
    // The apply pass read this row as 'approved'; before it finished, Bendik tapped Reject.
    // Closing on `state IN ('approved','rejected')` would have accepted that and labelled a
    // rejection 'applied'. Guarding on the state actually READ makes the tick lose the race
    // loudly, and the next one executes the branch he chose.
    const id = await insertAtlasProposal(db, input());
    await resolveAtlasProposal(db, id, "approve");
    await resolveAtlasProposal(db, id, "reject");
    await expect(completeAtlasProposal(db, id, "approved")).rejects.toThrow(/no longer 'approved'/i);
    expect(await rowOf(id)).toMatchObject({ state: "rejected", resolved_at: null });
    expect((await getAtlasProposalsAwaitingApply(db)).map((p) => p.state)).toEqual(["rejected"]);
  });
});

describe("supersedeAtlasProposal — the stale approval", () => {
  it("moves an approval to 'superseded' and stamps it, in one statement", async () => {
    const id = await insertAtlasProposal(db, input());
    await resolveAtlasProposal(db, id, "approve");
    await supersedeAtlasProposal(db, id);
    expect(await rowOf(id)).toMatchObject({ state: "superseded" });
    expect((await rowOf(id)).resolved_at).not.toBeNull();
    expect(await getAtlasProposalsAwaitingApply(db)).toEqual([]);
  });

  it("refuses anything that is not an open approval", async () => {
    // A rejection writes nothing, so nothing underneath it can go stale.
    const id = await insertAtlasProposal(db, input());
    await resolveAtlasProposal(db, id, "reject");
    await expect(supersedeAtlasProposal(db, id)).rejects.toThrow(/no longer an open approval/i);
    expect(await rowOf(id)).toMatchObject({ state: "rejected", resolved_at: null });
  });
});

describe("completeAtlasProposal — the engine-only path", () => {
  it("accepts only the two states a human decision can leave behind", () => {
    // `from` names the state the apply pass READ. The terminal states are what this
    // function WRITES, and offering them as input would reintroduce the unguarded
    // engine mover this replaced — a caller could walk 'applied' to 'applied' and
    // restamp, or move a superseded row as though it were still decidable.
    // @ts-expect-error — 'applied' is written by this function, never passed to it
    const _applied: Parameters<typeof completeAtlasProposal>[2] = "applied";
    // @ts-expect-error — same for 'superseded', which has its own guarded statement
    const _superseded: Parameters<typeof completeAtlasProposal>[2] = "superseded";
    // @ts-expect-error — an undecided row has nothing to close
    const _pending: Parameters<typeof completeAtlasProposal>[2] = "pending";
    expect(true).toBe(true);
  });
});

describe("the announce ledger", () => {
  it("returns only pending, un-announced proposals and stamps once", async () => {
    const id = await insertAtlasProposal(db, input());
    expect((await getUnannouncedAtlasProposals(db)).map((p) => p.id)).toEqual([id]);
    await markAtlasProposalAnnounced(db, id);
    expect(await getUnannouncedAtlasProposals(db)).toEqual([]);
  });

  it("never announces an already-decided proposal", async () => {
    const id = await insertAtlasProposal(db, input());
    await resolveAtlasProposal(db, id, "approve");
    expect(await getUnannouncedAtlasProposals(db)).toEqual([]);
  });

  it("carries the note's brand, so the announcement never guesses one from the filename", async () => {
    // `_projects/traad-io.md` is the brand `traad.io` — a basename heuristic gets that
    // wrong, which is why the brand is joined from the note row rather than derived.
    await upsertAtlasNote(db, { notePath: "_projects/traad-io.md", brand: "traad.io", bodyHash: "b" });
    await insertAtlasProposal(db, input({ notePath: "_projects/traad-io.md" }));
    expect((await getUnannouncedAtlasProposals(db))[0]!.brand).toBe("traad.io");
  });

  it("reports an absent brand as null rather than inventing one", async () => {
    // No note row at all — the LEFT JOIN must still return the proposal, with brand null.
    // Dropping the row would hide the proposal from the announcement entirely.
    const id = await insertAtlasProposal(db, input());
    const rows = await getUnannouncedAtlasProposals(db);
    expect(rows.map((p) => p.id)).toEqual([id]);
    expect(rows[0]!.brand).toBeNull();
  });

  it("markAtlasProposalAnnounced stamps once and never moves the timestamp", async () => {
    const id = await insertAtlasProposal(db, input());
    await markAtlasProposalAnnounced(db, id);
    // Pin to a known past value, same idiom as closeAtlasProposal's guard test — a second
    // stamp landing in the same millisecond as the first would hide behind a weaker check.
    await db.query("UPDATE atlas_proposals SET announced_at = '2020-01-01T00:00:00Z' WHERE id=$1", [id]);
    await markAtlasProposalAnnounced(db, id);
    const again = (await db.query("SELECT announced_at FROM atlas_proposals WHERE id=$1", [id])).rows[0].announced_at;
    expect(new Date(again).toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("atlas_notes", () => {
  it("records the accounted-for source fingerprint", async () => {
    await upsertAtlasNote(db, { notePath: "_projects/soma.md", brand: "soma", bodyHash: "b1" });
    await recordAtlasSourcesAccounted(db, "_projects/soma.md", "src-1");
    expect((await getAtlasNotes(db)).get("_projects/soma.md")?.accountedSourcesHash).toBe("src-1");
  });

  it("THROWS when accounting against a note with no row — a decision needs somewhere to live", async () => {
    await expect(recordAtlasSourcesAccounted(db, "_projects/ghost.md", "src-1"))
      .rejects.toThrow(/no state row/i);
  });

  it("setAtlasNoteState reports whether the state CHANGED, so pings fire on transitions only", async () => {
    const at = new Date("2026-08-11T09:00:00Z");
    await upsertAtlasNote(db, { notePath: "_projects/soma.md", brand: "soma", bodyHash: "b1" });
    expect(await setAtlasNoteState(db, "_projects/soma.md", "sources_failed", "github unreachable", at)).toBe(true);
    expect(await setAtlasNoteState(db, "_projects/soma.md", "sources_failed", "github unreachable", at)).toBe(false);
    expect(await setAtlasNoteState(db, "_projects/soma.md", "ok", null, at)).toBe(true);
  });

  it("keeps state_since at its FIRST value while the state holds", async () => {
    await upsertAtlasNote(db, { notePath: "_projects/soma.md", brand: "soma", bodyHash: "b1" });
    await setAtlasNoteState(db, "_projects/soma.md", "sources_failed", "x", new Date("2026-08-11T09:00:00Z"));
    await setAtlasNoteState(db, "_projects/soma.md", "sources_failed", "x", new Date("2026-08-12T09:00:00Z"));
    const since = (await getAtlasNotes(db)).get("_projects/soma.md")?.stateSince;
    expect(since?.toISOString()).toBe("2026-08-11T09:00:00.000Z");
  });

  it("MOVES state_since on a genuine transition, to the transition's own timestamp", async () => {
    await upsertAtlasNote(db, { notePath: "_projects/soma.md", brand: "soma", bodyHash: "b1" });
    await setAtlasNoteState(db, "_projects/soma.md", "sources_failed", "x", new Date("2026-08-11T09:00:00Z"));
    const recovered = new Date("2026-08-12T09:00:00Z");
    await setAtlasNoteState(db, "_projects/soma.md", "ok", null, recovered);
    const since = (await getAtlasNotes(db)).get("_projects/soma.md")?.stateSince;
    expect(since?.toISOString()).toBe(recovered.toISOString());
  });

  it("setAtlasNoteState THROWS against a note with no row — same posture as recordAtlasSourcesAccounted", async () => {
    await expect(
      setAtlasNoteState(db, "_projects/ghost.md", "sources_failed", "x", new Date("2026-08-11T09:00:00Z")),
    ).rejects.toThrow(/no state row/i);
  });
});
