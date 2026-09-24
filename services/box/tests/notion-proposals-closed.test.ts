// getRecentlyClosedProposals — the reader behind the morning brief's "what closed"
// block (ORB-39 follow-up).
//
// Why these run against a real Postgres rather than a fake: the whole reader IS a
// WHERE clause. The interesting behaviour is which rows a `resolved_at` predicate
// admits, and a fake that answers the question the test author had in mind proves
// nothing about the one the database will answer at 08:00.
//
// The measured failure this reader exists to make impossible: on 2026-08-06 the brief
// told Bendik two proposals were "still waiting on your decision" — both had been
// rejected the day before. The brief now reports what CLOSED, so a row that has moved
// out of the queue is visible as a fact rather than absent and reconstructed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import {
  insertProposal, resolveProposal, setProposalState, markProposalReverted,
  getRecentlyClosedProposals,
} from "../lib/notion-proposals.js";
import { startTestDb, type TestDb } from "./helpers/pg.js";

let tdb: TestDb;
let db: Pool;
beforeAll(async () => { tdb = await startTestDb(); db = tdb.pool; }, 120_000);
afterAll(async () => { await tdb?.stop(); });

/** A proposal in the queue. Each test uses its own vault_path — the partial unique
 *  index (016) allows only one OPEN proposal per path. */
async function propose(
  vaultPath: string,
  over: { kind?: "update" | "create" } = {},
): Promise<number> {
  return insertProposal(db, {
    vaultPath,
    notionPageId: `page-${vaultPath}`,
    proposedBody: "body from Notion",
    baseMdHash: "base-hash",
    notionHash: "notion-hash",
    ...(over.kind ? { kind: over.kind } : {}),
  });
}

/** Backdate a closed row's resolved_at — the only way to test a time window without
 *  sleeping through it. Same idiom as the staleness tests in notion-sync/store. */
async function backdateResolved(id: number, hours: number): Promise<void> {
  await db.query(
    `UPDATE notion_sync_proposals SET resolved_at = now() - ($2 || ' hours')::interval WHERE id = $1`,
    [id, String(hours)],
  );
}

const ids = (rows: Array<{ id: number }>): number[] => rows.map((r) => r.id);

describe("getRecentlyClosedProposals — what he decided, not what is waiting", () => {
  it("lists an APPROVED proposal once the engine has applied it", async () => {
    const id = await propose("desks/orakel/closed-applied.md");
    await resolveProposal(db, id, "approve");
    await setProposalState(db, id, "applied");   // the engine's next tick

    const row = (await getRecentlyClosedProposals(db, 24)).find((p) => p.id === id);
    expect(row).toBeDefined();
    expect(row?.state).toBe("applied");
    expect(row?.vaultPath).toBe("desks/orakel/closed-applied.md");
  });

  it("lists a REJECTED proposal once its revert has executed", async () => {
    const id = await propose("desks/orakel/closed-rejected.md");
    await resolveProposal(db, id, "reject");
    await markProposalReverted(db, id);          // the engine reverted the Notion page

    const row = (await getRecentlyClosedProposals(db, 24)).find((p) => p.id === id);
    expect(row?.state).toBe("rejected");
  });

  // THE DOCUMENTED CASE. For a rejected row `resolved_at` means "the revert has
  // executed", not "Bendik decided" (see setProposalState). A rejection whose revert
  // has not run yet is still owed a write, so it is not closed — and reporting it as
  // closed would tell him the page was reverted when it was not.
  it("does NOT list a rejection whose revert has not executed yet", async () => {
    const id = await propose("desks/orakel/rejected-unexecuted.md");
    await resolveProposal(db, id, "reject");     // resolved_at deliberately left NULL

    expect(ids(await getRecentlyClosedProposals(db, 24))).not.toContain(id);

    // …and it appears in the very next brief once the engine finishes.
    await markProposalReverted(db, id);
    expect(ids(await getRecentlyClosedProposals(db, 24))).toContain(id);
  });

  // The same gap on the approve side, and it is inherent to having no `decided_at`
  // column: 'approved' is an OPEN state (the engine still owes the vault write), so
  // resolved_at is NULL until the apply tick lands.
  it("does NOT list an approval the engine has not applied yet", async () => {
    const id = await propose("desks/orakel/approved-unapplied.md");
    await resolveProposal(db, id, "approve");

    expect(ids(await getRecentlyClosedProposals(db, 24))).not.toContain(id);
  });

  it("never lists a pending proposal — that is the live DM's job, not the brief's", async () => {
    const id = await propose("desks/orakel/still-pending.md");
    expect(ids(await getRecentlyClosedProposals(db, 24))).not.toContain(id);
  });

  // 'superseded' is stamped by the engine (a newer proposal replaced this one, or a
  // rejected page changed under the rejection). It is a machine event, not a decision
  // Bendik made, and listing it under his decisions would credit him with one.
  it("never lists a SUPERSEDED proposal, even though it carries a resolved_at", async () => {
    const id = await propose("desks/orakel/superseded.md");
    await setProposalState(db, id, "superseded");

    const raw = await db.query<{ resolved_at: Date | null }>(
      `SELECT resolved_at FROM notion_sync_proposals WHERE id = $1`, [id],
    );
    expect(raw.rows[0].resolved_at).not.toBeNull();     // it IS stamped…
    expect(ids(await getRecentlyClosedProposals(db, 24))).not.toContain(id);  // …and still excluded
  });

  it("admits a decision just INSIDE the window and drops one just outside it", async () => {
    const inside = await propose("desks/orakel/window-inside.md");
    const outside = await propose("desks/orakel/window-outside.md");
    for (const id of [inside, outside]) {
      await resolveProposal(db, id, "reject");
      await markProposalReverted(db, id);
    }
    await backdateResolved(inside, 23);
    await backdateResolved(outside, 25);

    const listed = ids(await getRecentlyClosedProposals(db, 24));
    expect(listed).toContain(inside);
    expect(listed).not.toContain(outside);
  });

  it("carries kind and the joined notionOwned through, like every other reader", async () => {
    // A create — no docs row exists for it, which is the whole premise of a create and
    // the reason the shared join is LEFT rather than inner.
    const created = await propose("zero7/transcripts/2026-08-05-standup.md", { kind: "create" });
    await resolveProposal(db, created, "reject");
    await markProposalReverted(db, created);

    // An update on a document NOTION owns.
    const owned = await propose("desks/orakel/notion-owned.md");
    await db.query(
      `INSERT INTO notion_sync_docs (vault_path, notion_page_id, target, direction)
       VALUES ($1, $2, 'docs', 'notion_to_md')`,
      ["desks/orakel/notion-owned.md", "doc-page-notion-owned"],
    );
    await resolveProposal(db, owned, "approve");
    await setProposalState(db, owned, "applied");

    const rows = await getRecentlyClosedProposals(db, 24);
    expect(rows.find((p) => p.id === created)?.kind).toBe("create");
    expect(rows.find((p) => p.id === created)?.notionOwned).toBe(false);
    expect(rows.find((p) => p.id === owned)?.kind).toBe("update");
    expect(rows.find((p) => p.id === owned)?.notionOwned).toBe(true);
  });

  it("orders by when the decision closed, oldest first", async () => {
    const older = await propose("desks/orakel/order-older.md");
    const newer = await propose("desks/orakel/order-newer.md");
    for (const id of [older, newer]) {
      await resolveProposal(db, id, "reject");
      await markProposalReverted(db, id);
    }
    await backdateResolved(older, 6);
    await backdateResolved(newer, 2);

    const listed = ids(await getRecentlyClosedProposals(db, 24));
    expect(listed.indexOf(older)).toBeLessThan(listed.indexOf(newer));
  });
});
