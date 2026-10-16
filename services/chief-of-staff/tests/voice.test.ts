import { describe, it, expect } from "vitest";
import { detectLanguage, buildVoiceBlock, pickModel, pickCard, type VoiceProfile } from "../lib/voice.js";

//: one card per mailbox. The singleton card was learned mostly from project.example sales mail
// and applied to owner.example mail to a journalist. `pickCard` is the pure seam: the mailbox's own
// row wins when it says anything at all; an empty row falls back to `default`; nothing → null.
describe("pickCard — the mailbox's own card wins, default is the fallback", () => {
  const def = { id: "default", core: "warm, short", notes_en: "Hey", notes_no: "Hei" };
  const ownerMailbox = { id: "owner@owner.example", core: "measured, no exclamation marks", notes_en: "", notes_no: "Hei," };

  it("returns the mailbox row when any of its three fields is non-empty", () => {
    expect(pickCard([def, ownerMailbox], "owner@owner.example")).toEqual({ core: ownerMailbox.core, notesEn: "", notesNo: "Hei," });
  });

  it("falls back to default when the mailbox row is empty or absent", () => {
    const empty = { id: "owner@project.example", core: "  ", notes_en: "", notes_no: "" };
    expect(pickCard([def, empty], "owner@project.example")).toEqual({ core: def.core, notesEn: def.notes_en, notesNo: def.notes_no });
    expect(pickCard([def], "owner@project.example")).toEqual({ core: def.core, notesEn: def.notes_en, notesNo: def.notes_no });
  });

  it("returns null when there is no card at all", () => {
    expect(pickCard([], "owner@owner.example")).toBeNull();
    expect(pickCard([{ id: "default", core: "", notes_en: "", notes_no: "" }], "owner@owner.example")).toBeNull();
  });

  it("never lets another mailbox's card leak in", () => {
    const otherMailbox = { id: "owner@project.example", core: "exclamation marks liberally", notes_en: "", notes_no: "" };
    expect(pickCard([otherMailbox], "owner@owner.example")).toBeNull();
  });
});

const profile: VoiceProfile = {
  core: "Warm, brief, lead with the point.",
  notesEn: 'Sign off "Best, Test Owner".',
  notesNo: 'Mer direkte. Avslutt "Beste hilsen, Test Owner".',
  modelEn: null,
  modelNo: "borealis-no",
};

describe("detectLanguage", () => {
  it("detects Norwegian via distinctive letters + common words", () => {
    expect(detectLanguage("Hei, takk for sist. Jeg gleder meg til å høre fra deg.")).toBe("no");
  });
  it("detects English", () => {
    expect(detectLanguage("Hi there, thanks for the note — happy to help with this.")).toBe("en");
  });
  it("defaults to English on empty input", () => {
    expect(detectLanguage("")).toBe("en");
  });
  it("does not misclassify English containing 'for' as Norwegian", () => {
    expect(detectLanguage("Thanks for the note — this is great for us and the team.")).toBe("en");
  });
});

describe("buildVoiceBlock", () => {
  it("returns '' when profile is null", () => {
    expect(buildVoiceBlock(null, "en")).toBe("");
  });
  it("includes core + the English section for en", () => {
    const b = buildVoiceBlock(profile, "en");
    expect(b).toContain("lead with the point");
    expect(b).toContain("Best, Test Owner");
    expect(b).not.toContain("Beste hilsen");
  });
  it("includes core + the Norsk section for no", () => {
    const b = buildVoiceBlock(profile, "no");
    expect(b).toContain("Beste hilsen");
    expect(b).not.toMatch(/Best, [A-Z]/);
  });
  it("returns '' when card text is all empty", () => {
    expect(buildVoiceBlock({ core: "", notesEn: "", notesNo: "", modelEn: null, modelNo: null }, "en")).toBe("");
  });
});

describe("pickModel", () => {
  it("uses model_no for Norwegian", () => {
    expect(pickModel(profile, "no", "default-model")).toBe("borealis-no");
  });
  it("falls back when the language model is blank", () => {
    expect(pickModel(profile, "en", "default-model")).toBe("default-model");
  });
  it("falls back when profile is null", () => {
    expect(pickModel(null, "no", "default-model")).toBe("default-model");
  });
});
