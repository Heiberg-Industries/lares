// The real-install image check's stand-in model provider (real-install/fake-internet.mjs) refuses
// every key but the one it was started with, the way the real provider does: HTTP 401 and the JSON
// body measured by tests/live/provider-models.live.mts. Without that, a dead key would pass the
// image check. Run here on a spare local port with a throwaway certificate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STAND_IN = join(dirname(fileURLToPath(import.meta.url)), "real-install", "fake-internet.mjs");
const KEY = "sk-ant-api03-stand-in-fixture-key";
const REFUSAL = { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } };

let dir = "", port = 0, child: ChildProcess | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port: found } = server.address() as net.AddressInfo;
      server.close(() => resolve(found));
    }).on("error", reject);
  });
}

function ask(method: string, path: string, key: string | undefined, body?: string): Promise<{ status: number; type: string; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: "127.0.0.1", port, method, path, servername: "api.anthropic.com", ca: readFileSync(join(dir, "server.pem")),
      headers: { host: "api.anthropic.com", "content-type": "application/json", "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, type: String(response.headers["content-type"]), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "stand-in-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api.anthropic.com", "-addext", "subjectAltName=DNS:api.anthropic.com",
    "-keyout", join(dir, "server-key.pem"), "-out", join(dir, "server.pem")], { stdio: "ignore" });
  port = await freePort();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ providerKey: KEY, port }));
  writeFileSync(join(dir, "calls.jsonl"), "");
  child = spawn(process.execPath, [STAND_IN, "serve", dir], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => { socket.end(); resolve(true); }).on("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the stand-in did not start");
}, 30_000);

afterAll(() => {
  child?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the stand-in model provider", () => {
  it("refuses a wrong or missing key on the model list and on a completion, with the provider's own status and body", async () => {
    const message = JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    for (const key of ["sk-ant-api03-some-other-key", undefined]) {
      for (const [method, path, body] of [["GET", "/v1/models", undefined], ["POST", "/v1/messages", message]] as const) {
        const answer = await ask(method, path, key, body);
        expect(answer.status).toBe(401);
        expect(answer.type).toBe("application/json");
        expect(answer.body).toEqual(REFUSAL);
      }
    }
  });

  it("accepts the key it was started with, and records only whether the model list's key was accepted", async () => {
    const answer = await ask("GET", "/v1/models", KEY);
    expect(answer.status).toBe(200);
    expect(Array.isArray((answer.body as { data?: unknown }).data)).toBe(true);
    const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; accepted?: boolean });
    expect(calls.filter((call) => call.kind === "models").map((call) => call.accepted)).toEqual([false, false, true]);
    expect(readFileSync(join(dir, "calls.jsonl"), "utf8")).not.toContain(KEY);
  });
});
