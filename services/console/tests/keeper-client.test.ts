import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keeper, keeperFailureText, keeperReferenceText, KeeperFailedError, KeeperUnavailableError, KEEPER_FAILURE_STATES } from "../lib/keeper-client";

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
      const encoded = Buffer.from(`${JSON.stringify({ ok: true, result: { name: "Test Owner" } })}\n`);
      const split = encoded.indexOf(Buffer.from("Ø")) + 1;
      socket.write(encoded.subarray(0, split));
      setTimeout(() => socket.end(encoded.subarray(split)), 1);
    });

    await expect(keeper<{ name: string }>("definition.list", {}, "b@h.co")).resolves.toEqual({ name: "Test Owner" });
  });

  it("turns a refusal into a typed error carrying every finding and its server message", async () => {
    const findings = [
      { check: "model-alias", message: "Choose an available model" },
      { check: "door", message: "Connect Slack first" },
    ];
    await fakeKeeper((_request, socket) => reply(socket, { ok: false, outcome:"refused", error: "invalid definition", findings }));

    await expect(keeper("definition.save", {}, "b@h.co")).rejects.toMatchObject({
      name: "KeeperRefusedError", message: "invalid definition", findings,
    });
  });

  it("preserves a generic action failure without claiming that its effects were rolled back", async () => {
    await fakeKeeper((_request, socket) => reply(socket, {
      ok: false,
      outcome:"unknown",
      error: "keeper could not confirm the action outcome",
    }));

    await expect(keeper("definition.save", {}, "b@h.co")).rejects.toMatchObject({
      name: "KeeperUnavailableError",
      outcomeMayBeUnknown:true,
      message: expect.stringContaining("refresh before trying again"),
    });
  });

  const REFERENCE = "3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b";

  it("passes on the reference the keeper sent with an unknown outcome", async () => {
    await fakeKeeper((_request, socket) => reply(socket, {
      ok: false, outcome: "unknown", error: "keeper could not confirm the action outcome", reference: REFERENCE,
    }));

    await expect(keeper("definition.save", {}, "b@h.co")).rejects.toMatchObject({
      name: "KeeperUnavailableError", outcomeMayBeUnknown: true, reference: REFERENCE,
      message: "keeper could not confirm the action outcome; refresh before trying again",
    });
  });

  it.each(KEEPER_FAILURE_STATES)("turns a failure the keeper can explain into a typed error with its message, state (%s) and reference", async (state) => {
    await fakeKeeper((_request, socket) => reply(socket, {
      ok: false, outcome: "failed", error: "Apply failed. Hand-written reason.", state, reference: REFERENCE,
    }));

    const error = await keeper("definition.reconcile", {}, "b@h.co").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeeperFailedError);
    expect(error).not.toBeInstanceOf(KeeperUnavailableError);
    expect(error).toMatchObject({ name: "KeeperFailedError", message: "Apply failed. Hand-written reason.", state, reference: REFERENCE });
  });

  it.each([
    ["a state outside the closed set", { state: "running-fine", reference: REFERENCE }],
    ["a state that is not a string", { state: 1, reference: REFERENCE }],
    ["no state", { reference: REFERENCE }],
    ["no reference", { state: "previous-running" }],
    ["a reference that is not an operation id", { state: "previous-running", reference: "see /etc/lares/secrets" }],
    ["a reference that is not a string", { state: "previous-running", reference: { id: REFERENCE } }],
  ])("rejects a failed reply with %s as an invalid response, never as a failure it can explain", async (_label, fields) => {
    await fakeKeeper((_request, socket) => reply(socket, { ok: false, outcome: "failed", error: "Apply failed.", ...fields }));

    const error = await keeper("definition.reconcile", {}, "b@h.co").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(KeeperFailedError);
    expect(error).toMatchObject({
      name: "KeeperUnavailableError", outcomeMayBeUnknown: true,
      message: "keeper returned an invalid response; the action outcome may be unknown",
    });
  });

  it("rejects a failed reply without a message, an outcome outside the closed set, and a malformed reference on unknown", async () => {
    for (const body of [
      { ok: false, outcome: "failed", state: "previous-running", reference: REFERENCE },
      { ok: false, outcome: "broken", error: "Apply failed.", state: "previous-running", reference: REFERENCE },
      { ok: false, outcome: "unknown", error: "keeper could not confirm the action outcome", reference: "not-an-id" },
    ]) {
      await fakeKeeper((_request, socket) => reply(socket, body));
      await expect(keeper("definition.reconcile", {}, "b@h.co")).rejects.toMatchObject({
        name: "KeeperUnavailableError", outcomeMayBeUnknown: true,
        message: "keeper returned an invalid response; the action outcome may be unknown",
      });
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("writes the reason, the state the agent is left in and the reference into one line for the owner", () => {
    expect(keeperFailureText(new KeeperFailedError("Apply failed. The agent is back on the last definition that had taken effect; the changes that were waiting for Apply were undone. Save them again before retrying.", "previous-running", REFERENCE)))
      .toBe(`Apply failed. The agent is back on the last definition that had taken effect; the changes that were waiting for Apply were undone. Save them again before retrying. The previous definition is still running. Quote reference ${REFERENCE} if you ask for help.`);
    expect(keeperFailureText(new KeeperFailedError("Apply failed.", "restored-stopped", REFERENCE)))
      .toContain("The saved definition was restored, but the agent is stopped and needs recovery.");
    expect(keeperFailureText(new KeeperFailedError("Apply failed.", "recovery-required", REFERENCE)))
      .toContain("Nothing verified is available; recovery is required.");
    expect(keeperReferenceText(REFERENCE)).toBe(` Quote reference ${REFERENCE} if you ask for help.`);
    expect(keeperReferenceText(undefined)).toBe("");
  });

  it("treats an error response without an outcome discriminator as unknown",async()=>{
    await fakeKeeper((_request,socket)=>reply(socket,{ok:false,error:"legacy refusal"}));
    await expect(keeper("definition.save",{},"b@h.co")).rejects.toMatchObject({
      name:"KeeperUnavailableError",outcomeMayBeUnknown:true,
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
