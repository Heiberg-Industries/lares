import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keeper, KeeperUnavailableError } from "../lib/keeper-client";

const MAX_MESSAGE_BYTES = 256 * 1024;
let server: Server | undefined;
let socketDir: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
  server = undefined;
  if (socketDir) await rm(socketDir, { recursive: true, force: true });
  socketDir = undefined;
});

async function fakeKeeper(handle: (request: unknown, socket: Socket) => void): Promise<void> {
  socketDir = await mkdtemp(join(tmpdir(), "keeper-client-"));
  const path = join(socketDir, "keeper.sock");
  server = createServer(socket => {
    let request = Buffer.alloc(0);
    socket.on("data", chunk => {
      request = Buffer.concat([request, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      const end = request.indexOf(10);
      if (end >= 0) handle(JSON.parse(request.subarray(0, end).toString("utf8")), socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(path, () => {
      server!.off("error", reject);
      resolve();
    });
  });
  vi.stubEnv("LARES_KEEPER_SOCKET", path);
}

function reply(socket: Socket, body: unknown): void {
  socket.end(`${JSON.stringify(body)}\n`);
}

describe("the keeper client", () => {
  it("passes action, input, and the signed-in owner as the actor", async () => {
    let seen: unknown;
    await fakeKeeper((request, socket) => {
      seen = request;
      reply(socket, { ok: true, result: { n: 1 } });
    });

    await expect(keeper("definition.list", { a: 1 }, "owner@owner.example")).resolves.toEqual({ n: 1 });
    expect(seen).toEqual({ action: "definition.list", input: { a: 1 }, actor: "owner@owner.example" });
  });

  it("accumulates byte fragments before decoding a UTF-8 response", async () => {
    await fakeKeeper((_request, socket) => {
      const encoded = Buffer.from(`${JSON.stringify({ ok: true, result: { name: "Bendik Østby" } })}\n`);
      const split = encoded.indexOf(Buffer.from("Ø")) + 1;
      socket.write(encoded.subarray(0, split));
      setTimeout(() => socket.end(encoded.subarray(split)), 1);
    });

    await expect(keeper<{ name: string }>("definition.list", {}, "b@h.co")).resolves.toEqual({ name: "Bendik Østby" });
  });

  it("turns a refusal into a typed error carrying every finding and its server message", async () => {
    const findings = [
      { check: "model-alias", message: "Choose an available model" },
      { check: "door", message: "Connect Slack first" },
    ];
    await fakeKeeper((_request, socket) => reply(socket, { ok: false, error: "invalid definition", findings }));

    await expect(keeper("definition.save", {}, "b@h.co")).rejects.toMatchObject({
      name: "KeeperRefusedError", message: "invalid definition", findings,
    });
  });

  it("preserves a generic action failure without claiming that its effects were rolled back", async () => {
    await fakeKeeper((_request, socket) => reply(socket, {
      ok: false,
      error: "keeper: response serialization failed; action may have completed",
    }));

    await expect(keeper("definition.save", {}, "b@h.co")).rejects.toMatchObject({
      name: "KeeperRefusedError",
      message: "keeper: response serialization failed; action may have completed",
    });
  });

  it("says an unreachable keeper is unavailable, never an empty result", async () => {
    vi.stubEnv("LARES_KEEPER_SOCKET", "/nonexistent/keeper.sock");
    await expect(keeper("definition.list", {}, "b@h.co")).rejects.toBeInstanceOf(KeeperUnavailableError);
  });

  it("times out when the keeper withholds a reply and marks the outcome unknown after transmission", async () => {
    await fakeKeeper(() => { /* deliberately withhold every reply */ });

    await expect(keeper("definition.list", {}, "b@h.co", { timeoutMs: 20 })).rejects.toMatchObject({
      name: "KeeperUnavailableError", outcomeMayBeUnknown: true,
      message: expect.stringMatching(/outcome may be unknown/i),
    });
  });

  it("rejects malformed and oversized replies instead of returning guessed data", async () => {
    await fakeKeeper((_request, socket) => socket.end("not json\n"));
    await expect(keeper("definition.list", {}, "b@h.co")).rejects.toThrow(/invalid response/i);

    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    await fakeKeeper((_request, socket) => socket.end(`${JSON.stringify({ ok: true, result: "x".repeat(MAX_MESSAGE_BYTES) })}\n`));
    await expect(keeper("definition.list", {}, "b@h.co")).rejects.toThrow(/response too large/i);
  });

  it("reports an unknown outcome when the keeper closes after receiving the request", async () => {
    await fakeKeeper((_request, socket) => socket.destroy());
    await expect(keeper("definition.save", {}, "b@h.co")).rejects.toMatchObject({
      name: "KeeperUnavailableError", outcomeMayBeUnknown: true,
      message: expect.stringMatching(/outcome may be unknown/i),
    });
  });

  it("does not transmit a request above the keeper's 256 KiB line limit", async () => {
    let connections = 0;
    await fakeKeeper((_request, socket) => reply(socket, { ok: true, result: null }));
    server!.on("connection", () => { connections += 1; });

    await expect(keeper("definition.save", { blob: "x".repeat(MAX_MESSAGE_BYTES) }, "b@h.co"))
      .rejects.toThrow(/request too large/i);
    expect(connections).toBe(0);
  });
});
