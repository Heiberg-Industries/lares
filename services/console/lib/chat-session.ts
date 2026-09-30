import type { ClientSessionState } from "eve/client";

/** Keep a tab's active chat separate for each signed-in owner and agent. */
export function chatSessionKey(owner: string, name: string): string {
  return `lares:chat:${encodeURIComponent(owner.toLowerCase())}:${encodeURIComponent(name)}`;
}

/** A corrupt or stale browser value must never become an Eve session URL. */
export function readChatSession(storage: Pick<Storage, "getItem">, key: string): ClientSessionState | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return null;
    const session = value as Record<string, unknown>;
    if (typeof session.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(session.sessionId)) return null;
    if (typeof session.streamIndex !== "number" || !Number.isSafeInteger(session.streamIndex) || session.streamIndex < 0) return null;
    return { sessionId: session.sessionId, streamIndex: session.streamIndex };
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
