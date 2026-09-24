// ORB-159 — the "/" command menu is registered with Telegram at every boot. The bot identity
// was re-registered on 2026-08-17 and the menu came back empty; a hand registration
// (2026-08-24) dies at the next one. Two scoped lists: groups see only `info`, the admin DM
// gets the toolkit. Best-effort by contract — a Telegram hiccup is reported, never thrown.
import { describe, it, expect } from "vitest";

import { ADMIN_COMMANDS, GROUP_COMMANDS, registerCommandMenus } from "../lib/telegram-commands.js";

interface Captured {
  url: string;
  body: { commands: { command: string; description: string }[]; scope: Record<string, unknown> };
}

function fetchRecorder(respond: (call: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Captured = { url: String(input), body: JSON.parse(String(init?.body)) as Captured["body"] };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const telegramOk = () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });

describe("registerCommandMenus", () => {
  it("registers the group menu (info only) and the admin menu (the toolkit) with setMyCommands", async () => {
    const rec = fetchRecorder(telegramOk);
    const result = await registerCommandMenus({ botToken: async () => "123:abc", fetch: rec.fetch, adminChatId: "42" });

    expect(result).toEqual({ ok: true });
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls.every((c) => c.url === "https://api.telegram.org/bot123:abc/setMyCommands")).toBe(true);

    const group = rec.calls.find((c) => c.body.scope.type === "all_group_chats");
    expect(group?.body.commands.map((c) => c.command)).toEqual(["info"]);

    const admin = rec.calls.find((c) => c.body.scope.type === "chat");
    expect(admin?.body.scope.chat_id).toBe(42);
    expect(admin?.body.commands.map((c) => c.command)).toEqual(["nytur", "sveip", "info", "marcel"]);
  });

  it("never offers /avbryt — there is no wizard on eve to cancel", () => {
    expect([...ADMIN_COMMANDS, ...GROUP_COMMANDS].some((c) => c.command === "avbryt")).toBe(false);
  });

  it("reports a Telegram refusal without throwing and without the token", async () => {
    const rec = fetchRecorder(() => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }));
    const result = await registerCommandMenus({ botToken: async () => "123:abc", fetch: rec.fetch, adminChatId: "42" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unauthorized");
    expect(result.error).not.toContain("123:abc");
  });

  it("reports a transport failure without throwing", async () => {
    const failing = (async () => {
      throw new Error("connect ECONNREFUSED slack-proxy:8888");
    }) as unknown as typeof fetch;
    const result = await registerCommandMenus({ botToken: async () => "123:abc", fetch: failing, adminChatId: "42" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});
