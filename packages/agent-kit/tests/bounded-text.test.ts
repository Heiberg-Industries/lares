import { describe, it, expect } from "vitest";

import { boundText, DEFAULT_READ_LIMIT } from "../src/bounded-text.js";

describe("boundText", () => {
  it("defaults to 12,000 characters per read", () => {
    expect(DEFAULT_READ_LIMIT).toBe(12000);
  });

  it("returns short text whole with no note", () => {
    const r = boundText("hello", { limit: 100, offset: 0 });
    expect(r).toEqual({ text: "hello", truncated: false, totalChars: 5 });
  });

  it("cuts at the limit and tells the model how to continue", () => {
    const r = boundText("a".repeat(30), { limit: 10, offset: 0 });
    expect(r.text).toBe("a".repeat(10));
    expect(r.truncated).toBe(true);
    expect(r.totalChars).toBe(30);
    expect(r.nextOffset).toBe(10);
    expect(r.note).toContain("20");
    expect(r.note).toContain("offset=10");
  });

  it("pages by offset until the end", () => {
    const text = "abcdefghij".repeat(3);
    const a = boundText(text, { limit: 12, offset: 0 });
    const b = boundText(text, { limit: 12, offset: a.nextOffset! });
    const c = boundText(text, { limit: 12, offset: b.nextOffset! });
    expect(a.text + b.text + c.text).toBe(text);
    expect(c.truncated).toBe(false);
    expect(c.nextOffset).toBeUndefined();
  });

  it("returns empty text and a note when the offset is beyond the end", () => {
    const r = boundText("abc", { limit: 10, offset: 50 });
    expect(r.text).toBe("");
    expect(r.truncated).toBe(false);
    expect(r.totalChars).toBe(3);
    expect(r.note).toContain("3");
  });

  it("treats an offset exactly at the end as empty, not an error", () => {
    const r = boundText("abc", { limit: 10, offset: 3 });
    expect(r.text).toBe("");
    expect(r.truncated).toBe(false);
  });

  it("rejects a limit of zero or less", () => {
    expect(() => boundText("abc", { limit: 0, offset: 0 })).toThrow(RangeError);
    expect(() => boundText("abc", { limit: -5, offset: 0 })).toThrow(RangeError);
  });

  it("rejects a negative offset", () => {
    expect(() => boundText("abc", { limit: 10, offset: -1 })).toThrow(RangeError);
  });

  it("rejects non-integer or non-finite numbers", () => {
    expect(() => boundText("abc", { limit: 1.5, offset: 0 })).toThrow(RangeError);
    expect(() => boundText("abc", { limit: 10, offset: Number.NaN })).toThrow(RangeError);
    expect(() => boundText("abc", { limit: Infinity, offset: 0 })).toThrow(RangeError);
  });

  it("never splits a surrogate pair at the end of a page", () => {
    const text = "ab😀cd"; // the emoji is two UTF-16 units at index 2-3
    const r = boundText(text, { limit: 3, offset: 0 });
    expect(r.text).toBe("ab");
    expect(r.nextOffset).toBe(2);
    const next = boundText(text, { limit: 3, offset: r.nextOffset! });
    expect(next.text).toBe("😀c");
    for (const t of [r.text, next.text]) {
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(t)).toBe(false);
    }
  });

  it("never starts a page in the middle of a surrogate pair", () => {
    const r = boundText("ab😀cd", { limit: 10, offset: 3 });
    expect(r.text).toBe("😀cd");
  });

  it("still makes progress when the limit is smaller than one pair", () => {
    const r = boundText("😀😀", { limit: 1, offset: 0 });
    expect(r.text).toBe("😀");
    expect(r.nextOffset).toBe(2);
  });
});
