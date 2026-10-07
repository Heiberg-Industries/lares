/**
 * tests/live/slack-dispatcher.live.mts — the LIVE check that `installSlackProxyDispatcher` still
 * captures Node's BUILT-IN fetch (LAR-69 batch 10, undici 7 to 8).
 *
 * NOT part of `pnpm test`: it calls the real slack.com. Run it by hand whenever undici, Node or
 * `src/slack-dispatcher.ts` changes:
 *
 *     npx tsx packages/agent-kit/tests/live/slack-dispatcher.live.mts
 *
 * WHY. Node's built-in fetch runs on the undici copy bundled INSIDE Node, not on ours. The router
 * reaches it only through undici's global-dispatcher slot, and undici 8 reworked that slot and
 * dropped the legacy handler wrappers. If the router stops being picked up, Slack calls go direct,
 * and on a sealed box that is a hang against the firewall, never an error.
 * `tests/slack-dispatcher.test.ts` can only check the routing decision; this file checks that
 * real built-in fetch traffic to Slack goes through a proxy and other traffic does not.
 *
 * WHICH PROXY. With `SLACK_PROXY_URL` set (inside an agent container, where it is the real squid)
 * it uses that. Without it, it starts a throwaway CONNECT proxy on 127.0.0.1, which proves the
 * routing from a laptop. `NON_SLACK_URL` (default https://example.com/) is the direct-path target;
 * on a sealed box point it at something the container may reach directly, such as the gateway.
 *
 * Exit code is 0 only when the Slack call went through the proxy and got Slack's answer, and the
 * non-Slack call did not touch the proxy.
 */
import http from "node:http";
import net from "node:net";
import { Dispatcher, ProxyAgent } from "undici";

import { installSlackProxyDispatcher } from "../../src/slack-dispatcher.js";

/** Forwards to the real proxy agent and counts what it is handed. */
class CountingDispatcher extends Dispatcher {
  readonly origins: string[] = [];
  readonly #inner: Dispatcher;
  constructor(inner: Dispatcher) {
    super();
    this.#inner = inner;
  }
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    this.origins.push(String(options.origin));
    return this.#inner.dispatch(options, handler);
  }
}

async function startLocalProxy(): Promise<{ url: string; tunnels: string[]; close: () => void }> {
  const tunnels: string[] = [];
  const server = http.createServer().on("connect", (req, sock, head) => {
    tunnels.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(sock);
      sock.pipe(upstream);
    });
    upstream.on("error", () => sock.destroy());
    sock.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return { url: `http://127.0.0.1:${port}`, tunnels, close: () => server.close() };
}

async function timed<T>(label: string, p: Promise<T>, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no answer in ${ms} ms (a hang, not an error)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const envProxy = process.env["SLACK_PROXY_URL"];
const local = envProxy ? undefined : await startLocalProxy();
const proxyUrl = envProxy ?? local!.url;
const nonSlackUrl = process.env["NON_SLACK_URL"] ?? "https://example.com/";

const counting = new CountingDispatcher(new ProxyAgent(proxyUrl));
installSlackProxyDispatcher({ proxy: counting, proxyUrl });

console.log(`node ${process.version}, bundled undici ${process.versions["undici"]}`);
console.log(`proxy: ${proxyUrl}${local ? " (throwaway local CONNECT proxy)" : " (SLACK_PROXY_URL)"}`);

const failures: string[] = [];

// 1. Slack, through Node's built-in fetch. api.test needs no token and echoes its arguments.
try {
  const res = await timed("slack.com", fetch("https://slack.com/api/api.test", {
    method: "POST",
    body: new URLSearchParams({ probe: "slack-dispatcher" }),
  }));
  const body = (await res.json()) as { ok?: boolean; args?: Record<string, string> };
  const viaProxy = counting.origins.some((o) => o.includes("slack.com"));
  console.log(`slack.com    -> HTTP ${res.status}, ok=${body.ok}, args=${JSON.stringify(body.args)}, via proxy: ${viaProxy}`);
  if (!viaProxy) failures.push("the Slack call did not go through the proxy dispatcher");
  if (body.ok !== true || body.args?.["probe"] !== "slack-dispatcher") failures.push("Slack did not echo the request");
  if (local && !local.tunnels.some((t) => t.startsWith("slack.com:"))) failures.push("the local proxy saw no CONNECT to slack.com");
} catch (err) {
  failures.push(`Slack call failed: ${(err as Error).message}`);
}

// 2. Anything else must NOT touch the proxy. Reaching it is reported; routing is what is asserted.
const before = counting.origins.length;
try {
  const res = await timed(nonSlackUrl, fetch(nonSlackUrl));
  console.log(`${nonSlackUrl} -> HTTP ${res.status}`);
} catch (err) {
  console.log(`${nonSlackUrl} -> unreachable (${(err as Error).message}); routing still checked below`);
}
const leaked = counting.origins.slice(before);
console.log(`non-Slack via proxy: ${leaked.length > 0 ? leaked.join(", ") : "no"}`);
if (leaked.length > 0) failures.push(`non-Slack traffic went through the proxy: ${leaked.join(", ")}`);

local?.close();
if (failures.length > 0) {
  console.error(`\nFAIL\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nPASS: built-in fetch sends Slack through the proxy and everything else direct.");
process.exit(0);
