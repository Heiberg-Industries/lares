/**
 * Bound a long text to one page the model can read, with a note telling it how to fetch the
 * next page. Offsets and limits count characters as JavaScript strings do (UTF-16 code units);
 * a page never starts or ends in the middle of a surrogate pair, so emoji and other
 * multi-unit characters stay whole.
 */

/** The default size of one read, in characters. */
export const DEFAULT_READ_LIMIT = 12000;

export interface BoundTextOptions {
  /** Most characters to return. A positive integer. */
  limit: number;
  /** Where to start reading. A non-negative integer. */
  offset: number;
}

export interface BoundedText {
  text: string;
  /** True when more text follows this page. */
  truncated: boolean;
  /** Length of the whole text, in the same units as limit and offset. */
  totalChars: number;
  /** Set only when truncated: the offset to pass to read the next page. */
  nextOffset?: number;
  /** Set when the model needs guidance: more to read, or an offset past the end. */
  note?: string;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

export function boundText(text: string, { limit, offset }: BoundTextOptions): BoundedText {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`offset must be a non-negative integer, got ${offset}`);
  }

  const totalChars = text.length;
  if (offset >= totalChars) {
    return {
      text: "",
      truncated: false,
      totalChars,
      ...(offset > totalChars
        ? { note: `Offset ${offset} is past the end; the text is ${totalChars} characters long.` }
        : {}),
    };
  }

  // Start on a whole character: step back if the offset lands inside a pair.
  let start = offset;
  if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start -= 1;
  }

  let end = Math.min(start + limit, totalChars);
  if (end < totalChars && isHighSurrogate(text.charCodeAt(end - 1))) {
    // The cut would leave half a pair: drop it, unless that leaves nothing (a limit of 1).
    end = end - 1 > start ? end - 1 : Math.min(end + 1, totalChars);
  }

  const page = text.slice(start, end);
  if (end >= totalChars) return { text: page, truncated: false, totalChars };

  const remaining = totalChars - end;
  return {
    text: page,
    truncated: true,
    totalChars,
    nextOffset: end,
    note: `Showing characters ${start}-${end} of ${totalChars}; ${remaining} characters remain. Call again with offset=${end} to continue.`,
  };
}
