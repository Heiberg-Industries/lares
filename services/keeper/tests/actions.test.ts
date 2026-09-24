import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerAction, resetActions, runAction, RESERVED_ACTIONS, KeeperRefusedError, type AuditRecord } from "../lib/actions.js";
beforeEach(resetActions);
const context = () => ({ actor: "owner@example.com", audit: vi.fn(async (_r: AuditRecord) => { }) });
it("persists intent before execution and finalizes the same operation", async () => {
  const c = context();
  registerAction({ name: "echo", input: z.object({ s: z.string() }), run: async (i) => {
      expect(c.audit).toHaveBeenCalledTimes(1);
      expect(c.audit.mock.calls[0][0].outcome).toBe("pending");
      return i;
    } });
  await expect(runAction("echo", { s: "hi" }, c)).resolves.toEqual({ s: "hi" });
  expect(c.audit.mock.calls.map(([r]) => r.outcome)).toEqual(["pending", "ok"]);
  expect(c.audit.mock.calls[0][0].operationId).toBe(c.audit.mock.calls[1][0].operationId);
});
it("fails closed when intent cannot be persisted", async () => {
  const run = vi.fn();
  registerAction({ name: "echo", input: z.object({}), run });
  const c = context();
  c.audit.mockRejectedValue(new Error("credential-secret"));
  await expect(runAction("echo", {}, c)).rejects.toThrow("audit unavailable");
  expect(run).not.toHaveBeenCalled();
});
it("reports uncertain completion without rerunning or overwriting the pending row", async () => {
  const run = vi.fn(async () => 1);
  registerAction({ name: "echo", input: z.object({}), run });
  const c = context();
  c.audit.mockResolvedValueOnce().mockRejectedValue(new Error("secret"));
  await expect(runAction("echo", {}, c)).rejects.toThrow("outcome uncertain");
  expect(run).toHaveBeenCalledTimes(1);
  expect(c.audit).toHaveBeenCalledTimes(2);
});
it("audits unknown, reserved and host-only refusals", async () => {
  const c = context();
  expect(RESERVED_ACTIONS).toContain("update");
  await expect(runAction("rm", { secret: "token" }, c)).rejects.toThrow("unknown action");
  await expect(runAction("update", {}, c)).rejects.toThrow("not available in this release");
  registerAction({ name: "host.test", hostOnly: true, input: z.object({}), run: async () => 1 });
  await expect(runAction("host.test", {}, c)).rejects.toThrow("host command");
  expect(c.audit.mock.calls.every(([r]) => r.outcome === "refused")).toBe(true);
  await expect(runAction("host.test", {}, c, { host: true })).resolves.toBe(1);
});
it("redacts secrets, extra fields, validation text and thrown exceptions", async () => {
  const c = context();
  const run = vi.fn(async () => {
    throw new Error("token-secret");
  });
  registerAction({ name: "secret.set", input: z.object({ name: z.string(), value: z.string().refine(() => false, "token-secret") }), secretFields: ["value"], run });
  await expect(runAction("secret.set", { name: "key", value: "token-secret", extra: "token-secret" }, c)).rejects.toThrow("invalid input");
  expect(run).not.toHaveBeenCalled();
  expect(JSON.stringify(c.audit.mock.calls)).not.toContain("token-secret");
  resetActions();
  registerAction({ name: "secret.set", input: z.object({ name: z.string(), value: z.string() }), secretFields: ["value"], run });
  await expect(runAction("secret.set", { name: "key", value: "token-secret", extra: "token-secret" }, c)).rejects.toThrow("action failed");
  expect(JSON.stringify(c.audit.mock.calls)).not.toContain("token-secret");
  expect(c.audit.mock.calls.at(-1)![0]).toMatchObject({ outcome: "failed", input: { name: "key", value: "<redacted>" } });
});
it("rejects duplicate registrations", () => {
  const a = { name: "test", input: z.object({}), run: async () => null };
  registerAction(a);
  expect(() => registerAction(a)).toThrow("twice");
});
it("preserves trusted refusal findings but redacts marked secrets", async () => {
  const c = context();
  registerAction({
    name: "validate",
    input: z.object({ value: z.string() }),
    secretFields: ["value"],
    run: async () => { throw new KeeperRefusedError("invalid model token-secret", [{ check: "model-alias", message: "Choose a model; token-secret is private" }]); },
  });
  let error: unknown;
  try { await runAction("validate", { value: "token-secret" }, c); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(KeeperRefusedError);
  expect((error as KeeperRefusedError).findings?.[0].check).toBe("model-alias");
  expect(JSON.stringify(error)).not.toContain("token-secret");
  expect((error as Error).message).not.toContain("token-secret");
  expect(c.audit.mock.calls.at(-1)![0].outcome).toBe("refused");
  expect(JSON.stringify(c.audit.mock.calls)).not.toContain("token-secret");
});
