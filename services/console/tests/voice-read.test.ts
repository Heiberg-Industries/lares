import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/db", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (/from voice_profile/i.test(sql)) return { rows: [{ id: "default", core: "C", english: "E", norsk: "N", model_en: "", model_no: "m", learn_key: "saga", learn_lookback_days: 365, learn_cap: 300, learn_status: "idle", learn_message: "", proposed: null }] };
      if (/from voice_exemplar/i.test(sql)) return { rows: [{ id: "a", lang: "no", text: "Hei, dette er et ganske langt eksempel på tekst.", included: true }] };
      return { rows: [] };
    }),
  },
}));

import { getVoiceCards, listVoiceExamples } from "../lib/voice";

describe("console voice reads", () => {
  it("maps the profile rows to VoiceCardDTOs, default first", async () => {
    const [c] = await getVoiceCards();
    expect(c).toMatchObject({ id: "default", core: "C", english: "E", norsk: "N", modelNo: "m", learnKey: "saga", lookbackDays: 365, learnStatus: "idle", proposed: null });
  });
  it("maps exemplars to snippets", async () => {
    const ex = await listVoiceExamples();
    expect(ex[0]).toMatchObject({ id: "a", lang: "no", included: true });
    expect(ex[0].snippet.length).toBeLessThanOrEqual(140);
  });
});
