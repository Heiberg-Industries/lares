// Send a real email from the connected mailbox. GATED WRITE — requires the owner to tap Approve
// on every call (this puts mail in a real inbox). Ported from hands/gmail.ts's "send" action.
// Set `threadId` + `inReplyTo` to reply within an existing thread; `account` to act as a
// specific connected mailbox (defaults to the primary).
import { defineTool } from "eve/tools";
import { z } from "zod";

import { googleClients } from "../lib/google.js";
import { assertApproval } from "../lib/approvals.js";
import { approvalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Send a real email from the connected mailbox (requires the owner to tap Approve on the card — this puts mail in " +
    "a real inbox). Set `threadId` + `inReplyTo` (the original message's Message-ID) to reply " +
    "within an existing thread. Set `account` to act as a specific connected mailbox " +
    "(defaults to the primary).",
  inputSchema: z.object({
    from: z.string(),
    to: z.array(z.string()).min(1),
    subject: z.string(),
    bodyText: z.string(),
    threadId: z.string().optional(),
    inReplyTo: z.string().optional(),
    references: z.string().optional(),
    account: z.string().optional(),
    signatureText: z.string().nullable().optional(),
    signatureHtml: z.string().nullable().optional(),
  }),
  approval: approvalFor("gmail_send"),
  async execute(input, ctx) {
    await assertApproval(ctx, "gmail_send", input);

    const gmail = await googleClients().gmail(input.account);
    return gmail.send(input);
  },
});
