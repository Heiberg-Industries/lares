/**
 * Outbound routing for Telegram Bot API traffic.
 *
 * Each eve agent on the box is sealed to its own fixed egress set — the gateway, the db,
 * DNS, and the shared `slack-proxy` squid container, nothing else — each agent has its own
 * sealed IP and its own nft egress rule (`services/box/ops/egress-*.nft`).
 * `api.telegram.org` resolves inside Telegram's documented `149.154.160.0/20` block, which
 * an agent's egress rule already allows directly — but the squid proxy is the one path an
 * agent's outbound calls are meant to converge on (it is also where the domain-level
 * allow-list lives, `services/box/proxy/squid.conf`), so Telegram traffic is routed
 * there too, matching the Slack precedent.
 *
 * Unlike Slack, eve gives Telegram an explicit per-call fetch seam
 * (`TelegramApiOptions.fetch`, wired through `telegramChannel({ api: { fetch } })`), so
 * this does NOT install a global undici dispatcher the way `lib/slack-dispatcher.ts`
 * does. It is a plain function, injected once, at the one call site that needs it.
 *
 * Note that proxy environment variables are NOT an option: Node's built-in fetch ignores
 * them outright (a lesson `lib/slack-dispatcher.ts` and the Atlas sync job paid for
 * first). Routing has to be explicit, not implicit.
 */
import { ProxyAgent, fetch as undiciFetch } from "undici";

/** Where squid listens on the box's internal network. Matches the `slack-proxy` service —
 *  there is no separate Telegram proxy container; every agent shares this one. */
const DEFAULT_PROXY_URL = "http://slack-proxy:8888";

export interface TelegramFetchOptions {
  /** Override the proxy URL directly. Defaults to `TELEGRAM_PROXY_URL`, falling back to
   *  `SLACK_PROXY_URL` (every agent shares one proxy container), then the compose
   *  service's DNS name. */
  readonly proxyUrl?: string;
  /** Inject a dispatcher directly (tests: a real CONNECT proxy; production: unused). */
  readonly dispatcher?: ProxyAgent;
}

/**
 * Builds a `fetch`-shaped function bound to the squid `ProxyAgent`, for eve's
 * `TelegramApiOptions.fetch` seam. Constructing the `ProxyAgent` connects to nothing
 * until a call is actually dispatched, so this is safe to do at module scope — it reads
 * no secret, matching `lib/gateway-provider.ts`'s "no I/O until called" reasoning.
 */
export function createTelegramFetch(opts?: TelegramFetchOptions): typeof fetch {
  const proxyUrl =
    opts?.proxyUrl ??
    process.env["TELEGRAM_PROXY_URL"] ??
    process.env["SLACK_PROXY_URL"] ??
    DEFAULT_PROXY_URL;
  const dispatcher = opts?.dispatcher ?? new ProxyAgent(proxyUrl);
  const bound = (input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as never, { ...(init ?? {}), dispatcher } as never);
  return bound as unknown as typeof fetch;
}

/** The fetch bound into `agent/channels/telegram.ts`'s `api.fetch`. */
export const telegramFetch = createTelegramFetch();

/** ORB-214 (5): the honest name. This is the GENERIC sealed-egress proxy fetch — every agent's
 *  outbound call to a third-party host goes through the same squid `ProxyAgent`; Telegram was
 *  merely the first caller, and the docblock above still reads that way. New callers (the
 *  market venues, readability, Entur) should say `createProxyFetch`; `createTelegramFetch` stays
 *  as the same function under its historical name. */
export const createProxyFetch = createTelegramFetch;
