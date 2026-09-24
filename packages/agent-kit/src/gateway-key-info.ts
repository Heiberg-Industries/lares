/**
 * gateway-key-info.ts — an agent reads its OWN LiteLLM virtual key's spend and budget
 * (LAR-20-s1). Groundwork only: nothing here samples, stores or displays anything; it just
 * asks the gateway one question and hands back a typed answer or `null`.
 *
 * ## Documented vs. believed (checked against docs.litellm.ai 2026-09-18)
 *
 * DOCUMENTED: `GET /key/info?key=<some key>`, called with `Authorization: Bearer <MASTER
 * key>`, is the only form LiteLLM's docs show — a master-key holder looking up a key it
 * manages (`docs.litellm.ai/docs/proxy/virtual_keys`). The one worked example there returns
 * `{ "key": "sk-...", "info": { "token": ..., "spend": ..., "expires": ..., "models": [...],
 * "aliases": {...}, "config": {} } }` — note that example does NOT show `max_budget`,
 * `budget_duration`, `budget_reset_at` or `key_alias` inside `/key/info` specifically. Those
 * four field names ARE documented, but on the equivalent key-object schema returned by
 * `/user/info`'s `keys[]` array and by `/key/generate`
 * (`docs.litellm.ai/docs/proxy/users`, `docs.litellm.ai/docs/proxy/cost_tracking`) — reasonable
 * to expect `/key/info` shares that schema, since `info` is that same object, but NOT itself
 * shown in a `/key/info` sample. DOCUMENTED separately: `/key/generate` (and by extension the
 * other `/key/*` mutators) is an admin-only route — a non-admin virtual key gets exactly
 * `{"error":{"message":"user not allowed to access this route. Route=/key/generate is an
 * admin only route","type":"auth_error","param":"None","code":"403"}}`
 * (`docs.litellm.ai/docs/proxy/public_routes`).
 *
 * NOT DOCUMENTED ANYWHERE: what `GET /key/info` with NO `key` parameter, called with an
 * ordinary (non-admin, budget-capped) virtual key as the bearer token, answers. Every
 * documented example is the master-key/`?key=` form above — none describes a parameterless
 * self-lookup. That the caller's own key would be enough to read its own `spend`/budget is
 * this file's BELIEF, not a documented contract, chosen because it is the natural reading of
 * "no key given = the caller's own" and the cheapest way for a capped, non-admin key to see
 * its own spend. This belief, and the shape of whatever it actually returns, is exactly what
 * `tests/live/litellm-key-info.live.mts` exists to settle against the real gateway (root
 * CLAUDE.md's fixture rule) — its step 1 is the no-parameter form, step 2 is the documented
 * `?key=<the same key>` fallback if step 1 doesn't answer the same way.
 *
 * Until that probe has run, this client is written to be honest about the uncertainty: it
 * tolerates the one documented envelope, validates every field it needs rather than trusting
 * the shape, and returns `null` — never a thrown error, never an invented number — for
 * anything that isn't a clean, typed answer. A caller that gets `null` back has exactly as
 * much information as "the gateway didn't give me a usable answer just now," nothing more.
 *
 * ## Posture
 *
 * Mirrors `entur-client.ts`/`orakel-client.ts`: fetch is injected (never a bare `fetch(...)`
 * call), nothing is read at module scope, and the client takes its config as plain arguments
 * rather than reaching into `process.env` itself — callers use `gatewayUrl()`/`gatewayKey()`
 * from `./gateway-provider.ts` for that, the same way `gatewayModel()` does, so this goes out
 * over whatever fetch the caller already uses for its model calls (the sealed box's egress
 * proxy, on an agent; `globalThis.fetch` in tests and from a Mac).
 *
 * The key must NEVER be logged, printed, or embedded in a returned/thrown value: every failure
 * path below returns `null` with no message that could carry the key or the raw response body.
 */
import { IDENTITY_ENCODING_HEADERS } from "./gateway-provider.js";

/** What an agent needs to know about its own gateway key, or `null` when the gateway didn't
 *  give a clean, typed answer (see this file's header — `null` is not "zero", it is
 *  "unavailable, forbidden, or malformed"). */
export interface GatewayKeyInfo {
  spend: number;
  maxBudget: number | null;
  budgetDuration: string | null;
  budgetResetAt: string | null;
  keyAlias: string | null;
}

export interface ReadOwnKeyInfoOptions {
  gatewayUrl: string;
  /** This agent's own gateway virtual key. Never logged; see this file's header. */
  key: string;
  /** Injected so tests never touch the network and the box's sealed egress can be used in
   *  production, matching `entur-client.ts`/`orakel-client.ts`. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Per-request bound, so a dead hop fails in seconds rather than hanging the caller. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

/**
 * Asks the gateway about the calling key's own spend and budget. Returns `null` — never
 * throws — on a network failure, a non-200 status, a non-JSON body, or a body missing a
 * numeric `spend`: those are exactly "unavailable / forbidden / malformed", and this function
 * deliberately does not try to tell them apart, because doing so would mean guessing at
 * behaviour the docs don't describe (see the header comment).
 */
export async function readOwnKeyInfo(opts: ReadOwnKeyInfoOptions): Promise<GatewayKeyInfo | null> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${opts.gatewayUrl.replace(/\/+$/, "")}/key/info`;

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { Authorization: `Bearer ${opts.key}`, ...IDENTITY_ENCODING_HEADERS },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network error, timeout, or an aborted signal — never surface the cause, since a thrown
    // fetch error can carry the request (and so the key) in some environments.
    return null;
  }
  if (res.status !== 200) return null;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Not JSON — e.g. an HTML error page from a proxy in front of the gateway.
    return null;
  }
  if (!isObject(body)) return null;
  const info = body["info"];
  if (!isObject(info)) return null;

  const spend = readNumber(info, "spend");
  if (spend === undefined) return null;

  return {
    spend,
    maxBudget: readNumber(info, "max_budget") ?? null,
    budgetDuration: readString(info, "budget_duration"),
    budgetResetAt: readString(info, "budget_reset_at"),
    keyAlias: readString(info, "key_alias"),
  };
}
