/**
 * Thin client for the shared `@lares/readability` worker.
 *
 * POST `{baseUrl}/extract`, header `x-readability-token`, body `{url}`. `read_url` is an
 * engine-core capability, so this one client is its single home.
 *
 * Failures are told apart rather than collapsed into `null`: `ReadabilityUnavailableError`
 * (transport/HTTP/parse failure) is distinct from
 * `ReadabilityNoContentError` (a 200 with no usable article text), so a caller can tell
 * "the worker is down" from "that page just isn't an article".
 */
import { readFileSync } from "node:fs";
import { toolOutput, toolOutputPart } from "eve/tools";

import { boundText, DEFAULT_READ_LIMIT } from "./bounded-text.js";

export class ReadabilityUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ReadabilityUnavailableError";
  }
}

export class ReadabilityNoContentError extends Error {
  constructor(readonly url: string) {
    super(`Readability: no usable article text for ${url}`);
    this.name = "ReadabilityNoContentError";
  }
}

/**
 * The worker is up and answered, but could not fetch or read THAT link — the target refused,
 * timed out, was too large, or is a format it can't read. Before this, every such
 * answer was a `ReadabilityUnavailableError`, and the chief of staff told the owner "the reader is down" while the
 * worker was healthy. The worker marks these with status 400 or 502 plus a JSON
 * `{ error }` body; anything else stays "unavailable".
 */
export class ReadabilityTargetError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`The reader is working, but could not read ${url}: ${reason}`);
    this.name = "ReadabilityTargetError";
  }
}

/** An image the worker fetched from an image link, ready to hand to a vision model. */
export interface ReadImage {
  mediaType: string;
  base64: string;
}

/**
 * `toModelOutput` for a read_url tool: an image link reaches the model as the picture
 * itself, through eve's content parts (eve docs, tools/overview.mdx "Send images to the model").
 * Before this, the chief of staff answered an image link with "I have no vision capability" — false, because
 * attached photos reach it. Anything else goes to the model as the JSON it always did.
 */
export function readUrlModelOutput(output: { title: string; text: string; image?: ReadImage }) {
  if (!output.image) return toolOutput.json(output as never);
  return toolOutput.content([
    toolOutputPart.text(`Image from the link (${output.title}, ${output.image.mediaType}) — look at it:`),
    toolOutputPart.file(output.image.base64, { mediaType: output.image.mediaType }),
  ]);
}

/**
 * One page of a read_url result. The model reads `DEFAULT_READ_LIMIT` characters at a time;
 * `offset` is where this page starts (pass the previous page's `nextOffset`). A short page
 * from the start comes back exactly as it was read. An image is left alone. When the reader
 * itself cut the document (`sourceCut`), a plain `sourceNote` says so, separately from the
 * paging note: that part cannot be fetched with a bigger offset.
 */
export function pageReadUrlResult<T extends { text: string; image?: unknown; sourceCut?: { totalChars: number } }>(
  result: T,
  offset = 0,
) {
  if (result.image) return result;
  const { sourceCut, ...rest } = result;
  const page = boundText(result.text, { limit: DEFAULT_READ_LIMIT, offset });
  return {
    ...rest,
    text: page.text,
    ...(page.truncated || page.note !== undefined || offset > 0 ? { totalChars: page.totalChars } : {}),
    ...(page.truncated ? { truncated: true, nextOffset: page.nextOffset } : {}),
    ...(page.note !== undefined ? { pagingNote: page.note } : {}),
    ...(sourceCut
      ? {
          sourceNote: `The reader stopped at ${result.text.length.toLocaleString("en-US")} of ${sourceCut.totalChars.toLocaleString("en-US")} characters of this document; the rest cannot be read through this tool.`,
        }
      : {}),
  };
}

// Below this many characters of extracted text, the page is treated as
// unreadable (paywall stub, listing page, …) rather than a real article.
const MIN_ARTICLE_CHARS = 300;

const DEFAULT_TOKEN_FILE = "/run/secrets/readability-token";

/** Read on every call, never at module scope — `eve build` has no secrets. */
function readToken(): string {
  const path = process.env["READABILITY_TOKEN_FILE"] ?? DEFAULT_TOKEN_FILE;
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new ReadabilityUnavailableError(`readability token not readable: ${path}`);
  }
  if (value.length === 0) throw new ReadabilityUnavailableError(`readability token file is empty: ${path}`);
  return value;
}

function extractUrl(): string {
  const base = process.env["READABILITY_URL"];
  if (!base) throw new ReadabilityUnavailableError("READABILITY_URL is not set");
  return `${base.replace(/\/+$/, "")}/extract`;
}

/**
 * Read the readable text of a web page. Throws `ReadabilityUnavailableError` on any
 * transport/HTTP/parse failure, `ReadabilityNoContentError` when the page yields too
 * little text to be a usable article (paywall, non-article page).
 */
export async function readUrl(url: string): Promise<{
  title: string;
  text: string;
  image?: ReadImage;
  /** Set when the reader cut the document at its own size limit; carries the full length. */
  sourceCut?: { totalChars: number };
}> {
  const token = readToken();
  let res: Response;
  try {
    res = await fetch(extractUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-readability-token": token },
      body: JSON.stringify({ url }),
    });
  } catch (err) {
    throw new ReadabilityUnavailableError(
      `readability extract — network error: ${(err as Error).message}`,
      err,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // The worker's own verdict on the target: it is up, the link is the problem.
    if (res.status === 400 || res.status === 502) {
      let reason: unknown;
      try {
        reason = (JSON.parse(text) as { error?: unknown }).error;
      } catch {
        reason = undefined;
      }
      if (typeof reason === "string" && reason !== "") throw new ReadabilityTargetError(url, reason);
    }
    throw new ReadabilityUnavailableError(`readability extract → ${res.status} ${text.slice(0, 160)}`);
  }
  let data: { title?: string; text?: string; image?: ReadImage; truncated?: unknown; totalChars?: unknown };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    throw new ReadabilityUnavailableError("readability extract — malformed JSON response", err);
  }
  if (data.image && typeof data.image.base64 === "string" && typeof data.image.mediaType === "string") {
    return { title: data.title ?? "Image", text: data.text ?? "", image: data.image };
  }
  if (!data.text || data.text.length < MIN_ARTICLE_CHARS) throw new ReadabilityNoContentError(url);
  // Older readers never send these two fields; a cut is reported only when both are sane.
  const sourceCut =
    data.truncated === true && typeof data.totalChars === "number" && data.totalChars > data.text.length
      ? { sourceCut: { totalChars: data.totalChars } }
      : {};
  return { title: data.title ?? "Untitled", text: data.text, ...sourceCut };
}
