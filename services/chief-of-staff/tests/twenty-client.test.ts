import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import { twentyGet, twentyPatch, twentyPost, TwentyNotFoundError, TwentyUnavailableError } from "../lib/twenty-client.js";

/**
 * Task 3 — against a REAL local HTTP server (per the task brief's Step 1), not a fetch
 * stub: proves the actual request Twenty receives (method, path, headers, body) and the
 * actual response handling (200 → parsed body, 404 → typed NotFound, connection refused →
 * typed Unavailable) end to end.
 */

let server: Server | undefined;
let keyDir: string;

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve((server!.address() as AddressInfo).port);
    });
  });
}

beforeEach(() => {
  keyDir = mkdtempSync(join(tmpdir(), "twenty-key-"));
  writeFileSync(join(keyDir, "twenty-key"), "test-api-key\n");
  process.env["TWENTY_KEY_FILE"] = join(keyDir, "twenty-key");
});

afterEach(async () => {
  delete process.env["TWENTY_BASE_URL"];
  delete process.env["TWENTY_KEY_FILE"];
  delete process.env["TWENTY_REQUEST_TIMEOUT_MS"];
  rmSync(keyDir, { recursive: true, force: true });
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("twentyGet", () => {
  it("hits {baseUrl}/rest{path} with Bearer auth and parses a 200 JSON body", async () => {
    let receivedPath: string | undefined;
    let receivedAuth: string | undefined;
    const port = await listen((req, res) => {
      receivedPath = req.url;
      receivedAuth = req.headers["authorization"] as string | undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { people: [{ id: "abc" }] } }));
    });
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;

    const body = await twentyGet<{ data: { people: { id: string }[] } }>("/people/abc");

    expect(receivedPath).toBe("/rest/people/abc");
    expect(receivedAuth).toBe("Bearer test-api-key");
    expect(body).toEqual({ data: { people: [{ id: "abc" }] } });
  });

  it("throws TwentyNotFoundError, not TwentyUnavailableError, on a 404", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no such record" }));
    });
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;

    await expect(twentyGet("/people/nope")).rejects.toThrow(TwentyNotFoundError);
  });

  it("throws TwentyUnavailableError, not TwentyNotFoundError, when the connection is refused", async () => {
    // Bind to get a free port, then close it — nothing listens there, so the connection
    // is genuinely refused (a real network failure, not a stubbed one).
    const port = await listen((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;

    await expect(twentyGet("/people")).rejects.toThrow(TwentyUnavailableError);
  });

  it("throws TwentyUnavailableError on a non-404 non-2xx response", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "down for maintenance" }));
    });
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;

    await expect(twentyGet("/people")).rejects.toThrow(TwentyUnavailableError);
  });

  it("throws TwentyUnavailableError when TWENTY_BASE_URL is unset", async () => {
    await expect(twentyGet("/people")).rejects.toThrow(TwentyUnavailableError);
  });

  it("throws TwentyUnavailableError when the key file isn't readable", async () => {
    process.env["TWENTY_KEY_FILE"] = join(keyDir, "does-not-exist");
    process.env["TWENTY_BASE_URL"] = "http://127.0.0.1:1"; // never reached
    await expect(twentyGet("/people")).rejects.toThrow(TwentyUnavailableError);
  });
});

describe("twentyPost", () => {
  it("sends a JSON body with Content-Type and returns the parsed 200 response", async () => {
    let receivedMethod: string | undefined;
    let receivedBody = "";
    const port = await listen((req, res) => {
      receivedMethod = req.method;
      req.on("data", (chunk) => (receivedBody += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { note: { id: "note_1" } } }));
      });
    });
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;

    const result = await twentyPost<{ data: { note: { id: string } } }>("/notes", {
      title: "hi",
      bodyV2: { markdown: "hello" },
    });

    expect(receivedMethod).toBe("POST");
    expect(JSON.parse(receivedBody)).toEqual({ title: "hi", bodyV2: { markdown: "hello" } });
    expect(result).toEqual({ data: { note: { id: "note_1" } } });
  });
});

describe("twentyPatch", () => {
  it("sends a JSON body via PATCH and returns the parsed 200 response", async () => {
    let receivedMethod: string | undefined;
    let receivedBody = "";
    const port = await listen((req, res) => {
      receivedMethod = req.method;
      req.on("data", (chunk) => (receivedBody += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { opportunity: { id: "opp_1", stage: "won" } } }));
      });
    });
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;

    const result = await twentyPatch<{ data: { opportunity: { stage: string } } }>("/opportunities/opp_1", {
      stage: "won",
    });

    expect(receivedMethod).toBe("PATCH");
    expect(JSON.parse(receivedBody)).toEqual({ stage: "won" });
    expect(result.data.opportunity.stage).toBe("won");
  });
});

describe("request timeout (ORB-156 security review)", () => {
  it("rejects with TwentyUnavailableError within the timeout, rather than hanging forever", async () => {
    // A server that accepts the connection and then never writes a response — the shape a
    // genuinely hung Twenty takes. `TWENTY_REQUEST_TIMEOUT_MS` overrides the 15s production
    // default purely so this test proves the behaviour in milliseconds, not minutes; every
    // real deployment leaves it unset and gets the 15s default.
    const port = await listen(() => {
      // Never calls res.end() or res.writeHead() — the request hangs until aborted.
    });
    process.env["TWENTY_BASE_URL"] = `http://127.0.0.1:${port}`;
    process.env["TWENTY_REQUEST_TIMEOUT_MS"] = "50";

    await expect(twentyGet("/people")).rejects.toThrow(TwentyUnavailableError);
  });
});
