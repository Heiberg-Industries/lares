import { describe, it, expect } from "vitest";
import { postSlackMessage } from "../lib/slack.js";

function fakeFetch(response: unknown): { calls: { url: string; init: RequestInit }[]; fetch: typeof fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return { json: async () => response } as Response;
  }) as typeof fetch;
  return { calls, fetch: f };
}

describe("postSlackMessage", () => {
  it("POSTs chat.postMessage with bearer token, channel and text", async () => {
    const { calls, fetch } = fakeFetch({ ok: true });
    await postSlackMessage({ token: "xoxb-t", fetchImpl: fetch }, { channel: "#heiberg-ops", text: "hello" });
    expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-t");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ channel: "#heiberg-ops", text: "hello" });
  });

  it("throws when Slack replies ok:false", async () => {
    const { fetch } = fakeFetch({ ok: false, error: "channel_not_found" });
    await expect(postSlackMessage({ token: "t", fetchImpl: fetch }, { channel: "#x", text: "y" }))
      .rejects.toThrow("channel_not_found");
  });
});
