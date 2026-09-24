// Record a sent outreach email for reply-watching (ORB-75). Bookkeeping only — no side
// effects on Gmail or Twenty — so it is NOT gated: call it right after a successful,
// already-approved gmail_send for a sales-outreach message, passing the threadId gmail_send
// returned. agent/schedules/outreach-reply-watch.ts polls rows this creates.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { trackOutreachThread } from "../lib/outreach-store.js";

export default defineTool({
  description:
    "Start watching a just-sent outreach email's thread for a reply. Call this immediately " +
    "after gmail_send succeeds for a sales-outreach message — pass the threadId AND sentAt " +
    "gmail_send returned, the account it was sent from, and the Twenty personId if known. " +
    "sentAt anchors reply-detection to the actual send time (not whenever this call runs), " +
    "so a very fast reply isn't missed. Not gated: this only records bookkeeping, it sends " +
    "nothing and writes nothing to Twenty.",
  inputSchema: z.object({
    threadId: z.string(),
    account: z.string(),
    personId: z.string().optional(),
    sentAt: z.string().optional().describe("The `sentAt` gmail_send returned for this message."),
  }),
  async execute({ threadId, account, personId, sentAt }) {
    const tracked = await trackOutreachThread(getPool(), { threadId, account, personId, sentAt });
    return { ok: true, id: tracked.id } as const;
  },
});
