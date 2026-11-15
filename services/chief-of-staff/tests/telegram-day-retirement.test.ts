/**
 * The day boundary, from the front door's side.
 *
 * The framework's session rename is additive — every address a session has ever claimed keeps
 * resolving to it — so the day's conversation can only be retired by naming its exact durable
 * session id and ending it, and only a ROUTE handler is handed `attachSession`. That puts the
 * retirement in the webhook front door, which has one standing contract above all others:
 * FAIL-OPEN. A slow database, a column a box has not migrated yet, an end that throws — each
 * one costs exactly one log line, and the update is forwarded regardless. The owner never loses
 * a message because the rotation had a bad day.
 *
 * eve 1.0 renamed the retirement: the handle `attachSession` returns has `end({ reason })` where
 * eve 0.60 had `reset({ reason })`. The last block runs the installed eve's own handle, so the
 * call this file fakes everywhere else is known to be the one eve really offers.
 *
 * These tests drive the exported helpers and the real route handler with fakes; the
 * database-shaped half (what is recorded, and the claim being idempotent when two updates arrive
 * together) is proved against a real disposable Postgres in tests/telegram-rotation.test.ts.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";

// The front door reaches its pool through agent-kit's lazy singleton, which needs a live
// DATABASE_URL. Replacing it here is what lets the ROUTE be exercised end to end — claim,
// end, forward — rather than only its fail-open half.
const live = vi.hoisted(() => ({
  order: [] as string[],
  claim: null as string | null,
  fails: false,
}));
vi.mock("@lares/agent-kit/db", () => ({
  getPool: () => ({
    query: async () => {
      live.order.push("claim");
      if (live.fails) throw new Error("connection refused");
      return { rows: live.claim === null ? [] : [{ session_id: live.claim }] };
    },
  }),
}));

import {
  retirePriorDaySession,
  telegramChatIdOfUpdate,
  type RetireHandle,
} from "../lib/telegram-rotation.js";
import webhook from "../agent/channels/telegram-webhook.js";

// The front door only ACTS on an update Telegram really sent: it compares the request's secret
// header with the installation's webhook secret, read from a file. A throwaway file stands in.
const FIXTURE_SECRET = "fixture-secret";
const secretDir = mkdtempSync(joinPath(tmpdir(), "webhook-secret-"));
writeFileSync(joinPath(secretDir, "secret"), FIXTURE_SECRET);
process.env["TELEGRAM_WEBHOOK_SECRET_TOKEN_FILE"] = joinPath(secretDir, "secret");

const FIXTURE_CHAT = 5550001;
const YESTERDAYS_SESSION = "wrun_fixture_yesterday";

function update(): string {
  return JSON.stringify({
    update_id: 1,
    message: { message_id: 2, chat: { id: FIXTURE_CHAT, type: "private" }, text: "god morgen" },
  });
}

/** A database that answers the day-boundary claim, or fails the way the named fault would. */
function fakeDb(behaviour: { claims?: string | null; fails?: string; hangs?: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      query: async (sql: string) => {
        calls.push(sql);
        if (behaviour.hangs) return await new Promise(() => {});
        if (behaviour.fails) throw new Error(behaviour.fails);
        return { rows: behaviour.claims == null ? [] : [{ session_id: behaviour.claims }] };
      },
    } as unknown as Pool,
  };
}

function fakeAttach(onEnd?: () => void | Promise<void>) {
  const ended: { sessionId: string; reason: string | undefined }[] = [];
  const attach = (sessionId: string): RetireHandle => ({
    end: async (options) => {
      await onEnd?.();
      ended.push({ sessionId, reason: options?.reason });
      // What eve resolves with: a delivery receipt. The retirement does not read it.
      return { sessionId, deliveryId: "delivery-fixture" };
    },
  });
  return { ended, attach };
}

beforeEach(() => {
  live.order.length = 0;
  live.claim = null;
  live.fails = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telegramChatIdOfUpdate", () => {
  it("reads the chat id off an ordinary inbound message", () => {
    expect(telegramChatIdOfUpdate(update())).toBe(String(FIXTURE_CHAT));
  });

  it("returns null for a body that is not JSON at all — the front door never throws on input", () => {
    expect(telegramChatIdOfUpdate("<html>502 Bad Gateway</html>")).toBeNull();
  });

  it("returns null for a button tap: a tap answers the LIVE conversation and must never retire it", () => {
    const tap = JSON.stringify({
      update_id: 3,
      callback_query: { id: "q1", message: { chat: { id: FIXTURE_CHAT } }, data: "eve:0" },
    });
    expect(telegramChatIdOfUpdate(tap)).toBeNull();
  });
});

describe("retirePriorDaySession", () => {
  it("ends exactly the recorded session, once, on the first update of a new day", async () => {
    const { db, calls } = fakeDb({ claims: YESTERDAYS_SESSION });
    const { attach, ended } = fakeAttach();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await retirePriorDaySession(update(), attach, { db });

    expect(ended.map((r) => r.sessionId)).toEqual([YESTERDAYS_SESSION]);
    // The reason travels with the retirement, so the runtime's own log tells a day boundary
    // from a conversation the owner ended from the console.
    expect(ended[0]!.reason).toMatch(/day rolled over/);
    expect(calls).toHaveLength(1);
  });

  it("ends nothing when the claim comes back empty (same day, or already claimed)", async () => {
    const { db } = fakeDb({ claims: null });
    const { attach, ended } = fakeAttach();

    await retirePriorDaySession(update(), attach, { db });

    expect(ended).toEqual([]);
  });

  it("forwards anyway when the database is unreachable — one log line, nothing ended", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ fails: "connection refused" });
    const { attach, ended } = fakeAttach();

    await expect(retirePriorDaySession(update(), attach, { db })).resolves.toBeUndefined();

    expect(ended).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("forwards anyway when the column is missing — a box that has not applied the migration yet", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ fails: 'column "session_id" does not exist' });
    const { attach } = fakeAttach();

    await expect(retirePriorDaySession(update(), attach, { db })).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("forwards anyway when ending the session throws — one log line", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ claims: YESTERDAYS_SESSION });
    const attach = (): RetireHandle => ({
      end: async () => { throw new Error("runtime unreachable"); },
    });

    await expect(retirePriorDaySession(update(), attach, { db })).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("forwards anyway when the handle has no end() at all (a framework that renamed it again) — one log line", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ claims: YESTERDAYS_SESSION });
    // The handle an older framework returned: the retirement was called something else on it.
    const olderHandle = { retire: async () => ({}) } as unknown as RetireHandle;

    await expect(retirePriorDaySession(update(), () => olderHandle, { db })).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("gives up on a slow read inside its budget instead of holding the update", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ hangs: true });
    const { attach, ended } = fakeAttach();

    const started = Date.now();
    await retirePriorDaySession(update(), attach, { db, budgetMs: 25 });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(ended).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("gives up on a slow end() inside its budget instead of holding the update", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ claims: YESTERDAYS_SESSION });
    const attach = (): RetireHandle => ({ end: () => new Promise(() => {}) });

    const started = Date.now();
    await retirePriorDaySession(update(), attach, { db, budgetMs: 25 });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("two updates racing over the day boundary end the old conversation once, and never the fresh one", async () => {
    // The claim is the database's (proved against a real Postgres in telegram-rotation.test.ts):
    // it hands the recorded session to one caller and nothing to the next. Whatever session the
    // first update's message then opens is never named to `attachSession` at all, so no
    // retirement can reach it.
    let claims = 0;
    const db = {
      query: async () => ({ rows: (claims += 1) === 1 ? [{ session_id: YESTERDAYS_SESSION }] : [] }),
    } as unknown as Pool;
    const { attach, ended } = fakeAttach();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await Promise.all([
      retirePriorDaySession(update(), attach, { db }),
      retirePriorDaySession(update(), attach, { db }),
    ]);

    expect(claims).toBe(2);
    expect(ended.map((r) => r.sessionId)).toEqual([YESTERDAYS_SESSION]);
  });

  it("does nothing at all for an update carrying no chat — no query, nothing ended", async () => {
    const { db, calls } = fakeDb({ claims: YESTERDAYS_SESSION });
    const { attach, ended } = fakeAttach();

    await retirePriorDaySession("not json", attach, { db });

    expect(calls).toEqual([]);
    expect(ended).toEqual([]);
  });
});

describe("the webhook front door", () => {
  const route = webhook.routes.find((r) => r.method === "POST")!;
  const handler = route.handler as unknown as (
    request: Request,
    args: { attachSession: (id: string) => RetireHandle },
  ) => Promise<Response>;

  function post(body: string): Request {
    return new Request("http://127.0.0.1/eve/v1/telegram", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": FIXTURE_SECRET },
      body,
    });
  }

  it("retires the prior day's conversation BEFORE the update is forwarded, so the message opens a new one", async () => {
    live.claim = YESTERDAYS_SESSION;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      live.order.push("forward");
      return new Response("ok");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    // The end takes a moment, as the real one does: eve resolves it only once the ended session
    // has released its address. The forward must wait for that, or the message would land in the
    // conversation being retired instead of opening a new one.
    const { attach, ended } = fakeAttach(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      live.order.push("end");
    });

    const response = await handler(post(update()), { attachSession: attach });

    expect(response.status).toBe(200);
    expect(live.order).toEqual(["claim", "end", "forward"]);
    expect(ended.map((r) => r.sessionId)).toEqual([YESTERDAYS_SESSION]);
  });

  it("forwards the update untouched on an ordinary same-day message — nothing is retired", async () => {
    const forwarded: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      forwarded.push(String((init as RequestInit).body));
      return new Response("ok");
    });
    const { attach, ended } = fakeAttach();

    const response = await handler(post(update()), { attachSession: attach });

    expect(response.status).toBe(200);
    expect(JSON.parse(forwarded[0]!).message.chat.id).toBe(FIXTURE_CHAT);
    expect(ended).toEqual([]);
  });

  it("forwards the update even though the retirement half could not reach the database", async () => {
    live.fails = true;
    const forwarded: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      forwarded.push(String((init as RequestInit).body));
      return new Response("ok");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { attach, ended } = fakeAttach();

    const response = await handler(post(update()), { attachSession: attach });

    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(ended).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("a button tap never retires the day's conversation: it answers the live one", async () => {
    live.claim = YESTERDAYS_SESSION;
    process.env["TELEGRAM_PRINCIPAL_ID"] = String(FIXTURE_CHAT);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const { attach, ended } = fakeAttach();
    const tap = JSON.stringify({
      update_id: 3,
      callback_query: {
        id: "q1",
        from: { id: FIXTURE_CHAT, is_bot: false },
        message: { message_id: 7, chat: { id: FIXTURE_CHAT, type: "private" } },
        data: "eve:0",
      },
    });

    try {
      const response = await handler(post(tap), { attachSession: attach });
      expect(response.status).toBe(200);
      expect(ended).toEqual([]);
      // Not even the day-boundary read: a tap carries no `message` of its own.
      expect(live.order).toEqual([]);
    } finally {
      delete process.env["TELEGRAM_PRINCIPAL_ID"];
    }
  });
});

// ── The installed eve's own session handle ───────────────────────────────────────────────
//
// Everything above fakes `attachSession(id).end(...)`. This block runs the real one, from the
// installed eve, on a stand-in runtime, to pin the three things the retirement relies on: the
// method exists, it is aimed at the exact session id it was attached to, and it carries the
// reason. If eve renames the method or changes what it dispatches, this fails.
describe("eve's own attachSession handle", () => {
  const EVE_DIST = pathToFileURL(fileURLToPath(new URL("../node_modules/eve/dist/src", import.meta.url))).href;

  interface Dispatched {
    sessionId: string;
    command: { kind: string; reason?: string; deliveryId?: string };
  }
  async function eveAttach(result: (sessionId: string) => Record<string, unknown>) {
    const { createAttachSessionFn } = (await import(`${EVE_DIST}/channel/session.js`)) as {
      createAttachSessionFn(runtime: unknown): (sessionId: string) => RetireHandle & { id: string };
    };
    const dispatched: Dispatched[] = [];
    const runtime = {
      dispatchSession: async (input: Dispatched) => {
        dispatched.push(input);
        return result(input.sessionId);
      },
      getEventStream: async function* () {},
    };
    return { attach: createAttachSessionFn(runtime), dispatched };
  }

  it("has end(), and nothing called reset() — the name the retirement calls is the one eve 1.0 offers", async () => {
    const { attach } = await eveAttach((id) => ({ status: "reset", previousSessionId: id }));
    const handle = attach(YESTERDAYS_SESSION) as unknown as Record<string, unknown>;
    expect(typeof handle["end"]).toBe("function");
    expect(handle["reset"]).toBeUndefined();
    expect(handle["id"]).toBe(YESTERDAYS_SESSION);
  });

  it("the retirement ends the exact recorded session, with its reason, through eve's handle", async () => {
    const { db } = fakeDb({ claims: YESTERDAYS_SESSION });
    const { attach, dispatched } = await eveAttach((id) => ({ status: "reset", previousSessionId: id }));
    const said = vi.spyOn(console, "log").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await retirePriorDaySession(update(), attach, { db });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.sessionId).toBe(YESTERDAYS_SESSION);
    // "reset" is eve's wire name for ending a session; `end()` is what sends it.
    expect(dispatched[0]!.command).toMatchObject({ kind: "reset", reason: expect.stringMatching(/day rolled over/) });
    expect(logged).not.toHaveBeenCalled();
    expect(said).toHaveBeenCalledTimes(1);
  });

  it("a session that is already gone rejects, and costs one log line — the update is still forwarded", async () => {
    const { db } = fakeDb({ claims: YESTERDAYS_SESSION });
    const { attach, dispatched } = await eveAttach(() => ({ status: "no_active_session" }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(retirePriorDaySession(update(), attach, { db })).resolves.toBeUndefined();

    expect(dispatched).toHaveLength(1);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
