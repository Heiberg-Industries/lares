/**
 * Pending Notion and shared-notes proposals for the Waiting on you page, read from the database
 * and decided here — whether or not any agent is running. The agents announce proposals, but the
 * proposals themselves live in two tables, so this page never depends on an agent being up.
 *
 * NO NEW STATE FLIP. Every decision goes through the guarded transition the other surfaces use
 * (`resolveProposal`, `resolveAtlasProposal` in `@lares/agent-box`): one statement that moves a row
 * only while it is still open. The engine's next sync tick does the actual write, exactly as for a
 * decision made on /integrations or in chat. Memory proposals are not handled here.
 *
 * AUTHORISATION is that of `app/api/notion-proposals/route.ts`: any signed-in console member
 * (the page and the action both check the session before they get here).
 *
 * The database is reached through `WaitingDeps.query`, the page's one connection, so the module is
 * tested with a fake database like the rest of the page.
 */
import {
  approveConsequence, getOpenProposals, rejectConsequence, resolveProposal, type ProposalRow,
} from "@lares/agent-box/lib/notion-proposals.js";
import { getOpenAtlasProposals, resolveAtlasProposal, type AtlasProposalRow } from "@lares/agent-box/lib/atlas-proposals.js";
import type { DecideResult, Unreadable, WaitingDeps, WaitingItem } from "./waiting";

type Db = Parameters<typeof getOpenProposals>[0];

function dbOf(deps: Pick<WaitingDeps, "query">): Db {
  return {
    query: async (text: string, values?: unknown[]) => {
      const res = await deps.query(text, values ?? []);
      return { rows: res.rows as never[], rowCount: res.rows.length };
    },
  };
}

const ACTIONS: WaitingItem["actions"] = [
  { id: "approve", label: "Approve", tone: "primary" },
  { id: "reject", label: "Reject", tone: "neutral" },
];

const NOTION_LABEL = "Notion proposal";
// The owner's word for the Atlas is "shared notes". The engine's name for it never reaches a page.
const SHARED_NOTES_LABEL = "Shared notes proposal";

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function notionItem(row: ProposalRow, id: (parts: readonly string[]) => string): WaitingItem {
  return {
    id: id(["notion", String(row.id)]),
    kind: "proposal",
    kindLabel: NOTION_LABEL,
    agent: "Notion",
    channel: "Console",
    createdAt: row.createdAt.toISOString(),
    title: row.kind === "create" ? `New file from Notion: ${row.vaultPath}` : `Change from Notion to ${row.vaultPath}`,
    body: [
      { format: "text", label: "Proposed change", text: row.diffPreview || "(no preview was saved)" },
      { format: "text", label: "If you approve", text: sentence(approveConsequence(row)) },
      { format: "text", label: "If you reject", text: sentence(rejectConsequence(row)) },
    ],
    actions: ACTIONS,
    ref: `notion-${row.id}`,
  };
}

function sharedNotesItem(row: AtlasProposalRow, id: (parts: readonly string[]) => string): WaitingItem {
  return {
    id: id(["atlas", String(row.id)]),
    kind: "proposal",
    kindLabel: SHARED_NOTES_LABEL,
    agent: "Shared notes",
    channel: "Console",
    createdAt: row.createdAt.toISOString(),
    title: `Rewrite of the shared note ${row.notePath}`,
    body: [
      { format: "text", label: "Proposed change", text: row.diffPreview || "(no preview was saved)" },
      { format: "text", label: "If you approve", text: "The rewritten note replaces the current one on the next sync, and is pushed." },
      { format: "text", label: "If you reject", text: "The note stays exactly as it is. This draft is not offered again until one of its sources actually changes." },
    ],
    actions: ACTIONS,
    ref: `atlas-${row.id}`,
  };
}

/** Every pending proposal. A table that cannot be read is named, never silently dropped. Only
 *  'pending': an 'approved' row is already decided and waits for the engine. */
export async function listProposals(
  deps: Pick<WaitingDeps, "query" | "log">,
  id: (parts: readonly string[]) => string,
): Promise<{ items: WaitingItem[]; unreadable: Unreadable[] }> {
  const db = dbOf(deps);
  const items: WaitingItem[] = [];
  const unreadable: Unreadable[] = [];
  const log = deps.log ?? ((line: string) => console.warn(line));
  try {
    items.push(...(await getOpenProposals(db)).filter((r) => r.state === "pending").map((r) => notionItem(r, id)));
  } catch {
    log("[waiting] could not read the Notion proposals");
    unreadable.push({ agent: "Notion proposals", kind: "error" });
  }
  try {
    items.push(...(await getOpenAtlasProposals(db)).filter((r) => r.state === "pending").map((r) => sharedNotesItem(r, id)));
  } catch {
    log("[waiting] could not read the shared notes proposals");
    unreadable.push({ agent: "Shared notes proposals", kind: "error" });
  }
  return { items, unreadable };
}

const GONE: DecideResult = { ok: false, reason: "gone", message: "That item could not be found." };

/** Decides one proposal. `parts` are the item id's parts: the table and the row number. */
export async function decideProposal(parts: unknown, actionId: string, deps: Pick<WaitingDeps, "query">): Promise<DecideResult> {
  if (!Array.isArray(parts) || parts.length !== 2 || !parts.every((p) => typeof p === "string")) return GONE;
  const [table, rawId] = parts as [string, string];
  if (!/^[1-9][0-9]{0,15}$/.test(rawId) || (table !== "notion" && table !== "atlas")) return GONE;
  if (actionId !== "approve" && actionId !== "reject") return GONE;
  const id = Number(rawId);
  const db = dbOf(deps);
  let done: string;
  try {
    if (table === "notion") {
      const row = await resolveProposal(db, id, actionId);
      done = actionId === "approve" ? `the next sync ${row.kind === "create" ? "creates the file" : "writes the edit"}` : rejectConsequence(row);
    } else {
      await resolveAtlasProposal(db, id, actionId);
      done = actionId === "approve" ? "the rewritten note is written on the next sync" : "the note stays exactly as it is";
    }
  } catch (error) {
    // The guarded transition throws only when no open row is left to move: someone decided it first.
    if (error instanceof Error && /^no open (atlas )?proposal with id/.test(error.message)) {
      return { ok: false, reason: "decided-elsewhere", message: "This was already decided elsewhere. Nothing more was done." };
    }
    return { ok: false, reason: "unavailable", message: "The console could not reach its database. Nothing was decided; try again in a moment." };
  }
  return actionId === "approve"
    ? { ok: true, outcome: "approved", message: `Approved. ${sentence(done)}.` }
    : { ok: true, outcome: "cancelled", message: `Rejected. ${sentence(done)}.` };
}
