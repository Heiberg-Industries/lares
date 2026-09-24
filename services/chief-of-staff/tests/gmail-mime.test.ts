import { describe, it, expect } from "vitest";

import { buildMimeEnvelope, parseAddressHeader } from "../lib/google.js";

// 2026-09-08: reply drafts go to everyone on the original, so the envelope must carry Cc and the
// parser must read it. `parseAddressHeader` is the one place a header becomes a list.
describe("buildMimeEnvelope — Cc", () => {
  const base = { from: "owner@owner.example", to: ["a@x.no", "Kjetil <k@x.no>"], subject: "Re: x", bodyText: "Hei" };

  it("writes a Cc header when given, after To", () => {
    const raw = buildMimeEnvelope({ ...base, cc: ["eli@x.no", "Ola <o@x.no>"] });
    const headers = raw.split("\r\n\r\n")[0]!;
    expect(headers).toContain("To: a@x.no, Kjetil <k@x.no>");
    expect(headers).toContain("Cc: eli@x.no, Ola <o@x.no>");
    expect(headers.indexOf("To:")).toBeLessThan(headers.indexOf("Cc:"));
  });

  it("writes no Cc header at all when there is nobody to copy", () => {
    expect(buildMimeEnvelope(base)).not.toMatch(/^Cc:/m);
    expect(buildMimeEnvelope({ ...base, cc: [] })).not.toMatch(/^Cc:/m);
  });
});

// Fix-round-2 review, item 2a (Critical, controller ruling): encodeSubject's ASCII_ONLY check
// passes CR/LF through unchanged (both are within \x00-\x7F), so a caller-supplied subject
// like "Hi\r\nBcc: stranger@evil.example" would write a second, unapproved header straight
// into the raw message — reaching a recipient no approval ever considered, once Task 5 wires
// board-approval to gmail_send. buildMimeEnvelope must refuse to build ANY message whose
// header-bound fields (from, to entries, cc entries, subject, messageId, inReplyTo,
// references, boundarySeed) carry a raw CR or LF, before writing a single header.
describe("buildMimeEnvelope — refuses header injection (fix round 2, item 2a)", () => {
  const base = { from: "owner@example.com", to: ["a@example.com"], subject: "Re: x", bodyText: "Hi" };

  it("throws when subject carries a CR/LF header-injection attempt", () => {
    expect(() => buildMimeEnvelope({ ...base, subject: "Hi\r\nBcc: stranger@evil.example" })).toThrow();
  });
  it("throws when from carries CR/LF", () => {
    expect(() => buildMimeEnvelope({ ...base, from: "owner@example.com\r\nBcc: stranger@evil.example" })).toThrow();
  });
  it("throws when a to entry carries CR/LF", () => {
    expect(() => buildMimeEnvelope({ ...base, to: ["a@example.com\r\nBcc: stranger@evil.example"] })).toThrow();
  });
  it("throws when a cc entry carries CR/LF", () => {
    expect(() => buildMimeEnvelope({ ...base, cc: ["a@example.com\r\nBcc: stranger@evil.example"] })).toThrow();
  });
  it("throws when inReplyTo carries CR/LF", () => {
    expect(() => buildMimeEnvelope({ ...base, inReplyTo: "<id>\r\nBcc: stranger@evil.example" })).toThrow();
  });
  it("throws when references carries CR/LF", () => {
    expect(() => buildMimeEnvelope({ ...base, references: "<id>\r\nBcc: stranger@evil.example" })).toThrow();
  });
  it("throws when a bare LF (no CR) is present, not only CRLF", () => {
    expect(() => buildMimeEnvelope({ ...base, subject: "Hi\nBcc: stranger@evil.example" })).toThrow();
  });
  it("does NOT throw on a legitimate multi-line bodyText or signatureText — only header fields are checked", () => {
    expect(() => buildMimeEnvelope({ ...base, bodyText: "line1\r\nline2\nline3", signatureText: "Best,\r\nOwner" })).not.toThrow();
  });
  it("a legitimate call still builds the byte-identical envelope as before (no regression)", () => {
    const raw = buildMimeEnvelope({ ...base, cc: ["eli@example.com", "Ola <o@example.com>"] });
    const headers = raw.split("\r\n\r\n")[0]!;
    expect(headers).toContain("To: a@example.com");
    expect(headers).toContain("Cc: eli@example.com, Ola <o@example.com>");
    expect(headers.indexOf("To:")).toBeLessThan(headers.indexOf("Cc:"));
  });
});

describe("parseAddressHeader — a comma-separated header into addresses", () => {
  it("splits on commas outside quotes and trims", () => {
    expect(parseAddressHeader('"Tufte, Kjetil" <k@x.no>, eli@x.no ,  Ola <o@x.no>'))
      .toEqual(['"Tufte, Kjetil" <k@x.no>', "eli@x.no", "Ola <o@x.no>"]);
  });
  it("an empty or missing header is an empty list", () => {
    expect(parseAddressHeader("")).toEqual([]);
    expect(parseAddressHeader("   ")).toEqual([]);
  });
});
