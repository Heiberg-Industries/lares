/**
 * The shared-room rule, once, for every role and every door.
 *
 * Everyone in a shared room (a Slack channel, a private channel, a group chat) reads the agent's
 * answers. So a conversation STARTED in one is limited to what the room may read along with: the
 * names on {@link SHARED_ROOM_ALLOWED}, and nothing else of the role's own (eve's built-in
 * `ask_question` and `todo` are not decided per door). How each kind is kept to the list:
 *   - a catalogue tool: each role's catalogue resolver leaves out what is not listed, and its
 *     approval policy, answer check and execution guard refuse it before any card or execution, so
 *     a new catalogue tool is hidden in a room until someone lists it here;
 *   - an own-resolver tool, a skill or a connection: each file decides for itself (with
 *     {@link hiddenInSharedRoom}, or by offering nothing outside the private console). Each role's
 *     tests read those files from disk and fail on one that offers a room a name this list does
 *     not hold, so a new file that forgets the rule does not pass them.
 *
 * Where a conversation started is read from the session's initiator, which never changes
 * (`auth.current` becomes whoever answered a card), through one row per door. It fails closed:
 * a door without a row, or a door conversation with no initiator, is a shared room.
 *
 * NO IMPORTS ON PURPOSE: `conversation-too-long.ts`, which the console's browser code reads, uses
 * the door table below. So the web chat authenticator is written out here (it is
 * `CONSOLE_SESSION_AUTHENTICATOR` in `door-authority.ts`; `tests/shared-room.test.ts` holds the two
 * equal), and whether a direct message offers a tool is the caller's answer (`privateOnlyTool` in
 * `private-console-surface.ts`), not read here.
 */

export type StartedIn = 'private-chat' | 'shared-room' | 'not-a-door';
type Identity = { readonly authenticator?: unknown; readonly attributes?: Readonly<Record<string, unknown>> } | null | undefined;

/** One row per door, keyed by the authenticator eve stamps on the verified sender: when the
 *  identity names a private chat. Anything else on that door is a shared room. */
const PRIVATE_CHAT_WHEN: Readonly<Record<string, (attributes: Readonly<Record<string, unknown>>) => boolean>> = {
  // eve's Slack identity carries the channel id and no channel type; a direct message's id starts with `D`.
  'slack-webhook': (a) => typeof a['channel_id'] === 'string' && a['channel_id'].startsWith('D'),
  // eve's Telegram identity carries the chat's type.
  'telegram-webhook': (a) => a['chat_type'] === 'private',
};

/** The conversations that are not a door: web chat (the console's member stamp, or the route
 *  password alone) and a conversation a schedule started. Every other authenticator is a door.
 *  eve's `local-dev` (its development server's own sign-in) is left a door on purpose: eve grants
 *  it from an environment flag read at run time (`EVE_DEV=1`, `isLocalDevelopmentServer`), not
 *  from how the image was built, so a built image could produce it too. It fails closed: a
 *  conversation started that way gets the room list. */
const NOT_A_DOOR: ReadonlySet<string> = new Set(['lares-console', 'http-basic', 'app']);

/** What one verified identity says about the chat it came from. No identity is not a door. */
export function chatKindOf(identity: Identity): StartedIn {
  if (identity === null || identity === undefined) return 'not-a-door';
  const authenticator = identity.authenticator;
  if (typeof authenticator === 'string' && NOT_A_DOOR.has(authenticator)) return 'not-a-door';
  const row = typeof authenticator === 'string' ? PRIVATE_CHAT_WHEN[authenticator] : undefined;
  return row !== undefined && row(identity.attributes ?? {}) ? 'private-chat' : 'shared-room';
}

/** Where this conversation STARTED. A tool or approval-request context carries
 *  `session.auth.initiator`; an approval answer carries `session.initiator`. With no initiator, a
 *  door `current` is a shared room (fail closed), and anything else is not a door. */
export function startedIn(ctx: unknown): StartedIn {
  const session = (ctx as { session?: { initiator?: unknown; auth?: { initiator?: unknown; current?: unknown } | null } } | undefined)?.session;
  const initiator = (session?.auth?.initiator ?? session?.initiator) as Identity;
  if (initiator !== null && initiator !== undefined) return chatKindOf(initiator);
  return chatKindOf(session?.auth?.current as Identity) === 'not-a-door' ? 'not-a-door' : 'shared-room';
}

/** Everything a conversation started in a shared room may use: tools, own-resolver tools and skills.
 *  Public material, the conversation's own language, and read-only looks at contacts, deadlines
 *  and reminders. Nothing here writes outside the conversation or raises an approval card. */
export const SHARED_ROOM_ALLOWED: ReadonlySet<string> = new Set([
  'set_language', // writes this conversation's language and nothing else
  'lares_read_public_doc', // the reviewed public Lares pages
  'lares-docs', // the skill that points at those pages
  'agent-kit__transit_plan', // public transport
  'twenty_lookup', // contacts: read-only
  'twenty_get_person', // contacts: read-only
  'twenty_company_for_person', // contacts: read-only
  'deadline_list', // deadlines: read-only
  'remind_list', // reminders: read-only
]);

/** Whether a conversation started in a shared room may be offered and may call this name. */
export function sharedRoomAllows(name: string): boolean {
  return SHARED_ROOM_ALLOWED.has(name);
}

/** Why a tool is refused in a conversation started in a shared room, in words for the room. */
export const SHARED_ROOM_REFUSED = 'That is not available in a shared room. Ask me in a direct message.';
/** The same refusal for a tool a direct message does not offer either, so it gives no advice. */
export const SHARED_ROOM_UNAVAILABLE = 'That is not available in a shared room.';
/** The room's refusal for one name. `offeredInDirectMessage` is false only for a tool a direct
 *  message (a native door) never offers (`privateOnlyTool`): then the room does not send the
 *  person to one. */
export function sharedRoomRefusal(offeredInDirectMessage: boolean): string {
  return offeredInDirectMessage ? SHARED_ROOM_REFUSED : SHARED_ROOM_UNAVAILABLE;
}

/** What a conversation started in a shared room is told about where it is, appended to the
 *  persona by each role's `agent/instructions/aa-definition.ts`. One fixed text for every role, so
 *  it names no tool: it speaks of "the tools you have here". "People allowed to use you" and not "the
 *  owner" alone, because the Slack door admits everyone on its allow-list (on an older installation
 *  that can be several people). It ends with {@link SHARED_ROOM_REFUSED}, so that sentence is written once. */
export const SHARED_ROOM_INSTRUCTIONS = [
  'This conversation is in a shared channel. Everyone in the channel reads your answers, including people who cannot ask you anything.',
  'Only people allowed to use you can ask you things here, and the owner is one of them.',
  'Answer from general knowledge and the tools you have here.',
  'If you are asked for something one of those tools looks up, you may say what it finds; remember that everyone in the channel reads it.',
  'Do not repeat or guess anything else private about the owner or other people: mail, calendar, notes, what the owner asked you to remember, or details of your own duties.',
  `If you are asked for something one of your other tools does, say: ${SHARED_ROOM_REFUSED}`,
].join(' ');

/** Whether this name is kept from this conversation by the room rule. */
export function hiddenInSharedRoom(ctx: unknown, name: string): boolean {
  return !sharedRoomAllows(name) && startedIn(ctx) === 'shared-room';
}

/** Throws the room's sentence for a name a conversation started in a shared room may not use. */
export function assertSharedRoomAllows(ctx: unknown, name: string, offeredInDirectMessage: boolean): void {
  if (hiddenInSharedRoom(ctx, name)) throw new Error(sharedRoomRefusal(offeredInDirectMessage));
}
