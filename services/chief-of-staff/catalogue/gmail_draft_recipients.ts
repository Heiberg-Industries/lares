/**
 * gmail_draft_recipients — change who an EXISTING draft goes to (2026-09-08).
 *
 * Bendik: recipients of a drafted reply must be editable "both via Gmail AND by telling Saga".
 * Gmail already works — it is a normal draft. This is the telling-Saga half: "add Kjetil to the
 * reply to Stefan" resolves to the draft the triage remembered for that thread (sql/034), reads
 * its raw message, rewrites ONLY the To/Cc headers (lib/draft-recipients.ts) and writes the same
 * bytes back with drafts.update — body, HTML part and signature untouched, same draft id.
 *
 * Autonomous by default because this only edits an unsent draft. An installation can re-gate the
 * specific action. Refuses a change that would leave nobody in To.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "@lares/agent-kit/db";
import { googleClients, listEnrolledMailboxes } from "../lib/google.js";
import { findDraft } from "../lib/email-triage-store.js";
import { applyRecipientChanges, currentRecipients, rewriteRecipientHeaders } from "../lib/draft-recipients.js";
import { draftApprovalFor } from "../lib/board.js";

export default defineTool({
  description:
    "Change who an EXISTING Gmail draft goes to — add or remove recipients. Nothing is sent, and " +
    "the draft's text is untouched. Name the draft by `threadId` (the thread the " +
    "reply is on — I look up the draft the triage created there) or by `draftId`. Set `account` to " +
    "act as a specific connected mailbox (defaults to the primary). Addresses may carry a display " +
    "name: `Kjetil <kjetil@example.com>`.",
  inputSchema: z.object({
    account: z.string().optional(),
    threadId: z.string().optional(),
    draftId: z.string().optional(),
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
  }),
  approval: draftApprovalFor("gmail_draft_recipients"),
  async execute(input) {
    if ((input.add?.length ?? 0) === 0 && (input.remove?.length ?? 0) === 0) {
      throw new Error("nothing to change — give at least one address to add or remove");
    }
    // The mailbox the draft lives in: the named account, else the primary (first enrolled) one —
    // the same default `googleClients().gmail()` applies.
    const mailbox = input.account ?? (await listEnrolledMailboxes(process.env["GOOGLE_PRINCIPAL_ID"]))[0] ?? "";
    const gmail = await googleClients().gmail(mailbox || undefined);

    let draftId = input.draftId;
    if (!draftId) {
      if (!input.threadId) throw new Error("name the draft: give threadId (the thread the reply is on) or draftId");
      const known = await findDraft(getPool(), mailbox, { threadId: input.threadId });
      if (!known) throw new Error(`no draft is known for thread ${input.threadId} in this mailbox — the triage did not draft there, or it was drafted before 2026-09-08`);
      draftId = known.draftId;
    }

    const { raw, threadId } = await gmail.readDraftRaw(draftId);
    const next = applyRecipientChanges(currentRecipients(raw), { add: input.add ?? [], remove: input.remove ?? [] });
    await gmail.updateDraftRaw(draftId, rewriteRecipientHeaders(raw, next), threadId || input.threadId);
    return { draftId, to: next.to, cc: next.cc };
  },
});
