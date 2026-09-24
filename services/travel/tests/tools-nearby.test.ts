// Tests for agent/tools/nearby_places.ts's Task 11 addition: an optional {lat, lon} override
// that falls back to the calling chat's live-location (lib/live-location.ts) when omitted.
// Discovery itself is stubbed via NearbyPlacesDeps (Task 6's own seam) — these tests only
// prove the point-resolution logic this task added, not lib/discovery.ts's own search
// behaviour (covered elsewhere).
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createNearbyPlacesTool,
  NoLocationAvailableError,
  type NearbyPlacesDeps,
} from "../catalogue/nearby_places.js";
import { setLiveLocation, __resetLiveLocationStoreForTest } from "../lib/live-location.js";
import type { Discovery } from "../lib/discovery.js";

const CHAT_ID = "123";

function ctxFor(chatId: string | undefined) {
  const auth = chatId
    ? { attributes: { chat_id: chatId }, authenticator: "telegram-webhook", principalId: "x", principalType: "user" }
    : null;
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

function stubDeps(): { deps: NearbyPlacesDeps; search: ReturnType<typeof vi.fn> } {
  const search = vi.fn(async () => ({ hits: [], kilde: "Google" as const }));
  const discovery = { search } as unknown as Discovery;
  return { deps: { discovery: () => discovery }, search };
}

beforeEach(() => {
  __resetLiveLocationStoreForTest();
});

describe("nearby_places — {lat, lon} resolution (Task 11)", () => {
  it("uses the explicit lat/lon when given, ignoring any live location on file", async () => {
    setLiveLocation(CHAT_ID, 0, 0, 900); // stale/irrelevant — should be ignored entirely
    const { deps, search } = stubDeps();
    const tool = createNearbyPlacesTool(deps);

    await tool.execute({ category: "restaurant", lat: 43.296, lon: 5.37, radiusM: 1500 }, ctxFor(CHAT_ID));

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ point: { lat: 43.296, lon: 5.37 } }),
    );
  });

  it("falls back to the chat's live location when lat/lon are omitted", async () => {
    setLiveLocation(CHAT_ID, 48.8566, 2.3522, 900);
    const { deps, search } = stubDeps();
    const tool = createNearbyPlacesTool(deps);

    await tool.execute({ category: "cafe", radiusM: 1500 }, ctxFor(CHAT_ID));

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ point: { lat: 48.8566, lon: 2.3522 } }),
    );
  });

  it("prefers an explicit lat/lon over a stale-but-still-valid live location — explicit always wins", async () => {
    setLiveLocation(CHAT_ID, 48.8566, 2.3522, 900); // still valid, but explicit input must win
    const { deps, search } = stubDeps();
    const tool = createNearbyPlacesTool(deps);

    await tool.execute({ category: "bakery", lat: 45.764, lon: 4.8357, radiusM: 1500 }, ctxFor(CHAT_ID));

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ point: { lat: 45.764, lon: 4.8357 } }));
  });

  it("throws NoLocationAvailableError when lat/lon are omitted and no live location is on file", async () => {
    const { deps, search } = stubDeps();
    const tool = createNearbyPlacesTool(deps);

    await expect(tool.execute({ category: "restaurant", radiusM: 1500 }, ctxFor(CHAT_ID))).rejects.toThrow(
      NoLocationAvailableError,
    );
    expect(search).not.toHaveBeenCalled();
  });

  it("throws NoLocationAvailableError when lat/lon are omitted and there is no chat id in the auth context at all", async () => {
    const { deps, search } = stubDeps();
    const tool = createNearbyPlacesTool(deps);

    await expect(tool.execute({ category: "restaurant", radiusM: 1500 }, ctxFor(undefined))).rejects.toThrow(
      NoLocationAvailableError,
    );
    expect(search).not.toHaveBeenCalled();
  });
});

describe("nearby_places — inputSchema (Task 11)", () => {
  it("rejects a partial override — lat given without lon — at the schema level, before execute() ever runs", async () => {
    const mod = await import("../catalogue/nearby_places.js");
    const schema = (mod.createNearbyPlacesTool(stubDeps().deps) as unknown as { inputSchema: { safeParse(v: unknown): { success: boolean } } })
      .inputSchema;
    const result = schema.safeParse({ category: "restaurant", lat: 43.296, radiusM: 1500 });
    expect(result.success).toBe(false);
  });

  it("accepts lat/lon both omitted", async () => {
    const mod = await import("../catalogue/nearby_places.js");
    const schema = (mod.createNearbyPlacesTool(stubDeps().deps) as unknown as { inputSchema: { safeParse(v: unknown): { success: boolean } } })
      .inputSchema;
    const result = schema.safeParse({ category: "restaurant", radiusM: 1500 });
    expect(result.success).toBe(true);
  });

  it("accepts lat/lon both given", async () => {
    const mod = await import("../catalogue/nearby_places.js");
    const schema = (mod.createNearbyPlacesTool(stubDeps().deps) as unknown as { inputSchema: { safeParse(v: unknown): { success: boolean } } })
      .inputSchema;
    const result = schema.safeParse({ category: "restaurant", lat: 1, lon: 2, radiusM: 1500 });
    expect(result.success).toBe(true);
  });
});
