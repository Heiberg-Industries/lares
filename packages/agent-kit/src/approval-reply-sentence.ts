/**
 * WHAT A PERSON SEES WHEN THE REPLY IN A TURN THAT ASKED A CARD IS REFUSED. No imports on purpose:
 * the console's browser code reads it too.
 *
 * On eve 1.0 the turn that asked a card carries on after the card settles. Its next model call can
 * be refused (fails closed). Then every door (web chat, Slack, Telegram) shows one fixed sentence in
 * place of the framework's error text, and the sentence must be TRUE, so there are two:
 *
 * - {@link APPROVAL_REPLY_REFUSED}: a person's answer to a card in this turn was applied (an Approve
 *   ran its action; a Deny did nothing), but the reply could not be finished (the agent restarted
 *   since the answer, the answer's receipt expired, the answers did not all come from the person who
 *   asked, the record was full). "Nothing happened" would be untrue; silence would look like a hang.
 * - {@link APPROVAL_UNANSWERED}: the turn asked a card but nobody's answer was applied (it expired,
 *   or was withdrawn because the person typed a new message while it waited). Nothing was done.
 *
 * The model seam throws the code; {@link approvalReplySentence} maps it to the sentence.
 */
export const APPROVAL_REPLY_REFUSED = 'The reply after an approval answer was refused';
export const APPROVAL_REPLY_REFUSED_SENTENCE = 'Your answer was applied, but I could not finish my reply. Ask me what happened.';
export const APPROVAL_UNANSWERED = 'The approval in this turn ended without an answer';
export const APPROVAL_UNANSWERED_SENTENCE = 'That request ended without an answer; nothing was done.';

const SENTENCES: ReadonlyArray<readonly [string, string]> = [
  [APPROVAL_REPLY_REFUSED, APPROVAL_REPLY_REFUSED_SENTENCE],
  [APPROVAL_UNANSWERED, APPROVAL_UNANSWERED_SENTENCE],
];

/** The fixed sentence for a failure's message when it is one of the seam's two refusals, as thrown
 *  or as eve wraps it (`DefinitionFailedError: …`); otherwise undefined. */
export function approvalReplySentence(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  for (const [code, sentence] of SENTENCES) if (message === code || message.endsWith(`: ${code}`)) return sentence;
  return undefined;
}
