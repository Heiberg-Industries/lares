// The four kinds a vendor request can fail in — ADR-0019 rule 2, docs/decisions/0019-integrations.md.
//
// This is the taxonomy, not the helper that classifies a live request into it: the shared
// request helper (timeout, retry, backoff, single-flight refresh, pagination) is a later slice
// and imports from here.
//
// A SEPARATE CONCERN FROM gateway-budget.ts. That module recognises the model GATEWAY's own
// budget refusal (LiteLLM, `error.type === "budget_exceeded"`) — a control-plane concern between
// this fleet and its own model provider. `not_subscribed` here is the VENDOR's version of the
// same idea (the third-party integration itself says the owner's plan does not cover this call).
// The two must stay separate types with separate recognisers; see gateway-budget.ts's own header
// for the cross-reference back to this file.
//
// kindForStatus's 403 split is a GUESS until a live probe per vendor says otherwise — the repo
// rule in CLAUDE.md: "A fixture is what we believe an API does. Only a live call is what it
// does." The first client that relies on the 403 split ships a committed live probe
// (`tests/live/<api>.live.mts`) naming the vendor; this slice adds no such probe because nothing
// here calls a live vendor yet.

/** The vendor's plan-related words a 403 body is checked against, case-insensitively, to decide
 *  between `not_subscribed` and the `not_authorised` default. A guess, not a measured contract —
 *  see this file's header. */
const PLAN_WORDS = ["plan", "upgrade", "subscription", "not subscribed", "quota exceeded for your plan"];

export const REQUEST_ERROR_KINDS = ["down", "not_authorised", "rate_limited", "not_subscribed"] as const;
export type RequestErrorKind = (typeof REQUEST_ERROR_KINDS)[number];

/** Only these two are worth retrying — a stale credential or an unpaid plan never fixes itself
 *  on a second try. */
const RETRYABLE_KINDS: readonly RequestErrorKind[] = ["down", "rate_limited"];

export interface RequestErrorDetail {
  /** The integration's id, for the Repairs inbox later. Never a URL with a token in it. */
  integration: string;
  /** HTTP status when there was one. Absent for a network failure or a timeout. */
  status?: number;
  /** Seconds the vendor asked us to wait, when it said. `rate_limited` only. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class RequestError extends Error {
  override readonly name = "RequestError";
  readonly kind: RequestErrorKind;
  readonly integration: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(kind: RequestErrorKind, message: string, detail: RequestErrorDetail) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.kind = kind;
    this.integration = detail.integration;
    this.status = detail.status;
    this.retryAfterSeconds = detail.retryAfterSeconds;
  }
}

export function isRequestError(e: unknown): e is RequestError {
  return e instanceof RequestError;
}

/** Only `down` and `rate_limited` are worth trying again. */
export function isRetryable(e: unknown): boolean {
  return isRequestError(e) && RETRYABLE_KINDS.includes(e.kind);
}

/** Maps one HTTP response to a kind, or undefined when the response is fine.
 *  402/403-with-a-plan-word → not_subscribed; 401/403 → not_authorised; 429 → rate_limited;
 *  408 and 5xx → down. Everything else is the caller's to interpret. */
export function kindForStatus(status: number, body?: string): RequestErrorKind | undefined {
  if (status === 402) return "not_subscribed";
  if (status === 401) return "not_authorised";
  if (status === 403) {
    const lower = body?.toLowerCase();
    const looksLikePlan = lower !== undefined && PLAN_WORDS.some((word) => lower.includes(word));
    return looksLikePlan ? "not_subscribed" : "not_authorised";
  }
  if (status === 429) return "rate_limited";
  if (status === 408 || (status >= 500 && status < 600)) return "down";
  return undefined;
}

/** Seconds from a `Retry-After` header, honouring both the delta and the HTTP-date form. */
export function retryAfterSeconds(headerValue: string | null, now: Date): number | undefined {
  if (headerValue === null) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const asDate = new Date(trimmed);
  if (Number.isNaN(asDate.getTime())) return undefined;
  const deltaMs = asDate.getTime() - now.getTime();
  return Math.max(0, Math.round(deltaMs / 1000));
}
