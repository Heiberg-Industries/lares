import { describe, it, expect, vi } from "vitest";

// lib/voice imports lib/db at module load — mock it so the pure helper under test loads hermetically.
vi.mock("../lib/db", () => ({ pool: {} }));

import { orderVoiceCards, type VoiceCardRow } from "../lib/voice";

/**
 * ORB-176 — the console shows one voice card per mailbox (sql/033), with `default` first as the
 * shared fallback and the mailboxes after it in a stable order. Rows come straight from
 * voice_profile; the helper is the only place the ordering and the DTO shape are decided.
 */
const row = (over: Partial<VoiceCardRow>): VoiceCardRow => ({
  id: "default", core: "", english: "", norsk: "", model_en: null, model_no: null,
  learn_key: "saga", learn_lookback_days: 365, learn_cap: 300, learn_status: "idle", learn_message: "", proposed: null,
  ...over,
});

describe("orderVoiceCards — default first, then each mailbox, stably", () => {
  it("puts default first and mailboxes alphabetically after it", () => {
    const out = orderVoiceCards([row({ id: "owner@project.example" }), row({ id: "default", core: "warm" }), row({ id: "owner@owner.example" })]);
    expect(out.map((c) => c.id)).toEqual(["default", "owner@owner.example", "owner@project.example"]);
  });

  it("maps NULL model fields to empty strings and keeps the proposal", () => {
    const proposed = { core: "c", english: "e", norsk: "n", learnedAt: "2026-09-08T02:00:00.000Z", sampleSize: 3 };
    const [d] = orderVoiceCards([row({ id: "default", model_en: null, model_no: "heiberg-writer", proposed })]);
    expect(d).toMatchObject({ id: "default", modelEn: "", modelNo: "heiberg-writer", proposed });
  });

  it("synthesises an empty default when the table has none, so the page always has a shared card to edit", () => {
    const out = orderVoiceCards([row({ id: "owner@owner.example", core: "x" })]);
    expect(out[0]).toMatchObject({ id: "default", core: "", learnStatus: "idle" });
    expect(out).toHaveLength(2);
  });
});
