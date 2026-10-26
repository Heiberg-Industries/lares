import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELIVERY_KINDS, type DeliveryKind } from "@lares/agent-kit/delivery";

const gatewayComplete = vi.fn(async (_prompt: string, _opts?: unknown) => "Generated for the web.");
vi.mock("../lib/llm-complete.js", () => ({ gatewayComplete }));

const OWNER = "owner-1";
beforeEach(() => {
  process.env["AGENT_OWNER_USER_ID"] = OWNER;
  gatewayComplete.mockClear();
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
    { calls: [string, unknown[]][]; query: (sql: string, params?: unknown[]) => Promise<unknown> };
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
  const routedVia = async (door: "telegram" | "slack" | "web") => {
    const { routeDelivery } = await import("../lib/delivery.js");
    const db = fakeDb();
    const routed = routeDelivery("crm-routing", loaded({ delivery: { "crm-routing": [door] } }), { targets: { telegram: "123", slack: "U1" }, db })!;
    return { routed, db };
  };

  it("telegram: starts the session in that chat, as the push approver", async () => {
    const { sendTurn } = await import("../lib/delivery-send.js");
    const { routed } = await routedVia("telegram");
    const { send, to, rt: runtime } = rt();
    await sendTurn(routed, runtime, "PROMPT", { lane: "crm-routing", title: "T" });
    expect(to).toHaveBeenCalledWith("TG", { chatId: "123" });
    expect(send).toHaveBeenCalledWith("PROMPT", { auth: { who: "app", attributes: expect.objectContaining({ lane: "crm-routing", approverPrincipalId: "123" }) } });
  });

  it("slack: starts the session in that channel", async () => {
    const { sendTurn } = await import("../lib/delivery-send.js");
    const { routed } = await routedVia("slack");
    const { send, to, rt: runtime } = rt();
    await sendTurn(routed, runtime, "PROMPT", { lane: "crm-routing", title: "T" });
    expect(to).toHaveBeenCalledWith("SL", { channelId: "U1" });
    expect(send).toHaveBeenCalledWith("PROMPT", { auth: { who: "app", attributes: { lane: "crm-routing" } } });
  });

  it("web: no session; the text is generated once, in the agent's voice, and filed in the inbox", async () => {
    const { sendTurn } = await import("../lib/delivery-send.js");
    const { routed, db } = await routedVia("web");
    const { send, rt: runtime } = rt();
    await routed.gate({ cls: "event", itemKey: "crm-routing/s1" }, () => sendTurn(routed, runtime, "PROMPT", { lane: "crm-routing", title: "T" }));
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
    expect(db.calls[0]![1]).toEqual([OWNER, "chief-of-staff", "crm-routing", "T", "Read me", "ACT PROMPT", "k1", null, null, null]);
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
    expect(db.calls[0]![1]).toEqual([OWNER, "chief-of-staff", "crm-routing", "Notice", "Plain notice", null, "n1", null, null, null]);
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
