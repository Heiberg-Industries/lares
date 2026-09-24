/**
 * PROMOTED into @lares/agent-kit 2026-09-01 (ORB-160): eve-saga and eve-marcel carried two
 * byte-identical copies of this file, and the engine/overlay inventory names `read_url` an
 * engine-core capability — one client, one home. History: the copies came from the ORB-142
 * era, before the kit existed as the shared layer. Original header follows.
 */
/**
 * Thin client for the shared `@lares/readability` worker.
 *
 * Ported from `services/agent-runtime/lib/adapters/digest/enrich.ts`'s
 * `makeReadabilityClient`: POST `{baseUrl}/extract`, header `x-readability-token`, body
 * `{url}`.
 *
 * Deliberate behavior change from the old client (ORB-51, same note as
 * `lib/orakel-client.ts`): the old client returned `null` on every failure — network error,
 * non-2xx, or an article too short to be useful. This wave distinguishes
 * `ReadabilityUnavailableError` (transport/HTTP/parse failure) from
 * `ReadabilityNoContentError` (a 200 with no usable article text), so a caller can tell
 * "the worker is down" from "that page just isn't an article".
 */
import { readFileSync } from "node:fs";
import { toolOutput, toolOutputPart } from "eve/tools";

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
 * timed out, was too large, or is a format it can't read (ORB-289). Before this, every such
 * answer was a `ReadabilityUnavailableError`, and Saga told Bendik "the reader is down" while the
 * worker was healthy (2026-09-14). The worker marks these with status 400 or 502 plus a JSON
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
 * `toModelOutput` for a read_url tool (ORB-286): an image link reaches the model as the picture
 * itself, through eve's content parts (eve docs, tools/overview.mdx "Send images to the model").
 * Before this, Saga answered an image link with "I have no vision capability" — false, because
 * attached photos reach her. Anything else goes to the model as the JSON it always did.
 */
export function readUrlModelOutput(output: { title: string; text: string; image?: ReadImage }) {
  if (!output.image) return toolOutput.json(output as never);
  return toolOutput.content([
    toolOutputPart.text(`Image from the link (${output.title}, ${output.image.mediaType}) — look at it:`),
    toolOutputPart.file(output.image.base64, { mediaType: output.image.mediaType }),
  ]);
}

// Below this many characters of extracted text, the old client treated the page as
// unreadable (paywall stub, listing page, …) rather than a real article. Ported verbatim.
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
export async function readUrl(url: string): Promise<{ title: string; text: string; image?: ReadImage }> {
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
  let data: { title?: string; text?: string; image?: ReadImage };
  try {
    data = (await res.json()) as { title?: string; text?: string; image?: ReadImage };
  } catch (err) {
    throw new ReadabilityUnavailableError("readability extract — malformed JSON response", err);
  }
  if (data.image && typeof data.image.base64 === "string" && typeof data.image.mediaType === "string") {
    return { title: data.title ?? "Image", text: data.text ?? "", image: data.image };
  }
  if (!data.text || data.text.length < MIN_ARTICLE_CHARS) throw new ReadabilityNoContentError(url);
  return { title: data.title ?? "Untitled", text: data.text };
}
