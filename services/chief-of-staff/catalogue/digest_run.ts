// Ask the digest service (the untouched chief-of-staff-digest container) to run now instead of
// waiting for its next scheduled pass. Writes one queue row via lib/digest-client.ts;
// ungated (unlike the write tools elsewhere in this agent) per the plan's TOOL verdict.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { enqueueDigestRequest } from "../lib/digest-client.js";
import { allowedSlackUserIds } from "../lib/slack-allowlist.js";
import { agentName } from "../lib/agent-name.js";

// Must match the untouched chief-of-staff-digest container's own `AGENT` constant
// (services/agent-runtime/bin/digest.ts) — it polls digest_requests WHERE agent = 'the chief of staff'.

export default defineTool({
  description:
    "Ask the digest service to process the _inbox now instead of waiting for its next " +
    "scheduled pass (09:00/17:00 in the owner's home time zone). Writes one row to the digest_requests " +
    "queue (Postgres, via DATABASE_URL) that the separate, already-running digest " +
    "service polls and claims — this tool does not run the digest itself, so results " +
    "arrive as a Slack message shortly after, not in this reply. Ungated: enqueuing an " +
    "on-demand digest pass carries no approval gate.",
  inputSchema: z.object({}),
  async execute() {
    const principalId = allowedSlackUserIds()[0];
    if (!principalId) {
      throw new Error("digest_run: no Slack principal configured (SLACK_ALLOWED_USER_IDS)");
    }
    const { id } = await enqueueDigestRequest(getPool(), {
      agent: agentName(),
      requestedBy: principalId,
      door: "slack",
      threadRef: principalId,
    });
    return { requestId: id };
  },
});
