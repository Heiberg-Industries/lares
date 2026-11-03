import { describe, it, expect, vi } from "vitest";
import { agentNotRunning, notRunningSay } from "../lib/agent-reachability";

const answer = (status: number, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response("x", { status, headers })) as unknown as typeof fetch;

describe("agentNotRunning", () => {
  it("is true only for the proxy's own not-running mark", async () => {
    expect(await agentNotRunning("helper", answer(502, { "x-lares-agent-state": "not-running" }))).toBe(true);
    expect(await agentNotRunning("helper", answer(404, { "x-lares-agent-state": "not-running" }))).toBe(true);
  });
  it("is false for an access refusal, a healthy agent, or no answer", async () => {
    expect(await agentNotRunning("helper", answer(403))).toBe(false);
    expect(await agentNotRunning("helper", answer(200))).toBe(false);
    expect(await agentNotRunning("helper", vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe(false);
  });
  it("asks the agent's health route once, through the console", async () => {
    const f = answer(200);
    await agentNotRunning("helper", f);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toBe("/api/chat/helper/eve/v1/health");
  });
  it("words the failure with the start command", () => {
    expect(notRunningSay("Helper", "helper")).toBe("Helper is not running right now. On the server, run: sudo lares agent start helper");
  });
});
