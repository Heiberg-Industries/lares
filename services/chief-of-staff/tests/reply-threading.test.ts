import { describe, expect, it } from "vitest";
import { pickOriginal, replyHeaders, replySubject } from "../lib/reply-threading.js";

describe("reply threading helper", () => {
  it("adds one reply prefix and keeps an existing one", () => {
    expect(replySubject("Lunch")).toBe("Re: Lunch");
    for (const s of ["Re: x", "RE: x", "SV: x", "AW: x", "Antw: x", "VS: x", "re :x"]) expect(replySubject(s)).toBe(s);
  });
  it("builds References from the original's References plus its Message-ID, de-duplicated in order", () => {
    expect(replyHeaders({ messageId: "<b>", references: "<a>  <b>" })).toEqual({ inReplyTo: "<b>", references: "<a> <b>" });
    expect(replyHeaders({ messageId: "<a>" })).toEqual({ inReplyTo: "<a>", references: "<a>" });
    expect(replyHeaders({})).toEqual({});
  });
  it("picks the named message, else the newest from someone else", () => {
    const thread = [{ messageId: "<1>", from: "x@example.com" }, { messageId: "<2>", from: "Me <me@example.com>" }];
    expect(pickOriginal(thread, "<2>", ["me@example.com"])?.messageId).toBe("<2>");
    expect(pickOriginal(thread, "<9>", [])).toBeUndefined();
    expect(pickOriginal(thread, undefined, ["me@example.com"])?.messageId).toBe("<1>");
    expect(pickOriginal(thread.slice(1), undefined, ["me@example.com"])?.messageId).toBe("<2>");
  });
});
