import { expect, it } from "vitest";
import { creationNotices, firstChatPath } from "../lib/first-conversation";

it("sends a healthy new agent straight to its first conversation", () => {
  expect(firstChatPath("my-helper", true)).toBe("/chat/my-helper?created=1");
  expect(creationNotices({ created: "1" })).toEqual({
    ready: "Agent created and healthy. Send its first message below.",
    backup: null,
  });
});

it("keeps an optional backup failure visible without blocking the healthy local chat", () => {
  expect(firstChatPath("my-helper", false)).toBe("/chat/my-helper?created=1&backup=failed");
  expect(creationNotices({ created: "1", backup: "failed" })).toEqual({
    ready: "Agent created and healthy. Send its first message below.",
    backup: "The definition is saved, but its Git backup did not complete. You can chat now; inspect backup status separately.",
  });
});
