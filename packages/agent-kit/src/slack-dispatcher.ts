/**
 * Outbound routing for Slack traffic.
 *
 * eve-saga is sealed: `172.18.0.24` may reach the gateway, the db, DNS and the
 * `slack-proxy` squid container, and nothing else. Slack lives on rotating AWS IPs, so
 * the only way out is squid's domain allow-list — and a call that skips it is DROPPED,
 * surfacing as a hang rather than an error.
 *
 * eve gives us nowhere to hook that in. Its Slack calls land in
 * `#compiled/@chat-adapter/slack/api.js`, which uses `a.fetch ?? fetch`, and eve's own
 * `createSlackApiOptions` passes only `{ token }` — no fetch, no agent, no dispatcher.
 * So the routing has to be installed process-wide instead, and it has to be selective:
 * a blanket proxy would send model traffic to squid, which denies everything that is not
 * Slack/Google/Atlas.
 *
 * Note that proxy environment variables are NOT an option: Node's built-in fetch ignores
 * them outright (a lesson the Atlas sync job paid for first).
 */
import { Dispatcher, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

/** Where squid listens on the box's internal network. Matches the `slack-proxy` service. */
const DEFAULT_PROXY_URL = "http://slack-proxy:8888";

/**
 * Slack's own domains. `slack-files.com` is where `files.slack.com` 302s a file download (seen
 * for every PDF, 2026-09-14, ORB-286). fetch follows that redirect through this same dispatcher,
 * so a domain missing here goes direct and dies against the seal as a 10 s connect timeout.
 */
const SLACK_DOMAINS = ["slack.com", "slack-files.com"];

/**
 * True for Slack's domains and their subdomains, matched on a host boundary so `notslack.com`
 * and `slack.com.evil.test` do not qualify. Mirrors squid's `saga_slack` acl
 * (`.slack.com .slack-files.com`) — a domain added here must be added there too.
 */
export function isSlackOrigin(origin: string | URL): boolean {
  const host = (origin instanceof URL ? origin : new URL(String(origin))).hostname.toLowerCase();
  return SLACK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Routes Slack origins to one dispatcher and everything else to another. */
export class SlackProxyDispatcher extends Dispatcher {
  readonly #proxy: Dispatcher;
  readonly #direct: Dispatcher;

  constructor(opts: { proxy: Dispatcher; direct: Dispatcher }) {
    super();
    this.#proxy = opts.proxy;
    this.#direct = opts.direct;
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const target = isSlackOrigin(options.origin ?? "") ? this.#proxy : this.#direct;
    return target.dispatch(options, handler);
  }
}

export interface InstalledSlackProxy {
  /** The proxy URL in use, or undefined when a dispatcher was injected directly. */
  readonly proxyUrl: string | undefined;
  readonly dispatcher: SlackProxyDispatcher;
}

/**
 * Installs the routing as undici's global dispatcher, so Node's built-in `fetch` picks it
 * up. Non-Slack traffic keeps whatever dispatcher was global beforehand, which is what
 * leaves the gateway path untouched.
 */
export function installSlackProxyDispatcher(opts?: {
  proxy?: Dispatcher;
  proxyUrl?: string;
}): InstalledSlackProxy {
  const proxyUrl = opts?.proxy
    ? opts.proxyUrl
    : (opts?.proxyUrl ?? process.env["SLACK_PROXY_URL"] ?? DEFAULT_PROXY_URL);
  const proxy = opts?.proxy ?? new ProxyAgent(proxyUrl as string);
  const dispatcher = new SlackProxyDispatcher({ proxy, direct: getGlobalDispatcher() });
  setGlobalDispatcher(dispatcher);
  return { proxyUrl, dispatcher };
}
