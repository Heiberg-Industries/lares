/**
 * The gateway's budget refusal, made legible on every door (ORB-188 item 2).
 *
 * When a LiteLLM virtual key crosses its `max_budget`, the gateway refuses the model call
 * with a body whose `error.type` is `budget_exceeded`. Before this module, nothing in the
 * fleet recognised that: eve classified it as an ordinary terminal 4xx, and the door posted
 * its generic "I hit an error while handling your request" — a capped Saga looked broken
 * rather than capped.
 *
 * ## The measured contract — and why it moved
 *
 * This is observation, not a documented API, and the observation has already changed once.
 *
 * **400 — measured 2026-09-01**, `docs/runbooks/per-user-spend-caps.md`, "Transcript — run
 * 2026-09-01, against the live gateway", a throwaway key with `max_budget: 0.01`:
 *
 * ```
 * call   6 -> HTTP 400
 * {
 *   "error": {
 *     "message": "Budget has been exceeded! Current cost: 0.0124665, Max budget: 0.01",
 *     "type": "budget_exceeded",
 *     "param": null,
 *     "code": "400"
 *   }
 * }
 * ```
 *
 * **429 — current LiteLLM, verified 2026-09-18 in its own source** (not yet re-measured
 * against our gateway with a live probe — `tests/live/litellm-budget-refusal.live.mts` will
 * record that run when someone does it): `litellm/exceptions.py` sets
 * `self.status_code = 429` on `BudgetExceededError`, and
 * `litellm/proxy/auth/auth_exception_handler.py` passes it through with
 * `type = "budget_exceeded"` intact:
 *
 * ```
 * HTTP 429
 * {
 *   "error": {
 *     "message": "Budget has been exceeded! Current cost: X, Max budget: Y",
 *     "type": "budget_exceeded",
 *     "param": null,
 *     "code": "429"
 *   }
 * }
 * ```
 *
 * Same envelope, same two markers, different transport status — which is exactly why
 * recognition reads the TYPE and treats the status as a plausibility check, never the
 * primary signal. A future LiteLLM release could move the status again without changing
 * anything a caller of this module has to do.
 *
 * Two independent markers are read from the body, and either one is enough:
 *
 *  - **the type** — `error.type === "budget_exceeded"`, read structurally (a parsed field),
 *    never as a substring of some larger blob, so a body that merely *mentions* the string
 *    does not trip it;
 *  - **the sentence** — `error.message` opens with `Budget has been exceeded!`.
 *
 * **What breaks silently if LiteLLM changes:** rename the type, or reword the sentence, and
 * every door falls back to the generic failure text — legible-but-wrong, never a wrong action.
 * Re-run the runbook's throwaway-key proof (or the live probe below) to re-measure; that
 * transcript is the acceptance bar for this file, not the fixtures below (which are copied
 * from it, plus a 429 fixture shaped from LiteLLM's source pending its own live measurement).
 *
 * ## Where the refusal is seen from
 *
 * Three vantage points, all of which must be recognised, because the doors only ever see the
 * third:
 *
 *  1. **the raw body**, as a probe would see it (a parsed object, or JSON text);
 *  2. **the AI SDK's wrapper** — `AI_APICallError` with `statusCode: 400` or `429`, the raw
 *     text on `responseBody`, and the parsed body on `data`;
 *  3. **eve's `turn.failed` / `session.failed` event data** — `{ code, message, details }`,
 *     where `details` carries eve's own distillation of (2): `upstreamType`,
 *     `upstreamMessage`, `apiErrorMessage`, `statusCode`, `responseBodySnippet` (eve 0.32.0,
 *     `dist/src/harness/model-call-error.js`).
 *
 * ## What this module deliberately does NOT do
 *
 * It never throws inside the request path. `createGatewayProvider`'s fetch seams stay a plain
 * pass-through: turning a refusal into a thrown `GatewayBudgetExceededError` there would strip
 * the `statusCode` eve's classifier reads, flipping the failure from "terminal" to
 * "retry"/"recoverable" and changing which events fire. Recognition happens where the answer
 * is composed — on the door — and `GatewayBudgetExceededError` exists for callers that want
 * to raise the condition themselves (and for tests).
 *
 * And it never retries. An uncapped retry loop around a paid call is the founding incident
 * (2026-08-14/15, `docs/solutions/2026-08-15-api-cost-leak-proposal-retry-loop.md`); a budget
 * refusal is the one failure where retrying is most obviously wrong. This is precisely what
 * the move to 429 threatens from a direction this module cannot reach: eve's own
 * `classifyModelCallError` (`dist/src/harness/model-call-error.js`) treats a bare 4xx of 400
 * as TERMINAL but an unrecognised-type error carrying 429 as RETRY — 429 sits in its
 * transient-status branch alongside 408/409/5xx, and `budget_exceeded` is in neither of its
 * gateway-type allow-lists. So a REAL production 429 budget refusal — the raw `AI_APICallError`
 * the gateway call actually throws, which this module never touches — is retried up to twice
 * more by eve's own outer loop (`runModelCallWithRetries`, `dist/src/harness/tool-loop.js`)
 * before `turn.failed` ever fires and this module gets a chance to recognise anything. Verified
 * by executing the installed eve's own `classifyModelCallError` against a 429-shaped budget
 * refusal (`tests/gateway-budget-eve-retry-classification.test.ts`). Fixing that is a change to
 * eve's retry policy or to `createGatewayProvider`'s fetch seam, not to this file — out of
 * scope for this slice; see that test's header for the smallest follow-up.
 */

/** LiteLLM's `error.type` on a budget refusal. Measured 2026-09-01 (see this file's header). */
export const LITELLM_BUDGET_EXCEEDED_TYPE = "budget_exceeded";

/** The opening of LiteLLM's `error.message` on a budget refusal. Measured 2026-09-01. */
export const LITELLM_BUDGET_EXCEEDED_MESSAGE_PREFIX = "Budget has been exceeded!";

/**
 * The HTTP statuses LiteLLM has answered a budget refusal with, across measurements: 400
 * (measured 2026-09-01, `docs/runbooks/per-user-spend-caps.md`) and 429 (LiteLLM's own
 * source, `litellm/exceptions.py` / `litellm/proxy/auth/auth_exception_handler.py`, read
 * 2026-09-18 — not yet re-measured against our gateway with a live probe). When a numeric
 * status is visible anywhere in an error, it must be one of these or `isBudgetExceeded`
 * rejects — see this file's header for why the type still decides and the status is only a
 * plausibility check.
 */
export const LITELLM_BUDGET_EXCEEDED_STATUSES: readonly number[] = [400, 429];

/**
 * The typed form of the gateway's refusal, for callers that want to raise it rather than
 * classify someone else's error. `isBudgetExceeded` recognises this too, so a caller can
 * wrap-and-rethrow without the doors needing to know.
 */
export class GatewayBudgetExceededError extends Error {
  override readonly name = "GatewayBudgetExceededError";
  /**
   * Always 400 — never the real observed status, even when that was 429. This is a
   * presentation value for eve's classifier, not a measurement; the measurement lives on
   * `observedStatus` below.
   *
   * Why fixed: this error's name starts with "Gateway", which is exactly what eve's
   * `findGatewayError` (`dist/src/harness/model-call-error.js`) looks for when it picks a
   * status source out of a cause chain. If this error is ever thrown into eve's path (a
   * caller that raises it itself — see this file's header on why the request path itself
   * never does) and `statusCode` carried the real 429, `classifyModelCallError` would read
   * that 429 off THIS error and retry a call this module has already identified as capped —
   * confirmed by executing the installed eve's classifier against both values
   * (`tests/gateway-budget-eve-retry-classification.test.ts`: 400 -> "terminal", 429 ->
   * "retry", on an otherwise identical object). Presenting a fixed 400 keeps that classifier
   * landing on "terminal" regardless of which status LiteLLM actually used.
   */
  readonly statusCode: number = 400;
  /**
   * The HTTP status actually observed on this refusal (400 or 429) — for logging and tests.
   * Not read by `isBudgetExceeded` (a `GatewayBudgetExceededError` is recognised by
   * `instanceof`, before any status check runs) and deliberately not read by eve's classifier
   * either — see `statusCode` above for why those two diverge on purpose.
   */
  readonly observedStatus: number;
  /** LiteLLM's own `error.type`, so the value that identified the refusal survives wrapping. */
  readonly type: string = LITELLM_BUDGET_EXCEEDED_TYPE;

  constructor(
    message = "The gateway refused the call: this key's budget is exhausted.",
    options?: { cause?: unknown; observedStatus?: number },
  ) {
    super(message, options);
    this.observedStatus = options?.observedStatus ?? 400;
  }
}

// ── Recognition ─────────────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isObject(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!isObject(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

/** Parses a JSON body if the value is a string that holds one; otherwise returns it as-is. */
function asBody(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

interface Signals {
  /** Every `type`-shaped field seen, read structurally. */
  readonly types: string[];
  /** Every message-shaped field seen. */
  readonly messages: string[];
  /** Every numeric HTTP status seen. */
  readonly statuses: number[];
}

/**
 * Walks a value the way eve's own `readModelCallErrorSignals` walks a model-call error —
 * down `cause`, into `data`/`details`, and through a JSON `responseBody` — collecting the
 * three fields that decide the question. Bounded by an explicit seen-set so a self-
 * referencing `cause` (or eve's `details.error` echoing the error) cannot loop.
 */
function collectSignals(root: unknown): Signals {
  const types: string[] = [];
  const messages: string[] = [];
  const statuses: number[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined || node === null) continue;
    if (isObject(node)) {
      if (seen.has(node)) continue;
      seen.add(node);
    } else if (typeof node !== "string") {
      continue;
    }

    // A JSON string is a body: parse it and keep walking the parsed shape.
    if (typeof node === "string") {
      const parsed = asBody(node);
      if (parsed !== undefined) queue.push(parsed);
      continue;
    }

    // Types, read as fields — never as a substring of a blob.
    for (const key of ["type", "upstreamType", "gatewayType"]) {
      const value = readString(node, key);
      if (value !== undefined) types.push(value);
    }
    // Messages.
    for (const key of ["message", "apiErrorMessage", "upstreamMessage", "error_description"]) {
      const value = readString(node, key);
      if (value !== undefined) messages.push(value);
    }
    // Statuses.
    for (const key of ["statusCode", "status", "upstreamStatusCode"]) {
      const value = readNumber(node, key);
      if (value !== undefined) statuses.push(value);
    }

    // Nested carriers. `responseBody`/`responseBodySnippet` are JSON text on an AI SDK
    // APICallError; `data` is its parsed twin; `details` is eve's event payload; `error` is
    // LiteLLM's own envelope; `cause` is the AI SDK / eve wrapping chain.
    for (const key of ["error", "data", "details", "cause", "response", "responseBody", "responseBodySnippet"]) {
      if (key in node) queue.push(node[key]);
    }
  }

  return { types, messages, statuses };
}

/**
 * True when this error is the gateway saying the key's budget is spent — and only then.
 *
 * Accepts any of the three vantage points named in this file's header: the raw body (object
 * or JSON text), the AI SDK's `AI_APICallError`, and eve's `turn.failed`/`session.failed`
 * event data. A `GatewayBudgetExceededError` is recognised too.
 *
 * Both directions matter and both are tested:
 *
 *  - **the leak** — a refusal that is not recognised posts a generic failure, and the cap
 *    looks like a bug;
 *  - **the over-rejection** — an ordinary 400 (a bad model name, a malformed request) that
 *    IS recognised would claim "I have hit my budget" about a completely different fault.
 *
 * So a marker is required (an ordinary 400 carries neither), and when a numeric status is
 * visible anywhere it must be one of the measured statuses — 400 or 429, see
 * `LITELLM_BUDGET_EXCEEDED_STATUSES` — (a 500 that happens to echo the sentence back is not
 * the gateway refusing).
 */
export function isBudgetExceeded(err: unknown): boolean {
  if (err instanceof GatewayBudgetExceededError) return true;

  const { types, messages, statuses } = collectSignals(err);

  const hasType = types.includes(LITELLM_BUDGET_EXCEEDED_TYPE);
  const hasSentence = messages.some((m) => m.includes(LITELLM_BUDGET_EXCEEDED_MESSAGE_PREFIX));
  if (!hasType && !hasSentence) return false;

  // A status is not always visible (eve's event data carries one; a bare body does not).
  // When it is, it must be one of the measured statuses.
  if (statuses.length > 0 && !statuses.some((s) => LITELLM_BUDGET_EXCEEDED_STATUSES.includes(s))) return false;

  return true;
}

// ── The door's answer ───────────────────────────────────────────────────────────────────

/**
 * The failure-event payload a door handler receives. Structurally eve 0.32.0's
 * `EventData<"turn.failed">` and `EventData<"session.failed">` (`{ code, message, details? }`
 * plus ids); narrowed here to the fields the answer is composed from, so the kit does not
 * take a type dependency on eve's protocol module.
 */
export interface FailureEventData {
  readonly code?: string;
  readonly message?: string;
  readonly details?: Record<string, unknown> | undefined;
}

/**
 * Which door is asking. The two differ in eve's own default failure text — Slack italicises
 * the error id and says "couldn't"/"a new thread"; Telegram writes it plain and says
 * "could not"/"a new message" — so the fallback has to know which one it is reproducing.
 */
export type FailureDialect = "slack" | "telegram";

/** What the door should do with one failure event. */
export type FailureResponse =
  /** A capped turn: post `text` — the door's own fixed sentence — and log one line. */
  | { readonly kind: "budget-refusal"; readonly text: string }
  /** An ordinary failure: post `text`, which is byte-for-byte what eve would have posted. */
  | { readonly kind: "default"; readonly text: string }
  /** Post nothing (the budget refusal was already answered on this turn). */
  | { readonly kind: "silent" };

export interface FailureResponseOptions {
  /** The door's fixed sentence for a capped turn. Never composed by a model. */
  readonly refusalText: string;
  /** Which door's default text to reproduce when this is NOT a budget refusal. */
  readonly dialect: FailureDialect;
}

// eve 0.32.0's own display helpers, reproduced field-for-field from
// `dist/src/internal/logging.js` (`formatErrorHint`, `truncateForDisplay`, `extractErrorId`).
// Reproduced rather than imported because eve exports neither them nor `defaultEvents`: a
// door that supplies `events["turn.failed"]` REPLACES the default outright, and the default's
// text is the behaviour that must not change on an ordinary error. `tests/gateway-budget-eve-
// default-text.test.ts` re-reads the installed eve and fails loudly if this drifts.

function truncateForDisplay(value: string, max = 160): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function formatErrorHint(data: FailureEventData): string {
  const rawName = isObject(data.details) ? data.details["name"] : undefined;
  const name = typeof rawName === "string" && rawName.length > 0 ? rawName : undefined;
  const message = typeof data.message === "string" ? data.message.trim() : "";
  if (name && message.length > 0) return ` (${name}: ${truncateForDisplay(message)})`;
  if (name) return ` (${name})`;
  if (message.length > 0) return ` (${truncateForDisplay(message)})`;
  return "";
}

function extractErrorId(details: unknown): string | undefined {
  if (!isObject(details)) return undefined;
  const errorId = details["errorId"];
  return typeof errorId === "string" && errorId.length > 0 ? errorId : undefined;
}

/** eve 0.32.0's default `turn.failed` text, per dialect. */
export function defaultTurnFailedText(data: FailureEventData, dialect: FailureDialect): string {
  const hint = formatErrorHint(data);
  const errorId = extractErrorId(data.details);
  return [
    `I hit an error while handling your request${hint}.`,
    "",
    "Please try again, rephrase, or reach out if it keeps failing.",
    ...(errorId ? ["", dialect === "slack" ? `_Error id: \`${errorId}\`_` : `Error id: ${errorId}`] : []),
  ].join("\n");
}

/** eve 0.32.0's default `session.failed` text, per dialect. */
export function defaultSessionFailedText(data: FailureEventData, dialect: FailureDialect): string {
  const hint = formatErrorHint(data);
  const errorId = extractErrorId(data.details);
  const [opening, advice] =
    dialect === "slack"
      ? [
          `This session couldn't recover from an error${hint}.`,
          "Start a new thread to continue — I can't pick this one back up.",
        ]
      : [
          `This session could not recover from an error${hint}.`,
          "Start a new message to continue.",
        ];
  return [
    opening,
    "",
    advice,
    ...(errorId ? ["", dialect === "slack" ? `_Error id: \`${errorId}\`_` : `Error id: ${errorId}`] : []),
  ].join("\n");
}

/**
 * The door's answer to a `turn.failed` event.
 *
 * A budget refusal answers with the door's fixed sentence and nothing else — the turn did
 * nothing, so nothing may be claimed. Everything else reproduces eve's own default exactly.
 */
export function respondToTurnFailed(
  data: FailureEventData,
  options: FailureResponseOptions,
): FailureResponse {
  if (isBudgetExceeded(data)) return { kind: "budget-refusal", text: options.refusalText };
  return { kind: "default", text: defaultTurnFailedText(data, options.dialect) };
}

/**
 * The door's answer to a `session.failed` event.
 *
 * A gateway budget refusal is classified **terminal** by eve (a non-transient 4xx —
 * `classifyModelCallError`, eve 0.32.0), so it emits `turn.failed` AND `session.failed` for
 * the same fault. `turn.failed` already said it; this stays silent so the door speaks once
 * per turn rather than twice. Every other failure keeps eve's default text.
 */
export function respondToSessionFailed(
  data: FailureEventData,
  options: FailureResponseOptions,
): FailureResponse {
  if (isBudgetExceeded(data)) return { kind: "silent" };
  return { kind: "default", text: defaultSessionFailedText(data, options.dialect) };
}
