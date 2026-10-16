/**
 * Outbound routing for Slack traffic.
 *
 * the chief-of-staff service is sealed: `172.18.0.24` may reach the gateway, the db, DNS and the
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
 * for every PDF, 2026-09-14,. fetch follows that redirect through this same dispatcher,
 * so a domain missing here goes direct and dies against the seal as a 10 s connect timeout.
 */
const SLACK_DOMAINS = ["slack.com", "slack-files.com"];

/**
 * True for Slack's domains and their subdomains, matched on a host boundary so `notslack.com`
 * and `slack.com.evil.test` do not qualify. Mirrors squid's `agent_slack` acl
 * (`.slack.com .slack-files.com`) — a domain added here must be added there too.
 */
export function isSlackOrigin(origin: string | URL): boolean {
  const host = (origin instanceof URL ? origin : new URL(String(origin))).hostname.toLowerCase();
  return SLACK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Outside tools: the https hosts of the MCP servers an agent's definition lists. eve's
 * MCP client uses Node's built-in `fetch` and has no per-connection fetch seam, so these hosts
 * ride the same process-wide dispatcher as Slack. Only a PUBLIC dotted hostname qualifies: a
 * single-label compose service name or an IP address never goes to squid (it only allows CONNECT
 * to port 443 for its allow-listed domains, and the internal networks are reachable directly).
 */
export function isProxiableOutsideHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h) && !/^\d+(\.\d+)*$/.test(h);
}

/** Routes Slack origins, and any registered outside-tool https host, to the proxy dispatcher and
 *  everything else to the direct one. */
export class SlackProxyDispatcher extends Dispatcher {
  readonly #proxy: Dispatcher;
  readonly #direct: Dispatcher;
  readonly #outsideHosts = new Set<string>();
  #outsideProxy: Dispatcher | undefined;
  readonly #outsideProxyFactory: (() => Dispatcher | undefined) | undefined;

  constructor(opts: { proxy: Dispatcher; direct: Dispatcher; outsideProxy?: () => Dispatcher | undefined }) {
    super();
    this.#proxy = opts.proxy;
    this.#direct = opts.direct;
    this.#outsideProxyFactory = opts.outsideProxy;
  }

  /** Adds hosts (exact match, no subdomains). Idempotent; hosts that are not public dotted
   *  hostnames are ignored. */
  addOutsideHosts(hosts: Iterable<string>): void {
    for (const h of hosts) if (isProxiableOutsideHost(h)) this.#outsideHosts.add(h.trim().toLowerCase());
  }

  /** True when this origin is an https origin on a registered outside-tool host. */
  isOutsideOrigin(origin: string | URL): boolean {
    if (this.#outsideHosts.size === 0) return false;
    try {
      const url = origin instanceof URL ? origin : new URL(String(origin));
      return url.protocol === "https:" && this.#outsideHosts.has(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  get outsideHosts(): readonly string[] {
    return [...this.#outsideHosts].sort();
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const origin = options.origin ?? "";
    if (isSlackOrigin(origin)) return this.#proxy.dispatch(options, handler);
    if (this.isOutsideOrigin(origin)) {
      this.#outsideProxy ??= this.#outsideProxyFactory?.() ?? this.#proxy;
      return this.#outsideProxy.dispatch(options, handler);
    }
    return this.#direct.dispatch(options, handler);
  }
}

export interface InstalledSlackProxy {
  /** The proxy URL in use, or undefined when a dispatcher was injected directly. */
  readonly proxyUrl: string | undefined;
  readonly dispatcher: SlackProxyDispatcher;
}

let current: InstalledSlackProxy | undefined;

/**
 * Installs the routing as undici's global dispatcher, so Node's built-in `fetch` picks it
 * up. Non-Slack traffic keeps whatever dispatcher was global beforehand, which is what
 * leaves the gateway path untouched.
 */
export function installSlackProxyDispatcher(opts?: {
  proxy?: Dispatcher;
  proxyUrl?: string;
}): InstalledSlackProxy {
  // Idempotent: the Slack channel installs it at module load and the outside-tools resolver
  // needs it too. A second install must not nest a dispatcher inside the first.
  if (current !== undefined && getGlobalDispatcher() === current.dispatcher) return current;
  const proxyUrl = opts?.proxy
    ? opts.proxyUrl
    : (opts?.proxyUrl ?? process.env["SLACK_PROXY_URL"] ?? DEFAULT_PROXY_URL);
  const proxy = opts?.proxy ?? new ProxyAgent(proxyUrl as string);
  const dispatcher = new SlackProxyDispatcher({
    proxy,
    direct: getGlobalDispatcher(),
    // Outside tools use EGRESS_PROXY_URL (the keeper sets it beside SLACK_PROXY_URL; both are the
    // agent's own squid). Built lazily on first use; an injected proxy keeps tests off the network.
    outsideProxy: () => {
      if (opts?.proxy) return undefined;
      const url = process.env["EGRESS_PROXY_URL"];
      return url && url !== proxyUrl ? new ProxyAgent(url) : undefined;
    },
  });
  setGlobalDispatcher(dispatcher);
  current = { proxyUrl, dispatcher };
  return current;
}

/**
 * Registers the https hosts of an agent's outside tools with the engine egress dispatcher,
 * installing it first when no channel has. Idempotent and cheap: eve runs the connection resolver
 * several times per session. Nothing outside the given hosts and Slack's domains is ever proxied.
 */
export function addEgressHosts(hosts: Iterable<string>): void {
  const installed = installSlackProxyDispatcher();
  installed.dispatcher.addOutsideHosts(hosts);
}
