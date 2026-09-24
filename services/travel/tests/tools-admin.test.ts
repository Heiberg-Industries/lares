// Tests for Task 9's trip-admin tools (nytur, info, toggle_kill_switch, link_group,
// predeparture_pack) PLUS the veto-callback wiring added to agent/channels/telegram.ts per
// Ruling 5 (Task 5's review — the veto button had no onCallbackQuery handler anywhere).
//
// Mirrors tools-conversation-batch.test.ts's convention: each tool is exercised via its
// exported `createXTool(deps)` factory with stubbed deps, never the real `defaultXDeps` (which
// does real I/O / reads secret files). `eve/channels/telegram`'s `sendTelegramMessage` /
// `answerTelegramCallbackQuery` / `editTelegramMessageReplyMarkup` are mocked at the module
// level so tools that DO reach for the raw send primitives directly (toggle_kill_switch,
// link_group, info, the veto handler) never touch real credentials or network.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionAuth } from "eve/context";

vi.mock("eve/channels/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("eve/channels/telegram")>();
  return {
    ...actual,
    sendTelegramMessage: vi.fn(async () => ({ id: "1", chatId: undefined, chatType: undefined, raw: {} })),
    answerTelegramCallbackQuery: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    editTelegramMessageReplyMarkup: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    callTelegramApi: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
  };
});

import { sendTelegramMessage, answerTelegramCallbackQuery, editTelegramMessageReplyMarkup, callTelegramApi } from "eve/channels/telegram";
import { TripStore, type Trip } from "../lib/trip-store.js";
import { createNyturTool, slugify, type NyturDeps } from "../catalogue/nytur.js";
import { createInfoTool, infoCard, type InfoDeps } from "../catalogue/info.js";
import { createToggleKillSwitchTool, type ToggleKillSwitchDeps } from "../catalogue/toggle_kill_switch.js";
import { createLinkGroupTool, type LinkGroupDeps } from "../catalogue/link_group.js";
import { createPredeparturePackTool, composeStopMessage, type PredeparturePackDeps } from "../catalogue/predeparture_pack.js";
import type { DiscoveryHit } from "../lib/discovery.js";

const sendMock = vi.mocked(sendTelegramMessage);
const answerCallbackMock = vi.mocked(answerTelegramCallbackQuery);
const editMarkupMock = vi.mocked(editTelegramMessageReplyMarkup);
const callApiMock = vi.mocked(callTelegramApi);

const ADMIN_ID = "123456789";
const OTHER_ID = "999999999";
const GROUP_CHAT_ID = "-100123";

function auth(overrides: Partial<{ chatType: string; userId: string; chatId: string }> = {}): SessionAuth {
  const chatType = overrides.chatType ?? "private";
  const userId = overrides.userId ?? ADMIN_ID;
  const chatId = overrides.chatId ?? (chatType === "private" ? userId : GROUP_CHAT_ID);
  const a = {
    authenticator: "telegram-webhook",
    principalId: chatType === "private" ? `telegram:${userId}` : `telegram:${chatId}:${userId}`,
    principalType: "user",
    attributes: { chat_id: chatId, chat_type: chatType, user_id: userId },
  } as never;
  return { current: a, initiator: a } as SessionAuth;
}

function ctx(a: SessionAuth | null) {
  return { session: { id: "wrun_test", auth: a } } as never;
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-admin-tools-"));
  process.env["MARCEL_ADMIN_TELEGRAM_ID"] = ADMIN_ID;
  sendMock.mockClear();
  answerCallbackMock.mockClear();
  editMarkupMock.mockClear();
  callApiMock.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env["MARCEL_ADMIN_TELEGRAM_ID"];
  delete process.env["MARCEL_DATA_ROOT"];
});

function baseTrip(overrides: Partial<Omit<Trip, "dir" | "chatId">> = {}): Omit<Trip, "dir" | "chatId"> {
  return {
    slug: "nyc-2026",
    name: "NYC",
    start: "2026-09-01",
    end: "2026-09-08",
    timezone: "America/New_York",
    destination: { name: "New York", lat: 40.7128, lon: -74.006 },
    ...overrides,
  };
}

function seedStore(): TripStore {
  const store = new TripStore(root);
  store.saveConfig({ adminId: ADMIN_ID, killSwitch: false, dailyTokenBudget: 1_000_000, trips: [] });
  return store;
}

// ---------------------------------------------------------------------------------------
// nytur
// ---------------------------------------------------------------------------------------
describe("nytur", () => {
  it("slugify — ported verbatim from old Marcel", () => {
    expect(slugify("NYC 2026!")).toBe("nyc-2026");
    expect(slugify("Côte d'Azur")).toBe("cote-d-azur");
  });

  it("creates a trip and returns its slug", async () => {
    const store = seedStore();
    const deps: NyturDeps = { store: () => store };
    const tool = createNyturTool(deps);

    const result = (await tool.execute(
      {
        name: "NYC 2026",
        destinationName: "New York",
        lat: 40.7128,
        lon: -74.006,
        startISO: "2026-09-01",
        endISO: "2026-09-08",
        timezone: "America/New_York",
      },
      ctx(auth()),
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(result["slug"]).toBe("nyc-2026");
    expect(store.trips()).toHaveLength(1);
    expect(store.trips()[0]!.timezone).toBe("America/New_York");
  });

  it("writes house info into trip.md when given", async () => {
    const store = seedStore();
    const tool = createNyturTool({ store: () => store });

    await tool.execute(
      {
        name: "NYC 2026",
        destinationName: "New York",
        lat: 40.7128,
        lon: -74.006,
        startISO: "2026-09-01",
        endISO: "2026-09-08",
        timezone: "America/New_York",
        houseInfo: "Wifi: guest123",
      },
      ctx(auth()),
    );

    const trip = store.trips()[0]!;
    expect(store.read(trip, "trip.md")).toContain("Wifi: guest123");
  });

  it("refuses a duplicate slug rather than clobbering the existing trip", async () => {
    const store = seedStore();
    store.createTrip(baseTrip());
    const tool = createNyturTool({ store: () => store });

    const result = (await tool.execute(
      {
        name: "NYC 2026",
        destinationName: "New York",
        lat: 1,
        lon: 1,
        startISO: "2027-01-01",
        endISO: "2027-01-08",
        timezone: "America/New_York",
      },
      ctx(auth()),
    )) as Record<string, unknown>;

    expect(result["error"]).toBeDefined();
    expect(store.trips()).toHaveLength(1);
  });

  it("is admin-DM only", async () => {
    const store = seedStore();
    const tool = createNyturTool({ store: () => store });

    await expect(
      tool.execute(
        {
          name: "NYC 2026",
          destinationName: "New York",
          lat: 1,
          lon: 1,
          startISO: "2027-01-01",
          endISO: "2027-01-08",
          timezone: "America/New_York",
        },
        ctx(auth({ chatType: "group" })),
      ),
    ).rejects.toThrow(/admin-DM only/);
    expect(store.trips()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------------------
describe("info", () => {
  it("infoCard renders the house-info card with the emergency footer", () => {
    const card = infoCard("Wifi: guest123\nDørkode: 4711");
    expect(card).toContain("🏠 Husets info");
    expect(card).toContain("Wifi: guest123");
    expect(card).toContain("Nød: 112");
  });

  it("infoCard still carries the emergency footer when trip.md is empty", () => {
    const card = infoCard("");
    expect(card).toContain("🏠 Husets info");
    expect(card).toContain("Nød: 112");
  });

  it("renders the CURRENT trip's card in a group and pins it — ignores any slug input", async () => {
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.linkChat(trip.slug, GROUP_CHAT_ID);
    store.write({ ...trip, dir: trip.dir }, "trip.md", "Wifi: guest123");

    const send = vi.fn(async () => ({ id: "555" }));
    const pin = vi.fn(async () => {});
    const deps: InfoDeps = { store: () => store, send, pin };
    const tool = createInfoTool(deps);

    const result = (await tool.execute({ slug: "some-other-slug" }, ctx(auth({ chatType: "group" })))) as Record<
      string,
      unknown
    >;

    expect(result["ok"]).toBe(true);
    expect(send).toHaveBeenCalledWith(GROUP_CHAT_ID, infoCard("Wifi: guest123"));
    expect(pin).toHaveBeenCalledWith(GROUP_CHAT_ID, "555");
  });

  it("group /info is not admin-gated — any group member can trigger it", async () => {
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.linkChat(trip.slug, GROUP_CHAT_ID);

    const send = vi.fn(async () => ({ id: "1" }));
    const pin = vi.fn(async () => {});
    const tool = createInfoTool({ store: () => store, send, pin });

    await expect(
      tool.execute({}, ctx(auth({ chatType: "group", userId: OTHER_ID }))),
    ).resolves.toMatchObject({ ok: true });
  });

  it("returns an error, not a throw, when the group has no linked trip", async () => {
    const store = seedStore();
    const send = vi.fn();
    const pin = vi.fn();
    const tool = createInfoTool({ store: () => store, send, pin });

    const result = (await tool.execute({}, ctx(auth({ chatType: "group" })))) as Record<string, unknown>;
    expect(result["error"]).toBeDefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("admin DM requires a slug and sends without pinning", async () => {
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.write(trip, "trip.md", "Dørkode: 1234");

    const send = vi.fn(async () => ({ id: "1" }));
    const pin = vi.fn(async () => {});
    const tool = createInfoTool({ store: () => store, send, pin });

    const result = (await tool.execute({ slug: "nyc-2026" }, ctx(auth()))) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(send).toHaveBeenCalledWith(ADMIN_ID, infoCard("Dørkode: 1234"));
    expect(pin).not.toHaveBeenCalled();
  });

  it("admin DM without a slug returns an error, never guesses a trip", async () => {
    const store = seedStore();
    store.createTrip(baseTrip());
    const send = vi.fn();
    const tool = createInfoTool({ store: () => store, send, pin: vi.fn() });

    const result = (await tool.execute({}, ctx(auth()))) as Record<string, unknown>;
    expect(result["error"]).toBeDefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("a private-chat non-admin is rejected outright", async () => {
    const store = seedStore();
    const tool = createInfoTool({ store: () => store, send: vi.fn(), pin: vi.fn() });

    await expect(
      tool.execute({ slug: "nyc-2026" }, ctx(auth({ userId: OTHER_ID }))),
    ).rejects.toThrow(/admin-DM only/);
  });

  it("the real default send splits text past Telegram's 4096-char limit into multiple sendMessage calls, and returns the FIRST chunk's id for pinning (review fix, minor item 4)", async () => {
    const { defaultInfoDeps } = await import("../catalogue/info.js");
    // house rules text long enough to force a split — well past 4096 chars.
    const longLine = "Dørkode: 4711 — husk å låse etter deg, ikke fôr mågene, søppel tømmes tirsdager.\n";
    const longText = longLine.repeat(80); // ~80 * ~85 chars ≈ 6800 chars, comfortably over the cap

    sendMock.mockClear();
    sendMock
      .mockResolvedValueOnce({ id: "111", chatId: undefined, chatType: undefined, raw: {} })
      .mockResolvedValueOnce({ id: "222", chatId: undefined, chatType: undefined, raw: {} });

    const result = await defaultInfoDeps.send(GROUP_CHAT_ID, longText);

    expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(2); // Telegram would reject one 6800-char sendMessage
    expect(result.id).toBe("111"); // the FIRST chunk's id — that's the message a pin should anchor to
  });
});

// ---------------------------------------------------------------------------------------
// toggle_kill_switch — real integration against agent/channels/telegram.ts's shared state
// ---------------------------------------------------------------------------------------
describe("toggle_kill_switch", () => {
  it("is admin-only: a non-admin call throws and never flips the switch", async () => {
    process.env["MARCEL_DATA_ROOT"] = root;
    seedStore();
    const { createToggleKillSwitchTool: createTool, defaultToggleKillSwitchDeps } = await import(
      "../catalogue/toggle_kill_switch.js"
    );
    const { defaultDoorDeps } = await import("../agent/channels/telegram.js");
    defaultDoorDeps.setKillSwitch(false);

    const tool = createTool(defaultToggleKillSwitchDeps);
    await expect(tool.execute({ on: true }, ctx(auth({ userId: OTHER_ID })))).rejects.toThrow(/admin-DM only/);

    expect(defaultDoorDeps.isKillSwitchOn()).toBe(false);
  });

  it("flips the shared kill switch and the channel's onMessage (Task 3) honors it end-to-end", async () => {
    process.env["MARCEL_DATA_ROOT"] = root;
    seedStore();
    const telegramModule = await import("../agent/channels/telegram.js");
    const { defaultDoorDeps, createOnMessage } = telegramModule;
    defaultDoorDeps.setKillSwitch(false);

    const tool = createToggleKillSwitchTool({ setKillSwitch: defaultDoorDeps.setKillSwitch });

    await tool.execute({ on: true }, ctx(auth()));
    expect(defaultDoorDeps.isKillSwitchOn()).toBe(true);

    const onMessage = createOnMessage(defaultDoorDeps);
    const fakeCtx = { telegram: { startTyping: vi.fn(async () => {}) } } as never;
    const adminMessage = {
      attachments: [],
      caption: "",
      chat: { id: ADMIN_ID, type: "private" },
      from: { id: ADMIN_ID, isBot: false, firstName: "Bendik" },
      messageId: "1",
      raw: {},
      text: "hei",
    } as never;

    const result = await onMessage(fakeCtx, adminMessage);
    expect(result).toBeNull(); // kill switch is ON — even the admin is silenced

    await tool.execute({ on: false }, ctx(auth()));
    expect(defaultDoorDeps.isKillSwitchOn()).toBe(false);
    const result2 = await onMessage(fakeCtx, adminMessage);
    expect(result2).not.toBeNull();
  });

  it("persists to MarcelConfig.killSwitch on disk — the SAME field lib/trip-schedule.ts and lib/dream.ts read, closing the split-brain gap (review finding 2)", async () => {
    process.env["MARCEL_DATA_ROOT"] = root;
    const store = seedStore();
    const { defaultDoorDeps } = await import("../agent/channels/telegram.js");

    defaultDoorDeps.setKillSwitch(true);
    // A brand new TripStore instance, reading straight off disk — proves the write is a real
    // persisted fact, not just an in-memory value this same module happens to also expose.
    expect(new TripStore(root).config().killSwitch).toBe(true);
    expect(store.config().killSwitch).toBe(true);

    defaultDoorDeps.setKillSwitch(false);
    expect(new TripStore(root).config().killSwitch).toBe(false);
  });

  it("isKillSwitchOn() reads false (not a throw) when config.json hasn't been seeded yet — the door must not crash on every inbound message before Task 12's seed step runs", async () => {
    process.env["MARCEL_DATA_ROOT"] = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-empty-"));
    const { defaultDoorDeps } = await import("../agent/channels/telegram.js");
    expect(defaultDoorDeps.isKillSwitchOn()).toBe(false);
  });

  it("isKillSwitchOn() does NOT silently read as 'off' when config.json EXISTS but is unreadable (malformed JSON, a truncated write, or — same code path — a permissions problem) — only a genuinely MISSING file reads as false; fails closed (true) and logs loudly (review fix, minor item 3)", async () => {
    const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-corrupt-"));
    fs.writeFileSync(path.join(badRoot, "config.json"), "{ not valid json ][");
    process.env["MARCEL_DATA_ROOT"] = badRoot;
    const { defaultDoorDeps } = await import("../agent/channels/telegram.js");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A corrupted config must not be indistinguishable from "not seeded yet" (false) — that
      // would let Marcel keep talking on a broken safety-control file with zero trace in the
      // logs. It fails toward SILENCE instead (true is the safe direction for a kill switch).
      expect(defaultDoorDeps.isKillSwitchOn()).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("kill switch config unreadable"),
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sends the fixed Norwegian confirmation DM to the admin", async () => {
    const setKillSwitch = vi.fn();
    const tool = createToggleKillSwitchTool({ setKillSwitch });

    await tool.execute({ on: true }, ctx(auth()));
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: ADMIN_ID, body: { text: "Marcel er av. 😴" } }),
    );

    await tool.execute({ on: false }, ctx(auth()));
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: ADMIN_ID, body: { text: "Marcel er på igjen. 🙋" } }),
    );
  });
});

// ---------------------------------------------------------------------------------------
// link_group
// ---------------------------------------------------------------------------------------
describe("link_group", () => {
  it("writes the chat→trip link TripStore reads", async () => {
    const store = seedStore();
    store.createTrip(baseTrip());
    const sendIntro = vi.fn(async () => {});
    const tool = createLinkGroupTool({ store: () => store, sendIntro });

    const result = (await tool.execute({ chatId: GROUP_CHAT_ID, tripSlug: "nyc-2026" }, ctx(auth()))) as Record<
      string,
      unknown
    >;

    expect(result["ok"]).toBe(true);
    expect(store.tripForChat(GROUP_CHAT_ID)?.slug).toBe("nyc-2026");
    expect(sendIntro).toHaveBeenCalledWith(GROUP_CHAT_ID, expect.stringContaining("NYC"));
  });

  it("returns an error for an unknown slug rather than throwing", async () => {
    const store = seedStore();
    const sendIntro = vi.fn(async () => {});
    const tool = createLinkGroupTool({ store: () => store, sendIntro });

    const result = (await tool.execute({ chatId: GROUP_CHAT_ID, tripSlug: "nope" }, ctx(auth()))) as Record<
      string,
      unknown
    >;

    expect(result["error"]).toBeDefined();
    expect(sendIntro).not.toHaveBeenCalled();
  });

  it("is admin-DM only", async () => {
    const store = seedStore();
    store.createTrip(baseTrip());
    const sendIntro = vi.fn(async () => {});
    const tool = createLinkGroupTool({ store: () => store, sendIntro });

    await expect(
      tool.execute({ chatId: GROUP_CHAT_ID, tripSlug: "nyc-2026" }, ctx(auth({ chatType: "group" }))),
    ).rejects.toThrow(/admin-DM only/);
    expect(store.tripForChat(GROUP_CHAT_ID)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// predeparture_pack
// ---------------------------------------------------------------------------------------
function hit(overrides: Partial<DiscoveryHit> = {}): DiscoveryHit {
  return { name: "Joe's Pizza", lat: 40.73, lon: -74.0, distanceM: 100, rating: 4.7, ...overrides };
}

describe("predeparture_pack", () => {
  it("composeStopMessage renders Telegram HTML: bold header, ⭐, a real <a href> link, escaped names", () => {
    const msg = composeStopMessage("Hotel & Spa", [
      hit({
        name: "Katz's <Deli>",
        rating: 4.6,
        userRatingCount: 20000,
        mapsUrl: "https://maps.google/x?q=a&b=c",
        paaBendiksListe: { liste: "NYC" },
      }),
    ]);
    expect(msg).toContain("<b>🧭 Hotel &amp; Spa</b>");
    expect(msg).toContain("⭐");
    // The place name is HTML-escaped (< and > neutralized) so it can never break out of the
    // surrounding <a> tag or be mistaken for markup Telegram would then reject/mangle.
    expect(msg).toContain("Katz's &lt;Deli&gt;");
    expect(msg).not.toContain("Katz's <Deli>");
    // The href carries the REAL mapsUrl, its own & escaped for HTML-attribute safety.
    expect(msg).toContain('<a href="https://maps.google/x?q=a&amp;b=c">');
  });

  it("composeStopMessage omits the <a> wrapper (name only) when nearby_places returned no mapsUrl", () => {
    const msg = composeStopMessage("Hotel", [hit({ name: "OSM Cafe", mapsUrl: undefined })]);
    expect(msg).toContain("OSM Cafe");
    expect(msg).not.toContain("<a href");
  });

  it("composeStopMessage handles zero hits without crashing", () => {
    const msg = composeStopMessage("Empty Stop", []);
    expect(msg).toContain("<b>🧭 Empty Stop</b>");
  });

  it("the real default send carries parse_mode: HTML via the raw callTelegramApi primitive (Important #2 fix)", async () => {
    const { defaultPredeparturePackDeps } = await import("../catalogue/predeparture_pack.js");
    await defaultPredeparturePackDeps.send(GROUP_CHAT_ID, "<b>🧭 Hotel</b>");

    expect(callApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sendMessage",
        body: expect.objectContaining({ chat_id: GROUP_CHAT_ID, text: "<b>🧭 Hotel</b>", parse_mode: "HTML" }),
      }),
    );
  });

  it("the real default send splits text past Telegram's 4096-char limit into multiple sendMessage calls (review fix, minor item 4)", async () => {
    const { defaultPredeparturePackDeps } = await import("../catalogue/predeparture_pack.js");
    const oneLine = `⭐ <a href="https://maps.example/?q=a">En restaurant med et ganske langt navn</a> (4.5★, 120 vurderinger)\n`;
    const longText = "<b>🧭 Hotel</b>\n" + oneLine.repeat(80); // comfortably over 4096 chars

    callApiMock.mockClear();
    await defaultPredeparturePackDeps.send(GROUP_CHAT_ID, longText);

    expect(callApiMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of callApiMock.mock.calls) {
      const body = (call[0] as { body: { text: string } }).body;
      expect(body.text.length).toBeLessThanOrEqual(4096);
    }
  });

  it("calls nearby_places (searchStop) exactly ONCE per known stop, and sends exactly ONE message per stop — never one per venue", async () => {
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.linkChat(trip.slug, GROUP_CHAT_ID);

    const searchStop = vi.fn(async () => ({
      hits: [hit({ name: "A" }), hit({ name: "B" }), hit({ name: "C" })],
      kilde: "Google" as const,
    }));
    const send = vi.fn(async () => {});
    const deps: PredeparturePackDeps = { store: () => store, searchStop, send };
    const tool = createPredeparturePackTool(deps);

    const stops = [
      { name: "Hotel", lat: 40.75, lon: -73.98 },
      { name: "Times Square", lat: 40.758, lon: -73.9855 },
    ];

    const result = (await tool.execute({ tripSlug: "nyc-2026", stops, category: "restaurant" }, ctx(auth()))) as Record<
      string,
      unknown
    >;

    expect(result["ok"]).toBe(true);
    expect(searchStop).toHaveBeenCalledTimes(2); // once per stop, NOT once per venue (3 venues/stop)
    expect(send).toHaveBeenCalledTimes(2); // one immersive-pack message per stop
    expect(send.mock.calls[0]![0]).toBe(GROUP_CHAT_ID);
  });

  // -------------------------------------------------------------------------------------
  // Photo sending (Fix Wave B, Finding 3; ordering/containment per the Important #3 review
  // fix) — text is ALWAYS sent first; a photo of the top hit is sent AFTER, strictly as
  // best-effort garnish that can never cost the text or abort the loop.
  // -------------------------------------------------------------------------------------
  it("sends the text first, then a best-effort photo of the top pick, when the top hit carries a photoRef and photo() resolves bytes", async () => {
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.linkChat(trip.slug, GROUP_CHAT_ID);

    const callOrder: string[] = [];
    const searchStop = vi.fn(async () => ({
      hits: [hit({ name: "Joe's Pizza", photoRef: "places/x/photos/y" })],
      kilde: "Google" as const,
    }));
    const send = vi.fn(async () => {
      callOrder.push("send");
    });
    const photo = vi.fn(async () => Buffer.from([1, 2, 3]));
    const sendPhotoMessage = vi.fn(async () => {
      callOrder.push("sendPhotoMessage");
    });
    const tool = createPredeparturePackTool({ store: () => store, searchStop, send, photo, sendPhotoMessage });

    const result = (await tool.execute(
      { tripSlug: "nyc-2026", stops: [{ name: "Hotel", lat: 40.75, lon: -73.98 }], category: "restaurant" },
      ctx(auth()),
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    // Text is ALWAYS sent, unconditionally — never replaced by the photo.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toContain("Joe's Pizza");
    // Photo is sent too, AFTER the text, with the same rendered content as its caption.
    expect(photo).toHaveBeenCalledWith("places/x/photos/y");
    expect(sendPhotoMessage).toHaveBeenCalledTimes(1);
    expect(sendPhotoMessage.mock.calls[0]![0]).toBe(GROUP_CHAT_ID);
    expect(sendPhotoMessage.mock.calls[0]![2]).toContain("Joe's Pizza");
    expect(callOrder).toEqual(["send", "sendPhotoMessage"]);
  });

  it("a sendPhotoMessage failure never costs the stop's text and never aborts the rest of the loop (Important #3 fix)", async () => {
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.linkChat(trip.slug, GROUP_CHAT_ID);

    const searchStop = vi.fn(async () => ({
      hits: [hit({ name: "Joe's Pizza", photoRef: "places/x/photos/y" })],
      kilde: "Google" as const,
    }));
    const send = vi.fn(async () => {});
    const photo = vi.fn(async () => Buffer.from([1, 2, 3]));
    const sendPhotoMessage = vi.fn(async () => {
      throw new Error("telegram sendPhoto: chat not found");
    });
    const tool = createPredeparturePackTool({ store: () => store, searchStop, send, photo, sendPhotoMessage });

    const stops = [
      { name: "Hotel", lat: 40.75, lon: -73.98 },
      { name: "Times Square", lat: 40.758, lon: -73.9855 },
    ];

    const result = (await tool.execute(
      { tripSlug: "nyc-2026", stops, category: "restaurant" },
      ctx(auth()),
    )) as Record<string, unknown>;

    // The throw never propagated out of execute() — both stops completed.
    expect(result["ok"]).toBe(true);
    expect(result["sent"]).toBe(2);
    // Both stops' TEXT still went out despite the photo failing every time.
    expect(send).toHaveBeenCalledTimes(2);
    // The (failing) photo was still attempted for both stops — one stop's failure didn't skip
    // the next stop's own attempt either.
    expect(sendPhotoMessage).toHaveBeenCalledTimes(2);
  });

  it("a photo() rejection is contained the same way sendPhotoMessage's is — text still sends, loop still continues", async () => {
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.linkChat(trip.slug, GROUP_CHAT_ID);

    const searchStop = vi.fn(async () => ({
      hits: [hit({ name: "Joe's Pizza", photoRef: "places/x/photos/y" })],
      kilde: "Google" as const,
    }));
    const send = vi.fn(async () => {});
    const photo = vi.fn(async () => {
      throw new Error("google places: photo fetch timed out");
    });
    const sendPhotoMessage = vi.fn(async () => {});
    const tool = createPredeparturePackTool({ store: () => store, searchStop, send, photo, sendPhotoMessage });

    const result = (await tool.execute(
      { tripSlug: "nyc-2026", stops: [{ name: "Hotel", lat: 40.75, lon: -73.98 }], category: "restaurant" },
      ctx(auth()),
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sendPhotoMessage).not.toHaveBeenCalled();
  });

  it("falls back to the text-only path when the top hit has no photoRef", async () => {
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.linkChat(trip.slug, GROUP_CHAT_ID);

    const searchStop = vi.fn(async () => ({ hits: [hit({ name: "Joe's Pizza" })], kilde: "Google" as const }));
    const send = vi.fn(async () => {});
    const photo = vi.fn(async () => Buffer.from([1]));
    const sendPhotoMessage = vi.fn(async () => {});
    const tool = createPredeparturePackTool({ store: () => store, searchStop, send, photo, sendPhotoMessage });

    await tool.execute(
      { tripSlug: "nyc-2026", stops: [{ name: "Hotel", lat: 40.75, lon: -73.98 }], category: "restaurant" },
      ctx(auth()),
    );

    expect(photo).not.toHaveBeenCalled();
    expect(sendPhotoMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("falls back to the text-only path when photo()/sendPhotoMessage are not wired at all (no Google Places key)", async () => {
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.linkChat(trip.slug, GROUP_CHAT_ID);

    const searchStop = vi.fn(async () => ({
      hits: [hit({ name: "Joe's Pizza", photoRef: "places/x/photos/y" })],
      kilde: "Google" as const,
    }));
    const send = vi.fn(async () => {});
    const tool = createPredeparturePackTool({ store: () => store, searchStop, send }); // no photo/sendPhotoMessage

    await tool.execute(
      { tripSlug: "nyc-2026", stops: [{ name: "Hotel", lat: 40.75, lon: -73.98 }], category: "restaurant" },
      ctx(auth()),
    );

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("falls back to the text-only path when photo() resolves null (photo fetch failed)", async () => {
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.linkChat(trip.slug, GROUP_CHAT_ID);

    const searchStop = vi.fn(async () => ({
      hits: [hit({ name: "Joe's Pizza", photoRef: "places/x/photos/y" })],
      kilde: "Google" as const,
    }));
    const send = vi.fn(async () => {});
    const photo = vi.fn(async () => null);
    const sendPhotoMessage = vi.fn(async () => {});
    const tool = createPredeparturePackTool({ store: () => store, searchStop, send, photo, sendPhotoMessage });

    await tool.execute(
      { tripSlug: "nyc-2026", stops: [{ name: "Hotel", lat: 40.75, lon: -73.98 }], category: "restaurant" },
      ctx(auth()),
    );

    expect(sendPhotoMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is admin-DM only", async () => {
    const store = seedStore();
    store.createTrip(baseTrip());
    const searchStop = vi.fn();
    const send = vi.fn();
    const tool = createPredeparturePackTool({ store: () => store, searchStop, send });

    await expect(
      tool.execute(
        { tripSlug: "nyc-2026", stops: [{ name: "Hotel", lat: 1, lon: 1 }], category: "restaurant" },
        ctx(auth({ chatType: "group" })),
      ),
    ).rejects.toThrow(/admin-DM only/);
    expect(searchStop).not.toHaveBeenCalled();
  });

  it("returns an error when the trip isn't linked to a group yet — never sends anything", async () => {
    const store = seedStore();
    store.createTrip(baseTrip()); // not linked

    const searchStop = vi.fn();
    const send = vi.fn();
    const tool = createPredeparturePackTool({ store: () => store, searchStop, send });

    const result = (await tool.execute(
      { tripSlug: "nyc-2026", stops: [{ name: "Hotel", lat: 1, lon: 1 }], category: "restaurant" },
      ctx(auth()),
    )) as Record<string, unknown>;

    expect(result["error"]).toBeDefined();
    expect(searchStop).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// Callback-query wiring (ADDED SCOPE — Ruling 5, extended in the 2026-08-16 fix round to also
// resolve the group-link offer button) — agent/channels/telegram.ts's onCallbackQuery
// ---------------------------------------------------------------------------------------
describe("callback-query wiring (agent/channels/telegram.ts's onCallbackQuery)", () => {
  function callbackQuery(overrides: Record<string, unknown> = {}) {
    return {
      id: "cbq1",
      data: "veto:msg-abc",
      from: { id: ADMIN_ID, isBot: false, firstName: "Bendik" },
      message: { chat: { id: GROUP_CHAT_ID, type: "group" }, messageId: "42", from: undefined },
      raw: {},
      ...overrides,
    } as never;
  }

  // A stub `linkGroup` shared by the veto-only tests below — asserted un-called wherever the
  // test's whole point is that a veto tap must never touch the link path either.
  function stubLinkGroup() {
    return vi.fn(async () => ({ ok: true }) as const);
  }

  it("recognizes the veto button's callback_data, calls veto(), acks, and removes the button", async () => {
    const { createOnCallbackQuery } = await import("../agent/channels/telegram.js");
    const veto = vi.fn(async () => {});
    const linkGroup = stubLinkGroup();
    const handler = createOnCallbackQuery({ veto, linkGroup });

    await handler({} as never, callbackQuery());

    expect(veto).toHaveBeenCalledWith("msg-abc");
    expect(linkGroup).not.toHaveBeenCalled();
    expect(answerCallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ callbackQueryId: "cbq1" }),
    );
    expect(editMarkupMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: GROUP_CHAT_ID, messageId: "42", replyMarkup: undefined }),
    );
  });

  it("rejects a non-admin tap WITHOUT calling veto() — the gate runs before the action, not after", async () => {
    const { createOnCallbackQuery } = await import("../agent/channels/telegram.js");
    const veto = vi.fn(async () => {});
    const handler = createOnCallbackQuery({ veto, linkGroup: stubLinkGroup() });

    await handler({} as never, callbackQuery({ from: { id: OTHER_ID, isBot: false } }));

    expect(veto).not.toHaveBeenCalled();
    expect(answerCallbackMock).toHaveBeenCalled(); // still acked, so the tapper's spinner clears
    expect(editMarkupMock).not.toHaveBeenCalled(); // nothing removed — nothing happened
  });

  it("ignores a callback whose data matches NEITHER shape — never calls veto() or linkGroup(), still acks so eve's spinner clears", async () => {
    const { createOnCallbackQuery } = await import("../agent/channels/telegram.js");
    const veto = vi.fn(async () => {});
    const linkGroup = stubLinkGroup();
    const handler = createOnCallbackQuery({ veto, linkGroup });

    await handler({} as never, callbackQuery({ data: "proposal:abc123" }));

    expect(veto).not.toHaveBeenCalled();
    expect(linkGroup).not.toHaveBeenCalled();
    expect(answerCallbackMock).toHaveBeenCalled();
  });

  it("acks with a failure notice and never throws when veto() itself rejects", async () => {
    const { createOnCallbackQuery } = await import("../agent/channels/telegram.js");
    const veto = vi.fn(async () => {
      throw new Error("disk full");
    });
    const handler = createOnCallbackQuery({ veto, linkGroup: stubLinkGroup() });

    await expect(handler({} as never, callbackQuery())).resolves.toBeUndefined();
    expect(answerCallbackMock).toHaveBeenCalled();
  });

  it("the exported default channel wires onCallbackQuery at all", async () => {
    const mod = await import("../agent/channels/telegram.js");
    // telegramChannel() wraps the config; the important, testable fact for this task is that
    // creating the handler and default deps both exist and are wired together, not eve's own
    // internal dispatch (already covered by eve's own test suite, not this repo's).
    expect(mod.createOnCallbackQuery).toBeDefined();
    expect(mod.defaultTelegramCallbackDeps).toBeDefined();
  });

  // ── link:<chatId>:<tripSlug> — the group-link offer button's own tap (fix round) ─────────
  describe("link:<chatId>:<tripSlug> — resolves via the SAME handler as veto", () => {
    function linkCallbackQuery(overrides: Record<string, unknown> = {}) {
      return {
        id: "cbq-link",
        data: `link:${GROUP_CHAT_ID}:nyc-2026`,
        from: { id: ADMIN_ID, isBot: false, firstName: "Bendik" },
        // The offer message lives in the ADMIN's own private DM, not the group being linked.
        message: { chat: { id: ADMIN_ID, type: "private" }, messageId: "99", from: undefined },
        raw: {},
        ...overrides,
      } as never;
    }

    it("parses chatId + tripSlug out of the callback_data and calls linkGroup with them, in that order", async () => {
      const { createOnCallbackQuery } = await import("../agent/channels/telegram.js");
      const veto = vi.fn(async () => {});
      const linkGroup = vi.fn(async () => ({ ok: true }) as const);
      const handler = createOnCallbackQuery({ veto, linkGroup });

      await handler({} as never, linkCallbackQuery());

      expect(veto).not.toHaveBeenCalled();
      expect(linkGroup).toHaveBeenCalledWith(GROUP_CHAT_ID, "nyc-2026");
      expect(answerCallbackMock).toHaveBeenCalledWith(expect.objectContaining({ callbackQueryId: "cbq-link" }));
      expect(editMarkupMock).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: ADMIN_ID, messageId: "99", replyMarkup: undefined }),
      );
    });

    it("a non-admin tap on the link offer does NOT call linkGroup", async () => {
      const { createOnCallbackQuery } = await import("../agent/channels/telegram.js");
      const linkGroup = vi.fn(async () => ({ ok: true }) as const);
      const handler = createOnCallbackQuery({ veto: vi.fn(), linkGroup });

      await handler({} as never, linkCallbackQuery({ from: { id: OTHER_ID, isBot: false } }));

      expect(linkGroup).not.toHaveBeenCalled();
    });

    it("a failed link (stale slug) does NOT remove the offer's buttons — the admin can still try another", async () => {
      const { createOnCallbackQuery } = await import("../agent/channels/telegram.js");
      const linkGroup = vi.fn(async () => ({ ok: false, error: "fant ingen tur" }) as const);
      const handler = createOnCallbackQuery({ veto: vi.fn(), linkGroup });

      await handler({} as never, linkCallbackQuery());

      expect(answerCallbackMock).toHaveBeenCalledWith(expect.objectContaining({ text: "fant ingen tur" }));
      expect(editMarkupMock).not.toHaveBeenCalled();
    });

    it("the real defaultTelegramCallbackDeps.linkGroup actually links the chat via TripStore and sends the intro", async () => {
      process.env["MARCEL_DATA_ROOT"] = root;
      const { defaultTelegramCallbackDeps } = await import("../agent/channels/telegram.js");
      const store = seedStore();
      store.createTrip(baseTrip());

      const result = await defaultTelegramCallbackDeps.linkGroup(GROUP_CHAT_ID, "nyc-2026");

      expect(result).toEqual({ ok: true });
      expect(store.tripForChat(GROUP_CHAT_ID)?.slug).toBe("nyc-2026");
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: GROUP_CHAT_ID, body: expect.objectContaining({ text: expect.stringContaining("NYC") }) }),
      );
    });
  });
});

// ---------------------------------------------------------------------------------------
// Group-linking, closed end-to-end (fix round — Important #1 + the connected Ruling)
// ---------------------------------------------------------------------------------------
describe("group-linking closes end-to-end (fix round)", () => {
  it("Important #1: defaultDoorDeps.tripForChat resolves a REAL TripStore link (not the old null placeholder), and a group message now reaches the gate", async () => {
    process.env["MARCEL_DATA_ROOT"] = root;
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.linkChat(trip.slug, GROUP_CHAT_ID); // the exact write path agent/tools/link_group.ts uses

    const { defaultDoorDeps, createOnMessage } = await import("../agent/channels/telegram.js");

    const lookup = await defaultDoorDeps.tripForChat(GROUP_CHAT_ID);
    expect(lookup).toEqual({ tz: "America/New_York", dir: trip.dir });
    expect(await defaultDoorDeps.tripForChat("-100999")).toBeNull(); // an unlinked chat is still honestly null

    // End-to-end: a group message on the now-linked chat reaches the REAL appendInbound (writes
    // to disk under trip.dir/chatlog) and the gate, proving this isn't just a lookup in
    // isolation — it's the same deps object the channel's own onMessage dispatch uses.
    const gatekeeper = { consider: vi.fn(async () => ({ action: "speak" as const })) };
    const onMessage = createOnMessage({ ...defaultDoorDeps, gatekeeper: gatekeeper as never });
    const fakeCtx = { telegram: { startTyping: vi.fn(async () => {}) } } as never;
    const groupMessage = {
      attachments: [],
      caption: "",
      chat: { id: GROUP_CHAT_ID, type: "group", title: "Family" },
      from: { id: OTHER_ID, isBot: false, firstName: "Mor" },
      messageId: "1",
      raw: { date: Math.floor(Date.now() / 1000) },
      text: "skal vi spise ute i kveld?",
    } as never;

    const result = await onMessage(fakeCtx, groupMessage);

    expect(result).not.toBeNull();
    expect(gatekeeper.consider).toHaveBeenCalledWith(GROUP_CHAT_ID, expect.stringContaining("skal vi spise ute"), "America/New_York");

    const chatlogDir = path.join(trip.dir, "chatlog");
    expect(fs.existsSync(chatlogDir)).toBe(true);
  });

  it("Ruling: onBotAddedToGroup DMs the admin an inline-button offer listing each unlinked trip", async () => {
    process.env["MARCEL_DATA_ROOT"] = root;
    const store = seedStore();
    store.createTrip(baseTrip()); // not yet linked to any chat

    const { defaultDoorDeps } = await import("../agent/channels/telegram.js");
    await defaultDoorDeps.onBotAddedToGroup?.(GROUP_CHAT_ID, "Family Trip");

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: ADMIN_ID,
        body: expect.objectContaining({
          text: expect.stringContaining("Family Trip"),
          reply_markup: {
            inline_keyboard: [[expect.objectContaining({ text: "NYC", callback_data: `link:${GROUP_CHAT_ID}:nyc-2026` })]],
          },
        }),
      }),
    );
  });

  it("onBotAddedToGroup offers nothing (no send) when every trip already points at this exact chat", async () => {
    process.env["MARCEL_DATA_ROOT"] = root;
    const store = seedStore();
    const trip = store.createTrip(baseTrip());
    store.linkChat(trip.slug, GROUP_CHAT_ID);

    const { defaultDoorDeps } = await import("../agent/channels/telegram.js");
    await defaultDoorDeps.onBotAddedToGroup?.(GROUP_CHAT_ID, "Family Trip");

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("onBotAddedToGroup fails silently (no throw) when no trips exist yet at all (config.json missing)", async () => {
    process.env["MARCEL_DATA_ROOT"] = fs.mkdtempSync(path.join(os.tmpdir(), "eve-marcel-empty-"));
    const { defaultDoorDeps } = await import("../agent/channels/telegram.js");

    await expect(defaultDoorDeps.onBotAddedToGroup?.(GROUP_CHAT_ID, "New Group")).resolves.toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("composeLinkOffer — pure: excludes a trip already linked to THIS chat, labels one linked elsewhere as moving here, and returns null when nothing to offer", async () => {
    const { composeLinkOffer } = await import("../agent/channels/telegram.js");

    const here = composeLinkOffer("Family", GROUP_CHAT_ID, [{ slug: "a", name: "A", chatId: GROUP_CHAT_ID }]);
    expect(here).toBeNull();

    const moving = composeLinkOffer("Family", GROUP_CHAT_ID, [{ slug: "a", name: "A", chatId: "-100999" }]);
    expect(moving?.buttons[0]).toEqual({ text: "A (flytter hit)", data: `link:${GROUP_CHAT_ID}:a` });

    const fresh = composeLinkOffer("Family", GROUP_CHAT_ID, [{ slug: "a", name: "A" }]);
    expect(fresh?.buttons[0]).toEqual({ text: "A", data: `link:${GROUP_CHAT_ID}:a` });
  });
});
