import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocking shape as tests/notion-sync-tile.test.ts and
// tests/board.test.ts: a pool whose .query is a controllable mock,
// so the queries this module makes through @lares/notion-sync/lib/store.js run
// for real against a fake result set — no database, no testcontainer.
const queryMock = vi.fn();
vi.mock("../lib/db", () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));

import {
  toProposalDTO, toFrozenDTO, getNotionProposalsView, applyProposalAction,
} from "../lib/notion-proposals";
import type { ProposalRow, FrozenDocRow } from "@lares/notion-sync/lib/store.js";
import { NOTION_RESOLVE_COMMAND } from "../lib/contracts";

beforeEach(() => { queryMock.mockReset(); });

function makeProposal(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: 1,
    vaultPath: "desks/orakel/roadmap.md",
    notionPageId: "page-1",
    proposedBody: "line one\nline two",
    baseMdHash: "base",
    notionHash: "notion",
    diffPreview: "- line one (old)\n+ line one\n+ line two",
    kind: "update",
    notionOwned: false,
    state: "pending",
    createdAt: new Date("2026-08-03T09:05:00.000Z"),
    ...over,
  };
}

function makeFrozen(over: Partial<FrozenDocRow> = {}): FrozenDocRow {
  return {
    vaultPath: "desks/orakel/conflict.md",
    reason: "changed in both Notion and the vault",
    frozenAt: new Date("2026-08-01T00:00:00.000Z"),
    ...over,
  };
}

describe("toProposalDTO", () => {
  it("shapes a proposal row into the DTO, ISO-stamping createdAt", () => {
    const dto = toProposalDTO(makeProposal());
    expect(dto).toEqual({
      id: 1,
      vaultPath: "desks/orakel/roadmap.md",
      state: "pending",
      createdAt: "2026-08-03T09:05:00.000Z",
      preview: "- line one (old)\n+ line one\n+ line two",
      kind: "update",
    notionOwned: false,
    });
  });

  // Phase 4: the card states what each button will do, and the two kinds do
  // different things — an update's Reject reverts the Notion page, a create's
  // changes nothing anywhere. Dropping `kind` here would leave the card stating
  // the update's consequence for every row in a mixed queue.
  it("carries kind through so the card can state the right consequence", () => {
    expect(toProposalDTO(makeProposal({ kind: "create" })).kind).toBe("create");
  });

  // F2 (T6 review): the console has no vault mount, so it cannot derive a
  // vault-vs-Notion diff itself — the preview is passed through VERBATIM from
  // the row's stored diff_preview (captured at propose time by pull-sync.ts /
  // cli.ts resolveFrozenDoc, already truncated there to ~10 changed lines),
  // never re-derived or re-truncated from proposedBody here.
  it("passes diffPreview through verbatim — never derives a preview from proposedBody", () => {
    const dto = toProposalDTO(makeProposal({
      proposedBody: "a completely different, much longer body the preview ignores",
      diffPreview: "- old\n+ new",
    }));
    expect(dto.preview).toBe("- old\n+ new");
  });

  it("passes through the 016 column default ('') when no preview was captured", () => {
    const dto = toProposalDTO(makeProposal({ diffPreview: "" }));
    expect(dto.preview).toBe("");
  });
});

describe("toFrozenDTO", () => {
  it("shapes a frozen doc row into the DTO, ISO-stamping frozenAt", () => {
    expect(toFrozenDTO(makeFrozen())).toEqual({
      vaultPath: "desks/orakel/conflict.md",
      reason: "changed in both Notion and the vault",
      frozenAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("carries a null reason through untouched", () => {
    expect(toFrozenDTO(makeFrozen({ reason: null })).reason).toBeNull();
  });
});

describe("getNotionProposalsView", () => {
  it("returns proposals and frozen docs shaped as DTOs", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          id: "1", vault_path: "desks/orakel/roadmap.md", notion_page_id: "page-1",
          proposed_body: "x", base_md_hash: "b", notion_hash: "n", diff_preview: "- old\n+ new",
          state: "pending", created_at: new Date("2026-08-03T09:05:00.000Z"),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          vault_path: "desks/orakel/conflict.md", frozen_reason: "conflict",
          frozen_at: new Date("2026-08-01T00:00:00.000Z"),
        }],
      });

    const view = await getNotionProposalsView();
    expect(view.unavailable).toBeUndefined();
    expect(view.proposals).toHaveLength(1);
    expect(view.proposals[0].vaultPath).toBe("desks/orakel/roadmap.md");
    expect(view.frozen).toHaveLength(1);
    expect(view.frozen[0].vaultPath).toBe("desks/orakel/conflict.md");
  });

  it("degrades to an empty, unavailable view instead of throwing when a query fails", async () => {
    queryMock.mockRejectedValue(new Error('relation "notion_sync_proposals" does not exist'));
    const view = await getNotionProposalsView();
    expect(view).toEqual({ proposals: [], frozen: [], unavailable: true });
  });
});

// applyProposalAction now delegates to resolveProposal (@lares/agent-box), which is ONE
// guarded UPDATE rather than a read-then-write. That is not a refactor for tidiness: the
// old shape raced the sync engine's hourly apply pass and could leave a 'rejected' row
// with resolved_at already stamped, which getRejectedUnexecuted never picks up — so a
// rejection Bendik made would silently never revert his Notion page. These tests pin the
// single-statement shape, because losing it reintroduces that.
describe("applyProposalAction", () => {
  function openRow(id: string, vaultPath: string, state: string) {
    return {
      id, vault_path: vaultPath, notion_page_id: "page-1",
      proposed_body: "x", base_md_hash: "b", notion_hash: "n", diff_preview: "",
      state, created_at: new Date(),
    };
  }

  it("approves an open proposal in ONE guarded statement", async () => {
    queryMock.mockResolvedValueOnce({ rows: [openRow("5", "desks/orakel/roadmap.md", "approved")] });

    await applyProposalAction(5, "approve");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("UPDATE notion_sync_proposals");
    // The state predicate IS the guard — without it the UPDATE can land after the engine
    // has already applied the row.
    expect(sql).toContain("state IN ('pending', 'approved')");
    expect(sql).toContain("RETURNING");
    expect(params).toEqual([5, "approved"]);
  });

  it("rejects an open proposal — same statement, 'rejected'", async () => {
    queryMock.mockResolvedValueOnce({ rows: [openRow("6", "desks/orakel/other.md", "rejected")] });

    await applyProposalAction(6, "reject");
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([6, "rejected"]);
  });

  it("errors clearly when the UPDATE matches nothing — already resolved, or never existed", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // guarded UPDATE touched no row
    await expect(applyProposalAction(999, "approve")).rejects.toThrow(/no open proposal/);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

// I1 (final review): the frozen table used to print `notion-sync resolve <path>
// --keep md|notion`, a command that cannot be run anywhere the sync actually
// lives — the box has no lares checkout and the image ships services/notion-sync
// alone. The card now shows the entrypoint flag, which is runnable as printed.
describe("NOTION_RESOLVE_COMMAND — what the frozen table tells a human to run", () => {
  it("is the box entrypoint with both halves of the decision, not the commander CLI", () => {
    expect(NOTION_RESOLVE_COMMAND).toContain("docker compose");
    expect(NOTION_RESOLVE_COMMAND).toContain("services/notion-sync/bin/notion-sync.ts");
    expect(NOTION_RESOLVE_COMMAND).toContain("--resolve <path>");
    expect(NOTION_RESOLVE_COMMAND).toContain("--keep md|notion");
    // The old, unrunnable form must not creep back.
    expect(NOTION_RESOLVE_COMMAND).not.toMatch(/(^|\s)notion-sync resolve\b/);
  });
});
