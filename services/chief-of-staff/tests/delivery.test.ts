import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELIVERY_KINDS, type DeliveryKind } from "@lares/agent-kit/delivery";

import type { RouteDeps } from "../lib/delivery.js";

const gatewayComplete = vi.fn(async (_prompt: string, _opts?: unknown) => "Generated for the web.");
vi.mock("../lib/llm-complete.js", () => ({ gatewayComplete }));

// The conversation's identity lookup, replaced so a test can see WHICH id it is asked about. It
// answers "no identity" (what the unreachable database gave these tests before), so the auth
// attributes the other tests expect are unchanged.
const { proactiveContinuityIdentity } = vi.hoisted(() => ({
  proactiveContinuityIdentity: vi.fn(async (_door: string, _alias: string) => undefined),
}));
vi.mock("../lib/conversation-continuity.js", () => ({
  proactiveContinuityIdentity,
  continuityAuthAttributes: () => ({}),
  nativeConversationContinuity: async () => ({ context: [] }),
}));

const OWNER = "owner-1";
beforeEach(() => {
  process.env["AGENT_OWNER_USER_ID"] = OWNER;
  gatewayComplete.mockClear();
  proactiveContinuityIdentity.mockClear();
});

const definition = (over: Record<string, unknown> = {}) =>
  ({
    name: "chief-of-staff", channels: [], doors: [
      { kind: "telegram", enabled: true, settings: {} },
      { kind: "slack", enabled: true, settings: {} },
    ], ...over,
  }) as never;
const loaded = (over: Record<string, unknown> = {}) => ({ definition: definition(over), voiceMd: "Warm and brief." });

function fakeDb() {
  const calls: [string, unknown[]][] = [];
  return { calls, query: vi.fn(async (sql: string, params?: unknown[]) => { calls.push([sql, params ?? []]); return { rows: [], rowCount: 0 }; }) } as never as
    { calls: [string, unknown[]][] } & NonNullable<RouteDeps["db"]>;
}

const sent = { verdict: "send", sent: true, alreadySeen: false, handled: true } as const;
const held = { verdict: "suppress", reason: "dnd", sent: false, alreadySeen: false, handled: false } as const;

describe("routeDelivery", () => {
  it("every kind routes to its own door per the map, and to today's door without one", async () => {
    const { routeDelivery } = await import("../lib/delivery.js");
    const targets = { telegram: "123", slack: "U1" };
    for (const [kind, today] of Object.entries(DELIVERY_KINDS) as [DeliveryKind, "telegram" | "slack"][]) {
      const without = routeDelivery(kind, loaded(), { targets, db: fakeDb() });
      expect(without?.door, `${kind} without a map`).toBe(today);
      const other = today === "telegram" ? "slack" : "telegram";
      const mapped = routeDelivery(kind, loaded({ delivery: { [kind]: [other, "web"] } }), { targets, db: fakeDb() });
      expect(mapped?.door, `${kind} mapped`).toBe(other);
      const web = routeDelivery(kind, loaded({ delivery: { [kind]: ["web"] } }), { targets, db: fakeDb() });
      expect(web?.door, `${kind} web only`).toBe("web");
      expect(web?.doorId).toBe("web:inbox");
    }
  });

  it("no map and today's door missing: web chat, with the reason", async () => {
    const { routeDelivery } = await import("../lib/delivery.js");
    const r = routeDelivery("morning-brief", loaded(), { targets: { slack: "U1" }, db: fakeDb() })!;
    expect(r.door).toBe("web");
    expect(r.note).toBe("Morning brief went to web chat: Telegram is not connected");
  });

  it("a map with no connected chat door still delivers, to web chat, with the reason", async () => {
    const { routeDelivery } = await import("../lib/delivery.js");
    const r = routeDelivery("morning-brief", loaded({ delivery: { "morning-brief": ["telegram"] } }), { targets: {}, db: fakeDb() })!;
    expect(r.door).toBe("web");
    expect(r.note).toBe("Morning brief went to web chat: Telegram is not connected");
  });

  it("the gate binds the chosen door and records the fallback only after a real send", async () => {
    const { routeDelivery } = await import("../lib/delivery.js");
    const db = fakeDb();
    const initiate = vi.fn(async (_s: string, _i: unknown, run: () => Promise<void>) => { await run(); return sent; });
    const r = routeDelivery("digest", loaded({ delivery: { digest: ["telegram", "web"] } }), { targets: {}, db, initiate: initiate as never })!;
    await r.gate({ cls: "scheduled", itemKey: "digest/x" }, async () => {});
    expect(initiate).toHaveBeenCalledWith("digest", expect.objectContaining({ door: "web:inbox", itemKey: "digest/x" }), expect.any(Function));
    expect(db.calls.map(([s]) => s).join(" ")).toMatch(/UPDATE initiations SET fallback_note/);
    expect(db.calls[0]![1]).toEqual([OWNER, "chief-of-staff", "digest/x", "Digest went to web chat: Telegram is not connected"]);

    const heldDb = fakeDb();
    const holding = vi.fn(async () => held);
    const h = routeDelivery("digest", loaded({ delivery: { digest: ["telegram", "web"] } }), { targets: {}, db: heldDb, initiate: holding as never })!;
    await h.gate({ cls: "scheduled", itemKey: "digest/y" }, async () => {});
    expect(heldDb.calls).toEqual([]);
  });

  it("who the message is for and where a conversation starts are two things, and only Slack's differ", async () => {
    const { routeDelivery } = await import("../lib/delivery.js");
    const slackDmChannel = vi.fn(async (_userId: string) => "D1");
    const targets = { telegram: "123", slack: "U1" };
    const via = (door: string) =>
      routeDelivery("digest", loaded({ delivery: { digest: [door] } }), { targets, db: fakeDb(), slackDmChannel })!;

    const slack = via("slack");
    // Unchanged: the ledger door and the conversation's identity are keyed on the user id.
    expect([slack.target, slack.doorId]).toEqual(["U1", "slack:U1"]);
    // The conversation is started at the direct-message channel the lookup returned.
    expect(await slack.conversationAddress()).toBe("D1");
    expect(slackDmChannel).toHaveBeenCalledWith("U1");

    const telegram = via("telegram");
    expect([telegram.target, await telegram.conversationAddress()]).toEqual(["123", "123"]);
    const web = via("web");
    expect(await web.conversationAddress()).toBe(OWNER);
    expect(slackDmChannel).toHaveBeenCalledTimes(1);
  });

  it("a Slack lookup that fails rejects the address; it never hands back the user id", async () => {
    const { routeDelivery } = await import("../lib/delivery.js");
    const slackDmChannel = vi.fn(async () => { throw new Error("slack direct-message channel lookup failed: missing_scope"); });
    const r = routeDelivery("digest", loaded({ delivery: { digest: ["slack"] } }), { targets: { slack: "U1" }, db: fakeDb(), slackDmChannel })!;
    await expect(r.conversationAddress()).rejects.toThrow(/missing_scope/);
  });

  it("a first-choice send records no fallback", async () => {
    const { routeDelivery } = await import("../lib/delivery.js");
    const db = fakeDb();
    const initiate = vi.fn(async () => sent);
    const r = routeDelivery("digest", loaded({ delivery: { digest: ["slack"] } }), { targets: { slack: "U1" }, db, initiate: initiate as never })!;
    await r.gate({ cls: "scheduled", itemKey: "digest/z" }, async () => {});
    expect(db.calls).toEqual([]);
  });
});

describe("sendTurn / sendText", () => {
  const rt = () => {
    const send = vi.fn(async () => ({}));
    const to = vi.fn((_c: unknown, _t: unknown) => ({ send }));
    return { send, to, rt: { to, waitUntil: vi.fn(), appAuth: { who: "app" }, telegram: "TG", slack: "SL" } };
  };
  const routedVia = async (door: "telegram" | "slack" | "web", slackDmChannel: (userId: string) => Promise<string> = async () => "D1") => {
    const { routeDelivery } = await import("../lib/delivery.js");
    const db = fakeDb();
    const routed = routeDelivery("track-routing", loaded({ delivery: { "track-routing": [door] } }), { targets: { telegram: "123", slack: "U1" }, db, slackDmChannel })!;
    return { routed, db };
  };

  it("telegram: starts the session in that chat, as the push approver", async () => {
    const { sendTurn } = await import("../lib/delivery-send.js");
    const { routed } = await routedVia("telegram");
    const { send, to, rt: runtime } = rt();
    await sendTurn(routed, runtime, "PROMPT", { lane: "track-routing", title: "T" });
    expect(to).toHaveBeenCalledWith("TG", { chatId: "123" });
    expect(send).toHaveBeenCalledWith("PROMPT", { auth: { who: "app", attributes: expect.objectContaining({ lane: "track-routing", approverPrincipalId: "123" }) } });
  });

  // NEEDS ANOTHER PACKET: `lib/delivery-send.ts` belongs to the Telegram door's packet. These two
  // are what its `sendTurn` has to do for Slack, and they stay red until it passes
  // `await routed.conversationAddress()` to `to(slack, ...)` instead of `routed.target`. Started
  // at the user id, the conversation's approval cards cannot be answered.
  it("slack: starts the session in the owner's direct-message channel, and keeps identity on the user id", async () => {
    const { sendTurn } = await import("../lib/delivery-send.js");
    const { routed } = await routedVia("slack");
    const { send, to, rt: runtime } = rt();
    await sendTurn(routed, runtime, "PROMPT", { lane: "track-routing", title: "T" });
    expect(to).toHaveBeenCalledWith("SL", { channelId: "D1" });
    expect(send).toHaveBeenCalledWith("PROMPT", { auth: { who: "app", attributes: { lane: "track-routing" } } });
    // No conversation is re-keyed: the identity lookup is still asked about the USER id.
    expect(proactiveContinuityIdentity).toHaveBeenCalledWith("slack", "U1");
  });

  it("slack: when the direct-message lookup fails, no session is started and the error reaches the caller", async () => {
    const { sendTurn } = await import("../lib/delivery-send.js");
    const { routed } = await routedVia("slack", async () => { throw new Error("slack direct-message channel lookup failed: missing_scope"); });
    const { send, to, rt: runtime } = rt();
    await expect(sendTurn(routed, runtime, "PROMPT", { lane: "track-routing", title: "T" })).rejects.toThrow(/missing_scope/);
    expect(to).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("web: no session; the text is generated once, in the agent's voice, and filed in the inbox", async () => {
    const { sendTurn } = await import("../lib/delivery-send.js");
    const { routed, db } = await routedVia("web");
    const { send, rt: runtime } = rt();
    await routed.gate({ cls: "event", itemKey: "track-routing/s1" }, () => sendTurn(routed, runtime, "PROMPT", { lane: "track-routing", title: "T" }));
    expect(send).not.toHaveBeenCalled();
    expect(String(gatewayComplete.mock.calls[0]![0])).toContain("Warm and brief.");
    expect(String(gatewayComplete.mock.calls[0]![0])).toContain("PROMPT");
    // (the real gate is not mocked here; the item key is whatever the gate last saw, i.e. unset)
    expect(db.calls.some(([s]) => /INSERT INTO web_inbox/.test(s))).toBe(true);
  });

  it("web: a schedule that already knows what to say skips the model and hands the chat its instruction", async () => {
    const { sendTurn } = await import("../lib/delivery-send.js");
    const { routed, db } = await routedVia("web");
    await sendTurn(routed, rt().rt, "ACT PROMPT", { lane: "x", title: "T", itemKey: "k1", webBody: "Read me", webContext: "ACT PROMPT" });
    expect(gatewayComplete).not.toHaveBeenCalled();
    expect(db.calls[0]![1]).toEqual([OWNER, "chief-of-staff", "track-routing", "T", "Read me", "ACT PROMPT", "k1", null, null, null]);
  });

  it("web: an empty model answer is a failed send, not an empty message", async () => {
    const { sendTurn } = await import("../lib/delivery-send.js");
    const { routed, db } = await routedVia("web");
    gatewayComplete.mockResolvedValueOnce("   ");
    await expect(sendTurn(routed, rt().rt, "P", { lane: "x", title: "T", itemKey: "k" })).rejects.toThrow(/no text/);
    expect(db.calls.some(([sql]) => /INSERT INTO web_inbox/.test(sql))).toBe(false);
  });

  it("sendText on web files the text under the title", async () => {
    const { sendText } = await import("../lib/delivery-send.js");
    const { routed, db } = await routedVia("web");
    await sendText(routed, "Plain notice", { itemKey: "n1", title: "Notice" });
    expect(db.calls[0]![1]).toEqual([OWNER, "chief-of-staff", "track-routing", "Notice", "Plain notice", null, "n1", null, null, null]);
  });

  it("plainFromTelegramHtml drops markup and keeps links readable", async () => {
    const { plainFromTelegramHtml } = await import("../lib/delivery-send.js");
    expect(plainFromTelegramHtml('<b>Ny</b> &amp; <a href="https://x.example/a">side</a> &lt;1&gt;')).toBe("Ny & side (https://x.example/a) <1>");
  });
});

describe("the web inbox row", () => {
  it("is written once per item key", async () => {
    const { putInbox } = await import("../lib/web-inbox.js");
    const db = fakeDb();
    await putInbox(db, { owner: OWNER, agent: "a", kind: "k", title: "t", body: "b", itemKey: "i" });
    expect(db.calls[0]![0]).toMatch(/ON CONFLICT \(owner, agent, item_key\) DO NOTHING/);
  });
});
