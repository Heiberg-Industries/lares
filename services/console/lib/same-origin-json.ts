// The exact-origin rule and the bounded JSON body reader the console's owner-only POST routes share
// (/api/clipping, /api/credentials/notion/preview, /api/meetings/source). The Notion key route
// (app/api/credentials/notion/route.ts) keeps its own copy of the same rule and is not changed.

/** True when the request comes from the console's own configured address (or, outside production,
 *  from the address it was sent to). Anything else is refused before the body is read. */
export function sameOrigin(req: Request): boolean {
  try {
    const configured = process.env.CONSOLE_OAUTH_REDIRECT;
    const origin = configured ? new URL(configured).origin : process.env.NODE_ENV !== 'production' ? new URL(req.url).origin : null;
    return !!origin && req.headers.get('origin') === origin;
  } catch { return false; }
}

/** The request's JSON body: no query string, `application/json`, at most 16 KiB, valid UTF-8.
 *  Throws on anything else; the caller answers `invalid-request`. */
export async function jsonBody(req: Request): Promise<unknown> {
  if (new URL(req.url).search || req.headers.get('content-type')?.split(';')[0] !== 'application/json' || !req.body) throw new Error('Invalid request');
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.length;
      if (length > 16_384) throw new Error('Invalid request');
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
