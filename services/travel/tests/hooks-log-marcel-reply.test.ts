// Tests for agent/hooks/log-marcel-reply.ts — Fix Wave B review fix (Important #1): Marcel's
// own replies were never logged, making "## Samtalen nylig" (Finding 1) one-sided.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionAuth } from "eve/context";
import type { HookContext } from "eve/hooks";

import { TripStore, type Trip } from "../lib/trip-store.js";
import { ConversationLog } from "../lib/conversation-log.js";
import logMarcelReply from "../agent/hooks/log-marcel-reply.js";

const CHAT_ID = "-100123";

function auth(chatId: string | null): SessionAuth {
  const a = chatId
    ? ({
        authenticator: "telegram-webhook",
        principalId: `telegram:${chatId}:1`,
        principalType: "user",
        attributes: { chat_id: chatId, chat_type: "group", user_id: "1" },
      } as never)
    : null;
  return { current: a, initiator: a } as SessionAuth;
}

function hookCtx(chatId: string | null): HookContext {
  return {
    session: { id: "wrun_test", auth: auth(chatId) },
    agent: { name: "marcel" },
    channel: {},
  } as unknown as HookContext;
}

function completedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message.completed" as const,
    data: {
      finishReason: "stop",
      message: "Bonjour! Det blir sol i morgen.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-1",
      ...overrides,
    },
  } as never;
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-log-reply-"));
  process.env["MARCEL_DATA_ROOT"] = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env["MARCEL_DATA_ROOT"];
});

function baseTrip(overrides: Partial<Omit<Trip, "dir" | "chatId">> = {}): Omit<Trip, "dir" | "chatId"> {
  return {
    slug: "paris-2026",
    name: "Paris",
    start: "2026-07-21",
    end: "2026-07-28",
    timezone: "Europe/Paris",
    destination: { name: "Paris", lat: 48.8566, lon: 2.3522 },
    ...overrides,
  };
}

function seedTripStore(): { store: TripStore; trip: Trip } {
  const store = new TripStore(root);
  store.saveConfig({ adminId: "1", killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
  const trip = store.createTrip(baseTrip());
  store.linkChat(trip.slug, CHAT_ID);
  return { store, trip: { ...trip, chatId: CHAT_ID } };
}

function handler() {
  const h = logMarcelReply.events?.["message.completed"];
  if (!h) throw new Error("message.completed handler missing");
  return h;
}

describe("agent/hooks/log-marcel-reply.ts", () => {
  it("logs Marcel's terminal reply to the linked trip's conversation log with marcel: true", async () => {
    const { trip } = seedTripStore();

    await handler()(completedEvent(), hookCtx(CHAT_ID));

    const log = new ConversationLog(path.join(trip.dir, "chatlog"), trip.timezone);
    const entries = log.recent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "Marcel", text: "Bonjour! Det blir sol i morgen.", marcel: true });
  });

  it("renders as 'Marcel:' in the transcript, alongside an inbound message, as a real two-sided conversation", async () => {
    const { store, trip } = seedTripStore();
    const log = new ConversationLog(path.join(trip.dir, "chatlog"), trip.timezone);
    log.append({ ts: Math.floor(Date.now() / 1000), from: "1", name: "Bendik", text: "Blir det sol i morgen?" });

    await handler()(completedEvent({ message: "Ja, sol og 24 grader!" }), hookCtx(CHAT_ID));

    const transcript = log.transcript(10);
    expect(transcript).toContain("Bendik: Blir det sol i morgen?");
    expect(transcript).toContain("Marcel: Ja, sol og 24 grader!");
    void store;
  });

  it("skips tool-call narration (finishReason: 'tool-calls'), logging only the terminal reply", async () => {
    const { trip } = seedTripStore();

    await handler()(completedEvent({ finishReason: "tool-calls", message: "Sjekker værmeldingen..." }), hookCtx(CHAT_ID));
    await handler()(completedEvent({ finishReason: "stop", message: "Sol i morgen!" }), hookCtx(CHAT_ID));

    const log = new ConversationLog(path.join(trip.dir, "chatlog"), trip.timezone);
    const entries = log.recent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("Sol i morgen!");
  });

  it("no-ops when the message is null (a step with no visible text)", async () => {
    const { trip } = seedTripStore();

    await handler()(completedEvent({ message: null }), hookCtx(CHAT_ID));

    const log = new ConversationLog(path.join(trip.dir, "chatlog"), trip.timezone);
    expect(log.recent(10)).toHaveLength(0);
  });

  it("no-ops cleanly (no throw) when no trip is linked to the calling chat", async () => {
    seedTripStore(); // linked to a DIFFERENT chat than the caller below
    await expect(handler()(completedEvent(), hookCtx("-999999"))).resolves.toBeUndefined();
  });

  it("no-ops cleanly when the caller carries no chat id at all", async () => {
    await expect(handler()(completedEvent(), hookCtx(null))).resolves.toBeUndefined();
  });

  it("never throws even when the data root has no config.json yet (fresh/unseeded deploy)", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });

    await expect(handler()(completedEvent(), hookCtx(CHAT_ID))).resolves.toBeUndefined();
  });
});
