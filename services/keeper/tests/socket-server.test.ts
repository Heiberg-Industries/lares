import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerAction, resetActions, KeeperRefusedError, type AuditRecord } from "../lib/actions.js";
import { serve, MAX_REQUEST_BYTES } from "../lib/socket-server.js";
let dir: string;
let stop: (() => Promise<void>) | undefined;
const ownership = { uid: process.getuid!(), gid: process.getgid!() };
const audit = vi.fn(async (_r: AuditRecord) => { });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "keeper-"));
  resetActions();
  audit.mockReset();
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  await rm(dir, { recursive: true, force: true });
});
async function start(host = false) {
  const socket = join(dir, "keeper.sock");
  stop = await serve({ socket, host, context: { actor: "unused", audit }, ownership });
  return socket;
}
function request(path: string, data: string, halfClose = false): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = createConnection(path);
    let response = "";
    client.setTimeout(5000, () => {
      client.destroy();
      reject(new Error("timeout"));
    });
    client.on("error", reject);
    client.on("connect", () => halfClose ? client.end(data) : client.write(data));
    client.on("data", chunk => {
      response += chunk;
      if (response.includes("\n")) {
        client.destroy();
        resolve(JSON.parse(response.split("\n")[0]));
      }
    });
  });
}
it("runs real socket requests, enforces mode and propagates verified actor", async () => {
  registerAction({ name: "echo", input: z.object({ s: z.string() }), run: async (i, c) => ({ ...i, actor: c.actor }) });
  const socket = await start();
  expect((await stat(socket)).mode & 0o777).toBe(0o660);
  expect(await request(socket, JSON.stringify({ action: "echo", input: { s: "hello" }, actor: "owner@example.com" }) + "\n")).toEqual({ ok: true, result: { s: "hello", actor: "owner@example.com" } });
});
it("forces host actor and restricts host-only actions", async () => {
  registerAction({ name: "host.test", hostOnly: true, input: z.object({}), run: async (_, c) => c.actor });
  let socket = await start();
  expect((await request(socket, JSON.stringify({ action: "host.test", actor: "owner@example.com" }) + "\n")).ok).toBe(false);
  await stop!();
  stop = undefined;
  socket = await start(true);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect(await request(socket, JSON.stringify({ action: "host.test", actor: "owner@example.com" }) + "\n")).toEqual({ ok: true, result: "host" });
  expect(await request(socket, JSON.stringify({ action: "host.test", actor: "host" }) + "\n")).toEqual({ ok: true, result: "host" });
});
it("audits malformed, missing actor, oversized and incomplete requests without leaking payload", async () => {
  const socket = await start();
  for (const [data, half] of [["secret-token\n", false], [JSON.stringify({ action: "echo", input: "secret-token" }) + "\n", false], ["x".repeat(MAX_REQUEST_BYTES + 1), false], ["secret-token", true]] as const) {
    expect((await request(socket, data, half)).ok).toBe(false);
  }
  expect(audit).toHaveBeenCalledTimes(4);
  expect(audit.mock.calls.every(([r]) => r.outcome === "refused")).toBe(true);
  expect(JSON.stringify(audit.mock.calls)).not.toContain("secret-token");
});
it("handles split frames and multiple requests in order", async () => {
  let n = 0;
  registerAction({ name: "count", input: z.object({}), run: async () => ++n });
  const socket = await start(true);
  await new Promise<void>((resolve, reject) => {
    const client = createConnection(socket);
    let out = "";
    client.on("error", reject);
    client.on("connect", () => {
      client.write('{"action":');
      setTimeout(() => client.write('"count"}\n{"action":"count"}\n'), 5);
    });
    client.on("data", chunk => {
      out += chunk;
      if (out.trim().split("\n").length === 2) {
        expect(out.trim().split("\n").map(s => JSON.parse(s).result)).toEqual([1, 2]);
        client.destroy();
        resolve();
      }
    });
  });
});
it("fails closed when audit storage fails and does not unlink a live socket", async () => {
  const run = vi.fn(async () => 1);
  registerAction({ name: "work", input: z.object({}), run });
  const socket = await start(true);
  await expect(serve({ socket, host: true, context: { actor: "host", audit }, ownership })).rejects.toThrow("startup failed");
  audit.mockRejectedValue(new Error("secret-token"));
  const response = await request(socket, '{"action":"work"}\n');
  expect(response.ok).toBe(false);
  expect(response.error).not.toContain("secret-token");
  expect(run).not.toHaveBeenCalled();
});
it("never returns serializer exception text after an audited action", async () => {
  registerAction({
    name: "serialize",
    input: z.object({}),
    run: async () => ({ toJSON() { throw new Error("serializer-secret"); } }),
  });
  const socket = await start(true);
  const response = await request(socket, '{"action":"serialize"}\n');
  expect(response.ok).toBe(false);
  expect(response.error).toContain("may have completed");
  expect(response.error).not.toContain("serializer-secret");
  expect(audit.mock.calls.map(([r]) => r.outcome)).toEqual(["pending", "ok"]);
});

it("recovers an owned socket after SIGKILL and refuses a regular file", async () => {
  const socket = join(dir, "keeper.sock");
  const child = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1],()=>process.send('ready'))", socket], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("test listener exited before readiness")));
    });
    const killed = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await killed;
    expect((await stat(socket)).isSocket()).toBe(true);
    await start(true);
    expect((await request(socket, '{"action":"update"}\n')).error).toContain("not available in this release");
    await stop!();
    stop = undefined;
    await writeFile(socket, "keep me");
    await expect(start(true)).rejects.toThrow("startup failed");
    expect(await readFile(socket, "utf8")).toBe("keep me");
  } finally {
    child.kill("SIGKILL");
  }
});

it("transports trusted structured refusal findings and audits refusal", async () => {
  registerAction({name: "validate", input: z.object({}), run: async () => {
    throw new KeeperRefusedError("invalid model", [{check: "model-alias", message: "Choose an available model"}]);
  }});
  const socket = await start(true);
  expect(await request(socket, '{"action":"validate","actor":"host"}\n')).toEqual({ok:false,error:"invalid model",findings:[{check:"model-alias",message:"Choose an available model"}]});
  expect(audit.mock.calls.at(-1)![0].outcome).toBe("refused");
});

it.each([
  ["malformed", "not-json\n"],
  ["oversized", "x".repeat(MAX_REQUEST_BYTES + 1)],
])("makes a %s protocol rejection terminal for half-open clients", async (_kind, invalid) => {
  const run = vi.fn(async () => "must not run");
  registerAction({ name: "after.reject", input: z.object({}), run });
  const socket = await start(true);
  const client = createConnection({ path: socket, allowHalfOpen: true });
  let response = "";
  client.on("error", () => {}); // A terminal peer may reject the attempted post-EOF write.
  try {
    await new Promise<void>((resolve, reject) => {
      client.setTimeout(2000, () => reject(new Error("refusal response timed out")));
      client.once("connect", () => client.write(invalid));
      client.on("data", chunk => { response += chunk; });
      client.once("end", resolve);
    });
    expect(JSON.parse(response.trim()).ok).toBe(false);
    client.write('{"action":"after.reject"}\n');
    // Keep the write side open long enough for the original bug to dispatch the frame.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(run).not.toHaveBeenCalled();
    expect(audit.mock.calls.map(([record]) => record.outcome)).toEqual(["refused"]);
  } finally {
    client.destroy();
  }
});
