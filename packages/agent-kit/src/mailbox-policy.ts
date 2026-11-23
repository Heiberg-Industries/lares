/**
 * What an agent's chosen mailbox lets it do with mail. Today there is one answer for every agent: the mailbox only
 * ever WRITES DRAFTS, and the owner sends them from Gmail. The send call itself refuses (`MAILBOX_SEND_REFUSAL`).
 *
 * The refusal alone is too late: an agent that was handed a send tool offers it, raises an approval card, the owner
 * approves, and only then does it fail. So the tools that send are not handed over at all while the policy is
 * drafts-only (`grantedToolNames`), the persona stops mentioning them, and the agent says up front that it can only
 * write drafts. One place decides, so every door, web chat included, agrees.
 */
export type MailboxPolicy = "drafts-only" | "send-allowed";

/** The policy every chosen mailbox has today. */
export const ENGINE_MAILBOX_POLICY: MailboxPolicy = "drafts-only";

/** The sentence a refused send carries. */
export const MAILBOX_SEND_REFUSAL = "This agent writes drafts only; send it from Gmail";

/** Tools whose whole point is to send mail from the chosen mailbox. */
export const MAILBOX_SEND_TOOLS: readonly string[] = ["gmail_send", "meeting_followup_send"];

/** Whether the mailbox policy keeps this tool from being handed to the agent at all. */
export function withheldByMailboxPolicy(tool: string, policy: MailboxPolicy = ENGINE_MAILBOX_POLICY): boolean {
  return policy === "drafts-only" && MAILBOX_SEND_TOOLS.includes(tool);
}
