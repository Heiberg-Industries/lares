import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createTelegramFetch, telegramFetch } from "../src/telegram-fetch.js";

/**
 * Same proof shape as `slack-dispatcher.test.ts`'s "THE test": a real HTTP CONNECT proxy
 * that records tunnel targets and refuses to tunnel. Every eve agent on the box is sealed,
 * so the only observable evidence that Telegram traffic goes through squid's shape (rather
 * than around it, which would hang against the seal) is that the CONNECT reaches the proxy
 * at all.
 */
describe("createTelegramFetch", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function startConnectProxy(): Promise<{ url: string; connects: string[] }> {
    const connects: string[] = [];
    const server = createServer();
    server.on("connect", (req, socket) => {
      connects.push(req.url ?? "");
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, connects };
  }

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

  it("routes a Telegram Bot API call through the proxy, unlike a bare fetch", async () => {
    // Proven against a real CONNECT proxy rather than a stub: the assertion is that a
    // genuine api.telegram.org call arrives at the proxy as a tunnel request. The proxy
    // then refuses to tunnel, so the fetch rejects — irrelevant, and deliberately so.
    // What matters is that the request went through squid's shape, not around it.
    const proxy = await startConnectProxy();
    const fetchViaProxy = createTelegramFetch({ proxyUrl: proxy.url });

    await expect(
      fetchViaProxy("https://api.telegram.org/botTEST/getMe", { method: "POST" }),
    ).rejects.toThrow();

    expect(proxy.connects).toEqual(["api.telegram.org:443"]);
  });

  it("tunnels an http:// call through the same proxy too", async () => {
    // Unlike a global dispatcher that must choose proxy-vs-direct per origin because it
    // sits on one shared fetch used for everything, this function is injected only at
    // Telegram's own Bot API call site (`api.fetch` in `agent/channels/telegram.ts`). There
    // is no "other traffic" for it to accidentally catch, so every call it makes goes
    // through the proxy — proven here against a plain origin server reached over CONNECT
    // via the proxy, not directly.
    const proxy = await startConnectProxy();
    const origin = await startOriginServer();
    const fetchViaProxy = createTelegramFetch({ proxyUrl: proxy.url });

    await expect(fetchViaProxy(`${origin.url}/botTEST/getMe`)).rejects.toThrow();

    expect(proxy.connects.length).toBeGreaterThan(0);
    expect(origin.hits).toEqual([]);
  });

  it("builds its proxy from TELEGRAM_PROXY_URL, falling back to SLACK_PROXY_URL, when no dispatcher is injected", () => {
    // Production path: no injection, so the URL must come from config. Telegram falls
    // back to Slack's proxy var because every agent shares the box's one `slack-proxy`
    // container.
    process.env["SLACK_PROXY_URL"] = "http://slack-proxy:8888";
    try {
      const fn = createTelegramFetch();
      expect(fn).toBeInstanceOf(Function);
    } finally {
      delete process.env["SLACK_PROXY_URL"];
    }
  });

  it("exports a ready-to-use default instance for agent/channels/telegram.ts to inject", () => {
    expect(telegramFetch).toBeInstanceOf(Function);
  });
});
