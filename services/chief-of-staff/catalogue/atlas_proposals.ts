// List the open Atlas proposals: re-derived venture-note narratives waiting on Bendik's
// approval. Read-only, ungated — the atlas_resolve_proposal decision tool is the gated one.
//
// The Atlas equivalent of notion_proposals.ts. There is no prior agent-runtime "atlas
// proposal" hand to port from (the old system's Telegram `ap:a:`/`ap:r:` buttons were wired
// directly in bin/saga.ts, not behind a hand), so this mirrors notion_proposals.ts's shape
// rather than an existing tool description.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { atlasApproveConsequence, atlasRejectConsequence, getOpenAtlasProposals } from "../lib/proposals-store.js";

export default defineTool({
  description:
    "List the open Atlas proposals: a venture note whose narrative the Atlas sync job has " +
    "re-derived from its canonical sources, waiting on Bendik's approval before it is " +
    "written and pushed. Each shows an id, the note path, a diff, and the approve/reject " +
    "consequence sentence — quote it verbatim. Use this whenever he asks what Atlas note " +
    "changes are waiting, and ALWAYS before calling atlas_resolve_proposal, so you act on a " +
    "current id/notePath pair rather than one from earlier in the conversation.",
  inputSchema: z.object({}),
  async execute() {
    const rows = await getOpenAtlasProposals(getPool());
    return {
      proposals: rows.map((p) => ({
        id: p.id,
        notePath: p.notePath,
        state: p.state,
        diffPreview: p.diffPreview,
        createdAt: p.createdAt.toISOString(),
        approveConsequence: atlasApproveConsequence(),
        rejectConsequence: atlasRejectConsequence(),
      })),
    };
  },
});
