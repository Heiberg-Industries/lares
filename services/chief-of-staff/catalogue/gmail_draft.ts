// Create a reply DRAFT in the connected mailbox's Drafts folder (nothing is sent). Drafting is
// autonomous by default; an installation can re-gate this specific action on the permissions board.
//
// Set `threadId` + `inReplyTo` (the original
// message's Message-ID) to thread it as a proper reply; `signatureHtml` to append the
// account's signature.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";
import { configuredOwnerId, listAliases } from "../lib/identity-client.js";
import { ownerRecipientPosition, replyRecipients, PRIVATE_REPLY_NOTE } from "../lib/reply-recipients.js";
import { googleClients, listEnrolledMailboxes } from "../lib/google.js";
import { draftApprovalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Create a reply DRAFT in the connected mailbox's Drafts folder (nothing is sent). " +
    "After creating it, confirm in one line with its subject and say to open Gmail to send. " +
    "Set `threadId` + `inReplyTo` (the original message's Message-ID) to " +
    "thread it as a proper reply. Hidden recipients get a private sender-only draft. Set `signatureHtml` to append the account's signature. " +
    "Set `account` to act as a specific connected mailbox (defaults to the primary).",
  inputSchema: z.object({
    from: z.string(),
    to: z.array(z.string()).min(1),
    cc: z.array(z.string()).optional(),
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
  async execute(input, context) {
    const gmail = await googleClients().gmail(input.account);
    if (!input.threadId && !input.inReplyTo) return gmail.draft(input);
    if (!input.threadId || !input.inReplyTo) throw new Error("A reply draft needs both threadId and inReplyTo so its original recipients can be checked.");
    const self = [...await listAliases(getPool(), configuredOwnerId(), "email"),
      ...await listEnrolledMailboxes(process.env["GOOGLE_PRINCIPAL_ID"])];
    const key = turnKeyFrom(context);
    // Provider failures may carry outside text too, so mark the turn before the read.
    if (key) taintTurn(key, "third_party");
    const thread = await gmail.readThread(input.threadId);
    const original = thread.find((message) => message.messageId === input.inReplyTo);
    if (!original) throw new Error("The original message could not be found in this thread; no reply draft was created.");
    if (ownerRecipientPosition(original, self) !== "bcc_or_list") return gmail.draft(input);
    const recipients = replyRecipients(original, self);
    if (recipients.to.length === 0) throw new Error("The original sender has no safe reply address; no reply draft was created.");
    const result = await gmail.draft({ ...input, to: recipients.to, cc: [] });
    return { ...result, draftNote: PRIVATE_REPLY_NOTE };
  },
});
