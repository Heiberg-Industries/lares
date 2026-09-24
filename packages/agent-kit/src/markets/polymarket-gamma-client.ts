// Read-only Gamma catalog client. No auth (public API).
//
// `fetch` is REQUIRED, not defaulted — see kalshi-client.ts for why.
import type { GammaMarket, GammaEvent } from "./polymarket-parse.js";

export interface GammaClientDeps {
  fetch: typeof fetch;
  baseUrl?: string;
  /** Per-request bound — same reasoning as kalshi-client.ts's DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

const DEFAULT_QUERY = "closed=false&active=true&limit=20&order=volume24hr&ascending=false";

const DEFAULT_TIMEOUT_MS = 8_000;

export function makeGammaClient(deps: GammaClientDeps) {
  const baseUrl = deps.baseUrl ?? "https://gamma-api.polymarket.com";
  const doFetch = deps.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function get<T>(path: string): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`gamma ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    listEvents: (query: string = DEFAULT_QUERY) => get<GammaEvent[]>(`/events?${query}`),
    listMarkets: (query: string = DEFAULT_QUERY) => get<GammaMarket[]>(`/markets?${query}`),
    getEvent: (slug: string) => get<GammaEvent[]>(`/events?slug=${encodeURIComponent(slug)}`),
    /** Fetch top events ranked by total liquidity descending. */
    listTopByLiquidity: (limit: number) =>
      get<GammaEvent[]>(`/events?closed=false&active=true&order=liquidity&ascending=false&limit=${limit}`),
  };
}
