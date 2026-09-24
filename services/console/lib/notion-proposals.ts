// services/console/lib/notion-proposals.ts
// The console's half of the 👍 loop (Phase 3 plan T6, spec §18.4/§18.6): the same
// state-flip semantics as `notion-sync approve|reject <path>` (services/notion-sync/
// lib/cli.ts), reached from the console instead of a terminal. Kept as pure
// DB-facing functions — not the route — so they're unit-testable the way
// lib/queries.ts's toNotionSyncDTO/getNotionSyncStatus already are (see
// tests/notion-sync-tile.test.ts): the route (app/api/notion-proposals/route.ts)
// stays a thin HTTP/auth wrapper around these.
import { pool } from "./db";
import {
  getOpenProposals, getFrozenDocs, resolveProposal,
  type ProposalRow, type ProposalState, type ProposalKind, type FrozenDocRow,
} from "@lares/notion-sync/lib/store.js";

export interface NotionProposalDTO {
  id: number;
  vaultPath: string;
  state: ProposalState;
  createdAt: string;
  /**
   * The compact before/after diff preview captured at PROPOSE time
   * (pull-sync.ts's diffPreview, or cli.ts resolveFrozenDoc's own for a
   * forced proposal) and persisted on the row (`diff_preview`, T6 review F2)
   * — a real vault-vs-Notion diff, not a proposed-content-only preview this
   * console derives on its own. This container has no vault mount
   * (services/console/Dockerfile bakes only the agent-runtime `agents/`
   * folders, nothing under /srv/brain) and could never compute one itself;
   * storing the preview at propose time is what lets this card satisfy spec
   * §18.4's "diff visible" contract at all. Same string `notion-sync
   * proposals` prints — one preview per proposal, not two.
   */
  preview: string;
  /**
   * 'update' (a Notion edit to a file that exists) or 'create' (a file Notion wants
   * to ADD to the vault; Phase 4). Carried onto the card because the two Reject
   * buttons do different things — an update's rejection reverts the Notion page
   * from the vault, a create's changes nothing anywhere — and a card that states
   * only the first is telling him the wrong consequence for half the queue.
   */
  kind: ProposalKind;
  /**
   * Does NOTION own this document? The third thing Reject can do (Phase 4): for a
   * Notion-owned row nothing is written on either side, so the "your Notion page is
   * reverted" line — true for a mirror or two-way row — is false for it.
   */
  notionOwned: boolean;
}

export interface FrozenDocDTO {
  vaultPath: string;
  reason: string | null;
  frozenAt: string;
}

export interface NotionProposalsView {
  proposals: NotionProposalDTO[];
  frozen: FrozenDocDTO[];
  /** Set (never `false`) when the queries themselves failed — DB unreachable, or
   *  the Phase 3 tables not migrated in this environment yet. Same posture as
   *  queries.ts's NotionSyncDTO.unavailable, and for the same reason: a query
   *  failure here must degrade the card, not take the whole /integrations page
   *  down with it (see getNotionProposalsView). */
  unavailable?: true;
}

export function toProposalDTO(row: ProposalRow): NotionProposalDTO {
  return {
    id: row.id,
    vaultPath: row.vaultPath,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    preview: row.diffPreview,
    kind: row.kind,
    notionOwned: row.notionOwned,
  };
}

export function toFrozenDTO(row: FrozenDocRow): FrozenDocDTO {
  return {
    vaultPath: row.vaultPath,
    reason: row.reason,
    frozenAt: row.frozenAt.toISOString(),
  };
}

/**
 * Open proposals (pending + approved) plus every frozen doc — the §10 counts.
 * Degrades to an empty, `unavailable: true` view on any query failure rather
 * than throwing (mirrors queries.ts's getNotionSyncStatus): the other cards on
 * /integrations fetch in the same Promise.all (page.tsx), and a DB hiccup or
 * an unmigrated table here must not take the whole page down with it.
 */
export async function getNotionProposalsView(): Promise<NotionProposalsView> {
  try {
    const [proposals, frozen] = await Promise.all([getOpenProposals(pool), getFrozenDocs(pool)]);
    return { proposals: proposals.map(toProposalDTO), frozen: frozen.map(toFrozenDTO) };
  } catch {
    return { proposals: [], frozen: [], unavailable: true };
  }
}

export type ProposalAction = "approve" | "reject";

/**
 * Flips proposal `id` to approved/rejected — nothing else. The engine
 * (runApplySync) does the actual write on its next tick, and a rejection
 * deliberately leaves resolved_at untouched because the Notion revert has not
 * happened yet.
 *
 * The guard (re-check that `id` is still open, so a stale client cannot re-open
 * an already-resolved proposal into the `notion_sync_proposals_open` partial
 * unique index) used to live here. It now lives in `resolveProposal`
 * (@lares/agent-box/lib/notion-proposals.ts) because a second human-facing
 * surface — Saga's `notion` hand, spec §19.2/§20 — needs exactly the same
 * semantics, and two copies of an approval guard is precisely the "third
 * execution path" the design forbids. This function stays as the console's
 * thin, pool-bound entry point.
 */
export async function applyProposalAction(id: number, action: ProposalAction): Promise<void> {
  await resolveProposal(pool, id, action);
}
