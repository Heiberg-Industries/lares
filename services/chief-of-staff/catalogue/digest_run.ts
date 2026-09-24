// Ask the digest service (the untouched saga-digest container) to run now instead of
// waiting for its next scheduled pass. Writes one queue row via lib/digest-client.ts;
// ungated (unlike the write tools elsewhere in this agent) per the plan's TOOL verdict.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { enqueueDigestRequest } from "../lib/digest-client.js";
import { allowedSlackUserIds } from "../lib/slack-allowlist.js";

// Must match the untouched saga-digest container's own `AGENT` constant
// (services/agent-runtime/bin/digest.ts) — it polls digest_requests WHERE agent = 'saga'.
const AGENT = "saga";

export default defineTool({
  description:
    "Ask the digest service to process the _inbox now instead of waiting for its next " +
    "scheduled pass (09:00/17:00 Europe/Oslo). Writes one row to the digest_requests " +
    "queue (Postgres, via DATABASE_URL) that the separate, already-running saga-digest " +
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
      agent: AGENT,
      requestedBy: principalId,
      door: "slack",
      threadRef: principalId,
    });
    return { requestId: id };
  },
});
