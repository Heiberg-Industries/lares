/**
 * THE MODEL SEAM'S FIXED REFUSALS: what a person sees when a model call is refused for one of the
 * reasons below. No imports on purpose: the console's browser code reads it too.
 *
 * The model seam throws a code; every door (web chat, Slack, Telegram) shows one fixed sentence in
 * place of the framework's error text ({@link approvalReplySentence} maps the code to it). Each
 * sentence must be TRUE whatever happened before the refusal, so there are five:
 *
 * - {@link APPROVAL_REPLY_REFUSED}: on eve 1.0 the turn that asked a card carries on after the card
 *   settles, and its next model call can be refused (fails closed). A person's answer to a card in
 *   this turn was applied (an Approve ran its action; a Deny did nothing), but the reply could not be
 *   finished (the agent restarted since the answer, the answer's receipt expired, the answers did not
 *   all come from the person who asked, the record was full). "Nothing happened" would be untrue;
 *   silence would look like a hang.
 * - {@link APPROVAL_UNANSWERED}: the turn asked a card but nobody's answer was applied (for example
 *   it expired). Nothing was done.
 * - {@link APPROVAL_MESSAGE_REFUSED}: the person typed a new message while a card waited, which
 *   cancelled it (eve withdraws a card nobody answered), nobody's answer was applied in the turn, and
 *   the reply to that new message could not be finished. Nothing was done.
 * - {@link APPROVAL_MESSAGE_AFTER_ANSWER_REFUSED}: the same, but a person's answer to another card in
 *   this turn was applied (one card approved, the other cancelled by the new message). Says both.
 * - {@link DOOR_MODEL_REFUSED}: a Slack or Telegram turn got no model permission (the sender is not
 *   the person who claimed the door, Keeper refused or could not be reached). The sentence makes no
 *   claim about what was or was not done, so it stays true when it follows an approved action.
 */
export const APPROVAL_REPLY_REFUSED = 'The reply after an approval answer was refused';
export const APPROVAL_REPLY_REFUSED_SENTENCE = 'Your answer was applied, but I could not finish my reply. Ask me what happened.';
export const APPROVAL_UNANSWERED = 'The approval in this turn ended without an answer';
export const APPROVAL_UNANSWERED_SENTENCE = 'That request ended without an answer; nothing was done.';
export const APPROVAL_MESSAGE_REFUSED = 'The reply to a message sent while an approval waited was refused';
export const APPROVAL_MESSAGE_REFUSED_SENTENCE = 'Your new message cancelled what was waiting for your answer, so that was not done. I could not finish my reply to your new message; please send it again.';
export const APPROVAL_MESSAGE_AFTER_ANSWER_REFUSED = 'The reply to a message sent after an approval answer was refused';
export const APPROVAL_MESSAGE_AFTER_ANSWER_REFUSED_SENTENCE = 'Your answer was applied. Your new message cancelled what was still waiting for your answer, so nothing was done for that. I could not finish my reply to your new message; please send it again.';
export const DOOR_MODEL_REFUSED = 'A door turn has no model permission';
export const DOOR_MODEL_REFUSED_SENTENCE = 'I could not get permission to answer this message here. Please try again later, or write to me in web chat.';

const SENTENCES: ReadonlyArray<readonly [string, string]> = [
  [APPROVAL_REPLY_REFUSED, APPROVAL_REPLY_REFUSED_SENTENCE],
  [APPROVAL_UNANSWERED, APPROVAL_UNANSWERED_SENTENCE],
  [APPROVAL_MESSAGE_REFUSED, APPROVAL_MESSAGE_REFUSED_SENTENCE],
  [APPROVAL_MESSAGE_AFTER_ANSWER_REFUSED, APPROVAL_MESSAGE_AFTER_ANSWER_REFUSED_SENTENCE],
  [DOOR_MODEL_REFUSED, DOOR_MODEL_REFUSED_SENTENCE],
];

/** The fixed sentence for a failure's message when it is one of the seam's fixed refusals, as thrown
 *  or as eve wraps it (`DefinitionFailedError: …`); otherwise undefined. */
export function approvalReplySentence(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  for (const [code, sentence] of SENTENCES) if (message === code || message.endsWith(`: ${code}`)) return sentence;
  return undefined;
}
