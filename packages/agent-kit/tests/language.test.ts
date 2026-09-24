import { describe, expect, it } from "vitest";
import { languageInstruction, LANGUAGE_STATE_KEY } from "../src/language.js";

describe("the language switch", () => {
  it("says nothing when neither the session nor the definition names a language", () => {
    expect(languageInstruction(null, undefined)).toBe("");
  });

  it("uses the definition's language when the conversation has not switched", () => {
    expect(languageInstruction(null, "no")).toMatch(/\bno\b/);
    expect(languageInstruction(null, "no")).not.toMatch(/for this conversation/);
  });

  it("the session's choice wins, and says it is only for this conversation", () => {
    const out = languageInstruction("en", "no");
    expect(out).toMatch(/\ben\b/);
    expect(out).toMatch(/this conversation/);
    expect(out).not.toMatch(/\bno\b/);
  });

  it("a session choice with no definition default still holds", () => {
    expect(languageInstruction("fr", undefined)).toMatch(/\bfr\b/);
  });

  it("keys session state under one stable name", () => {
    expect(LANGUAGE_STATE_KEY).toBe("lares.language");
  });
});
