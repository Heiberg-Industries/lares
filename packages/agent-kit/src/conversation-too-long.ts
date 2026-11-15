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

/**
 * The model guard's DEGRADED refusal: a compaction that could not be scoped to its own conversation
 * (no session id, or too many at once in one process) makes the guard refuse every model call in the
 * process until a restart. That says nothing about the length of the conversation it lands in, so it
 * has its own message, which {@link isConversationTooLong} never matches: every door shows its
 * ordinary failure text for it, and Telegram marks nothing.
 */
export const MODEL_CALLS_REFUSED_UNSCOPED = 'Model calls are refused in this process until it restarts';

/** Web chat: the page keeps its "Start a new conversation" control under this sentence. */
export const CONVERSATION_TOO_LONG_WEB =
  'This conversation has grown too long for me to continue. Start a new conversation and send your message again there.';
/** Slack, a direct message: a new top-level message opens a new thread, and a new thread is a new
 *  conversation. */
export const CONVERSATION_TOO_LONG_SLACK =
  'This thread has grown too long for me to continue. Please send your message again as a new message, not as a reply in this thread.';
/** Slack, a shared room: the same, but the door hears a room message only when it mentions the agent. */
export const CONVERSATION_TOO_LONG_SLACK_ROOM =
  'This thread has grown too long for me to continue. Please send your message again as a new message that mentions me, not as a reply in this thread.';
/** Telegram: a private chat is one conversation and cannot be started over by hand, so the door
 *  retires this conversation at the person's next message (`lib/telegram-rotation.ts`). */
export const CONVERSATION_TOO_LONG_TELEGRAM =
  'This conversation has grown too long for me to continue, so your next message will start a new one. Please send your last message again.';
/** Telegram, a turn the person did not start (a scheduled brief or push run inside their chat). */
export const CONVERSATION_TOO_LONG_TELEGRAM_SCHEDULED =
  'This conversation has grown too long for me to continue, so your next message will start a new one. A scheduled update was not delivered.';
/** Appended, after a space, when the failed turn had already completed at least one call: resending
 *  could repeat it. */
export const CONVERSATION_TOO_LONG_PARTLY_DONE = 'Part of what you asked may already have been done, so check before asking again.';

/** True when a failure's message is the compaction refusal, as thrown or as eve wraps it
 *  (`<hook> failed: …`, `DefinitionFailedError: …`). The same rule as `approvalReplySentence`. */
export function isConversationTooLong(message: unknown): boolean {
  return typeof message === 'string' && (message === MODEL_COMPACTION_REFUSED || message.endsWith(`: ${MODEL_COMPACTION_REFUSED}`));
}

/**
 * Whether the failed turn had already completed a call, read from eve's own call table for that turn
 * (`calls(view, { turnId })` from `eve/events`, passed in so this file stays import-free). eve keeps
 * the latest turn's calls in the view, settled ones included, so at that turn's own `turn.settled` the
 * table is whole. Only a positive answer changes anything: a call that is not there adds nothing.
 */
export function anyCallCompleted(calls: readonly { readonly state?: unknown }[] | undefined): boolean {
  return Array.isArray(calls) && calls.some((c) => c?.state === 'completed');
}

/** The sentence, with {@link CONVERSATION_TOO_LONG_PARTLY_DONE} after it when the turn already did something. */
export function withPartlyDone(sentence: string, partlyDone: boolean): string {
  return partlyDone ? `${sentence} ${CONVERSATION_TOO_LONG_PARTLY_DONE}` : sentence;
}

type DoorAuth = { readonly authenticator?: unknown; readonly attributes?: Readonly<Record<string, unknown>> } | null | undefined;

/**
 * Which Slack sentence is true: the direct-message one only when the conversation is known to have
 * STARTED in a direct message, read the way the shared-room rule reads it
 * (`private-console-surface.ts`, `startedInSharedSlackRoom`): from the session's initiator, a
 * `slack-webhook` auth whose channel id starts with `D`. Anything else (a room, a conversation a
 * schedule started, no session to read) gets the room sentence, which is also true in a direct
 * message: mentioning the agent there does no harm.
 */
export function conversationTooLongSlackSentence(ctx: unknown): string {
  const session = (ctx as { session?: { initiator?: unknown; auth?: { initiator?: unknown; current?: unknown } | null } } | undefined)?.session;
  const initiator = (session?.auth?.initiator ?? session?.initiator ?? session?.auth?.current) as DoorAuth;
  const channel = initiator?.authenticator === 'slack-webhook' ? initiator.attributes?.['channel_id'] : undefined;
  return typeof channel === 'string' && channel.startsWith('D') ? CONVERSATION_TOO_LONG_SLACK : CONVERSATION_TOO_LONG_SLACK_ROOM;
}
