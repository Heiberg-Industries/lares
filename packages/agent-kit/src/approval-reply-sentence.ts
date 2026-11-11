/**
 * WHAT A PERSON SEES WHEN THE REPLY AFTER THEIR ANSWER IS REFUSED. No imports on purpose: the
 * console's browser code reads it too.
 *
 * On eve 1.0 the turn that asked a card carries on after the card is answered. Its next model call
 * can be refused (fails closed): the agent restarted since the answer, the answer's receipt
 * expired, the answers did not all come from the person who asked, or the record was full. By then
 * the answer has been applied (an Approve ran its action; a Deny did nothing), so "nothing
 * happened" would be untrue and silence would look like a hang. The model seam throws
 * {@link APPROVAL_REPLY_REFUSED}; every door (web chat, Slack, Telegram) shows
 * {@link APPROVAL_REPLY_REFUSED_SENTENCE} in its place, never the framework's error text.
 */
export const APPROVAL_REPLY_REFUSED = 'The reply after an approval answer was refused';
export const APPROVAL_REPLY_REFUSED_SENTENCE = 'Your answer was applied, but I could not finish my reply. Ask me what happened.';

/** True when a failure's message is the seam's refusal, as thrown or as eve wraps it
 *  (`DefinitionFailedError: …`). */
export function isApprovalReplyRefused(message: unknown): boolean {
  return typeof message === 'string' && (message === APPROVAL_REPLY_REFUSED || message.endsWith(`: ${APPROVAL_REPLY_REFUSED}`));
}
