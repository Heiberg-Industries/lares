import { describe, it, expect } from "vitest";
import { decodeAttributedBody } from "../lib/importers/attributed-body.js";

const MARK = Buffer.from("NSString");
const SKIP = Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]);
function blobFor(text: string, opts: { twoByte?: boolean } = {}): Buffer {
  const body = Buffer.from(text, "utf8");
  const len = opts.twoByte || body.length >= 0x80
    ? Buffer.from([0x81, body.length & 0xff, (body.length >> 8) & 0xff])
    : Buffer.from([body.length]);
  return Buffer.concat([Buffer.from("streamtyped\x00\x84\x01"), MARK, SKIP, len, body, Buffer.from("\x86\x84\x02iI\x01\x0b")]);
}

describe("decodeAttributedBody", () => {
  it("decodes a short message (1-byte length)", () => {
    expect(decodeAttributedBody(blobFor("hei hei"))).toBe("hei hei");
  });
  it("decodes multibyte UTF-8 with a byte length, not a character length", () => {
    expect(decodeAttributedBody(blobFor("Ærlig talt — på vei 🚂"))).toBe("Ærlig talt — på vei 🚂");
  });
  it("decodes a long message (0x81 + uint16 length)", () => {
    const long = "x".repeat(300) + " slutt";
    expect(decodeAttributedBody(blobFor(long, { twoByte: true }))).toBe(long);
  });
  it("returns null for null, empty, and blobs without the marker", () => {
    expect(decodeAttributedBody(null)).toBeNull();
    expect(decodeAttributedBody(Buffer.alloc(0))).toBeNull();
    expect(decodeAttributedBody(Buffer.from("bplist00 not a typedstream"))).toBeNull();
  });
  it("returns null, never a partial string, when the length runs past the blob", () => {
    const b = blobFor("hello");
    expect(decodeAttributedBody(b.subarray(0, b.length - 12))).toBeNull();
  });
  it("returns null on invalid UTF-8 in the payload", () => {
    const bad = Buffer.concat([MARK, SKIP, Buffer.from([2]), Buffer.from([0xff, 0xfe])]);
    expect(decodeAttributedBody(bad)).toBeNull();
  });
});
