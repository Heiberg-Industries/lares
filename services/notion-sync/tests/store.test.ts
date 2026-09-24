// Integration coverage: exercises every store function against a real Postgres
// container (via @lares/agent-box's shared test harness, which already applies
// 015_notion_sync.sql) so the hand-written SQL is proven correct — not just that
// it contains the right substrings. Slower than a unit test; the container pull
// + schema application can take a moment on a cold image.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { startTestDb, type TestDb } from "@lares/agent-box/tests/helpers/pg.js";
import {
  recordMeetingSynced, recordMeetingUnmatched, recordMeetingError,
  getDocRows, upsertDocSynced, recordDocError, markDocOrphaned,
  countByState, setLastRunAt, getLastRunAt,
  getDeskRows, setDocDirection, freezeDoc, unfreezeDoc, updateNotionWatermark,
  insertProposal, getOpenProposals, setProposalState, resolveProposal,
  getUnannouncedProposals, markProposalAnnounced, getStaleProposals,
  getRejectedUnexecuted, markProposalReverted, getFrozenDocs,
  replaceFidelity, getFidelityPassed,
  getLinkedRows, getMeetingRows, ensureMeetingRow, linkPageToVaultFile, recordNotionAccounted,
  getPageRows, ensureDocsRow,
  rejectConsequence, type ProposalRow,
} from "../lib/store.js";

interface DocRow {
  state: string;
  frozen_reason: string | null;
  frozen_at: Date | null;
  error_count: number;
  notion_last_edited: Date | null;
}

let tdb: TestDb;
let db: Pool;

beforeAll(async () => {
  tdb = await startTestDb();
  db = tdb.pool;
}, 120_000);

afterAll(async () => {
  await tdb?.stop();
});

async function readDoc(pageId: string): Promise<DocRow> {
  const res = await db.query<DocRow>(
    `SELECT state, frozen_reason, frozen_at, error_count, notion_last_edited
       FROM notion_sync_docs WHERE notion_page_id = $1`,
    [pageId],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0];
}

describe("recordMeetingSynced", () => {
  it("inserts on first call, then upserts the same notion_page_id without duplicating the row", async () => {
    const pageId = "page-synced-upsert";
    await recordMeetingSynced(db, pageId, "2026-07-21T13:53:51.558Z");
    let doc = await readDoc(pageId);
    expect(doc.state).toBe("synced");
    expect(doc.notion_last_edited).toEqual(new Date("2026-07-21T13:53:51.558Z"));

    await recordMeetingSynced(db, pageId, "2026-07-22T09:00:00.000Z");
    doc = await readDoc(pageId);
    expect(doc.notion_last_edited).toEqual(new Date("2026-07-22T09:00:00.000Z"));

    const { rowCount } = await db.query(
      `SELECT 1 FROM notion_sync_docs WHERE notion_page_id = $1`,
      [pageId],
    );
    expect(rowCount).toBe(1);
  });

  it("clears a prior unmatched flag when the meeting resyncs", async () => {
    const pageId = "page-synced-clears-flag";
    await recordMeetingUnmatched(db, pageId, "no-candidate");
    const unmatched = await readDoc(pageId);
    expect(unmatched.state).toBe("unmatched");
    expect(unmatched.frozen_reason).toBe("no-candidate");
    expect(unmatched.frozen_at).not.toBeNull();

    await recordMeetingSynced(db, pageId, "2026-07-21T13:53:51.558Z");
    const synced = await readDoc(pageId);
    expect(synced.state).toBe("synced");
    expect(synced.frozen_reason).toBeNull();
    expect(synced.frozen_at).toBeNull();
    expect(synced.error_count).toBe(0);
  });
});

describe("recordMeetingUnmatched", () => {
  it("stores the reason and preserves the original frozen_at across a second call", async () => {
    const pageId = "page-unmatched-preserves-frozen-at";
    await recordMeetingUnmatched(db, pageId, "no-candidate");
    const first = await readDoc(pageId);
    expect(first.state).toBe("unmatched");
    expect(first.frozen_reason).toBe("no-candidate");
    expect(first.frozen_at).not.toBeNull();

    // A measurable gap so a bug that resets frozen_at on every call is detectable.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await recordMeetingUnmatched(db, pageId, "ambiguous-match");
    const second = await readDoc(pageId);
    expect(second.state).toBe("unmatched");
    expect(second.frozen_reason).toBe("ambiguous-match");
    expect(second.frozen_at).toEqual(first.frozen_at);
  });
});

describe("recordMeetingError", () => {
  it("only flips state to 'error' on the third consecutive failure, then a resync resets the counter", async () => {
    const pageId = "page-error-three-strikes";

    // A page that never succeeded must never read as 'synced' — see the comment
    // on recordMeetingError. 'retrying' is the honest state below three strikes.
    await recordMeetingError(db, pageId, "429 rate limited");
    let doc = await readDoc(pageId);
    expect(doc.error_count).toBe(1);
    expect(doc.state).toBe("retrying");

    await recordMeetingError(db, pageId, "429 rate limited");
    doc = await readDoc(pageId);
    expect(doc.error_count).toBe(2);
    expect(doc.state).toBe("retrying");

    await recordMeetingError(db, pageId, "500 server error");
    doc = await readDoc(pageId);
    expect(doc.error_count).toBe(3);
    expect(doc.state).toBe("error");
    expect(doc.frozen_reason).toBe("500 server error");

    await recordMeetingSynced(db, pageId, "2026-07-21T13:53:51.558Z");
    doc = await readDoc(pageId);
    expect(doc.error_count).toBe(0);
    expect(doc.state).toBe("synced");
  });
});

describe("countByState", () => {
  it("returns real counts across a mixed set of rows, 0 for states with none", async () => {
    const before = await countByState(db);

    await recordMeetingSynced(db, "page-count-synced-1", null);
    await recordMeetingSynced(db, "page-count-synced-2", null);
    await recordMeetingUnmatched(db, "page-count-unmatched-1", "no-candidate");
    await recordMeetingError(db, "page-count-error-1", "boom");
    await recordMeetingError(db, "page-count-error-1", "boom");
    await recordMeetingError(db, "page-count-error-1", "boom");
    await recordMeetingError(db, "page-count-retrying-1", "boom");

    const after = await countByState(db);
    expect(after.synced - before.synced).toBe(2);
    expect(after.unmatched - before.unmatched).toBe(1);
    expect(after.error - before.error).toBe(1);
    expect(after.retrying - before.retrying).toBe(1);
    // 'frozen' is reachable only via freezeDoc (Phase 3), never through any
    // function exercised above, so it must stay at 0 regardless of the above.
    expect(after.frozen).toBe(0);
  });
});

interface FullDocRow extends DocRow {
  vault_path: string | null;
  notion_page_id: string;
  target: string;
  direction: string;
  md_hash: string | null;
  notion_hash: string | null;
}

async function readDocByPath(vaultPath: string): Promise<FullDocRow> {
  const res = await db.query<FullDocRow>(
    `SELECT vault_path, notion_page_id, target, direction, md_hash, notion_hash,
            state, frozen_reason, frozen_at, error_count, notion_last_edited
       FROM notion_sync_docs WHERE vault_path = $1`,
    [vaultPath],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0];
}

describe("upsertDocSynced", () => {
  it("inserts a 'docs'/'md_to_notion' row on first call, then upserts the same vault_path without duplicating", async () => {
    const vaultPath = "wiki/docs-upsert.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "doc-page-upsert-1", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: "2026-08-04T10:00:00.000Z",
    });
    let row = await readDocByPath(vaultPath);
    expect(row.target).toBe("docs");
    expect(row.direction).toBe("md_to_notion");
    expect(row.state).toBe("synced");
    expect(row.md_hash).toBe("md-1");
    expect(row.notion_hash).toBe("notion-1");
    expect(row.notion_last_edited).toEqual(new Date("2026-08-04T10:00:00.000Z"));

    // Same vault_path, different page id: the adoption/re-create path. The stored
    // page id must follow what Notion actually holds, or later patches hit a page
    // the engine no longer writes to.
    await upsertDocSynced(db, {
      vaultPath, pageId: "doc-page-upsert-2", mdHash: "md-2", notionHash: "notion-2",
      notionLastEdited: null,
    });
    row = await readDocByPath(vaultPath);
    expect(row.notion_page_id).toBe("doc-page-upsert-2");
    expect(row.md_hash).toBe("md-2");
    expect(row.notion_hash).toBe("notion-2");
    // A NULL from the caller means "took no reading", not "erase the baseline" —
    // see upsertDocSynced and the dedicated watermark test below.
    expect(row.notion_last_edited).toEqual(new Date("2026-08-04T10:00:00.000Z"));

    const { rowCount } = await db.query(
      `SELECT 1 FROM notion_sync_docs WHERE vault_path = $1`,
      [vaultPath],
    );
    expect(rowCount).toBe(1);
  });

  it("clears orphaned/error bookkeeping when the doc resyncs", async () => {
    const vaultPath = "wiki/docs-resync-clears.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "doc-page-resync", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: null,
    });
    await markDocOrphaned(db, vaultPath, "file-missing");
    await recordDocError(db, vaultPath, "boom");
    const flagged = await readDocByPath(vaultPath);
    expect(flagged.state).toBe("unmatched");
    expect(flagged.error_count).toBe(1);

    await upsertDocSynced(db, {
      vaultPath, pageId: "doc-page-resync", mdHash: "md-2", notionHash: "notion-2",
      notionLastEdited: null,
    });
    const synced = await readDocByPath(vaultPath);
    expect(synced.state).toBe("synced");
    expect(synced.frozen_reason).toBeNull();
    expect(synced.frozen_at).toBeNull();
    expect(synced.error_count).toBe(0);
  });
});

describe("getDocRows", () => {
  it("maps 'docs' rows by vault_path and excludes meeting rows", async () => {
    await upsertDocSynced(db, {
      vaultPath: "wiki/docs-map-a.md", pageId: "doc-page-map-a", mdHash: "hash-a",
      notionHash: "notion-a", notionLastEdited: null,
    });
    await upsertDocSynced(db, {
      vaultPath: "wiki/docs-map-b.md", pageId: "doc-page-map-b", mdHash: "hash-b",
      notionHash: "notion-b", notionLastEdited: null,
    });
    await recordDocError(db, "wiki/docs-map-b.md", "boom");
    // Meeting rows share the table but must never leak into the wiki pass.
    await recordMeetingSynced(db, "meeting-page-not-a-doc", null);

    const rows = await getDocRows(db);
    expect(rows.get("wiki/docs-map-a.md")).toEqual({
      pageId: "doc-page-map-a", mdHash: "hash-a", state: "synced",
    });
    expect(rows.get("wiki/docs-map-b.md")).toEqual({
      pageId: "doc-page-map-b", mdHash: "hash-b", state: "synced",
    });
    for (const key of rows.keys()) expect(key).not.toBe("meeting-page-not-a-doc");
  });
});

describe("recordDocError", () => {
  it("mirrors the 3-strike escalation on an existing row, preserving state below three", async () => {
    const vaultPath = "wiki/docs-three-strikes.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "doc-page-strikes", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: null,
    });

    // Unlike the meeting variant there is no 'retrying' insert branch: a doc row
    // only exists after a successful write, so below three strikes the honest
    // state is the one it already earned.
    await recordDocError(db, vaultPath, "429 rate limited");
    let row = await readDocByPath(vaultPath);
    expect(row.error_count).toBe(1);
    expect(row.state).toBe("synced");

    await recordDocError(db, vaultPath, "429 rate limited");
    row = await readDocByPath(vaultPath);
    expect(row.error_count).toBe(2);
    expect(row.state).toBe("synced");

    await recordDocError(db, vaultPath, "500 server error");
    row = await readDocByPath(vaultPath);
    expect(row.error_count).toBe(3);
    expect(row.state).toBe("error");
    expect(row.frozen_reason).toBe("500 server error");
  });

  it("is a deliberate no-op before a page exists (pre-create errors are summary-only)", async () => {
    const vaultPath = "wiki/docs-never-created.md";
    await recordDocError(db, vaultPath, "create failed");
    const { rowCount } = await db.query(
      `SELECT 1 FROM notion_sync_docs WHERE vault_path = $1`,
      [vaultPath],
    );
    expect(rowCount).toBe(0);
  });
});

describe("markDocOrphaned", () => {
  it("flags the row unmatched with a reason and preserves the original frozen_at", async () => {
    const vaultPath = "wiki/docs-orphaned.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "doc-page-orphaned", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: null,
    });

    await markDocOrphaned(db, vaultPath, "file-missing");
    const first = await readDocByPath(vaultPath);
    expect(first.state).toBe("unmatched");
    expect(first.frozen_reason).toBe("file-missing");
    expect(first.frozen_at).not.toBeNull();

    // A measurable gap so a bug that resets frozen_at on every call is detectable.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await markDocOrphaned(db, vaultPath, "still-missing");
    const second = await readDocByPath(vaultPath);
    expect(second.state).toBe("unmatched");
    expect(second.frozen_reason).toBe("still-missing");
    expect(second.frozen_at).toEqual(first.frozen_at);
  });
});

describe("run watermark", () => {
  it("returns null before any write, then round-trips a timestamp through the singleton row", async () => {
    expect(await getLastRunAt(db)).toBeNull();

    const at = new Date("2026-08-03T10:00:00.000Z");
    await setLastRunAt(db, at);
    expect(await getLastRunAt(db)).toEqual(at);
  });
});

describe("getDeskRows", () => {
  it("maps 'docs' rows to the full desk shape, excluding meeting rows", async () => {
    await upsertDocSynced(db, {
      vaultPath: "desks/orakel/roadmap.md", pageId: "desk-page-a", mdHash: "hash-a",
      notionHash: "notion-a", notionLastEdited: "2026-08-04T10:00:00.000Z", direction: "two_way",
    });
    await recordMeetingSynced(db, "meeting-page-not-a-desk", null);

    const rows = await getDeskRows(db);
    expect(rows.get("desks/orakel/roadmap.md")).toEqual({
      pageId: "desk-page-a",
      mdHash: "hash-a",
      notionHash: "notion-a",
      // notion_last_edited must round-trip as the exact ISO string it was written
      // with — pull-sync (T5) compares it directly against Notion's own
      // lastEditedTime strings (plan-context: minute-granular, `>=` not `>`), so a
      // driver-parsed Date here would silently break that comparison in production
      // while any fake-Queryable unit test (typed against this same interface)
      // stayed green.
      notionLastEdited: "2026-08-04T10:00:00.000Z",
      state: "synced",
      direction: "two_way",
    });
    for (const key of rows.keys()) expect(key).not.toBe("meeting-page-not-a-desk");
  });

  it("defaults direction to 'md_to_notion' and carries a null watermark through untouched", async () => {
    await upsertDocSynced(db, {
      vaultPath: "desks/orakel/mirror-file.md", pageId: "desk-page-b", mdHash: "hash-b",
      notionHash: "notion-b", notionLastEdited: null,
    });
    const rows = await getDeskRows(db);
    expect(rows.get("desks/orakel/mirror-file.md")).toEqual({
      pageId: "desk-page-b", mdHash: "hash-b", notionHash: "notion-b",
      notionLastEdited: null, state: "synced", direction: "md_to_notion",
    });
  });
});

describe("upsertDocSynced — direction and freeze survival (Phase 3)", () => {
  it("stores the given direction on first insert", async () => {
    const vaultPath = "desks/orakel/two-way-new.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-direction-1", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: null, direction: "two_way",
    });
    const row = await readDocByPath(vaultPath);
    expect(row.direction).toBe("two_way");
  });

  it("never resets an existing row's direction back to the default on a routine re-sync", async () => {
    const vaultPath = "desks/orakel/two-way-resync.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-direction-2", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: null, direction: "two_way",
    });
    // A routine push write (wiki-sync.ts via cli.ts) never passes `direction` — it
    // must not silently flip a desk row that enable-two-way already promoted back
    // down to Mirror. Direction only ever changes via setDocDirection.
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-direction-2", mdHash: "md-2", notionHash: "notion-2",
      notionLastEdited: null,
    });
    const row = await readDocByPath(vaultPath);
    expect(row.direction).toBe("two_way");
    expect(row.md_hash).toBe("md-2");
  });

  it("keeps the stored watermark when a write passes NULL, and moves it when a write observed one", async () => {
    const vaultPath = "desks/orakel/watermark-preserved.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-watermark-1", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: "2026-08-04T10:00:00.000Z", direction: "two_way",
    });

    // A push write never observes last_edited_time and passes null meaning "no
    // reading taken". Erasing the baseline here would make the pull pass treat the
    // row as unbaselined and skip it forever after the first vault-side edit.
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-watermark-1", mdHash: "md-2", notionHash: "notion-2",
      notionLastEdited: null,
    });
    let row = await readDocByPath(vaultPath);
    expect(row.notion_last_edited).toEqual(new Date("2026-08-04T10:00:00.000Z"));
    expect(row.md_hash).toBe("md-2");

    // A real observation still moves it forward.
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-watermark-1", mdHash: "md-3", notionHash: "notion-3",
      notionLastEdited: "2026-08-04T12:00:00.000Z",
    });
    row = await readDocByPath(vaultPath);
    expect(row.notion_last_edited).toEqual(new Date("2026-08-04T12:00:00.000Z"));
  });

  it("keeps a frozen row frozen across a resync, but still refreshes its hashes", async () => {
    const vaultPath = "desks/orakel/frozen-survives.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-freeze-1", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: null, direction: "two_way",
    });
    await freezeDoc(db, vaultPath, "changed in both Notion and the vault");
    const frozen = await readDocByPath(vaultPath);
    expect(frozen.state).toBe("frozen");

    // Simulates bookkeeping landing after the freeze — the guard keeps the row
    // frozen until an explicit resolve (spec §6), but a frozen row's hashes may
    // still refresh so the console shows current state on both sides.
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-freeze-1", mdHash: "md-2", notionHash: "notion-2",
      notionLastEdited: "2026-08-04T11:00:00.000Z",
    });
    const stillFrozen = await readDocByPath(vaultPath);
    expect(stillFrozen.state).toBe("frozen");
    expect(stillFrozen.frozen_reason).toBe("changed in both Notion and the vault");
    expect(stillFrozen.frozen_at).toEqual(frozen.frozen_at);
    expect(stillFrozen.md_hash).toBe("md-2");
    expect(stillFrozen.notion_hash).toBe("notion-2");
  });
});

describe("setDocDirection", () => {
  it("flips the direction of an existing row and touches nothing else", async () => {
    const vaultPath = "desks/orakel/set-direction.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-set-direction", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: null,
    });
    await setDocDirection(db, vaultPath, "two_way");
    const row = await readDocByPath(vaultPath);
    expect(row.direction).toBe("two_way");
    expect(row.state).toBe("synced");
    expect(row.md_hash).toBe("md-1");
  });
});

describe("freezeDoc", () => {
  it("freezes with a reason and preserves the original frozen_at across a second freeze", async () => {
    const vaultPath = "desks/orakel/freeze-doc.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-freeze-2", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: null,
    });
    await freezeDoc(db, vaultPath, "sub-page added under a mirror row — move it out, then resolve");
    const first = await readDocByPath(vaultPath);
    expect(first.state).toBe("frozen");
    expect(first.frozen_reason).toBe("sub-page added under a mirror row — move it out, then resolve");
    expect(first.frozen_at).not.toBeNull();

    // A measurable gap so a bug that resets frozen_at on every call is detectable.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await freezeDoc(db, vaultPath, "still blocked");
    const second = await readDocByPath(vaultPath);
    expect(second.state).toBe("frozen");
    expect(second.frozen_reason).toBe("still blocked");
    expect(second.frozen_at).toEqual(first.frozen_at);
  });
});

describe("unfreezeDoc", () => {
  it("clears the freeze back to synced so the next tick treats the row normally", async () => {
    const vaultPath = "desks/orakel/unfreeze-doc.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-unfreeze", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: null,
    });
    await freezeDoc(db, vaultPath, "changed in both Notion and the vault");
    await unfreezeDoc(db, vaultPath);
    const row = await readDocByPath(vaultPath);
    expect(row.state).toBe("synced");
    expect(row.frozen_reason).toBeNull();
    expect(row.frozen_at).toBeNull();
  });
});

describe("updateNotionWatermark", () => {
  it("refreshes notion_hash and notion_last_edited only", async () => {
    const vaultPath = "desks/orakel/watermark.md";
    await upsertDocSynced(db, {
      vaultPath, pageId: "desk-watermark", mdHash: "md-1", notionHash: "notion-1",
      notionLastEdited: "2026-08-04T09:00:00.000Z", direction: "two_way",
    });
    // Bumps error_count so we can prove the watermark call leaves it alone.
    await recordDocError(db, vaultPath, "429 rate limited");

    await updateNotionWatermark(db, vaultPath, "notion-2", "2026-08-04T10:30:00.000Z");
    const row = await readDocByPath(vaultPath);
    expect(row.notion_hash).toBe("notion-2");
    expect(row.notion_last_edited).toEqual(new Date("2026-08-04T10:30:00.000Z"));
    expect(row.md_hash).toBe("md-1");
    expect(row.state).toBe("synced");
    expect(row.error_count).toBe(1);
  });
});

interface ProposalRowRaw {
  id: string;
  vault_path: string;
  notion_page_id: string;
  proposed_body: string;
  base_md_hash: string;
  notion_hash: string;
  diff_preview: string;
  kind: string;
  state: string;
  created_at: Date;
  resolved_at: Date | null;
  announced_at: Date | null;
}

async function readProposal(id: number): Promise<ProposalRowRaw> {
  const res = await db.query<ProposalRowRaw>(
    `SELECT id, vault_path, notion_page_id, proposed_body, base_md_hash, notion_hash,
            diff_preview, kind, state, created_at, resolved_at, announced_at
       FROM notion_sync_proposals WHERE id = $1`,
    [id],
  );
  expect(res.rowCount).toBe(1);
  return res.rows[0];
}

describe("insertProposal / getOpenProposals / setProposalState", () => {
  it("inserts a pending proposal and returns its id", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/proposal-a.md", notionPageId: "page-proposal-a",
      proposedBody: "new body from Notion", baseMdHash: "base-hash-a", notionHash: "notion-hash-a",
    });
    expect(typeof id).toBe("number");
    const row = await readProposal(id);
    expect(row.state).toBe("pending");
    expect(row.resolved_at).toBeNull();
    expect(row.vault_path).toBe("desks/orakel/proposal-a.md");
    expect(row.proposed_body).toBe("new body from Notion");
    // No diffPreview given — 016's column default, not a NULL.
    expect(row.diff_preview).toBe("");
    // No kind given — 018's column default. This is what keeps every caller written
    // before Phase 4 correct without being touched.
    expect(row.kind).toBe("update");
  });

  it("round-trips kind: 'create' through every reader that builds a ProposalRow", async () => {
    const id = await insertProposal(db, {
      vaultPath: "zero7/transcripts/2026-08-05-standup.md", notionPageId: "page-create",
      // A create carries no base render — there is no vault file yet.
      proposedBody: "---\ntitle: Standup\n---\n\nnotes", baseMdHash: "", notionHash: "notion-hash-c",
      diffPreview: "+ notes", kind: "create",
    });
    expect((await readProposal(id)).kind).toBe("create");

    // Every SELECT, because a column silently omitted from one of them leaves `kind`
    // undefined at runtime while TypeScript believes it is there — and the apply
    // engine's branch on it would then take the UPDATE path for a create.
    expect((await getOpenProposals(db)).find((p) => p.id === id)?.kind).toBe("create");
    expect((await getUnannouncedProposals(db)).find((p) => p.id === id)?.kind).toBe("create");
    expect((await resolveProposal(db, id, "reject")).kind).toBe("create");
    expect((await getRejectedUnexecuted(db)).find((p) => p.id === id)?.kind).toBe("create");
  });

  // notionOwned is JOINED from notion_sync_docs.direction, not stored on the
  // proposal — so it follows the row, and an `enable-two-way` flip is reflected on
  // the very next read rather than by a stale copy (fix round 3).
  it("joins notionOwned from the doc row's direction, through every reader", async () => {
    const path = "zero7/transcripts/owned-join.md";
    await upsertDocSynced(db, {
      vaultPath: path, pageId: "page-owned-join", mdHash: "h", notionHash: "n",
      notionLastEdited: "2026-08-01T00:00:00.000Z", direction: "notion_to_md",
    });
    const id = await insertProposal(db, {
      vaultPath: path, notionPageId: "page-owned-join",
      proposedBody: "body", baseMdHash: "b", notionHash: "nh",
    });

    expect((await getOpenProposals(db)).find((p) => p.id === id)?.notionOwned).toBe(true);
    expect((await getUnannouncedProposals(db)).find((p) => p.id === id)?.notionOwned).toBe(true);
    // …and the guarded transition returns it too, which is what lets the surfaces
    // state the consequence of the proposal that actually moved.
    expect((await resolveProposal(db, id, "reject")).notionOwned).toBe(true);
    expect((await getRejectedUnexecuted(db)).find((p) => p.id === id)?.notionOwned).toBe(true);

    // Flip the direction; the SAME proposal now reads the other way. A stored copy
    // could not do this.
    await setDocDirection(db, path, "two_way");
    expect((await getRejectedUnexecuted(db)).find((p) => p.id === id)?.notionOwned).toBe(false);
  });

  it("reads notionOwned as false for a mirror row and for a create with no row yet", async () => {
    const mirrorPath = "zero7/mirror-join.md";
    await upsertDocSynced(db, {
      vaultPath: mirrorPath, pageId: "page-mirror-join", mdHash: "h", notionHash: "n",
      notionLastEdited: null, direction: "md_to_notion",
    });
    const mirrorId = await insertProposal(db, {
      vaultPath: mirrorPath, notionPageId: "page-mirror-join",
      proposedBody: "b", baseMdHash: "b", notionHash: "n",
    });
    // A create has NO docs row — the LEFT join yields NULL, read as false. An inner
    // join here would drop every create from every queue, including Saga's.
    const createId = await insertProposal(db, {
      vaultPath: "zero7/not-yet-created.md", notionPageId: "page-create-join",
      proposedBody: "b", baseMdHash: "", notionHash: "n", kind: "create",
    });

    const open = await getOpenProposals(db);
    expect(open.find((p) => p.id === mirrorId)?.notionOwned).toBe(false);
    const created = open.find((p) => p.id === createId);
    expect(created).toBeDefined();          // present, not dropped by the join
    expect(created?.notionOwned).toBe(false);
  });

  // Phase 4 (T4). A transcript's state row is its MEETINGS row, so the join that
  // decides which consequence a surface states has to reach one. It used to carry
  // `AND d.target = 'docs'`, which could never change WHICH row matched
  // (vault_path is globally UNIQUE) and could only make it MISS this one — so a
  // transcript's update proposal read notionOwned=false and rejectConsequence
  // promised a Notion revert the engine correctly refuses to perform.
  it("joins notionOwned from a MEETINGS row too — a transcript's proposal knows Notion owns it", async () => {
    const path = "zero7/transcripts/2026-08-05-meeting-join.md";
    await ensureMeetingRow(db, "page-meeting-join");
    await linkPageToVaultFile(db, {
      vaultPath: path, pageId: "page-meeting-join", mdHash: "h", notionHash: "n",
      notionLastEdited: null, direction: "notion_to_md", writtenBodyHash: "body-hash",
    });
    const id = await insertProposal(db, {
      vaultPath: path, notionPageId: "page-meeting-join",
      proposedBody: "body", baseMdHash: "b", notionHash: "nh",
    });

    const proposal = (await getOpenProposals(db)).find((p) => p.id === id);
    expect(proposal?.notionOwned).toBe(true);
    expect(rejectConsequence(proposal as ProposalRow)).toMatch(/Notion owns this document/);
    expect((await resolveProposal(db, id, "reject")).notionOwned).toBe(true);
  });

  it("refuses a kind the engine has no branch for", async () => {
    await expect(insertProposal(db, {
      vaultPath: "desks/orakel/proposal-bad-kind.md", notionPageId: "page-bad-kind",
      proposedBody: "body", baseMdHash: "", notionHash: "h",
      kind: "delete" as never,
    })).rejects.toThrow(/kind/);
  });

  it("persists diffPreview (T6 review, F2) and round-trips it through getOpenProposals", async () => {
    const preview = "- old line\n+ new line";
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/proposal-diff.md", notionPageId: "page-diff",
      proposedBody: "new line", baseMdHash: "base-hash", notionHash: "notion-hash",
      diffPreview: preview,
    });
    const row = await readProposal(id);
    expect(row.diff_preview).toBe(preview);

    const open = await getOpenProposals(db);
    expect(open.find((p) => p.id === id)?.diffPreview).toBe(preview);
  });

  it("getOpenProposals returns only pending/approved rows", async () => {
    const pendingId = await insertProposal(db, {
      vaultPath: "desks/orakel/proposal-open.md", notionPageId: "page-open",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    const rejectedPath = "desks/orakel/proposal-rejected.md";
    const rejectedId = await insertProposal(db, {
      vaultPath: rejectedPath, notionPageId: "page-rejected",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await setProposalState(db, rejectedId, "rejected");

    const open = await getOpenProposals(db);
    const paths = open.map((p) => p.vaultPath);
    expect(paths).toContain("desks/orakel/proposal-open.md");
    expect(paths).not.toContain(rejectedPath);
    const openRow = open.find((p) => p.id === pendingId);
    expect(openRow?.state).toBe("pending");
    expect(openRow?.notionPageId).toBe("page-open");
  });

  it("setProposalState stamps resolved_at on applied/superseded, never on approved", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/proposal-terminal.md", notionPageId: "page-terminal",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await setProposalState(db, id, "approved");
    let row = await readProposal(id);
    expect(row.state).toBe("approved");
    expect(row.resolved_at).toBeNull();

    await setProposalState(db, id, "applied");
    row = await readProposal(id);
    expect(row.state).toBe("applied");
    expect(row.resolved_at).not.toBeNull();
  });

  it("setProposalState leaves 'rejected' UNSTAMPED — the revert has not happened yet", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/proposal-reject-unstamped.md", notionPageId: "page-reject-unstamped",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await setProposalState(db, id, "rejected");
    const row = await readProposal(id);
    expect(row.state).toBe("rejected");
    expect(row.resolved_at).toBeNull();
  });
});

describe("getRejectedUnexecuted / markProposalReverted", () => {
  it("lists rejected proposals whose revert has not run, and stops listing them once it has", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/reject-queue.md", notionPageId: "page-reject-queue",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await setProposalState(db, id, "rejected");

    const queued = await getRejectedUnexecuted(db);
    expect(queued.map((p: { id: number }) => p.id)).toContain(id);
    expect(queued.find((p) => p.id === id)?.vaultPath).toBe("desks/orakel/reject-queue.md");

    await markProposalReverted(db, id);
    const row = await readProposal(id);
    expect(row.state).toBe("rejected");
    expect(row.resolved_at).not.toBeNull();
    expect((await getRejectedUnexecuted(db)).map((p: { id: number }) => p.id)).not.toContain(id);
  });

  it("never lists pending or approved rows, and re-marking keeps the first resolved_at", async () => {
    const pendingId = await insertProposal(db, {
      vaultPath: "desks/orakel/reject-queue-pending.md", notionPageId: "page-reject-queue-pending",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    const approvedId = await insertProposal(db, {
      vaultPath: "desks/orakel/reject-queue-approved.md", notionPageId: "page-reject-queue-approved",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await setProposalState(db, approvedId, "approved");

    const ids = (await getRejectedUnexecuted(db)).map((p: { id: number }) => p.id);
    expect(ids).not.toContain(pendingId);
    expect(ids).not.toContain(approvedId);

    const revertedId = await insertProposal(db, {
      vaultPath: "desks/orakel/reject-queue-twice.md", notionPageId: "page-reject-queue-twice",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await setProposalState(db, revertedId, "rejected");
    await markProposalReverted(db, revertedId);
    const first = await readProposal(revertedId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await markProposalReverted(db, revertedId);
    expect((await readProposal(revertedId)).resolved_at).toEqual(first.resolved_at);
  });
});

// resolveProposal (spec §20.1) is THE guarded transition every human-facing surface
// goes through — the console card, Saga's 👍 card, the CLI. These tests are the
// contract that keeps those surfaces from drifting apart.
describe("resolveProposal — the one guarded transition", () => {
  it("approve moves pending → approved and leaves resolved_at NULL (the engine still owes a write)", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/resolve-approve.md", notionPageId: "page-resolve-approve",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    const row = await resolveProposal(db, id, "approve");
    // Returns the proposal it acted on, so a caller (Saga) can name the file back
    // to the human without a second query.
    expect(row.vaultPath).toBe("desks/orakel/resolve-approve.md");

    const stored = await readProposal(id);
    expect(stored.state).toBe("approved");
    expect(stored.resolved_at).toBeNull();
  });

  it("reject moves pending → rejected and leaves resolved_at NULL — the revert has not happened yet", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/resolve-reject.md", notionPageId: "page-resolve-reject",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await resolveProposal(db, id, "reject");

    const stored = await readProposal(id);
    expect(stored.state).toBe("rejected");
    // NULL here is the engine's work queue (getRejectedUnexecuted). Stamping it
    // would make a rejection that never reverted look like one that did.
    expect(stored.resolved_at).toBeNull();
    expect((await getRejectedUnexecuted(db)).map((p: { id: number }) => p.id)).toContain(id);
  });

  it("refuses an id that is no longer open, instead of re-opening a resolved row", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/resolve-applied.md", notionPageId: "page-resolve-applied",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await setProposalState(db, id, "applied");

    // The chat surface makes this reachable in a way the console never did: a model
    // can echo back an id it read earlier in the conversation, after the engine
    // already applied it. Re-opening it could collide with the partial unique index
    // if a newer proposal for the same path has since opened.
    await expect(resolveProposal(db, id, "approve")).rejects.toThrow(/no open proposal/);
    expect((await readProposal(id)).state).toBe("applied");
  });

  it("refuses an id that never existed", async () => {
    await expect(resolveProposal(db, 987654, "reject")).rejects.toThrow(/no open proposal/);
  });

  it("cannot re-open a row the engine already applied — the state predicate is IN the UPDATE", async () => {
    // The race this closes: the hourly apply tick and a human 👍 are on a collision course
    // by design. A read-then-write guard can see the row open and still land its UPDATE
    // after the engine set 'applied' + resolved_at — producing a 'rejected' row WITH
    // resolved_at, which getRejectedUnexecuted never picks up, so the Notion revert he
    // asked for silently never happens.
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/resolve-race.md", notionPageId: "page-resolve-race",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await setProposalState(db, id, "approved");
    await setProposalState(db, id, "applied");          // the engine wins the race
    const applied = await readProposal(id);
    expect(applied.resolved_at).not.toBeNull();

    await expect(resolveProposal(db, id, "reject")).rejects.toThrow(/no open proposal/);

    const after = await readProposal(id);
    expect(after.state).toBe("applied");                 // untouched
    expect(after.resolved_at).toEqual(applied.resolved_at);
    expect((await getRejectedUnexecuted(db)).map((p: { id: number }) => p.id)).not.toContain(id);
  });

  it("resolves an already-approved proposal — changing his mind before the tick still works", async () => {
    // 'approved' must stay resolvable: he can 👍 approve and then reject before the engine
    // gets to it. Only states the engine has finished with are closed.
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/resolve-rethink.md", notionPageId: "page-resolve-rethink",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await resolveProposal(db, id, "approve");
    await resolveProposal(db, id, "reject");
    const after = await readProposal(id);
    expect(after.state).toBe("rejected");
    expect(after.resolved_at).toBeNull();                // the revert is still owed
  });
});

// The announce ledger (spec §20.3, migration 017) — what stops Saga re-DMing the same
// proposal on every poll and every restart.
describe("announce ledger — getUnannouncedProposals / markProposalAnnounced / getStaleAnnouncedProposals", () => {
  it("lists a fresh pending proposal, and stops listing it once announced", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/announce-a.md", notionPageId: "page-announce-a",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    expect((await getUnannouncedProposals(db)).map((p: { id: number }) => p.id)).toContain(id);

    await markProposalAnnounced(db, id);
    expect((await getUnannouncedProposals(db)).map((p: { id: number }) => p.id)).not.toContain(id);
  });

  it("never lists an APPROVED proposal — it is decided, and re-asking would be noise", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/announce-approved.md", notionPageId: "page-announce-approved",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await setProposalState(db, id, "approved");
    expect((await getUnannouncedProposals(db)).map((p: { id: number }) => p.id)).not.toContain(id);
  });

  it("first stamp wins — a re-announce cannot move the clock and reset the staleness countdown", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/announce-once.md", notionPageId: "page-announce-once",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await markProposalAnnounced(db, id);
    const first = (await readProposal(id)).announced_at;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await markProposalAnnounced(db, id);
    expect((await readProposal(id)).announced_at).toEqual(first);
  });

  it("escalates only a proposal still pending well after it was announced", async () => {
    const staleId = await insertProposal(db, {
      vaultPath: "desks/orakel/announce-stale.md", notionPageId: "page-announce-stale",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    const freshId = await insertProposal(db, {
      vaultPath: "desks/orakel/announce-fresh.md", notionPageId: "page-announce-fresh",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await markProposalAnnounced(db, staleId);
    await markProposalAnnounced(db, freshId);
    await db.query(
      `UPDATE notion_sync_proposals SET announced_at = now() - interval '25 hours' WHERE id = $1`,
      [staleId],
    );

    const stale = (await getStaleProposals(db, 24)).map((p: { id: number }) => p.id);
    expect(stale).toContain(staleId);
    expect(stale).not.toContain(freshId);
    const staleRow = (await getStaleProposals(db, 24)).find((p: { id: number }) => p.id === staleId);
    expect(staleRow?.announcedAt).toBeInstanceOf(Date);
  });

  it("ESCALATES a proposal nobody ever announced, once past the longer threshold", async () => {
    // The review catch. Excluding NULL announced_at assumed the poll always runs; it does
    // not when 017 is unapplied, the saga image predates the hand, the channel resolves
    // empty, or the door is down — exactly the failures this alarm exists to catch.
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/announce-never.md", notionPageId: "page-announce-never",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await db.query(
      `UPDATE notion_sync_proposals SET created_at = now() - interval '72 hours' WHERE id = $1`,
      [id],
    );
    const stale = await getStaleProposals(db, 24);
    const row = stale.find((p: { id: number }) => p.id === id);
    expect(row).toBeDefined();
    // The caller words the two cases differently, so it has to be able to tell them apart.
    expect(row?.announcedAt).toBeNull();
  });

  it("does NOT escalate a freshly proposed, not-yet-announced row — that window is the poll's", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/announce-fresh-unannounced.md", notionPageId: "page-fresh-unann",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    expect((await getStaleProposals(db, 24)).map((p: { id: number }) => p.id)).not.toContain(id);
  });

  it("stops escalating once the human decides", async () => {
    const id = await insertProposal(db, {
      vaultPath: "desks/orakel/announce-decided.md", notionPageId: "page-announce-decided",
      proposedBody: "body", baseMdHash: "base-hash", notionHash: "notion-hash",
    });
    await markProposalAnnounced(db, id);
    await db.query(
      `UPDATE notion_sync_proposals SET announced_at = now() - interval '48 hours' WHERE id = $1`,
      [id],
    );
    expect((await getStaleProposals(db, 24)).map((p: { id: number }) => p.id)).toContain(id);

    await resolveProposal(db, id, "approve");
    expect((await getStaleProposals(db, 24)).map((p: { id: number }) => p.id)).not.toContain(id);
  });
});

describe("getFrozenDocs", () => {
  it("returns frozen doc rows with their reason and original frozen_at, and nothing else", async () => {
    await upsertDocSynced(db, {
      vaultPath: "desks/orakel/frozen-listed.md", pageId: "page-frozen-listed",
      mdHash: "md", notionHash: "notion", notionLastEdited: null,
    });
    await upsertDocSynced(db, {
      vaultPath: "desks/orakel/frozen-not-listed.md", pageId: "page-frozen-not-listed",
      mdHash: "md", notionHash: "notion", notionLastEdited: null,
    });
    await freezeDoc(db, "desks/orakel/frozen-listed.md", "changed in both Notion and the vault");

    const frozen = await getFrozenDocs(db);
    const paths = frozen.map((row) => row.vaultPath);
    expect(paths).toContain("desks/orakel/frozen-listed.md");
    expect(paths).not.toContain("desks/orakel/frozen-not-listed.md");

    const row = frozen.find((r) => r.vaultPath === "desks/orakel/frozen-listed.md");
    expect(row?.reason).toBe("changed in both Notion and the vault");
    expect(row?.frozenAt).toBeInstanceOf(Date);
  });

  it("the DB enforces one open proposal per vault_path (never stack, per §18.4)", async () => {
    const vaultPath = "desks/orakel/proposal-unique.md";
    await insertProposal(db, {
      vaultPath, notionPageId: "page-unique-1", proposedBody: "body-1",
      baseMdHash: "base-1", notionHash: "notion-1",
    });
    await expect(insertProposal(db, {
      vaultPath, notionPageId: "page-unique-2", proposedBody: "body-2",
      baseMdHash: "base-2", notionHash: "notion-2",
    })).rejects.toThrow();
  });
});

describe("replaceFidelity / getFidelityPassed", () => {
  it("upserts pass/fail verdicts by vault_path; getFidelityPassed returns only the passing set", async () => {
    await replaceFidelity(db, [
      { vaultPath: "desks/orakel/fidelity-pass.md", passed: true },
      { vaultPath: "desks/orakel/fidelity-fail.md", passed: false, reason: "table roundtrip mismatch" },
    ]);
    const passed = await getFidelityPassed(db);
    expect(passed.has("desks/orakel/fidelity-pass.md")).toBe(true);
    expect(passed.has("desks/orakel/fidelity-fail.md")).toBe(false);

    // A re-check reverses the verdict — replace, not accumulate.
    await replaceFidelity(db, [
      { vaultPath: "desks/orakel/fidelity-pass.md", passed: false, reason: "regressed" },
    ]);
    const rechecked = await getFidelityPassed(db);
    expect(rechecked.has("desks/orakel/fidelity-pass.md")).toBe(false);
  });

  it("is a no-op on an empty batch", async () => {
    await expect(replaceFidelity(db, [])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 4 (T4) — the Meetings row as a transcript's state row
// ---------------------------------------------------------------------------

describe("the transcript state row", () => {
  it("ensureMeetingRow inserts once and never overwrites the attendee pass's verdict", async () => {
    await recordMeetingUnmatched(db, "page-ensure", "no calendar candidate");
    await ensureMeetingRow(db, "page-ensure");

    const rows = await db.query<{ state: string; target: string; direction: string; n: string }>(
      `SELECT state, target, direction, COUNT(*) OVER ()::text AS n
         FROM notion_sync_docs WHERE notion_page_id = $1`,
      ["page-ensure"],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].state).toBe("unmatched");     // ON CONFLICT DO NOTHING
    expect(rows.rows[0].target).toBe("meetings");
    expect(rows.rows[0].direction).toBe("notion_to_md");

    // …and it creates one where the attendee pass never wrote anything, which is
    // the case that matters: a meeting whose Attendees was already filled has no
    // row at all, and a rejected create would have nowhere to be remembered.
    await ensureMeetingRow(db, "page-ensure-fresh");
    expect((await getMeetingRows(db)).get("page-ensure-fresh")?.vaultPath).toBeNull();
  });

  it("linkPageToVaultFile fills in the vault path WITHOUT a second row or a UNIQUE violation", async () => {
    const path = "zero7/transcripts/2026-08-05-link.md";
    await recordMeetingUnmatched(db, "page-link", "no calendar candidate");

    // The path-keyed upsert would have tried to INSERT here and violated
    // `notion_page_id UNIQUE` — the collision this whole design exists to avoid.
    await linkPageToVaultFile(db, {
      vaultPath: path, pageId: "page-link", mdHash: "md", notionHash: "nh",
      notionLastEdited: null, direction: "notion_to_md", writtenBodyHash: "body-hash",
    });

    const row = (await getMeetingRows(db)).get("page-link");
    expect(row?.vaultPath).toBe(path);
    // The md_hash CASE: a MEETINGS row takes the WRITTEN-BODY hash, never the push
    // render hash the docs branch would store. That distinction is what stops a
    // transcript retiring itself the first time its render drifts or an edit is
    // declined — see MeetingStateRow.mdHash.
    expect(row?.mdHash).toBe("body-hash");
    expect(row?.notionHash).toBe("nh");
    // target, direction and state are all left exactly as they were.
    const raw = await db.query<{ target: string; direction: string; state: string }>(
      `SELECT target, direction, state FROM notion_sync_docs WHERE notion_page_id = $1`,
      ["page-link"],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]).toMatchObject({ target: "meetings", direction: "notion_to_md", state: "unmatched" });

    // Visible to the apply pass's across-targets read…
    expect((await getLinkedRows(db)).get(path)?.target).toBe("meetings");
    // …and structurally invisible to every desk pass.
    expect((await getDeskRows(db)).has(path)).toBe(false);
    expect((await getDocRows(db)).has(path)).toBe(false);
  });

  it("linkPageToVaultFile INSERTS a fresh docs row when the page has none — T6's shape, unchanged", async () => {
    await linkPageToVaultFile(db, {
      vaultPath: "zero7/born-in-notion.md", pageId: "page-born", mdHash: "md", notionHash: "nh",
      notionLastEdited: null, direction: "notion_to_md", writtenBodyHash: "body-hash",
    });
    const row = (await getLinkedRows(db)).get("zero7/born-in-notion.md");
    expect(row?.target).toBe("docs");
    // …and a DOCS row keeps the render hash, so the CASE cannot pass by always
    // taking the body hash.
    expect(row?.mdHash).toBe("md");
    expect(row?.direction).toBe("notion_to_md");
    expect(row?.state).toBe("synced");
  });

  // ── T6's half of the same mechanism ──────────────────────────────────────
  it("ensureDocsRow creates the state row a Notion-BORN page's decision needs", async () => {
    await ensureDocsRow(db, "page-born-ensure");

    const raw = await db.query<{ target: string; direction: string; state: string; vault_path: string | null }>(
      `SELECT target, direction, state, vault_path FROM notion_sync_docs WHERE notion_page_id = $1`,
      ["page-born-ensure"],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]).toMatchObject({ target: "docs", direction: "notion_to_md", state: "synced" });
    // NULL vault_path is the whole point: the row exists so a 👎 has somewhere to
    // live, and it names no file until an approved create fills one in.
    expect(raw.rows[0].vault_path).toBeNull();

    // …and it is therefore invisible to every path-keyed reader, so it cannot be
    // mistaken for a document by the desk passes or by the apply pass's row gate.
    expect([...(await getDeskRows(db)).values()].some((r) => r.pageId === "page-born-ensure")).toBe(false);
    expect([...(await getLinkedRows(db)).values()].some((r) => r.pageId === "page-born-ensure")).toBe(false);
  });

  it("ensureDocsRow never overwrites an existing row — not its hashes, not its state", async () => {
    await upsertDocSynced(db, {
      vaultPath: "zero7/already-a-document.md", pageId: "page-born-existing",
      mdHash: "md", notionHash: "nh", notionLastEdited: null, direction: "two_way",
    });
    await ensureDocsRow(db, "page-born-existing");

    const row = (await getLinkedRows(db)).get("zero7/already-a-document.md");
    expect(row?.notionHash).toBe("nh");
    expect(row?.direction).toBe("two_way");     // NOT flipped to notion_to_md
  });

  it("getPageRows answers 'does this Notion page have a state row' ACROSS both targets", async () => {
    await ensureDocsRow(db, "page-rows-born");
    await ensureMeetingRow(db, "page-rows-meeting");
    await upsertDocSynced(db, {
      vaultPath: "zero7/page-rows-doc.md", pageId: "page-rows-doc",
      mdHash: "md", notionHash: "nh", notionLastEdited: null,
    });

    const rows = await getPageRows(db);
    // A docs-scoped read would have missed the meetings row — and a create proposal
    // raised for that page would then have its approval fill in somebody else's
    // vault_path, because linkPageToVaultFile conflicts on notion_page_id.
    expect(rows.get("page-rows-meeting")?.target).toBe("meetings");
    expect(rows.get("page-rows-born")).toMatchObject({ target: "docs", vaultPath: null });
    expect(rows.get("page-rows-doc")).toMatchObject({ vaultPath: "zero7/page-rows-doc.md", notionHash: "nh" });
  });

  it("recordNotionAccounted remembers a declined CREATE against an ensureDocsRow row", async () => {
    // The loop this closes: without the row, this THROWS, the rejection stays
    // unexecuted, and T6 stays silent rather than re-asking. With it, the decline
    // is durable and the next tick's hash comparison finds it.
    await ensureDocsRow(db, "page-born-declined");
    await recordNotionAccounted(db, "page-born-declined", "declined-hash");
    expect((await getPageRows(db)).get("page-born-declined")?.notionHash).toBe("declined-hash");
  });

  it("recordNotionAccounted records a decline against the PAGE, and THROWS when there is no row", async () => {
    await ensureMeetingRow(db, "page-accounted");
    await recordNotionAccounted(db, "page-accounted", "declined-hash");
    expect((await getMeetingRows(db)).get("page-accounted")?.notionHash).toBe("declined-hash");

    // No row is a CONTRACT BREACH, not a no-op (review round 1). It still does not
    // insert one — that would mean guessing a `target` for a page this function
    // knows nothing about — but silence let the rejected-create branch "succeed",
    // close the proposal, and re-ask on the very next tick.
    await expect(recordNotionAccounted(db, "page-that-does-not-exist", "h"))
      .rejects.toThrow(/no state row/);
    expect((await getMeetingRows(db)).has("page-that-does-not-exist")).toBe(false);
  });

  // THE CRITICAL's second layer (review round 1). Even with every scope guard
  // wrong, a docs-pass write must not be able to take over a path another target
  // owns. `vault_path` is UNIQUE across the whole table, so without the predicate
  // this upsert lands on whatever row holds the path.
  it("upsertDocSynced REFUSES to take over a path a MEETINGS row owns, loudly", async () => {
    const path = "zero7/transcripts/2026-08-05-hijack.md";
    await ensureMeetingRow(db, "page-hijack");
    await linkPageToVaultFile(db, {
      vaultPath: path, pageId: "page-hijack", mdHash: "md", notionHash: "nh",
      notionLastEdited: null, direction: "notion_to_md", writtenBodyHash: "body-hash",
    });

    // What the desk push does after creating a page for a file it thinks is
    // unowned. Before the fix this SUCCEEDED and repointed the row.
    await expect(upsertDocSynced(db, {
      vaultPath: path, pageId: "page-the-push-just-invented", mdHash: "x", notionHash: "y",
      notionLastEdited: null,
    })).rejects.toThrow(/another target/);

    const row = (await getMeetingRows(db)).get("page-hijack");
    expect(row?.vaultPath).toBe(path);           // intact
    expect(row?.notionHash).toBe("nh");
    const raw = await db.query<{ notion_page_id: string; target: string }>(
      `SELECT notion_page_id, target FROM notion_sync_docs WHERE vault_path = $1`, [path],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0].notion_page_id).toBe("page-hijack");
    expect(raw.rows[0].target).toBe("meetings");
  });

  it("upsertDocSynced still updates an ordinary docs row — the guard refuses one thing only", async () => {
    const path = "zero7/ordinary.md";
    await upsertDocSynced(db, {
      vaultPath: path, pageId: "page-ordinary", mdHash: "a", notionHash: "b", notionLastEdited: null,
    });
    await upsertDocSynced(db, {
      vaultPath: path, pageId: "page-ordinary-2", mdHash: "c", notionHash: "d", notionLastEdited: null,
    });
    const row = (await getDeskRows(db)).get(path);
    expect(row?.pageId).toBe("page-ordinary-2");
    expect(row?.mdHash).toBe("c");
  });

  it("updateNotionWatermark reaches a MEETINGS row — the rejected-edit record depends on it", async () => {
    const path = "zero7/transcripts/2026-08-05-watermark.md";
    await ensureMeetingRow(db, "page-watermark");
    await linkPageToVaultFile(db, {
      vaultPath: path, pageId: "page-watermark", mdHash: "md", notionHash: "old",
      notionLastEdited: null, direction: "notion_to_md", writtenBodyHash: "body-hash",
    });

    await updateNotionWatermark(db, path, "declined", "2026-08-05T10:00:00.000Z");

    // With the old `target = 'docs'` predicate this updated ZERO rows, and pull
    // re-proposed the rejected edit on the very next tick, forever.
    expect((await getMeetingRows(db)).get("page-watermark")?.notionHash).toBe("declined");
  });
});
