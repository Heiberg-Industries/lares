// List the open Notion→vault proposals. Read-only, ungated, matching remind_list.ts's
// verdict for a list tool: only the decision (notion_resolve_proposal) needs the owner's approval.
// Reads lib/proposals-store.ts.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { approveConsequence, getOpenProposals, rejectConsequence } from "../lib/proposals-store.js";

export default defineTool({
  description:
    "List the open Notion→vault proposals: edits the owner made to a Notion doc page that are " +
    "waiting on the owner's approval before they are written to the private area of the Vault. Each shows an id, " +
    "the vault file, a diff, and its own approve/reject consequence sentence — quote those " +
    "sentences verbatim rather than describing the effect yourself, they are NOT the same " +
    "for every proposal. Entries with kind 'create' are different: that file does not exist " +
    "in the vault yet and Notion is asking to add it, so there is no 'before' side and " +
    "rejecting one changes nothing anywhere. Use this whenever the owner asks what is waiting, what " +
    "changed in Notion, or refers to an edit they made there — and ALWAYS before calling " +
    "notion_resolve_proposal, so you act on a current id/vaultPath pair rather than one from " +
    "earlier in the conversation.",
  inputSchema: z.object({}),
  async execute() {
    const rows = await getOpenProposals(getPool());
    return {
      proposals: rows.map((p) => ({
        id: p.id,
        vaultPath: p.vaultPath,
        kind: p.kind,
        notionOwned: p.notionOwned,
        state: p.state,
        diffPreview: p.diffPreview,
        createdAt: p.createdAt.toISOString(),
        approveConsequence: approveConsequence(p),
        rejectConsequence: rejectConsequence(p),
      })),
    };
  },
});
