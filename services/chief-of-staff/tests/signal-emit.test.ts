import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { emitSignal } from "../lib/signal-emit.js";

let server: Server | undefined;

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
  });
}

beforeEach(() => {
  delete process.env["SIGNAL_SPINE_URL"];
  delete process.env["SIGNAL_SPINE_TOKEN"];
  delete process.env["SIGNAL_PROJECT"];
});

afterEach(async () => {
  delete process.env["SIGNAL_SPINE_URL"];
  delete process.env["SIGNAL_SPINE_TOKEN"];
  delete process.env["SIGNAL_PROJECT"];
  vi.restoreAllMocks();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("emitSignal", () => {
  it("is a silent no-op — makes no network call — when SIGNAL_SPINE_URL is unset", async () => {
    process.env["SIGNAL_SPINE_TOKEN"] = "tok";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(emitSignal("workflow-step-failed", "job 42 failed")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a silent no-op — makes no network call — when SIGNAL_SPINE_TOKEN is unset", async () => {
    process.env["SIGNAL_SPINE_URL"] = "https://spine.example";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(emitSignal("workflow-step-failed", "job 42 failed")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a silent no-op when both env vars are unset", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(emitSignal("workflow-step-failed", "job 42 failed")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs {SIGNAL_SPINE_URL}/ingest with Bearer auth, source eve-saga, and a valid fingerprint", async () => {
    let receivedMethod: string | undefined;
    let receivedPath: string | undefined;
    let receivedAuth: string | undefined;
    let receivedBody = "";
    const port = await listen((req, res) => {
      receivedMethod = req.method;
      receivedPath = req.url;
      receivedAuth = req.headers["authorization"] as string | undefined;
      req.on("data", (chunk) => (receivedBody += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    process.env["SIGNAL_SPINE_URL"] = `http://127.0.0.1:${port}`;
    process.env["SIGNAL_SPINE_TOKEN"] = "s3cr3t";

    await emitSignal("workflow-step-failed", "job 42 (email-triage) step failed: boom", "Error: boom\n  at step");

    expect(receivedMethod).toBe("POST");
    expect(receivedPath).toBe("/ingest");
    expect(receivedAuth).toBe("Bearer s3cr3t");

    const body = JSON.parse(receivedBody);
    expect(body.source).toBe("eve-saga");
    expect(body.project).toBe("lares");
    expect(body.kind).toBe("alert");
    expect(body.type).toBe("app-exception");
    expect(body.severity).toBe("error");
    expect(body.title).toContain("job 42");
    expect(body.body).toContain("boom");
    expect(body.fingerprint).toBe(createHash("sha256")
      .update("eve-saga|workflow-step-failed|job 42 (email-triage) step failed: boom")
      .digest("hex"));
    expect(body.url).toBeNull();
    expect(new Date(body.occurredAt).toISOString()).toBe(body.occurredAt);
  });

  it("uses SIGNAL_PROJECT when the installation overrides the default", async () => {
    let receivedBody = "";
    const port = await listen((req, res) => {
      req.on("data", (chunk) => (receivedBody += chunk));
      req.on("end", () => res.writeHead(200).end());
    });
    process.env["SIGNAL_SPINE_URL"] = `http://127.0.0.1:${port}`;
    process.env["SIGNAL_SPINE_TOKEN"] = "tok";
    process.env["SIGNAL_PROJECT"] = "portfolio";

    await emitSignal("workflow-step-failed", "job failed");

    expect(JSON.parse(receivedBody).project).toBe("portfolio");
  });

  it("uses event options on the wire and gives repeated events distinct fingerprints", async () => {
    const received: Record<string, unknown>[] = [];
    const port = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    process.env["SIGNAL_SPINE_URL"] = `http://127.0.0.1:${port}`;
    process.env["SIGNAL_SPINE_TOKEN"] = "tok";

    const opts = {
      kind: "event" as const,
      severity: "info" as const,
      type: "app-exception",
      key: "digest",
      sections: [{ label: "Filed", value: "2" }],
      links: [{ label: "Open", url: "https://example.test" }],
      target: "C123",
    };
    await emitSignal("digest-run", "Saga ran the digest", undefined, opts);
    await emitSignal("digest-run", "Saga ran the digest", undefined, opts);

    expect(received[0]).toMatchObject({
      kind: "event", type: "app-exception", severity: "info", raw: { key: "digest" },
      sections: opts.sections, links: opts.links, target: "C123",
    });
    expect(received[0]?.["fingerprint"]).not.toBe(received[1]?.["fingerprint"]);
  });

  it("falls back to summary as body when no detail is given", async () => {
    let receivedBody = "";
    const port = await listen((req, res) => {
      req.on("data", (chunk) => (receivedBody += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    process.env["SIGNAL_SPINE_URL"] = `http://127.0.0.1:${port}`;
    process.env["SIGNAL_SPINE_TOKEN"] = "tok";

    await emitSignal("action-failed", "the CRM write failed");

    const body = JSON.parse(receivedBody);
    expect(body.body).toBe("the CRM write failed");
  });

  it("emits a report with caller-supplied anatomy and a stable fingerprint key", async () => {
    const bodies: Record<string, unknown>[] = [];
    const port = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200).end("ok");
      });
    });
    process.env["SIGNAL_SPINE_URL"] = `http://127.0.0.1:${port}`;
    process.env["SIGNAL_SPINE_TOKEN"] = "tok";
    const options = {
      kind: "report" as const, type: "user-feedback" as const, severity: "info" as const,
      key: "daily", fingerprintKey: "user-feedback|daily",
      sections: [{ label: "Needs a home", value: "Suggests reads · unclear" }],
      links: [{ label: "Commercial radar", url: "https://slack.com/app_redirect?channel=sales" }],
      target: "D123",
    };

    await expect(emitSignal("daily-digest", "Digest · 1 needs a home", "fallback", options)).resolves.toBe(true);
    await emitSignal("daily-digest", "A changed headline", "changed", options);

    expect(bodies[0]).toMatchObject({
      kind: "report", type: "user-feedback", severity: "info", source: "eve-saga",
      project: "lares", title: "Digest · 1 needs a home", target: "D123", raw: { key: "daily" },
      sections: options.sections, links: options.links,
    });
    expect(bodies[0]!.fingerprint).toBe(bodies[1]!.fingerprint);
  });

  it("never throws or rejects when the connection is refused", async () => {
    const port = await listen((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    process.env["SIGNAL_SPINE_URL"] = `http://127.0.0.1:${port}`;
    process.env["SIGNAL_SPINE_TOKEN"] = "tok";

    await expect(emitSignal("workflow-step-failed", "job failed")).resolves.toBeUndefined();
  });

  it("never throws when the spine responds non-2xx", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("bad");
    });
    process.env["SIGNAL_SPINE_URL"] = `http://127.0.0.1:${port}`;
    process.env["SIGNAL_SPINE_TOKEN"] = "tok";

    await expect(emitSignal("workflow-step-failed", "job failed")).resolves.toBeUndefined();
  });

  it("reads the bearer token from SIGNAL_SPINE_TOKEN_FILE when set (ORB-178)", async () => {
    // The token is cached per process (module-local), so this needs its own module instance
    // rather than the top-level `emitSignal` import the rest of this file shares.
    let receivedAuth: string | undefined;
    const port = await listen((req, res) => {
      receivedAuth = req.headers["authorization"] as string | undefined;
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    const dir = mkdtempSync(join(tmpdir(), "eve-saga-signal-token-"));
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "  file-secret-token  \n");

    process.env["SIGNAL_SPINE_URL"] = `http://127.0.0.1:${port}`;
    delete process.env["SIGNAL_SPINE_TOKEN"];
    process.env["SIGNAL_SPINE_TOKEN_FILE"] = tokenPath;

    try {
      vi.resetModules();
      const { emitSignal: emitSignalFresh } = await import("../lib/signal-emit.js");
      await emitSignalFresh("workflow-step-failed", "job failed");
      expect(receivedAuth).toBe("Bearer file-secret-token");
    } finally {
      delete process.env["SIGNAL_SPINE_TOKEN_FILE"];
      rmSync(dir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("degrades to a log line and does not reject when SIGNAL_SPINE_TOKEN_FILE points at a missing file (fix round 1)", async () => {
    // The never-throws contract is emitSignal's, not spineToken()'s — ~15 schedule call sites
    // await emitSignal from inside a bare `catch`, so a rejection here would be an unhandled
    // rejection on top of the failure being reported.
    const missingPath = join(tmpdir(), "eve-saga-signal-token-missing-" + Date.now(), "token");

    process.env["SIGNAL_SPINE_URL"] = "https://spine.invalid";
    delete process.env["SIGNAL_SPINE_TOKEN"];
    process.env["SIGNAL_SPINE_TOKEN_FILE"] = missingPath;

    try {
      vi.resetModules();
      const { emitSignal: emitSignalFresh } = await import("../lib/signal-emit.js");
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(emitSignalFresh("workflow-step-failed", "job failed")).resolves.toBeUndefined();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes(missingPath))).toBe(true);
    } finally {
      delete process.env["SIGNAL_SPINE_TOKEN_FILE"];
      vi.resetModules();
    }
  });

  it("degrades to a log line and does not reject when SIGNAL_SPINE_TOKEN_FILE is blank — never falls back to the plain env var (fix round 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eve-saga-signal-token-blank-"));
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "   \n");

    process.env["SIGNAL_SPINE_URL"] = "https://spine.invalid";
    process.env["SIGNAL_SPINE_TOKEN"] = "should-never-be-used";
    process.env["SIGNAL_SPINE_TOKEN_FILE"] = tokenPath;

    try {
      vi.resetModules();
      const { emitSignal: emitSignalFresh } = await import("../lib/signal-emit.js");
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(emitSignalFresh("workflow-step-failed", "job failed")).resolves.toBeUndefined();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes(tokenPath))).toBe(true);
    } finally {
      delete process.env["SIGNAL_SPINE_TOKEN_FILE"];
      rmSync(dir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("does NOT cache a failed read — a file that starts missing and then appears is picked up on the very next call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eve-saga-signal-token-retry-"));
    const tokenPath = join(dir, "token"); // does not exist yet

    let receivedAuth: string | undefined;
    const port = await listen((req, res) => {
      receivedAuth = req.headers["authorization"] as string | undefined;
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    process.env["SIGNAL_SPINE_URL"] = `http://127.0.0.1:${port}`;
    delete process.env["SIGNAL_SPINE_TOKEN"];
    process.env["SIGNAL_SPINE_TOKEN_FILE"] = tokenPath;

    try {
      vi.resetModules();
      const { emitSignal: emitSignalFresh } = await import("../lib/signal-emit.js");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchSpy = vi.spyOn(globalThis, "fetch"); // spy only — calls through

      await emitSignalFresh("workflow-step-failed", "job failed");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();

      writeFileSync(tokenPath, "now-present\n");
      await emitSignalFresh("workflow-step-failed", "job failed");
      expect(receivedAuth).toBe("Bearer now-present");
    } finally {
      delete process.env["SIGNAL_SPINE_TOKEN_FILE"];
      rmSync(dir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
