import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";
import { registerAction, resetActions, runAction, failureReference, RESERVED_ACTIONS, SLOW_ACTION_LOG_MS, KeeperFailedError, KeeperOutcomeUncertainError, KeeperRefusedError, KeeperUnknownFailureError, KEEPER_FAILURE_STATES, type AuditRecord } from "../lib/actions.js";
import { failureReply } from "../lib/socket-server.js";
import {registerInitialMemberBudgetActions} from '../lib/initial-member-budget.js';
// The keeper's own log: what runAction writes for each outcome. Silenced and captured for every test.
let logged: { error: MockInstance<typeof console.error>; log: MockInstance<typeof console.log> };
beforeEach(() => {
  resetActions();
  logged = { error: vi.spyOn(console, "error").mockImplementation(() => { }), log: vi.spyOn(console, "log").mockImplementation(() => { }) };
});
afterEach(() => { vi.restoreAllMocks(); });
const errorLines = () => logged.error.mock.calls.map(call => { expect(call).toHaveLength(1); return String(call[0]); });
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
it("logs one bounded line for an unexplained failure: the reference, the real cause, and none of its secrets", async () => {
  const c = context();
  const marked = "marked-input-value-7c1", key = "sk-" + "a1B2c3D4e5".repeat(4), url = "postgres://keeper:db-pass-9d2@db.example.test:5432/state";
  expect(key).toHaveLength(43);
  registerAction({ name: "apply", input: z.object({ name: z.string(), value: z.string() }), secretFields: ["value"], run: async () => {
    throw Object.assign(new Error(`insert failed for ${marked} at ${url} using ${key} with GATEWAY_KEY=abc123def\nservices:\n  agent:\n    image: example/image`),
      { code: "23505", detail: "Key (name)=(detail-secret) already exists.", hint: "hint-secret", where: "where-secret", stderr: "stderr-secret" });
  } });
  const error = await caught(runAction("apply", { name: "bookkeeper", value: marked }, c));
  expect(error).toBeInstanceOf(KeeperUnknownFailureError);
  expect(logged.log).not.toHaveBeenCalled();
  const lines = errorLines();
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  const reference = (error as KeeperUnknownFailureError).reference;
  expect(reference).toBe(c.audit.mock.calls[0][0].operationId);
  expect(line).toContain(`reference ${reference}`);
  expect(line).toMatch(new RegExp(`^keeper: apply outcome unknown for agent bookkeeper, reference ${reference}, \\d+ ms; cause: `));
  expect(line).toContain('Error 23505 "insert failed for <redacted> at <url> using <key> with GATEWAY_KEY=<redacted> services: agent: image: example/image"');
  for (const secret of [marked, "db-pass-9d2", "db.example.test", "postgres://", key, key.slice(0, 12), "abc123def", "detail-secret", "hint-secret", "where-secret", "stderr-secret", "owner@example.com"])
    expect(line).not.toContain(secret);
  expect(line).not.toMatch(/[\r\n]/);
  expect(line.length).toBeLessThanOrEqual(1000);
  // Nothing new leaves the keeper: the reply is built from the thrown error, which has none of it.
  const reply = JSON.stringify(failureReply(error));
  for (const text of ["insert failed", "23505", "services:", "<url>", marked, key, "abc123def"]) expect(reply).not.toContain(text);
  expect(JSON.stringify(c.audit.mock.calls)).not.toContain("insert failed");
});
it("logs a typed failure with its state and its cause, and still drops the cause from the error it throws", async () => {
  const c = context();
  registerAction({ name: "definition.reconcile", input: z.object({ name: z.string() }), run: async () => {
    throw new KeeperFailedError("Apply failed. Hand-written reason.", "previous-running", { cause: Object.assign(new Error("injected start failure"), { code: "ENOENT" }) });
  } });
  const error = await caught(runAction("definition.reconcile", { name: "bookkeeper" }, c));
  expect(error).toBeInstanceOf(KeeperFailedError);
  expect((error as Error).cause).toBeUndefined();
  const lines = errorLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(new RegExp(`^keeper: definition\\.reconcile failed \\(previous-running\\) for agent bookkeeper, reference ${(error as KeeperFailedError).reference}, \\d+ ms; cause: Error ENOENT "injected start failure"$`));
  // The hand-written message is the caller's; the log line adds the cause and nothing of the audit detail.
  expect(c.audit.mock.calls.at(-1)![0]).toMatchObject({ outcome: "failed", detail: "Apply failed. Hand-written reason. [previous-running]" });
  expect(JSON.stringify([error, c.audit.mock.calls])).not.toContain("injected start failure");
});
it("logs a typed failure that has no cause without inventing one", async () => {
  const c = context();
  registerAction({ name: "apply", input: z.object({}), run: async () => { throw new KeeperFailedError("Apply failed.", "recovery-required"); } });
  const error = await caught(runAction("apply", {}, c));
  expect(errorLines()).toEqual([expect.stringMatching(new RegExp(`^keeper: apply failed \\(recovery-required\\), reference ${(error as KeeperFailedError).reference}, \\d+ ms$`))]);
});
it("logs a refusal with its scrubbed text and never its findings", async () => {
  const c = context();
  registerAction({ name: "validate", input: z.object({ value: z.string() }), secretFields: ["value"],
    run: async () => { throw new KeeperRefusedError("invalid model token-secret\nsecond line", [{ check: "model-alias", message: "finding-text token-secret" }]); } });
  await expect(runAction("validate", { value: "token-secret" }, c)).rejects.toBeInstanceOf(KeeperRefusedError);
  const lines = errorLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(new RegExp(`^keeper: validate refused, reference ${c.audit.mock.calls[0][0].operationId}, \\d+ ms: invalid model <redacted> second line$`));
  for (const hidden of ["token-secret", "finding-text", "model-alias", "owner@example.com", "cause:"]) expect(lines[0]).not.toContain(hidden);
});
it("logs refusals raised before an audit record exists without a reference, and never an unregistered name or any input", async () => {
  const c = context();
  await expect(runAction("rm-everything-quietly", { secret: "input-secret" }, c)).rejects.toThrow("unknown action");
  await expect(runAction("update", { secret: "input-secret" }, c)).rejects.toThrow("not available in this release");
  registerAction({ name: "host.test", hostOnly: true, input: z.object({}), run: async () => 1 });
  await expect(runAction("host.test", {}, c)).rejects.toThrow("host command");
  registerAction({ name: "secret.set", input: z.object({ name: z.string(), value: z.string().refine(() => false, "input-secret") }), secretFields: ["value"], run: async () => 1 });
  await expect(runAction("secret.set", { name: "bookkeeper", value: "input-secret" }, c)).rejects.toThrow("invalid input");
  expect(errorLines()).toEqual([
    "keeper: unknown refused: unknown action",
    "keeper: update refused: not available in this release",
    "keeper: host.test refused: reachable only from the host command",
    "keeper: secret.set refused: invalid input",
  ]);
  expect(logged.log).not.toHaveBeenCalled();
});
it("stays silent for a quick success and logs a slow one once", async () => {
  expect(SLOW_ACTION_LOG_MS).toBe(2000);
  const c = context();
  registerAction({ name: "echo", input: z.object({ name: z.string() }), run: async (i) => i });
  await expect(runAction("echo", { name: "bookkeeper" }, c)).resolves.toEqual({ name: "bookkeeper" });
  const now = vi.spyOn(performance, "now");
  now.mockReturnValueOnce(1000).mockReturnValue(1000 + SLOW_ACTION_LOG_MS - 1);
  await runAction("echo", { name: "bookkeeper" }, c);
  expect(logged.log).not.toHaveBeenCalled();
  expect(logged.error).not.toHaveBeenCalled();
  now.mockReset();
  now.mockReturnValueOnce(1000).mockReturnValue(1000 + SLOW_ACTION_LOG_MS);
  await expect(runAction("echo", { name: "bookkeeper" }, c)).resolves.toEqual({ name: "bookkeeper" });
  now.mockRestore();
  expect(logged.error).not.toHaveBeenCalled();
  expect(logged.log.mock.calls).toEqual([[`keeper: echo succeeded for agent bookkeeper, reference ${c.audit.mock.calls.at(-1)![0].operationId}, 2000 ms`]]);
});
it("names the agent only from a name or agent field that looks like one, and never a marked secret", async () => {
  const c = context();
  const failing = async () => { throw new KeeperFailedError("Failed.", "recovery-required"); };
  registerAction({ name: "by.agent", input: z.object({ agent: z.string(), member: z.string() }), run: failing });
  registerAction({ name: "by.secret", input: z.object({ name: z.string() }), secretFields: ["name"], run: failing });
  await caught(runAction("by.agent", { agent: "ledger", member: "member-text" }, c));
  await caught(runAction("by.agent", { agent: "Not A Slug", member: "member-text" }, c));
  await caught(runAction("by.secret", { name: "bookkeeper" }, c));
  const lines = errorLines();
  expect(lines[0]).toContain("keeper: by.agent failed (recovery-required) for agent ledger, reference ");
  expect(lines[1]).toContain("keeper: by.agent failed (recovery-required), reference ");
  expect(lines[2]).toContain("keeper: by.secret failed (recovery-required), reference ");
  expect(lines.join("\n")).not.toContain("member-text");
});
it("summarises both errors of an aggregate cause, and prints only the type of a thrown value that is not an error", async () => {
  const c = context();
  registerAction({ name: "apply", input: z.object({}), run: async () => {
    throw new KeeperFailedError("Apply failed.", "restored-stopped", { cause: new AggregateError(
      [new Error("apply went wrong"), Object.assign(new TypeError("rollback went wrong"), { code: "ECONNREFUSED" })], "apply and rollback both failed") });
  } });
  await caught(runAction("apply", {}, c));
  registerAction({ name: "thrower", input: z.object({}), run: async () => { throw "thrown-text-content"; } });
  const error = await caught(runAction("thrower", {}, c));
  expect(error).toBeInstanceOf(KeeperUnknownFailureError);
  const lines = errorLines();
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('failed (restored-stopped)');
  expect(lines[0]).toContain('; cause: AggregateError "apply and rollback both failed" [Error "apply went wrong"; TypeError ECONNREFUSED "rollback went wrong"]');
  expect(lines[1]).toMatch(new RegExp(`^keeper: thrower outcome unknown, reference ${(error as KeeperUnknownFailureError).reference}, \\d+ ms; cause: non-error value \\(string\\)$`));
  expect(lines[1]).not.toContain("thrown-text-content");
});
it("follows a cause chain three levels deep and no further, and at most three errors of an aggregate", async () => {
  const c = context();
  const chain = new Error("level one", { cause: new Error("level two", { cause: new Error("level three", { cause: new Error("level four", { cause: new Error("level five") }) }) }) });
  registerAction({ name: "deep", input: z.object({}), run: async () => { throw chain; } });
  await caught(runAction("deep", {}, c));
  registerAction({ name: "wide", input: z.object({}), run: async () => { throw new AggregateError(["one", "two", "three", "four"].map(n => new Error(`sibling ${n}`)), "many"); } });
  await caught(runAction("wide", {}, c));
  const lines = errorLines();
  expect(lines[0]).toMatch(/; cause: Error "level one", caused by Error "level two", caused by Error "level three"$/);
  expect(lines[0]).not.toContain("level four");
  expect(lines[1]).toMatch(/; cause: AggregateError "many" \[Error "sibling one"; Error "sibling two"; Error "sibling three"; …\]$/);
  expect(lines[1]).not.toContain("sibling four");
});
it("strips every listed secret shape from a cause, reads no property but name, code, message and cause, and bounds the message and the line", async () => {
  const c = context();
  const secrets = ["https://user:url-pass@hooks.example.test/path?sig=url-query", "bearer-value-1", "xoxb-12345-slacktoken", "123456789:" + "T".repeat(35),
    "ntn_" + "n".repeat(24), "secret_" + "s".repeat(24), "env-value-2", "pw-value-3", "tok-value-4", "Q".repeat(40)];
  const [link, bearer, slack, telegram, ntn, legacy, env, password, token, opaque] = secrets;
  registerAction({ name: "leaky", input: z.object({}), run: async () => {
    throw Object.assign(new Error(`a ${link} b Bearer ${bearer} c ${slack} d ${telegram} e ${ntn} f ${legacy} g LARES_TOKEN=${env} h password: ${password} i Token=${token} j ${opaque} k`),
      { name: "bad name; rm -rf", code: "not a code!", stack: "stack-secret", config: { key: "config-secret" }, env: { KEY: "env-secret" }, stdout: "stdout-secret" });
  } });
  await caught(runAction("leaky", {}, c));
  registerAction({ name: "long", input: z.object({}), run: async () => {
    let error = new Error("word ".repeat(400));
    for (let i = 0; i < 2; i++) error = new AggregateError([error, error, error], "word ".repeat(400));
    throw error;
  } });
  await caught(runAction("long", {}, c));
  const lines = errorLines();
  expect(lines[0]).toContain('; cause: Error "a <url> b Bearer <token> c <token> d <token> e <token> f <token> g LARES_TOKEN=<redacted> h password: <redacted> i Token=<redacted> j <redacted> k"');
  for (const hidden of [...secrets, "url-pass", "hooks.example.test", "rm -rf", "not a code", "stack-secret", "config-secret", "env-secret", "stdout-secret"]) expect(lines[0]).not.toContain(hidden);
  expect(lines[1]).toContain(`AggregateError "${"word ".repeat(31)}word…" [`);
  expect(lines[1]!.length).toBe(1000);
  expect(lines[1]!.endsWith("…")).toBe(true);
});
it.each([
  ["a JSON key in double quotes", `request body {"password":"hunter2json"} was rejected`, ["hunter2json"]],
  ["a key in single quotes", `options were {'password': 'singleval9'}`, ["singleval9"]],
  ["a number under a quoted key, and the key after it", `sent {"pin_token": 48151623, "client_secret": "afterval7"}`, ["48151623", "afterval7"]],
  ["snake_case with a prefix", "config api_key: snakeval1 was refused", ["snakeval1"]],
  ["snake_case with a prefix and equals", "config access_token=snakeval2 was refused", ["snakeval2"]],
  ["snake_case ending in the secret word", "config client_secret=snakeval3 was refused", ["snakeval3"]],
  ["snake_case with both", "config slack_bot_token=snakeval4 was refused", ["snakeval4"]],
  ["dotted and dashed names", "set gateway.master-key: dottedval5 and x-api-key=dashedval6 failed", ["dottedval5", "dashedval6"]],
  ["an upper-case name and a colon", "environment SLACK_BOT_TOKEN: upperval1 is wrong", ["upperval1"]],
  ["an upper-case name and a spaced equals", "environment GATEWAY_KEY = upperval2 is wrong", ["upperval2"]],
  ["an upper-case name without a secret word, and a colon", "environment NOTION_SOURCE_ID: upperval3 is wrong", ["upperval3"]],
  ["an upper-case name without a secret word, and a spaced equals", "environment WORKSPACE = upperval4 is wrong", ["upperval4"]],
  ["a scheme word after an upper-case name", "environment PROXY_AUTH = Basic dXBwZXI6dmFs is wrong", ["dXBwZXI6dmFs", "Basic"]],
  ["Authorization: Basic", "upstream said 401 for Authorization: Basic dXNlcjpwYXNz on retry", ["dXNlcjpwYXNz"]],
  ["Authorization: Token", "upstream said 401 for Authorization: Token authtokval1 on retry", ["authtokval1"]],
  ["Authorization: Bearer", "upstream said 401 for Authorization: Bearer authbearval2 on retry", ["authbearval2"]],
  ["a header object", `headers {"authorization":"Basic aGVhZGVyOnZhbA==","cookie":"sid=cookieval3"}`, ["aGVhZGVyOnZhbA", "cookieval3"]],
  ["a double-quoted value with spaces", `login with password = "hunter 2" failed`, ["hunter", ` 2"`]],
  ["a single-quoted value with spaces", "login with passphrase: 'correct horse staple' failed", ["correct", "horse", "staple"]],
  ["a quoted value with an escaped quote", String.raw`login with secret="first\"second part" failed`, ["first", "second", "part"]],
  ["a quoted value that never closes", `login with token: "openval8 and the rest`, ["openval8", "the rest"]],
  ["a value on the next line", "credentials:\n  nextlineval9", ["nextlineval9"]],
  ["a query string without its address", "retry with token=queryval1&signature=queryval2", ["queryval1", "queryval2"]],
])("strips a secret written as %s from the cause", async (_shape, message, hidden) => {
  const c = context();
  registerAction({ name: "leaky", input: z.object({}), run: async () => { throw new Error(message); } });
  await caught(runAction("leaky", {}, c));
  const lines = errorLines();
  expect(lines).toHaveLength(1);
  // Scrubbed, not merely cut off: the message is short enough to be printed whole.
  expect(lines[0]).toContain("<redacted>");
  expect(lines[0]).not.toContain("…");
  for (const value of hidden) expect(lines[0]).not.toContain(value);
});
it.each([
  "ENOENT: no such file or directory, open 'agent.json'",
  "connect ECONNREFUSED 127.0.0.1:5432",
  'password authentication failed for user "keeper"',
  'duplicate key value violates unique constraint "agent_doors_pkey"',
  "Native runtime authority changed during start and the owned runtime could not be stopped",
  "Runtime held: native budget activation required",
])("leaves an ordinary cause readable: %s", async (message) => {
  const c = context();
  registerAction({ name: "plain", input: z.object({}), run: async () => { throw new Error(message); } });
  await caught(runAction("plain", {}, c));
  expect(errorLines()).toEqual([expect.stringContaining(`; cause: Error "${message}"`)]);
});
it("logs an audit that cannot be written: no reference when the action never ran, the reference when its record could not be closed", async () => {
  const run = vi.fn(async () => { throw new KeeperFailedError("Apply failed.", "previous-running", { cause: new Error("start failed") }); });
  registerAction({ name: "apply", input: z.object({ name: z.string() }), run });
  const c = context();
  c.audit.mockRejectedValue(Object.assign(new Error("connect refused at postgres://keeper:db-pass-9d2@db.example.test/state"), { code: "ECONNREFUSED" }));
  await expect(runAction("apply", { name: "bookkeeper" }, c)).rejects.toThrow("keeper: audit unavailable; action not run");
  expect(run).not.toHaveBeenCalled();
  const d = context();
  d.audit.mockResolvedValueOnce().mockRejectedValue(new Error("audit write lost"));
  const unfinished = await caught(runAction("apply", { name: "bookkeeper" }, d));
  expect(unfinished).toMatchObject({ message: "keeper: outcome uncertain; audit finalization failed; do not retry automatically", reference: d.audit.mock.calls[0][0].operationId });
  const lines = errorLines();
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^keeper: apply refused for agent bookkeeper, \d+ ms: audit unavailable; action not run; cause: Error ECONNREFUSED "connect refused at <url>"$/);
  expect(lines[0]).not.toMatch(UUID);
  expect(lines[1]).toMatch(new RegExp(`^keeper: apply outcome uncertain for agent bookkeeper, reference ${d.audit.mock.calls[0][0].operationId}, \\d+ ms: audit record could not be closed \\(action: failed \\(previous-running\\)\\); cause: AggregateError "the action and its audit record both failed" \\[Error "start failed"; Error "audit write lost"\\]$`));
});
it("never lets the log change an outcome: a console that throws leaves the result and the error as they were", async () => {
  logged.error.mockImplementation(() => { throw new Error("log unavailable"); });
  logged.log.mockImplementation(() => { throw new Error("log unavailable"); });
  const c = context();
  registerAction({ name: "apply", input: z.object({}), run: async () => { throw new KeeperFailedError("Apply failed.", "previous-running", { cause: new Error("start failed") }); } });
  registerAction({ name: "echo", input: z.object({}), run: async () => "done" });
  const error = await caught(runAction("apply", {}, c));
  expect(error).toMatchObject({ name: "KeeperFailedError", message: "Apply failed.", state: "previous-running", reference: c.audit.mock.calls[0][0].operationId });
  await expect(runAction("missing", {}, c)).rejects.toThrow("keeper: unknown action");
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(SLOW_ACTION_LOG_MS);
  await expect(runAction("echo", {}, c)).resolves.toBe("done");
  expect(logged.error).toHaveBeenCalledTimes(2);
  expect(logged.log).toHaveBeenCalledTimes(1);
});
