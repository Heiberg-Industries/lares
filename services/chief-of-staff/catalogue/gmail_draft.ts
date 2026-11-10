// Create a reply DRAFT in the connected mailbox's Drafts folder (nothing is sent). Drafting is
// autonomous by default; an installation can re-gate this specific action on the permissions board.
//
// Set `threadId` (from gmail_read or gmail_search) to make it a reply: the tool reads the
// thread and sets In-Reply-To, References and the subject itself (lib/reply-threading.ts), so the
// draft stays in the same Gmail conversation. `signatureHtml` appends the account's signature.
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { taintTurn, turnKeyFrom } from "@lares/agent-kit/origin-taint";
import { configuredOwnerId, listAliases } from "../lib/identity-client.js";
import { ownerRecipientPosition, replyRecipients, PRIVATE_REPLY_NOTE } from "../lib/reply-recipients.js";
import { googleClients, listEnrolledMailboxes } from "../lib/google.js";
import { draftApprovalFor } from "../lib/board.js";
import { pickOriginal, replyHeaders, replySubject } from "../lib/reply-threading.js";

export default defineTool({
  description:
    "Create a reply DRAFT in the connected mailbox's Drafts folder (nothing is sent). " +
    "After creating it, confirm in one line with its subject and say to open Gmail to send. " +
    "To reply, pass the email's `threadId` (from gmail_read or gmail_search): the tool sets the reply " +
    "headers and the subject itself, so the draft stays in the same Gmail conversation. Hidden recipients get a private sender-only draft. Set `signatureHtml` to append the account's signature. " +
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
    if (!input.threadId) throw new Error("A reply draft needs the email's threadId so its original recipients can be checked.");
    const self = [...await listAliases(getPool(), configuredOwnerId(), "email"),
      ...await listEnrolledMailboxes()];
    const key = turnKeyFrom(context);
    // Provider failures may carry outside text too, so mark the turn before the read.
    if (key) taintTurn(key, "third_party");
    const thread = await gmail.readThread(input.threadId);
    const original = pickOriginal(thread, input.inReplyTo, self);
    if (!original) throw new Error("The original message could not be found in this thread; no reply draft was created.");
    // Threading comes from the original, never from the model: the model's own headers and subject are ignored.
    const threaded = { ...input, ...replyHeaders(original), subject: replySubject(original.subject) };
    if (ownerRecipientPosition(original, self) !== "bcc_or_list") return gmail.draft(threaded);
    const recipients = replyRecipients(original, self);
    if (recipients.to.length === 0) throw new Error("The original sender has no safe reply address; no reply draft was created.");
    const result = await gmail.draft({ ...threaded, to: recipients.to, cc: [] });
    return { ...result, draftNote: PRIVATE_REPLY_NOTE };
  },
});
