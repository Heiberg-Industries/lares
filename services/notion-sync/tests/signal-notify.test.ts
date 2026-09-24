import { afterEach, describe, it, expect, vi } from "vitest";
import { makeSignalNotify } from "../lib/adapters/signal-notify.js";

const MESSAGE = "Notion edit proposed for wiki/alpha.md\napprove: notion-sync approve wiki/alpha.md";

afterEach(() => {
  delete process.env["SIGNAL_PROJECT"];
});

describe("makeSignalNotify", () => {
  it("falls back to console.log, never touching fetch, when url is unset", async () => {
    const fetchImpl = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const notify = makeSignalNotify({ token: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
      await expect(notify(MESSAGE)).resolves.toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join("\n")).toContain(MESSAGE);
    } finally {
      log.mockRestore();
    }
  });

  it("falls back to console.log, never touching fetch, when token is unset", async () => {
    const fetchImpl = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const notify = makeSignalNotify({ url: "https://spine.example", fetchImpl: fetchImpl as unknown as typeof fetch });
      await expect(notify(MESSAGE)).resolves.toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("POSTs the spine's real /ingest schema with Bearer auth when both are set", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const notify = makeSignalNotify({
      url: "https://spine.example",
      token: "s3cr3t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await notify(MESSAGE);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // Real intake: POST /ingest (services/signal-spine/server.ts), NOT /signals,
    // and NOT the task brief's guessed {text: message} body.
    expect(url).toBe("https://spine.example/ingest");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"] ?? headers["Authorization"]).toBe("Bearer s3cr3t");
    expect(headers["content-type"] ?? headers["Content-Type"]).toMatch(/application\/json/);

    const body = JSON.parse(init.body as string);
    // Full Signal shape (signal-spine/lib/signal.ts + lib/validate.ts signalSchema).
    expect(body.source).toBe("notion-sync");
    expect(body.project).toBe("lares");
    expect(body.type).toBe("app-exception");
    expect(body.severity).toBe("info");
    expect(body.title).toContain("Notion edit proposed");
    expect(body.body).toBe(MESSAGE);
    expect(body.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(body.url).toBeNull();
    expect(new Date(body.occurredAt).toISOString()).toBe(body.occurredAt);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses SIGNAL_PROJECT when the installation overrides the default", async () => {
    process.env["SIGNAL_PROJECT"] = "portfolio";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const notify = makeSignalNotify({
      url: "https://spine.example",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await notify(MESSAGE);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).project).toBe("portfolio");
  });

  it("strips a trailing slash from the configured url before appending /ingest", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const notify = makeSignalNotify({
      url: "https://spine.example/",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await notify(MESSAGE);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://spine.example/ingest");
  });

  it("truncates title to 200 chars and body to 4000, matching signalSchema's limits", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const notify = makeSignalNotify({
      url: "https://spine.example",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const long = "x".repeat(5000);
    await notify(long);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.title.length).toBe(200);
    expect(body.body.length).toBe(4000);
  });

  it("hashes identical messages to the same fingerprint (the spine's 24h dedupe key)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const notify = makeSignalNotify({
      url: "https://spine.example",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await notify(MESSAGE);
    await notify(MESSAGE);
    const bodies = fetchImpl.mock.calls.map(
      (call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    );
    expect(bodies[0].fingerprint).toBe(bodies[1].fingerprint);
  });

  it("never throws or rejects when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const notify = makeSignalNotify({
        url: "https://spine.example",
        token: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await expect(notify(MESSAGE)).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });

  it("never throws when the spine responds non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 500 }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const notify = makeSignalNotify({
        url: "https://spine.example",
        token: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await expect(notify(MESSAGE)).resolves.toBeUndefined();
    } finally {
      err.mockRestore();
    }
  });

  it("sends raw.key and severity when given; defaults info and no key", async () => {
    const sent: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    });
    const notify = makeSignalNotify({
      url: "https://spine.example",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await notify("transcripts are being skipped: Other", { key: "unmapped-project", severity: "warn" });
    await notify("plain");

    expect(sent[0]).toMatchObject({ severity: "warn", raw: { key: "unmapped-project" } });
    expect(sent[1]).toMatchObject({ severity: "info" });
    expect((sent[1] as { raw?: unknown }).raw).toBeUndefined();
  });
});
