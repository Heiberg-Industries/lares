import { describe, expect, it } from "vitest";
import { chatSessionKey, readChatSession, saveChatSession } from "../lib/chat-session";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("tab chat recovery", () => {
  it("keeps the saved cursor separate by signed-in owner and agent", () => {
    const storage = memoryStorage();
    const alice = chatSessionKey("Alice@example.com", "helper");
    saveChatSession(storage, alice, { sessionId: "wrun_1", streamIndex: 12 });
    expect(readChatSession(storage, alice)).toEqual({ sessionId: "wrun_1", streamIndex: 12 });
    expect(readChatSession(storage, chatSessionKey("bob@example.com", "helper"))).toBeNull();
    expect(readChatSession(storage, chatSessionKey("Alice@example.com", "other"))).toBeNull();
    saveChatSession(storage, alice, undefined);
    expect(readChatSession(storage, alice)).toBeNull();
  });

  it("refuses malformed browser state before it reaches an Eve route", () => {
    const storage = memoryStorage();
    for (const raw of ["{", "null", '{}', '{"sessionId":"../admin","streamIndex":0}',
      '{"sessionId":"wrun_1","streamIndex":-1}', '{"sessionId":"wrun_1","streamIndex":"0"}']) {
      storage.setItem("chat", raw);
      expect(readChatSession(storage, "chat")).toBeNull();
    }
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
