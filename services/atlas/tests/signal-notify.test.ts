// services/atlas/tests/signal-notify.test.ts
// makeSignalNotify was pulled out of bin/atlas-sync.ts (services/notion-sync's own
// lib/adapters/signal-notify.ts is the prior art) so it can be exercised with an injected
// fetch — the bin script itself wires config and live network calls at import time and
// cannot be imported by a test.
//
// Task 15: every atlas signal shipped as data-quality/info, and the spine's route table has
// no row for that pair — every atlas signal was silently dropped, which is how the first
// live tick's SOMA source-health alert was lost. `opts.key === "source-health"` is what
// upgrades a notice to data-quality/warn (which DOES have a route); everything else stays
// info via the v2 catch-all.
import { createHash } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import { makeSignalNotify } from "../lib/adapters/signal-notify.js";

const MESSAGE = "Atlas: _projects/soma.md is flagged FAILING — source unreadable: soma/meetings.";

afterEach(() => {
  delete process.env["SIGNAL_PROJECT"];
});

describe("makeSignalNotify", () => {
  it("source-health notices go out as data-quality/warn with raw.key; routine notices stay info", async () => {
    const sent: Array<{ severity: string; raw?: { key?: string } }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    });
    const notify = makeSignalNotify({
      url: "https://spine.example",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await notify("source unreadable: soma/meetings", { key: "source-health" });
    await notify("derived 3 notes");

    expect(sent[0]).toMatchObject({ severity: "warn", raw: { key: "source-health" } });
    expect(sent[1]).toMatchObject({ severity: "info" });
    expect(sent[1].raw).toBeUndefined();
  });

  it("falls back to console.log, never touching fetch, when the spine is not configured", async () => {
    const fetchImpl = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const notify = makeSignalNotify({ fetchImpl: fetchImpl as unknown as typeof fetch });
      await expect(notify(MESSAGE, { key: "source-health" })).resolves.toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join("\n")).toContain(MESSAGE);
    } finally {
      log.mockRestore();
    }
  });

  it("POSTs the spine's real /ingest schema with Bearer auth, unchanged from before this task", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const notify = makeSignalNotify({
      url: "https://spine.example",
      token: "s3cr3t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await notify(MESSAGE);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://spine.example/ingest");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"] ?? headers["Authorization"]).toBe("Bearer s3cr3t");
    expect(headers["content-type"] ?? headers["Content-Type"]).toMatch(/application\/json/);

    const body = JSON.parse(init.body as string);
    expect(body.source).toBe("atlas");
    expect(body.project).toBe("lares");
    expect(body.type).toBe("data-quality");
    expect(body.severity).toBe("info");
    expect(body.title).toBe(MESSAGE.slice(0, 120));
    expect(body.body).toBe(MESSAGE);
    expect(body.fingerprint).toBe(
      createHash("sha256").update(`atlas|notify|${MESSAGE}`).digest("hex"),
    );
    expect(body.url).toBeNull();
    expect(new Date(body.occurredAt).toISOString()).toBe(body.occurredAt);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses SIGNAL_PROJECT when the installation overrides the default", async () => {
    process.env["SIGNAL_PROJECT"] = "portfolio";
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const notify = makeSignalNotify({
      url: "https://spine.example",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await notify(MESSAGE);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).project).toBe("portfolio");
  });

  it("never throws when the spine responds non-2xx or fetch rejects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const notifyBadStatus = makeSignalNotify({
        url: "https://spine.example",
        token: "tok",
        fetchImpl: (async () => new Response("bad", { status: 500 })) as unknown as typeof fetch,
      });
      await expect(notifyBadStatus(MESSAGE)).resolves.toBeUndefined();

      const notifyThrows = makeSignalNotify({
        url: "https://spine.example",
        token: "tok",
        fetchImpl: (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
      });
      await expect(notifyThrows(MESSAGE)).resolves.toBeUndefined();
    } finally {
      err.mockRestore();
    }
  });
});
