import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici";

import {
  SlackProxyDispatcher,
  installSlackProxyDispatcher,
  isSlackOrigin,
} from "../src/slack-dispatcher.js";

/**
 * A Dispatcher that records what it was asked to dispatch and answers 200 without
 * touching the network. Real Dispatcher subclass, not a mock of our own code: the
 * assertions below are about which dispatcher undici hands a request to, which is
 * exactly the production behaviour we need and cannot otherwise observe.
 */
class RecordingDispatcher extends Dispatcher {
  readonly origins: string[] = [];

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    this.origins.push(String(options.origin));
    handler.onRequestStart?.({ abort: () => {} } as never, {});
    handler.onResponseStart?.({ abort: () => {} } as never, 200, {}, "OK");
    handler.onResponseEnd?.({ abort: () => {} } as never, {});
    return true;
  }
}

describe("isSlackOrigin", () => {
  it("matches slack.com and its subdomains", () => {
    expect(isSlackOrigin("https://slack.com/api/auth.test")).toBe(true);
    expect(isSlackOrigin("https://api.slack.com")).toBe(true);
    expect(isSlackOrigin("https://files.slack.com/x")).toBe(true);
    expect(isSlackOrigin(new URL("https://wss-primary.slack.com"))).toBe(true);
  });

  it("matches slack-files.com, where Slack redirects file downloads", () => {
    // Slack redirect shape: GET files.slack.com/files-pri/…/report.pdf → 302
    // https://slack-files.com/… . Routed direct, that hop died against the seal and every PDF
    // The owner sent the chief of staff failed after 4 × 10 s connect timeouts.
    expect(isSlackOrigin("https://slack-files.com/T00000000-F00000001-abc/report.pdf")).toBe(true);
    expect(isSlackOrigin("https://edge.slack-files.com/x")).toBe(true);
    expect(isSlackOrigin("https://notslack-files.com")).toBe(false);
    expect(isSlackOrigin("https://slack-files.com.evil.test")).toBe(false);
  });

  it("does not match look-alike hosts", () => {
    // The whole point of matching by suffix on a host boundary: `notslack.com` and
    // `slack.com.evil.test` must go direct (and therefore die against the seal),
    // never be handed a proxy that allow-lists Slack.
    expect(isSlackOrigin("https://notslack.com")).toBe(false);
    expect(isSlackOrigin("https://slack.com.evil.test")).toBe(false);
    expect(isSlackOrigin("https://myslack.com")).toBe(false);
  });

  it("does not match the gateway", () => {
    // Regression guard for the failure that would be hardest to spot: routing model
    // traffic through squid, which allow-lists only Slack/Google/Atlas sources and
    // would deny it.
    expect(isSlackOrigin("https://gateway.example.com/anthropic/v1")).toBe(false);
  });
});

describe("SlackProxyDispatcher", () => {
  it("sends Slack traffic to the proxy dispatcher", () => {
    const proxy = new RecordingDispatcher();
    const direct = new RecordingDispatcher();
    const d = new SlackProxyDispatcher({ proxy, direct });

    d.dispatch({ origin: "https://slack.com", path: "/api/auth.test", method: "POST" }, {});

    expect(proxy.origins).toEqual(["https://slack.com"]);
    expect(direct.origins).toEqual([]);
  });

  it("leaves every other origin on the direct dispatcher", () => {
    const proxy = new RecordingDispatcher();
    const direct = new RecordingDispatcher();
    const d = new SlackProxyDispatcher({ proxy, direct });

    d.dispatch(
      { origin: "https://gateway.example.com", path: "/anthropic/v1", method: "POST" },
      {},
    );

    expect(direct.origins).toEqual(["https://gateway.example.com"]);
    expect(proxy.origins).toEqual([]);
  });
});

describe("installSlackProxyDispatcher", () => {
  const original = getGlobalDispatcher();
  const servers: Server[] = [];

  afterEach(async () => {
    setGlobalDispatcher(original);
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  /** A real HTTP CONNECT proxy that records tunnel targets and refuses to tunnel. */
  async function startConnectProxy(): Promise<{ url: string; connects: string[] }> {
    const connects: string[] = [];
    const server = createServer();
    server.on("connect", (req, socket) => {
      connects.push(req.url ?? "");
      // Refuse the tunnel the way squid refuses a non-allow-listed domain, rather than
      // destroying the socket: a clean CONNECT rejection is what the client can actually
      // surface as an error instead of waiting on a dead connection.
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, connects };
  }

  /** A real origin server, so the direct path can be observed answering for itself. */
  async function startOriginServer(): Promise<{ url: string; hits: string[] }> {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200).end("ok");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
  }

  it("makes the built-in global fetch route Slack calls through the proxy", async () => {
    // THE test. eve gives no per-client fetch seam for Slack, so the proxy has to be
    // installed process-wide — which only works if Node's *built-in* fetch honours the
    // dispatcher set through the npm `undici` package. Those are two different undici
    // instances that agree only via a shared global symbol; if that agreement ever breaks,
    // Slack calls silently go direct and die against the seal as a HANG, not an error.
    //
    // Proven against a real CONNECT proxy rather than a stub: the assertion is that a
    // genuine `https://slack.com` fetch arrives at the proxy as a tunnel request. The
    // proxy then refuses to tunnel, so the fetch rejects — irrelevant, and deliberately
    // so. What matters is that the request went through squid's shape, not around it.
    const proxy = await startConnectProxy();
    installSlackProxyDispatcher({ proxyUrl: proxy.url });

    await expect(fetch("https://slack.com/api/auth.test", { method: "POST" })).rejects.toThrow();

    expect(proxy.connects).toEqual(["slack.com:443"]);
  });

  it("leaves non-Slack traffic off the proxy entirely", async () => {
    // The other half, and the one that would be expensive to get wrong: a blanket proxy
    // would send model traffic to squid, which denies anything that is not Slack/Google/
    // Atlas. This asserts the gateway-shaped call reaches its origin directly and the
    // proxy never sees it.
    const proxy = await startConnectProxy();
    const origin = await startOriginServer();
    installSlackProxyDispatcher({ proxyUrl: proxy.url });

    const response = await fetch(`${origin.url}/anthropic/v1`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(origin.hits).toEqual(["/anthropic/v1"]);
    expect(proxy.connects).toEqual([]);
  });

  it("builds its proxy from SLACK_PROXY_URL when no dispatcher is injected", () => {
    // Production path: no injection, so the URL must come from config. Guards against a
    // default that silently points nowhere.
    process.env["SLACK_PROXY_URL"] = "http://slack-proxy:8888";
    try {
      const installed = installSlackProxyDispatcher();
      expect(installed.proxyUrl).toBe("http://slack-proxy:8888");
    } finally {
      delete process.env["SLACK_PROXY_URL"];
    }
  });
});

describe("outside-tool hosts", () => {
  const dispatch = (d: SlackProxyDispatcher, origin: string) =>
    d.dispatch({ origin, path: "/mcp", method: "POST" }, {});
  const make = () => {
    const proxy = new RecordingDispatcher();
    const direct = new RecordingDispatcher();
    const d = new SlackProxyDispatcher({ proxy, direct });
    return { d, proxy, direct };
  };

  it("sends a registered https host through the proxy, and Slack as before", () => {
    const { d, proxy, direct } = make();
    d.addOutsideHosts(["tools.example.org"]);
    dispatch(d, "https://tools.example.org");
    dispatch(d, "https://slack.com");
    dispatch(d, "https://gateway.example.com");
    expect(proxy.origins).toEqual(["https://tools.example.org", "https://slack.com"]);
    expect(direct.origins).toEqual(["https://gateway.example.com"]);
  });

  it("matches the exact host only, not subdomains or look-alikes", () => {
    const { d, proxy, direct } = make();
    d.addOutsideHosts(["tools.example.org"]);
    dispatch(d, "https://evil.tools.example.org");
    dispatch(d, "https://tools.example.org.evil.test");
    dispatch(d, "https://example.org");
    expect(proxy.origins).toEqual([]);
    expect(direct.origins).toHaveLength(3);
  });

  it("never proxies compose-internal names, IP addresses or plain http, even if registered", () => {
    const { d, proxy, direct } = make();
    d.addOutsideHosts(["registry-mcp", "10.0.0.5", "127.0.0.1", "localhost", "tools.example.org"]);
    expect(d.outsideHosts).toEqual(["tools.example.org"]);
    dispatch(d, "http://registry-mcp:3000");
    dispatch(d, "http://10.0.0.5:3000");
    dispatch(d, "http://tools.example.org");
    expect(proxy.origins).toEqual([]);
    expect(direct.origins).toHaveLength(3);
  });

  it("is idempotent when the same host is added twice", () => {
    const { d } = make();
    d.addOutsideHosts(["tools.example.org"]);
    d.addOutsideHosts(["tools.example.org"]);
    expect(d.outsideHosts).toEqual(["tools.example.org"]);
  });

  it("uses EGRESS_PROXY_URL for outside hosts through the real global fetch", async () => {
    const original = getGlobalDispatcher();
    const slackProxy = new RecordingDispatcher();
    try {
      // Slack's own proxy is an injected recorder; the outside proxy comes from the env.
      const connects: string[] = [];
      const server = createServer();
      server.on("connect", (req, socket) => {
        connects.push(req.url ?? "");
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const egress = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      process.env["EGRESS_PROXY_URL"] = egress;
      setGlobalDispatcher(original);
      const { addEgressHosts } = await import("../src/slack-dispatcher.js");
      installSlackProxyDispatcher({ proxyUrl: "http://slack-proxy:8888" });
      addEgressHosts(["tools.example.org"]);
      await expect(fetch("https://tools.example.org/mcp", { method: "POST" })).rejects.toThrow();
      expect(connects).toEqual(["tools.example.org:443"]);
      await new Promise((r) => server.close(r));
    } finally {
      delete process.env["EGRESS_PROXY_URL"];
      setGlobalDispatcher(original);
      void slackProxy;
    }
  });

  it("installing twice does not nest a dispatcher in the first", () => {
    const original = getGlobalDispatcher();
    try {
      const a = installSlackProxyDispatcher({ proxy: new RecordingDispatcher() });
      const b = installSlackProxyDispatcher({ proxy: new RecordingDispatcher() });
      expect(b.dispatcher).toBe(a.dispatcher);
    } finally {
      setGlobalDispatcher(original);
    }
  });
});
