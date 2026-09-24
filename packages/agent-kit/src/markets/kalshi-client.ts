// Read-only Kalshi catalog client. No auth (public read API).
//
// `fetch` is REQUIRED, not defaulted: Node's built-in fetch ignores proxy env vars, so a client
// built without one works on a laptop and hangs against the box's sealed egress — the worst place
// to discover it. On the box the caller passes `createTelegramFetch()`.
import type { KalshiMarket, KalshiEvent } from "./kalshi-parse.js";

export interface KalshiClientDeps {
  fetch: typeof fetch;
  baseUrl?: string;
  /** Per-request bound; see DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

const DEFAULT_EVENTS_QUERY = "status=open&limit=100";

/** A hung socket is not an error anything upstream can see. `market_edge`'s `find` can issue
 *  ~80 venue requests in one turn, and nothing above this layer can abort one in flight, so the
 *  bound belongs HERE: a stalled venue becomes a rejected promise the caller already handles as
 *  "this venue is unavailable", never a turn that silently never answers. */
const DEFAULT_TIMEOUT_MS = 8_000;

export function makeKalshiClient(deps: KalshiClientDeps) {
  const baseUrl = deps.baseUrl ?? "https://api.elections.kalshi.com/trade-api/v2";
  const doFetch = deps.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function get<T>(path: string): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`kalshi ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    listEvents: async (query: string = DEFAULT_EVENTS_QUERY): Promise<KalshiEvent[]> => {
      const body = await get<{ events?: KalshiEvent[] }>(`/events?${query}`);
      return body.events ?? [];
    },
    listEventsPage: async (cursor?: string): Promise<{ events: KalshiEvent[]; cursor?: string | null }> => {
      const query = `status=open&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = await get<{ events?: KalshiEvent[]; cursor?: string | null }>(`/events?${query}`);
      return { events: body.events ?? [], cursor: body.cursor };
    },
    listMarketsForEvent: async (eventTicker: string): Promise<KalshiMarket[]> => {
      const body = await get<{ markets?: KalshiMarket[] }>(`/markets?event_ticker=${encodeURIComponent(eventTicker)}`);
      return body.markets ?? [];
    },
    getEvent: async (eventTicker: string): Promise<KalshiEvent> => {
      const body = await get<{ event: KalshiEvent }>(`/events/${encodeURIComponent(eventTicker)}`);
      return body.event;
    },
  };
}
