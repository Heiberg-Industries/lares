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
/** The state an agent is left in when an action fails after its side effects began.
 * Closed: the socket sends it and the console validates it against the same three values.
 *  - previous-running: the previous definition is still running.
 *  - restored-stopped: the saved definition was restored, but the agent is stopped and needs recovery.
 *  - recovery-required: nothing verified is available; recovery is required. */
export const KEEPER_FAILURE_STATES = ["previous-running", "restored-stopped", "recovery-required"] as const;
export type KeeperFailureState = (typeof KEEPER_FAILURE_STATES)[number];
/** Trusted keeper-code failure, raised AFTER side effects, that says why the action failed and
 * what the agent is left in. Like a refusal, its message is hand-written by the caller: never
 * pass an arbitrary exception's text. The real error goes in `cause`, which is never audited or
 * transported. runAction adds `reference`, the audit record's operation id, for the owner to quote.
 */
export class KeeperFailedError extends Error {
  readonly state: KeeperFailureState;
  readonly reference?: string;
  constructor(message: string, state: KeeperFailureState, options: { cause?: unknown; reference?: string } = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "KeeperFailedError";
    this.state = state;
    this.reference = options.reference;
  }
}
/** Fixed, secret-free failure for every exception the keeper did not write itself: such a
 * message can contain secrets, so it is never audited or transported. Only the audit record's
 * operation id is kept, as `reference`. */
export class KeeperUnknownFailureError extends Error {
  readonly reference: string;
  constructor(reference: string, message = "keeper: action failed") {
    super(message);
    this.name = "KeeperUnknownFailureError";
    this.reference = reference;
  }
}
function scrubber(input: unknown, fields: readonly string[]): (value: string) => string {
  const secrets = new Set<string>();
  function collect(value: unknown, secret = false): void {
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) collect(child, secret || fields.includes(key));
    } else if (secret && value !== null && value !== undefined && String(value)) secrets.add(String(value));
  }
  collect(input);
  return (value: string): string => {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, "<redacted>");
    return value;
  };
}
function safeRefusal(error: KeeperRefusedError, input: unknown, fields: readonly string[]): KeeperRefusedError {
  const scrub = scrubber(input, fields);
  return new KeeperRefusedError(scrub(error.message), error.findings?.map(f => ({check: scrub(f.check), message: scrub(f.message)})));
}
/** The cause is dropped here on purpose: nothing past runAction may read it. */
function safeFailure(error: KeeperFailedError, input: unknown, fields: readonly string[], reference: string): KeeperFailedError {
  return new KeeperFailedError(scrubber(input, fields)(error.message), error.state, { reference });
}

/** A fixed, secret-free result for a durable operation that may have crossed a side-effect
 * boundary. Callers must inspect its journal; the transport must never resubmit it. */
export class KeeperOutcomeUncertainError extends Error {
  /** The audit record's operation id, added by runAction. */
  readonly reference?: string;
  constructor(reference?: string) {
    super("keeper: outcome uncertain; inspect credential status; do not retry automatically");
    this.reference = reference;
  }
}
/** The audit reference an error thrown by runAction carries, if it has one. Errors raised before
 * an audit record exists (an unavailable audit, a transport refusal) have none. */
export function failureReference(error: unknown): string | undefined {
  return error instanceof KeeperFailedError || error instanceof KeeperUnknownFailureError || error instanceof KeeperOutcomeUncertainError
    ? error.reference : undefined;
}

export interface ActionContext {
  actor: string;
  /** Set by runAction from the trusted transport, never from actor text. */
  host?: boolean;
  audit(record: AuditRecord): Promise<void>;
  /** Close this action's audit before publishing durable success evidence. Only runAction
   * supplies this callback; failures leave the action's journal incomplete and inspectable. */
  finalizeAudit?: (result: unknown) => Promise<void>;
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
  "setup_link.issue", "allowlist.reset", "update", "member.remove",
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
  throw new KeeperRefusedError(`keeper: ${detail}`);
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
  // The owner can quote this id: it names the audit row for this one attempt.
  const reference = randomUUID();
  const record: AuditRecord = { operationId: reference, action: name, actor: ctx.actor, input: redact(parsed.data, action.secretFields ?? []), outcome: "pending" };
  try {
    await ctx.audit(record);
  }
  catch {
    throw new Error("keeper: audit unavailable; action not run");
  }
  let result: unknown;
  let failed = false;
  let refusal: KeeperRefusedError | undefined;
  let failure: KeeperFailedError | undefined;
  let uncertain: KeeperOutcomeUncertainError | undefined;
  let auditFinalized = false;
  try {
    result = await action.run(parsed.data as never, { ...ctx, host: opts.host === true, finalizeAudit: async result => {
      if (auditFinalized) throw new KeeperOutcomeUncertainError();
      auditFinalized = true;
      try {
        await ctx.audit({ ...record, outcome: 'ok', ...(action.successDetail ? { detail: action.successDetail(result) } : {}) });
      } catch { throw new KeeperOutcomeUncertainError(); }
    } });
  }
  catch (error) {
    failed = true;
    if (error instanceof KeeperOutcomeUncertainError) uncertain = new KeeperOutcomeUncertainError(reference);
    if (error instanceof KeeperRefusedError) refusal = safeRefusal(error, rawInput, action.secretFields ?? []);
    if (error instanceof KeeperFailedError) failure = safeFailure(error, rawInput, action.secretFields ?? [], reference);
    // Anything else keeps the fixed text below: its message is never read.
  }
  try {
    if (!auditFinalized) await ctx.audit({ ...record, outcome: refusal ? "refused" : failed ? "failed" : "ok", ...(failed ? { detail: refusal?.message ?? (failure ? `${failure.message} [${failure.state}]` : undefined) ?? uncertain?.message ?? "action failed" } : action.successDetail ? { detail: action.successDetail(result) } : {}) });
  }
  catch {
    throw new KeeperUnknownFailureError(reference, "keeper: outcome uncertain; audit finalization failed; do not retry automatically");
  }
  if (refusal) throw refusal;
  if (failure) throw failure;
  if (uncertain) throw uncertain;
  if (failed)
    throw new KeeperUnknownFailureError(reference);
  return result;
}
