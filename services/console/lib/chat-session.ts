import type { ClientSessionState } from "eve/client";

/** Keep a tab's active chat separate for each opaque member id and agent; old email-based handles are never resumed. */
export function chatSessionKey(memberId: string, name: string): string {
  return `lares:private-chat:v2:${encodeURIComponent(memberId)}:${encodeURIComponent(name)}`;
}

/** The longest `inbox` value the framework itself issues or accepts (its own handle limit). */
const MAX_INBOX_CHARS = 8192;

/**
 * The saved conversation, WHOLE and unchanged. The framework's client state is more than an id and
 * a cursor: it also carries an opaque `inbox` value, and a later release may add to it. What was
 * saved is therefore handed back as it was read, never rebuilt field by field.
 *
 * Two fields are checked because they become part of a request: `sessionId` goes into a URL, and
 * `streamIndex` into a query parameter. `inbox` is opaque to this console and is only checked to
 * be what the framework says it is, a string no longer than its own limit. A corrupt or stale
 * browser value must never become an Eve session URL, so anything else is no saved conversation.
 */
export function readChatSession(storage: Pick<Storage, "getItem">, key: string): ClientSessionState | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const session = value as Record<string, unknown>;
    if (typeof session.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(session.sessionId)) return null;
    if (typeof session.streamIndex !== "number" || !Number.isSafeInteger(session.streamIndex) || session.streamIndex < 0) return null;
    if ("inbox" in session && (typeof session.inbox !== "string" || session.inbox.length > MAX_INBOX_CHARS)) return null;
    return value as ClientSessionState;
  } catch {
    // Browser storage can be disabled. Chat still works without reload recovery.
    return null;
  }
}

export function saveChatSession(
  storage: Pick<Storage, "setItem" | "removeItem">,
  key: string,
  session: ClientSessionState | undefined,
): void {
  try {
    if (session === undefined) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(session));
  } catch {
    // A storage quota or browser policy must not stop a live conversation.
  }
}

/**
 * The mark the chat proxy puts on a refusal it wrote itself (`refuse` in `lib/chat-proxy.ts`), so
 * the page can tell the console's own sentence from anything an agent answered. The proxy relays
 * only a fixed list of an agent's response headers, and this name is not on it, so an agent
 * cannot set it. Here, with no imports, because both the server's proxy and the browser's chat
 * page read it.
 */
export const CONSOLE_REFUSAL_HEADER = "x-lares-console-refusal";

/**
 * What a person is told when an answer names a card that is no longer waiting for one: it was
 * already approved or denied, it expired, or it closed with nobody deciding. The chat proxy refuses
 * such an answer before it reaches the agent (`lib/chat-proxy.ts`), and the chat page shows this
 * sentence alone, with the conversation still open. The Waiting page says the same
 * (`lib/waiting.ts`).
 */
export const ANSWER_NOT_WAITING = "This request is no longer waiting. Nothing was sent.";

/** Why a conversation can take no more messages: an update ended it, or it ended some other way. */
export type EndedConversation = "update" | "ended";

/** The exact words a person sees. Never the framework's own error text. */
export const ENDED_SAY: Record<EndedConversation, string> = {
  update: "This conversation ended with an update. Start a new one.",
  ended: "This conversation has ended. Start a new one.",
};

/**
 * Reads a failure for the one thing the page must say differently: the conversation is over.
 *
 * Every framework upgrade ends the conversations that were open: the framework only continues a
 * conversation that the very same framework version started. A send or an answer into such a
 * conversation is refused with the code `session_stranded`; a saved record the new version cannot
 * read is refused with `session_version_unsupported`. Both are "ended with an update". A
 * conversation that ended for any other reason is refused with `session_not_active`, and one whose
 * record is gone with `session_expired`.
 *
 * Matched on the stable code, never on a message or a class: the framework's client puts the code
 * on `code`, and a failure it read back from the conversation's own record on `name`. A refusal
 * that asks for a retry (`session_not_ready`) is not an ending.
 */
export function endedConversation(error: unknown): EndedConversation | null {
  if (error === null || typeof error !== "object") return null;
  const { code, name } = error as { code?: unknown; name?: unknown };
  for (const value of [code, name]) {
    if (value === "session_stranded" || value === "session_version_unsupported") return "update";
    if (value === "session_not_active" || value === "session_expired") return "ended";
  }
  return null;
}
