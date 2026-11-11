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
/** A success is written to the keeper log only when it took at least this long. Every other outcome always is. */
export const SLOW_ACTION_LOG_MS = 2000;
const LOG_LINE_MAX = 1000;
const LOG_MESSAGE_MAX = 160;
const LOG_REFUSAL_MAX = 300;
/** A thrown message is cut to this before the patterns run, so one huge message cannot stall the keeper. */
const LOG_RAW_MAX = 4000;
const LOG_AGENT = /^[a-z][a-z0-9-]{1,30}$/;
const LOG_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const LOG_ERROR_CODE = /^[A-Za-z0-9_.-]{1,32}$/;
/** A value after a name: quoted up to its closing quote (and anything glued to it), or an unquoted
 * run up to the next whitespace, with a leading scheme word (`Basic xyz`) taken along. */
const LOG_VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"?[^\s,;}\])]*|'(?:[^'\\]|\\.)*'?[^\s,;}\])]*|(?:(?:[Bb]asic|BASIC|[Bb]earer|BEARER|[Tt]oken|TOKEN|[Dd]igest|DIGEST|[Nn]egotiate|NEGOTIATE|[Aa]pi[Kk]ey|APIKEY)\s+)?\S+)`;
/** Applied in this order to every message a cause summary prints, after the marked-secret scrubber.
 * Hiding too much is fine here; a harmless word after `key:` is an acceptable loss. */
const LOG_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "<url>"],
  [/\bBearer\s+\S+/gi, "Bearer <token>"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "<key>"],
  [/\bxox[a-z]-[A-Za-z0-9-]+/gi, "<token>"],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}/g, "<token>"],
  [/\b(?:ntn|secret)_[A-Za-z0-9]{20,}/g, "<token>"],
  // Environment style: NAME=value and NAME = value for any upper-case name, NAME_PART: value for one with an underscore
  // (so that `ENOENT: no such file` stays readable).
  [new RegExp(String.raw`\b([A-Z][A-Z0-9_]{2,}["']?\s*=\s*)${LOG_VALUE}`, "g"), "$1<redacted>"],
  [new RegExp(String.raw`\b([A-Z][A-Z0-9]*_[A-Z0-9_]*["']?\s*:\s*)${LOG_VALUE}`, "g"), "$1<redacted>"],
  // Any name that contains a secret word, with whatever is joined to it by `_`, `.` or `-`, quoted or
  // not: password, api_key, "client_secret", access-token, Authorization, SLACK_BOT_TOKEN.
  [new RegExp(String.raw`(?<![\w.-])([\w.-]*(?:pass|pwd|secret|token|key|auth|credential|cookie|signature)[\w.-]*["']?\s*[=:]\s*)${LOG_VALUE}`, "gi"), "$1<redacted>"],
  [/[A-Za-z0-9+/_=-]{32,}/g, "<redacted>"],
];
const oneLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
const cut = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;
function logMessage(message: unknown, scrub: (value: string) => string): string {
  let text = scrub(String(message));
  // Dropping the cut-off last word keeps half a secret from slipping past the patterns below.
  if (text.length > LOG_RAW_MAX) text = text.slice(0, LOG_RAW_MAX).replace(/\S+$/, "");
  for (const [pattern, replacement] of LOG_PATTERNS) text = text.replace(pattern, replacement);
  return cut(oneLine(text), LOG_MESSAGE_MAX);
}
/** What went wrong, for the keeper log only: class, code and a scrubbed, shortened message of the
 * error, up to three levels of `cause` deep and up to three errors of an AggregateError. It reads
 * `name`, `code`, `message`, `cause` and `errors` and nothing else: no stack, detail, hint, output
 * or configuration. A thrown value that is not an Error prints its type and none of its content. */
function causeSummary(error: unknown, scrub: (value: string) => string, level = 1): string {
  if (!(error instanceof Error)) return `non-error value (${typeof error})`;
  const name = typeof error.name === "string" && LOG_ERROR_NAME.test(error.name) ? error.name : "Error";
  const code = (error as { code?: unknown }).code;
  const shownCode = (typeof code === "string" || typeof code === "number") && LOG_ERROR_CODE.test(String(code)) ? ` ${code}` : "";
  let text = `${name}${shownCode} "${logMessage(error.message, scrub)}"`;
  if (level >= 3) return text;
  if (error instanceof AggregateError && Array.isArray(error.errors))
    text += ` [${error.errors.slice(0, 3).map(inner => causeSummary(inner, scrub, level + 1)).join("; ")}${error.errors.length > 3 ? "; …" : ""}]`;
  if (error.cause !== undefined) text += `, caused by ${causeSummary(error.cause, scrub, level + 1)}`;
  return text;
}
type LoggedOutcome = "succeeded" | "refused" | "failed" | "outcome unknown" | "outcome uncertain";
/** The agent an action was about, if its parsed input names one. No other input field is ever logged. */
function loggedAgent(input: unknown, secretFields: readonly string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const key of ["name", "agent"]) {
    const value = (input as Record<string, unknown>)[key];
    if (!secretFields.includes(key) && typeof value === "string" && LOG_AGENT.test(value)) return value;
  }
  return undefined;
}
/** One bounded, secret-free line per action outcome in the keeper's own log, under the reference
 * the console shows. Never the actor, never an input field other than the agent's name, never
 * findings. Logging must not change what runAction returns or throws, so nothing escapes here. */
function logOutcome(entry: {
  action: string; outcome: LoggedOutcome; state?: string; reference?: string; ms?: number;
  /** A refusal's text as the caller already receives it (scrubbed of marked secrets), or a fixed keeper text. */
  text?: string;
  /** Wrapped so that a thrown `undefined` is still a cause. */
  cause?: { error: unknown };
  /** The request as received and as parsed, read here only for the marked secrets and the agent's name. */
  rawInput?: unknown; parsedInput?: unknown; secretFields?: readonly string[];
}): void {
  try {
    if (entry.outcome === "succeeded" && !(entry.ms !== undefined && entry.ms >= SLOW_ACTION_LOG_MS)) return;
    const secretFields = entry.secretFields ?? [];
    const agent = loggedAgent(entry.parsedInput, secretFields);
    let line = `keeper: ${entry.action} ${entry.outcome}`;
    if (entry.state && (KEEPER_FAILURE_STATES as readonly string[]).includes(entry.state)) line += ` (${entry.state})`;
    if (agent) line += ` for agent ${agent}`;
    if (entry.reference) line += `, reference ${entry.reference}`;
    if (entry.ms !== undefined) line += `, ${Math.max(0, Math.round(entry.ms))} ms`;
    if (entry.text) line += `: ${cut(oneLine(entry.text), LOG_REFUSAL_MAX)}`;
    if (entry.cause) line += `; cause: ${causeSummary(entry.cause.error, scrubber(entry.rawInput, secretFields))}`;
    line = cut(oneLine(line), LOG_LINE_MAX);
    if (entry.outcome === "succeeded") console.log(line);
    else console.error(line);
  }
  catch { /* A log line is never worth changing an action's outcome for. */ }
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
  if (!action) {
    // The label the refusal is audited under: an unregistered name is never printed.
    const label = RESERVED_ACTIONS.includes(name) ? name : "unknown", detail = RESERVED_ACTIONS.includes(name) ? "not available in this release" : "unknown action";
    logOutcome({ action: label, outcome: "refused", text: detail });
    return refuse(ctx, label, detail);
  }
  if (action.hostOnly && !opts.host) {
    logOutcome({ action: name, outcome: "refused", text: "reachable only from the host command" });
    return refuse(ctx, name, "reachable only from the host command");
  }
  // Schema messages may echo credential values (enum literals, custom refinements, property names).
  let parsed;
  try {
    parsed = action.input.safeParse(rawInput);
  }
  catch {
    logOutcome({ action: name, outcome: "refused", text: "invalid input" });
    return refuse(ctx, name, "invalid input");
  }
  if (!parsed.success) {
    logOutcome({ action: name, outcome: "refused", text: "invalid input" });
    return refuse(ctx, name, "invalid input");
  }
  const secretFields = action.secretFields ?? [];
  const logged = { action: name, rawInput, parsedInput: parsed.data as unknown, secretFields };
  // The owner can quote this id: it names the audit row for this one attempt.
  const reference = randomUUID();
  const record: AuditRecord = { operationId: reference, action: name, actor: ctx.actor, input: redact(parsed.data, secretFields), outcome: "pending" };
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  try {
    await ctx.audit(record);
  }
  catch (error) {
    // No audit row exists, so the caller gets no reference and neither does the line.
    logOutcome({ ...logged, outcome: "refused", ms: elapsed(), text: "audit unavailable; action not run", cause: { error } });
    throw new Error("keeper: audit unavailable; action not run");
  }
  let result: unknown;
  let failed = false;
  let thrown: unknown;
  let refusal: KeeperRefusedError | undefined;
  let failure: KeeperFailedError | undefined;
  let uncertain: KeeperOutcomeUncertainError | undefined;
  let auditFinalized = false;
  let finalizeFailure: { error: unknown } | undefined;
  try {
    result = await action.run(parsed.data as never, { ...ctx, host: opts.host === true, finalizeAudit: async result => {
      if (auditFinalized) throw new KeeperOutcomeUncertainError();
      auditFinalized = true;
      try {
        await ctx.audit({ ...record, outcome: 'ok', ...(action.successDetail ? { detail: action.successDetail(result) } : {}) });
      } catch (error) { finalizeFailure = { error }; throw new KeeperOutcomeUncertainError(); }
    } });
  }
  catch (error) {
    failed = true;
    thrown = error;
    if (error instanceof KeeperOutcomeUncertainError) uncertain = new KeeperOutcomeUncertainError(reference);
    if (error instanceof KeeperRefusedError) refusal = safeRefusal(error, rawInput, secretFields);
    if (error instanceof KeeperFailedError) failure = safeFailure(error, rawInput, secretFields, reference);
    // Anything else keeps the fixed text below: its message is never read, except for the keeper's own log.
  }
  const outcome: LoggedOutcome = refusal ? "refused" : failure ? "failed" : uncertain ? "outcome uncertain" : failed ? "outcome unknown" : "succeeded";
  // The real cause, for the log only. A refusal's own text already says why. A typed failure carries
  // the real error as its cause (and may have none); anything else is its own cause.
  const cause: { error: unknown } | undefined = !failed || refusal ? undefined
    : thrown instanceof KeeperFailedError ? (thrown.cause !== undefined ? { error: thrown.cause } : undefined)
    : uncertain && finalizeFailure ? finalizeFailure
    : { error: thrown };
  try {
    if (!auditFinalized) await ctx.audit({ ...record, outcome: refusal ? "refused" : failed ? "failed" : "ok", ...(failed ? { detail: refusal?.message ?? (failure ? `${failure.message} [${failure.state}]` : undefined) ?? uncertain?.message ?? "action failed" } : action.successDetail ? { detail: action.successDetail(result) } : {}) });
  }
  catch (error) {
    logOutcome({ ...logged, outcome: "outcome uncertain", reference, ms: elapsed(),
      text: `audit record could not be closed (action: ${outcome}${failure ? ` (${failure.state})` : ""})`,
      cause: { error: cause ? new AggregateError([cause.error, error], "the action and its audit record both failed") : error } });
    throw new KeeperUnknownFailureError(reference, "keeper: outcome uncertain; audit finalization failed; do not retry automatically");
  }
  logOutcome({ ...logged, outcome, state: failure?.state, reference, ms: elapsed(), text: refusal?.message, cause });
  if (refusal) throw refusal;
  if (failure) throw failure;
  if (uncertain) throw uncertain;
  if (failed)
    throw new KeeperUnknownFailureError(reference);
  return result;
}
