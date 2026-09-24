// Tests for the live-location branch of agent/channels/telegram.ts's createOnMessage (Task
// 11). Same message()/fakeCtx()/baseDeps() helper shapes as tests/telegram-channel.test.ts —
// duplicated rather than imported, matching that file's own self-contained-per-test-file
// convention.
//
// IMPORTANT (see agent/channels/telegram.ts's own top-of-file doc comment and this task's
// report for the full explanation): these tests call `createOnMessage(...)`'s returned handler
// DIRECTLY with a synthetic `TelegramMessage`, exactly as tests/telegram-channel.test.ts does
// for every other branch. That proves the HANDLER's own set/clear logic is correct. It does
// NOT prove eve's real webhook route would ever invoke the handler this way for a "stop
// sharing" update — Telegram delivers that (and every live-location ping after the first) as
// an `edited_message` update, which eve 0.32.0's `parseTelegramUpdate` silently drops before
// `onMessage` is ever called. `lib/live-location.ts`'s TTL expiry is what actually protects
// production; the explicit-clear tests below prove the code is ready for the day eve adds
// `edited_message` support, not that it fires today.
// NOTE: deliberately a plain static import, NOT tests/telegram-channel.test.ts's own
// `vi.resetModules()` + dynamic-import "freshModule()" pattern — that pattern gives
// agent/channels/telegram.ts a BRAND NEW copy of lib/live-location.ts on every call (a fresh
// module instance means a fresh, separate `store` Map), which would silently desync from
// whatever this file's own top-level `getLiveLocation` import reads. Nothing under test here
// depends on env-var state read at module-import time (unlike telegram-channel.test.ts's
// credential tests), so there's no reason to pay that cost.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createOnMessage } from "../agent/channels/telegram.js";
import { getLiveLocation, __resetLiveLocationStoreForTest } from "../lib/live-location.js";

const ADMIN_ID = "123456789";
const OTHER_ID = "999999999";

function message(overrides: Record<string, unknown> = {}) {
  return {
    attachments: [],
    caption: "",
    chat: { id: "123", type: "private" },
    from: { id: ADMIN_ID, isBot: false, firstName: "Bendik" },
    messageId: "1",
    raw: {},
    text: "",
    ...overrides,
  } as never;
}

function locationMessage(location: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return message({ raw: { location }, ...overrides });
}

function fakeCtx() {
  return {
    telegram: {
      botUsername: "marcel_bot",
      chatId: "",
      chatType: undefined,
      conversationId: undefined,
      messageThreadId: undefined,
      startTyping: vi.fn(async () => {}),
      request: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
      post: vi.fn(async () => ({ id: "1", raw: {} })),
      sendMessage: vi.fn(async () => ({ id: "1", raw: {} })),
      answerCallbackQuery: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
      editMessageReplyMarkup: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    },
  } as never;
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    tripForChat: vi.fn(async () => null as { tz: string; dir: string } | null),
    appendInbound: vi.fn(),
    transcriptFor: () => "",
    isKillSwitchOn: () => false,
    setKillSwitch: vi.fn(),
    gatekeeper: { consider: vi.fn(async () => ({ action: "silent" as const })) },
    budget: { exceeded: () => false, notifyOnce: () => false, add: vi.fn() },
    notifyBudgetExceeded: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  __resetLiveLocationStoreForTest();
  process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
});

describe("createOnMessage — live-location tracking", () => {
  it("a live-location share (location + live_period) from the admin sets lastKnownLocation for that chat", async () => {
    const deps = baseDeps();
    const ctx = fakeCtx();

    const result = await createOnMessage(deps as never)(
      ctx,
      locationMessage({ latitude: 43.296482, longitude: 5.36978, live_period: 900 }),
    );

    expect(result).toBeNull(); // a location share is never itself a request for a reply
    expect(getLiveLocation("123")).toEqual({ lat: 43.296482, lon: 5.36978 });
  });

  it("a later live-location ping (still carrying live_period) overwrites the earlier position", async () => {
    const deps = baseDeps();
    const ctx = fakeCtx();
    const onMessage = createOnMessage(deps as never);

    await onMessage(ctx, locationMessage({ latitude: 43.296, longitude: 5.37, live_period: 900 }));
    await onMessage(ctx, locationMessage({ latitude: 43.3, longitude: 5.38, live_period: 900 }));

    expect(getLiveLocation("123")).toEqual({ lat: 43.3, lon: 5.38 });
  });

  it("a stopped live-location share (no live_period, while one was being tracked) clears it", async () => {
    const deps = baseDeps();
    const ctx = fakeCtx();
    const onMessage = createOnMessage(deps as never);

    await onMessage(ctx, locationMessage({ latitude: 43.296, longitude: 5.37, live_period: 900 }));
    expect(getLiveLocation("123")).not.toBeNull();

    const result = await onMessage(ctx, locationMessage({ latitude: 43.296, longitude: 5.37 }));

    expect(result).toBeNull();
    expect(getLiveLocation("123")).toBeNull();
  });

  it("a fresh one-off location share (no live_period, nothing tracked yet) still records a bounded position", async () => {
    const deps = baseDeps();
    const ctx = fakeCtx();

    await createOnMessage(deps as never)(ctx, locationMessage({ latitude: 48.8566, longitude: 2.3522 }));

    expect(getLiveLocation("123")).toEqual({ lat: 48.8566, lon: 2.3522 });
  });

  it("ignores a location share from a non-admin sender entirely — no location recorded", async () => {
    const deps = baseDeps();
    const ctx = fakeCtx();

    const result = await createOnMessage(deps as never)(
      ctx,
      locationMessage(
        { latitude: 43.296, longitude: 5.37, live_period: 900 },
        { chat: { id: "-100123", type: "group", title: "Family Trip" }, from: { id: OTHER_ID, isBot: false } },
      ),
    );

    expect(result).toBeNull();
    expect(getLiveLocation("-100123")).toBeNull();
  });

  it("ignores a location share from a bot", async () => {
    const deps = baseDeps();
    const ctx = fakeCtx();

    await createOnMessage(deps as never)(
      ctx,
      locationMessage({ latitude: 43.296, longitude: 5.37, live_period: 900 }, { from: { id: ADMIN_ID, isBot: true } }),
    );

    expect(getLiveLocation("123")).toBeNull();
  });

  it("does not dispatch a turn (no typing, no gatekeeper call) for a location share, even in a linked group from the admin", async () => {
    const gatekeeper = { consider: vi.fn(async () => ({ action: "speak" as const })) };
    const deps = baseDeps({ gatekeeper, tripForChat: vi.fn(async () => ({ tz: "Europe/Paris", dir: "/tmp/x" })) });
    const ctx = fakeCtx();

    const result = await createOnMessage(deps as never)(
      ctx,
      locationMessage(
        { latitude: 43.296, longitude: 5.37, live_period: 900 },
        { chat: { id: "-100123", type: "group" }, from: { id: ADMIN_ID, isBot: false } },
      ),
    );

    expect(result).toBeNull();
    expect((gatekeeper.consider as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((ctx as { telegram: { startTyping: ReturnType<typeof vi.fn> } }).telegram.startTyping).not.toHaveBeenCalled();
  });

  it("the kill switch short-circuits a location share too — nothing recorded", async () => {
    const deps = baseDeps({ isKillSwitchOn: () => true });
    const ctx = fakeCtx();

    await createOnMessage(deps as never)(ctx, locationMessage({ latitude: 43.296, longitude: 5.37, live_period: 900 }));

    expect(getLiveLocation("123")).toBeNull();
  });

  it("a normal text message is unaffected — no raw.location means the existing dispatch path still runs", async () => {
    const deps = baseDeps();
    const ctx = fakeCtx();

    const result = await createOnMessage(deps as never)(ctx, message({ text: "hei" }));

    expect(result).not.toBeNull();
    expect(getLiveLocation("123")).toBeNull();
  });
});
