// Create a reply DRAFT in the connected mailbox's Drafts folder (nothing is sent). Drafting is
// autonomous by default; an installation can re-gate this specific action on the permissions board.
//
// Ported from hands/gmail.ts's "draft" action. Set `threadId` + `inReplyTo` (the original
// message's Message-ID) to thread it as a proper reply; `signatureHtml` to append the
// account's signature.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { googleClients } from "../lib/google.js";
import { draftApprovalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Create a reply DRAFT in the connected mailbox's Drafts folder (nothing is sent). " +
    "After creating it, confirm in one line with its subject and say to open Gmail to send. " +
    "Set `threadId` + `inReplyTo` (the original message's Message-ID) to " +
    "thread it as a proper reply. Set `signatureHtml` to append the account's signature. " +
    "Set `account` to act as a specific connected mailbox (defaults to the primary).",
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
  approval: draftApprovalFor("gmail_draft"),
  async execute(input) {
    const gmail = await googleClients().gmail(input.account);
    return gmail.draft(input);
  },
});
