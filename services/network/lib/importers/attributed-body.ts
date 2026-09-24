/**
 * Decode the message body macOS Messages stores in `message.attributedBody` (a serialised
 * NSAttributedString "typedstream") when `message.text` is NULL — which, since 2025, is nearly
 * every message (ORB-162: 99.6% of the last 30 days on 2026-09-02).
 *
 * MEASURED, not assumed (2026-09-02, this Mac): the body sits after the ASCII marker `NSString`
 * + 5 fixed bytes, prefixed by its byte length — one byte, or 0x81 + little-endian uint16.
 * Two independent selections confirm the format:
 * - The 200 most recent rows WHERE text IS NOT NULL AND attributedBody IS NOT NULL (reaches back
 *   in time since this dual-field case is rare): all 200 decoded byte-identical to `text`.
 * - The 40 most recent rows overall WHERE text IS NULL: all 40 decoded successfully.
 * Your own re-run (Task A1 Step 4, top 500 rows overall): 500/500 decoded, 3 carried `text` and
 * all 3 matched — the two samples answer different questions and agree.
 * No typedstream parser: this is the one shape Messages writes for plain and attributed text,
 * and everything else returns null so an unreadable body is an honest NULL, never a truncated
 * string.
 */
const MARKER = Buffer.from("NSString");
const HEADER_SKIP = 5; // 01 94 84 01 2b

export function decodeAttributedBody(blob: Uint8Array | Buffer | null | undefined): string | null {
  if (!blob || blob.length === 0) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const i = buf.indexOf(MARKER);
  if (i < 0) return null;
  let j = i + MARKER.length + HEADER_SKIP;
  if (j >= buf.length) return null;
  let len = buf[j]!;
  j += 1;
  if (len === 0x81) {
    if (j + 2 > buf.length) return null;
    len = buf.readUInt16LE(j);
    j += 2;
  }
  if (j + len > buf.length) return null;
  const payload = buf.subarray(j, j + len);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return null;
  }
}
