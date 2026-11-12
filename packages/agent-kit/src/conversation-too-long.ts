/**
 * WHAT A PERSON SEES WHEN A CONVERSATION HAS GROWN TOO LONG TO CONTINUE. No imports on purpose:
 * the console's browser code reads it too.
 *
 * When a conversation nears the model's context window, eve 1.0 tries to summarise ("compact") its
 * history before the next model call. The engine refuses that on purpose: the summary call has no
 * fresh, purpose-bound model invocation of its own (`definition-model.ts`, `refuseModelCompaction`
 * and the model guard). The refusal fails the TURN, the conversation stays open, and every later
 * turn crosses the same line and fails the same way. So every door says, in one fixed sentence,
 * that the conversation is too long and how to go on, in place of the framework's error text.
 *
 * {@link MODEL_COMPACTION_REFUSED} is THE refusal's message. It is defined here, and the code that
 * throws it (`definition-model.ts`) imports it from here, so the thrower and the recogniser cannot
 * drift apart; `tests/conversation-too-long.test.ts` throws through the real refusal and checks the
 * recogniser still knows it.
 *
 * Nothing on this path calls a model, and nothing is summarised or carried over.
 */
export const MODEL_COMPACTION_REFUSED = 'Model compaction requires a fresh trusted invocation';

/** Web chat: the page keeps its "Start a new conversation" control under this sentence. */
export const CONVERSATION_TOO_LONG_WEB =
  'This conversation has grown too long for me to continue. Start a new conversation and send your message again there.';
/** Slack: a new top-level message opens a new thread, and a new thread is a new conversation, in a
 *  direct message and in a shared room alike. */
export const CONVERSATION_TOO_LONG_SLACK =
  'This thread has grown too long for me to continue. Please send your message again as a new message, not as a reply in this thread.';
/** Telegram: a private chat is one conversation and cannot be started over by hand, so the door
 *  retires this conversation at the person's next message (`lib/telegram-rotation.ts`). */
export const CONVERSATION_TOO_LONG_TELEGRAM =
  'This conversation has grown too long for me to continue, so your next message will start a new one. Please send your last message again.';

/** True when a failure's message is the compaction refusal, as thrown or as eve wraps it
 *  (`<hook> failed: …`, `DefinitionFailedError: …`). The same rule as `approvalReplySentence`. */
export function isConversationTooLong(message: unknown): boolean {
  return typeof message === 'string' && (message === MODEL_COMPACTION_REFUSED || message.endsWith(`: ${MODEL_COMPACTION_REFUSED}`));
}
