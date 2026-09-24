// Read-only CLOB price client. fetchAsks returns the backable ASK (side=sell) per token,
// batched to stay inside the request budget. No auth (public).
//
// `fetch` is REQUIRED, not defaulted — see kalshi-client.ts for why.

export interface ClobClientDeps {
  fetch: typeof fetch;
  baseUrl?: string;
  chunkSize?: number;
  /** Per-request bound — same reasoning as kalshi-client.ts's DEFAULT_TIMEOUT_MS. Here it also
   *  bounds a MULTI-chunk call: each chunk gets its own signal, so a stall costs one timeout per
   *  chunk and the chunks that answered are still returned. */
  timeoutMs?: number;
}

type PricesResponse = Record<string, { SELL?: string; BUY?: string }>;

const DEFAULT_TIMEOUT_MS = 8_000;

export function makeClobClient(deps: ClobClientDeps) {
  const baseUrl = deps.baseUrl ?? "https://clob.polymarket.com";
  const doFetch = deps.fetch;
  const chunkSize = deps.chunkSize ?? 50;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Best-effort: one bad chunk is logged and skipped (the producer fills missing tokens from
  // laggedPrice) instead of dropping the whole market. Never throw on a partial venue failure.
  async function fetchAsks(tokenIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < tokenIds.length; i += chunkSize) {
      const chunk = tokenIds.slice(i, i + chunkSize);
      try {
        const body = chunk.map((id) => ({ token_id: id, side: "sell" }));
        const res = await doFetch(`${baseUrl}/prices`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) { console.warn(`clob /prices chunk → ${res.status}; skipping ${chunk.length} tokens`); continue; }
        const json = (await res.json()) as PricesResponse;
        for (const [id, sides] of Object.entries(json)) {
          // ORB-214 (5): a present-but-garbage SELL ("", "abc", null-ish) must never reach the
          // book as NaN — the card path guards with Number.isFinite, but the client is where a
          // non-price stops being a price.
          // (`Number("")` is 0 — finite, and not a price either — so blank strings are refused first.)
          if (typeof sides.SELL === "string" && sides.SELL.trim() !== "") {
            const ask = Number(sides.SELL);
            if (Number.isFinite(ask)) out.set(id, ask);
          }
        }
      } catch (e) {
        console.warn(`clob /prices chunk threw; skipping ${chunk.length} tokens`, e);
      }
    }
    return out;
  }

  return { fetchAsks };
}
