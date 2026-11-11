import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerAction, resetActions, runAction, failureReference, RESERVED_ACTIONS, KeeperFailedError, KeeperOutcomeUncertainError, KeeperRefusedError, KeeperUnknownFailureError, KEEPER_FAILURE_STATES, type AuditRecord } from "../lib/actions.js";
import {registerInitialMemberBudgetActions} from '../lib/initial-member-budget.js';
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
const caught = async (work: Promise<unknown>): Promise<unknown> => { try { await work; } catch (error) { return error; } throw new Error("expected a rejection"); };
it.each(KEEPER_FAILURE_STATES)("keeps a typed failure's own message and state (%s) and returns the audit operation id as the reference", async (state) => {
  const c = context();
  registerAction({ name: "apply", input: z.object({}), run: async () => {
    throw new KeeperFailedError("Apply failed. Hand-written reason.", state, { cause: new Error("sk-live-9f8e7d6c5b4a") });
  } });
  const error = await caught(runAction("apply", {}, c));
  expect(error).toBeInstanceOf(KeeperFailedError);
  const operationId = c.audit.mock.calls[0][0].operationId;
  expect(operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(error).toMatchObject({ message: "Apply failed. Hand-written reason.", state, reference: operationId });
  expect(failureReference(error)).toBe(operationId);
  // The real cause stays inside the keeper: not on the error that leaves runAction, not in the audit.
  expect((error as Error).cause).toBeUndefined();
  expect(c.audit.mock.calls.at(-1)![0]).toMatchObject({ operationId, outcome: "failed", detail: `Apply failed. Hand-written reason. [${state}]` });
  expect(JSON.stringify(c.audit.mock.calls)).not.toContain("sk-live-9f8e7d6c5b4a");
});
it("scrubs marked secret input out of a typed failure's message", async () => {
  const c = context();
  registerAction({ name: "apply", input: z.object({ value: z.string() }), secretFields: ["value"], run: async (i) => {
    throw new KeeperFailedError(`Apply failed with ${i.value}.`, "recovery-required");
  } });
  const error = await caught(runAction("apply", { value: "token-secret" }, c));
  expect(error).toMatchObject({ message: "Apply failed with <redacted>.", state: "recovery-required" });
  expect(JSON.stringify(c.audit.mock.calls)).not.toContain("token-secret");
});
it("keeps the generic text for any other error, never its message, and still returns the reference", async () => {
  const c = context();
  registerAction({ name: "apply", input: z.object({}), run: async () => {
    throw new Error("connect failed: postgres://keeper:sk-live-9f8e7d6c5b4a@db/state");
  } });
  const error = await caught(runAction("apply", {}, c));
  expect(error).toBeInstanceOf(KeeperUnknownFailureError);
  expect(error).not.toBeInstanceOf(KeeperFailedError);
  const operationId = c.audit.mock.calls[0][0].operationId;
  expect(error).toMatchObject({ message: "keeper: action failed", reference: operationId });
  expect(failureReference(error)).toBe(operationId);
  expect(c.audit.mock.calls.at(-1)![0]).toMatchObject({ operationId, outcome: "failed", detail: "action failed" });
  expect(JSON.stringify(c.audit.mock.calls)).not.toContain("sk-live");
  expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toContain("sk-live");
});
it("gives an error that only looks like a typed failure the generic text", async () => {
  const c = context();
  registerAction({ name: "apply", input: z.object({}), run: async () => {
    throw Object.assign(new Error("sk-live-9f8e7d6c5b4a"), { name: "KeeperFailedError", state: "previous-running", reference: "forged" });
  } });
  const error = await caught(runAction("apply", {}, c));
  expect(error).toBeInstanceOf(KeeperUnknownFailureError);
  expect(error).toMatchObject({ message: "keeper: action failed", reference: c.audit.mock.calls[0][0].operationId });
});
it("returns the reference with an uncertain outcome and with a failed audit finalization", async () => {
  const c = context();
  registerAction({ name: "uncertain", input: z.object({}), run: async () => { throw new KeeperOutcomeUncertainError(); } });
  const uncertain = await caught(runAction("uncertain", {}, c));
  expect(uncertain).toBeInstanceOf(KeeperOutcomeUncertainError);
  expect(failureReference(uncertain)).toBe(c.audit.mock.calls[0][0].operationId);
  resetActions();
  registerAction({ name: "apply", input: z.object({}), run: async () => { throw new KeeperFailedError("Apply failed.", "previous-running"); } });
  const d = context();
  d.audit.mockResolvedValueOnce().mockRejectedValue(new Error("secret"));
  const unfinished = await caught(runAction("apply", {}, d));
  expect(unfinished).toMatchObject({ message: expect.stringContaining("outcome uncertain"), reference: d.audit.mock.calls[0][0].operationId });
  expect(unfinished).not.toBeInstanceOf(KeeperFailedError);
  expect(failureReference(new Error("keeper: audit unavailable; action not run"))).toBeUndefined();
});
it('registers initial-budget actions as unavailable without financial custody and redacts session authority',async()=>{
  const c=context();
  registerInitialMemberBudgetActions({pool:undefined,designatedOwnerId:'configured-owner'});
  await expect(runAction('member.initial-budget-status',{sessionToken:'a'.repeat(43)},c)).rejects.toMatchObject({
    findings:[{check:'member.initial-budget',message:'unavailable'}],
  });
  expect(JSON.stringify(c.audit.mock.calls)).not.toContain('a'.repeat(43));
  await expect(runAction('member.set-initial-budget',{sessionToken:'b'.repeat(43),targetMemberId:'member',monthlyLimit:'25'},c)).rejects.toMatchObject({
    findings:[{check:'member.initial-budget',message:'unavailable'}],
  });
  expect(JSON.stringify(c.audit.mock.calls)).not.toContain('b'.repeat(43));
  await expect(runAction('member.set-initial-budget',{sessionToken:'c'.repeat(43),targetMemberId:'member',monthlyLimit:'25',designatedOwnerId:'attacker'},c)).rejects.toThrow('invalid input');
  expect(JSON.stringify(c.audit.mock.calls)).not.toContain('c'.repeat(43));
});
