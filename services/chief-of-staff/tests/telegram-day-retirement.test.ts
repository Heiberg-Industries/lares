/**
 * The day boundary, from the front door's side.
 *
 * The framework's session rename is additive — every address a session has ever claimed keeps
 * resolving to it — so the day's conversation can only be retired by naming its exact durable
 * session id and resetting it, and only a ROUTE handler is handed `attachSession`. That puts the
 * retirement in the webhook front door, which has one standing contract above all others:
 * FAIL-OPEN. A slow database, a column a box has not migrated yet, a reset that throws — each
 * one costs exactly one log line, and the update is forwarded regardless. The owner never loses
 * a message because the rotation had a bad day.
 *
 * These tests drive the exported helpers and the real route handler with fakes; the
 * database-shaped half (what is recorded, and the claim being idempotent when two updates arrive
 * together) is proved against a real disposable Postgres in tests/telegram-rotation.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";

// The front door reaches its pool through agent-kit's lazy singleton, which needs a live
// DATABASE_URL. Replacing it here is what lets the ROUTE be exercised end to end — claim,
// reset, forward — rather than only its fail-open half.
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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
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

function fakeAttach(onReset?: () => void) {
  const resets: { sessionId: string; reason: string }[] = [];
  const attach = (sessionId: string): RetireHandle => ({
    reset: async ({ reason }) => {
      onReset?.();
      resets.push({ sessionId, reason });
      return { status: "reset" };
    },
  });
  return { resets, attach };
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
      callback_query: { id: "q1", message: { chat: { id: FIXTURE_CHAT } }, data: "approve" },
    });
    expect(telegramChatIdOfUpdate(tap)).toBeNull();
  });
});

describe("retirePriorDaySession", () => {
  it("resets exactly the recorded session, once, on the first update of a new day", async () => {
    const { db, calls } = fakeDb({ claims: YESTERDAYS_SESSION });
    const { attach, resets } = fakeAttach();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await retirePriorDaySession(update(), attach, { db });

    expect(resets.map((r) => r.sessionId)).toEqual([YESTERDAYS_SESSION]);
    expect(resets[0]!.reason.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
  });

  it("does not reset anything when the claim comes back empty (same day, or already claimed)", async () => {
    const { db } = fakeDb({ claims: null });
    const { attach, resets } = fakeAttach();

    await retirePriorDaySession(update(), attach, { db });

    expect(resets).toEqual([]);
  });

  it("forwards anyway when the database is unreachable — one log line, no reset", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ fails: "connection refused" });
    const { attach, resets } = fakeAttach();

    await expect(retirePriorDaySession(update(), attach, { db })).resolves.toBeUndefined();

    expect(resets).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("forwards anyway when the column is missing — a box that has not applied the migration yet", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ fails: 'column "session_id" does not exist' });
    const { attach } = fakeAttach();

    await expect(retirePriorDaySession(update(), attach, { db })).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("forwards anyway when the reset itself throws — one log line", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ claims: YESTERDAYS_SESSION });
    const attach = (): RetireHandle => ({
      reset: async () => { throw new Error("runtime unreachable"); },
    });

    await expect(retirePriorDaySession(update(), attach, { db })).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("gives up on a slow read inside its budget instead of holding the update", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ hangs: true });
    const { attach, resets } = fakeAttach();

    const started = Date.now();
    await retirePriorDaySession(update(), attach, { db, budgetMs: 25 });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(resets).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all for an update carrying no chat — no query, no reset", async () => {
    const { db, calls } = fakeDb({ claims: YESTERDAYS_SESSION });
    const { attach, resets } = fakeAttach();

    await retirePriorDaySession("not json", attach, { db });

    expect(calls).toEqual([]);
    expect(resets).toEqual([]);
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

  it("retires the prior day's conversation BEFORE the update is forwarded", async () => {
    live.claim = YESTERDAYS_SESSION;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      live.order.push("forward");
      return new Response("ok");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { attach, resets } = fakeAttach(() => live.order.push("reset"));

    const response = await handler(post(update()), { attachSession: attach });

    expect(response.status).toBe(200);
    expect(live.order).toEqual(["claim", "reset", "forward"]);
    expect(resets.map((r) => r.sessionId)).toEqual([YESTERDAYS_SESSION]);
  });

  it("forwards the update untouched on an ordinary same-day message — nothing is retired", async () => {
    const forwarded: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      forwarded.push(String((init as RequestInit).body));
      return new Response("ok");
    });
    const { attach, resets } = fakeAttach();

    const response = await handler(post(update()), { attachSession: attach });

    expect(response.status).toBe(200);
    expect(JSON.parse(forwarded[0]!).message.chat.id).toBe(FIXTURE_CHAT);
    expect(resets).toEqual([]);
  });

  it("forwards the update even though the retirement half could not reach the database", async () => {
    live.fails = true;
    const forwarded: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      forwarded.push(String((init as RequestInit).body));
      return new Response("ok");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { attach, resets } = fakeAttach();

    const response = await handler(post(update()), { attachSession: attach });

    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(resets).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
