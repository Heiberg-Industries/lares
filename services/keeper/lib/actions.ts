import { randomUUID } from "node:crypto";
import type { z } from "zod";
export interface AuditRecord {
  operationId?: string;
  action: string;
  actor: string;
  input: unknown;
  outcome: "pending" | "ok" | "refused" | "failed";
  detail?: string;
}

export interface KeeperFinding { check: string; message: string }
/** Trusted keeper-code refusal, raised BEFORE side effects. Callers must construct safe
 * messages/findings, never wrap arbitrary exceptions or raw Zod issue messages.
 * Marked secret values are additionally scrubbed by runAction before audit/transport.
 */
export class KeeperRefusedError extends Error {
  readonly findings?: readonly KeeperFinding[];
  constructor(message: string, findings?: readonly KeeperFinding[]) {
    super(message);
    this.name = "KeeperRefusedError";
    this.findings = findings;
  }
}
function safeRefusal(error: KeeperRefusedError, input: unknown, fields: readonly string[]): KeeperRefusedError {
  const secrets = new Set<string>();
  function collect(value: unknown, secret = false): void {
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) collect(child, secret || fields.includes(key));
    } else if (secret && value !== null && value !== undefined && String(value)) secrets.add(String(value));
  }
  collect(input);
  function scrub(value: string): string {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, "<redacted>");
    return value;
  }
  return new KeeperRefusedError(scrub(error.message), error.findings?.map(f => ({check: scrub(f.check), message: scrub(f.message)})));
}

export interface ActionContext {
  actor: string;
  audit(record: AuditRecord): Promise<void>;
}
export interface Action<I = unknown, O = unknown> {
  name: string;
  input: z.ZodType<I>;
  secretFields?: readonly string[];
  hostOnly?: boolean;
  run(input: I, ctx: ActionContext): Promise<O>;
  /** Trusted, fixed-format success evidence (e.g. definition fingerprint), never arbitrary input. */
  successDetail?(result: O): string;
}
export const RESERVED_ACTIONS: readonly string[] = Object.freeze([
  "apply", "dns.check", "cert.status", "gateway.provider_add", "gateway.key_create",
  "gateway.key_rotate", "gateway.cap_set", "vault.key_add", "backup.now", "backup.test_restore",
  "setup_link.issue", "allowlist.reset", "update",
]);
const registry = new Map<string, Action<never, unknown>>();
export function registerAction<I, O>(action: Action<I, O>): void {
  if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(action.name))
    throw new Error("keeper: invalid action name");
  if (registry.has(action.name))
    throw new Error("keeper: action registered twice");
  registry.set(action.name, action as unknown as Action<never, unknown>);
}
export function resetActions(): void {
  registry.clear();
}
export function actionNames(): string[] {
  return [...registry.keys()].sort();
}
function redact(value: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(value))
    return value.map(v => redact(v, fields));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fields.includes(k) ? "<redacted>" : redact(v, fields)]));
  return value;
}
/** Refusals contain no untrusted input or error messages. */
export async function refuse(ctx: ActionContext, action: string, detail: string): Promise<never> {
  try {
    await ctx.audit({ action, actor: ctx.actor, input: {}, outcome: "refused", detail });
  }
  catch {
    throw new Error("keeper: audit unavailable; request refused");
  }
  throw new Error(`keeper: ${detail}`);
}
export async function runAction(name: string, rawInput: unknown, ctx: ActionContext, opts: {
  host?: boolean;
} = {}): Promise<unknown> {
  const action = registry.get(name);
  if (!action)
    return refuse(ctx, RESERVED_ACTIONS.includes(name) ? name : "unknown", RESERVED_ACTIONS.includes(name) ? "not available in this release" : "unknown action");
  if (action.hostOnly && !opts.host)
    return refuse(ctx, name, "reachable only from the host command");
  // Schema messages may echo credential values (enum literals, custom refinements, property names).
  let parsed;
  try {
    parsed = action.input.safeParse(rawInput);
  }
  catch {
    return refuse(ctx, name, "invalid input");
  }
  if (!parsed.success)
    return refuse(ctx, name, "invalid input");
  const record: AuditRecord = { operationId: randomUUID(), action: name, actor: ctx.actor, input: redact(parsed.data, action.secretFields ?? []), outcome: "pending" };
  try {
    await ctx.audit(record);
  }
  catch {
    throw new Error("keeper: audit unavailable; action not run");
  }
  let result: unknown;
  let failed = false;
  let refusal: KeeperRefusedError | undefined;
  try {
    result = await action.run(parsed.data as never, ctx);
  }
  catch (error) {
    failed = true;
    if (error instanceof KeeperRefusedError) refusal = safeRefusal(error, rawInput, action.secretFields ?? []);
  }
  try {
    await ctx.audit({ ...record, outcome: refusal ? "refused" : failed ? "failed" : "ok", ...(failed ? { detail: refusal?.message ?? "action failed" } : action.successDetail ? { detail: action.successDetail(result) } : {}) });
  }
  catch {
    throw new Error("keeper: outcome uncertain; audit finalization failed; do not retry automatically");
  }
  if (refusal) throw refusal;
  if (failed)
    throw new Error("keeper: action failed");
  return result;
}
