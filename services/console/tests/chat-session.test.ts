import { describe, expect, it } from "vitest";
import type { ClientSessionState } from "eve/client";
import { ClientError, ClientSessionStrandedError, SessionNotActiveError } from "eve/client";
import { chatSessionKey, ENDED_SAY, endedConversation, readChatSession, saveChatSession } from "../lib/chat-session";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("tab chat recovery", () => {
  it("keeps the saved cursor separate by opaque member and agent", () => {
    const storage = memoryStorage();
    const alice = chatSessionKey("Alice@example.com", "helper");
    saveChatSession(storage, alice, { sessionId: "wrun_1", streamIndex: 12 });
    expect(readChatSession(storage, alice)).toEqual({ sessionId: "wrun_1", streamIndex: 12 });
    expect(readChatSession(storage, chatSessionKey("bob@example.com", "helper"))).toBeNull();
    expect(readChatSession(storage, chatSessionKey("Alice@example.com", "other"))).toBeNull();
    saveChatSession(storage, alice, undefined);
    expect(readChatSession(storage, alice)).toBeNull();
  });

  it('preserves opaque member case and never adopts the legacy email key',()=>{
    const storage=memoryStorage();storage.setItem('lares:chat:member-id:helper',JSON.stringify({sessionId:'old',streamIndex:0}));
    expect(chatSessionKey('Member-ID','helper')).not.toBe(chatSessionKey('member-id','helper'));
    expect(readChatSession(storage,chatSessionKey('member-id','helper'))).toBeNull();
  });

  it("refuses malformed browser state before it reaches an Eve route", () => {
    const storage = memoryStorage();
    for (const raw of ["{", "null", '{}', '{"sessionId":"../admin","streamIndex":0}',
      '{"sessionId":"wrun_1","streamIndex":-1}', '{"sessionId":"wrun_1","streamIndex":"0"}']) {
      storage.setItem("chat", raw);
      expect(readChatSession(storage, "chat")).toBeNull();
    }
  });

  it("saves the whole client state and hands it back unchanged, the opaque inbox included", () => {
    const storage = memoryStorage();
    const key = chatSessionKey("Member-ID", "helper");
    // `inbox` is opaque: this console never reads it, shortens it or rebuilds it.
    const state: ClientSessionState = { sessionId: "wrun_1", streamIndex: 41, inbox: "v1.eyJvcGFxdWUiOnRydWV9.c2lnbmF0dXJl" };
    saveChatSession(storage, key, state);
    expect(JSON.parse(storage.getItem(key)!)).toEqual(state);
    expect(readChatSession(storage, key)).toEqual(state);
    // Saved again from what was read, it is byte for byte what was saved the first time.
    const first = storage.getItem(key);
    saveChatSession(storage, key, readChatSession(storage, key)!);
    expect(storage.getItem(key)).toBe(first);
  });

  it("keeps a field a later framework version adds to the state, rather than dropping it", () => {
    const storage = memoryStorage();
    const later = { sessionId: "wrun_1", streamIndex: 3, inbox: "opaque", somethingNew: { nested: [1, 2] } };
    storage.setItem("chat", JSON.stringify(later));
    expect(readChatSession(storage, "chat")).toEqual(later);
  });

  it("a state without an inbox stays without one", () => {
    const storage = memoryStorage();
    saveChatSession(storage, "chat", { sessionId: "wrun_1", streamIndex: 0 });
    expect(readChatSession(storage, "chat")).toEqual({ sessionId: "wrun_1", streamIndex: 0 });
    expect("inbox" in readChatSession(storage, "chat")!).toBe(false);
  });

  it("refuses a saved state whose inbox is not what the framework issues", () => {
    const storage = memoryStorage();
    for (const inbox of [7, null, { a: 1 }, ["x"], "x".repeat(8193)]) {
      storage.setItem("chat", JSON.stringify({ sessionId: "wrun_1", streamIndex: 0, inbox }));
      expect(readChatSession(storage, "chat"), JSON.stringify(inbox).slice(0, 20)).toBeNull();
    }
    storage.setItem("chat", JSON.stringify([{ sessionId: "wrun_1", streamIndex: 0 }]));
    expect(readChatSession(storage, "chat")).toBeNull();
  });

  it("keeps live chat usable when browser storage is unavailable", () => {
    const unavailable = {
      getItem: (_key: string): string | null => { throw new Error("blocked"); },
      setItem: (_key: string, _value: string): void => { throw new Error("blocked"); },
      removeItem: (_key: string): void => { throw new Error("blocked"); },
    };
    expect(readChatSession(unavailable, "chat")).toBeNull();
    expect(() => saveChatSession(unavailable, "chat", { sessionId: "wrun_1", streamIndex: 0 })).not.toThrow();
  });
});

describe("a conversation that is over", () => {
  const refusal = (code: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ok: false, code, error: "framework words", ...extra });

  it("ended by an update: the framework's own client error for a refused send or answer", () => {
    // What the framework's client throws for the agent's `409 { code: "session_stranded" }`.
    const error = new ClientSessionStrandedError(409, refusal("session_stranded", { eveVersion: "0.60.1" }), { "content-type": "application/json" }, { eveVersion: "0.60.1" });
    expect(error.code).toBe("session_stranded");
    expect(endedConversation(error)).toBe("update");
    expect(ENDED_SAY.update).toBe("This conversation ended with an update. Start a new one.");
  });

  it("ended by an update: a record the new version cannot read, and a failure read back from the record", () => {
    expect(endedConversation(new ClientError(409, refusal("session_version_unsupported")))).toBe("update");
    // A failure the client read from the conversation's own record carries the code as its name.
    expect(endedConversation(Object.assign(new Error("This session is no longer available."), { name: "session_stranded" }))).toBe("update");
  });

  it("ended some other way: its own sentence, which does not mention an update", () => {
    const error = new SessionNotActiveError();
    expect(error.code).toBe("session_not_active");
    expect(endedConversation(error)).toBe("ended");
    expect(endedConversation(new ClientError(410, refusal("session_expired")))).toBe("ended");
    expect(ENDED_SAY.ended).toBe("This conversation has ended. Start a new one.");
    expect(ENDED_SAY.ended).not.toMatch(/update/i);
  });

  it("anything else is not an ending: a retry request, an ordinary refusal, a failed turn, nothing", () => {
    expect(endedConversation(new SessionNotActiveError({ retryable: true }))).toBeNull();
    expect(endedConversation(new ClientError(403, "This conversation is not available to this signed-in member."))).toBeNull();
    expect(endedConversation(new ClientError(409, "{}"))).toBeNull();
    expect(endedConversation(Object.assign(new Error("model exploded"), { name: "MODEL_FAILED" }))).toBeNull();
    for (const nothing of [undefined, null, "session_stranded", 409]) expect(endedConversation(nothing)).toBeNull();
  });

  it("never repeats the framework's own words", () => {
    for (const say of Object.values(ENDED_SAY)) expect(say).not.toMatch(/session|stranded|409|framework|eve/i);
  });
});
