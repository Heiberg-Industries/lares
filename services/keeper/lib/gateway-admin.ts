/**
 * Read-only adapter for the gateway (LiteLLM), used only by the keeper's `gateway.status` action.
 *
 * Hard allowlist: exactly three GET routes, enforced in `call`, the one function that talks to the
 * network. `/health` is deliberately NOT here: it sends a real, paid test request to every model.
 * No POST, no `/key/*`. One attempt per call, a bounded timeout, redirects never followed (so the
 * admin key can never be forwarded to another address). The key goes only to `/v1/model/info`, is
 * never put in a URL, and no error or result carries a response body, a key or an `api_base`.
 */
export const GATEWAY_ROUTES = {
  liveliness: "/health/liveliness",
  readiness: "/health/readiness",
  modelInfo: "/v1/model/info",
} as const;
const ALLOWED: ReadonlySet<string> = new Set(Object.values(GATEWAY_ROUTES));
export const GATEWAY_TIMEOUT_MS = 5_000;

export type LivelinessResult = { kind: "ok" } | { kind: "unreachable" };
export type ReadinessResult = { kind: "ready" } | { kind: "not-ready" } | { kind: "unreadable" } | { kind: "unreachable" };
export interface GatewayModel { alias: string; target: { provider: string; model: string } | null }
export type ModelInfoResult = { kind: "ok"; models: GatewayModel[] } | { kind: "refused" } | { kind: "invalid" } | { kind: "unavailable" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Provider is everything before the first "/"; no other interpretation. */
function targetOf(model: unknown): GatewayModel["target"] {
  if (typeof model !== "string") return null;
  const i = model.indexOf("/");
  if (i < 1 || i === model.length - 1) return null;
  return { provider: model.slice(0, i).slice(0, 200), model: model.slice(i + 1).slice(0, 200) };
}

export class GatewayAdmin {
  private origin: string;
  constructor(gatewayUrl: string, private request: typeof fetch = globalThis.fetch, private timeoutMs = GATEWAY_TIMEOUT_MS) {
    this.origin = new URL(gatewayUrl).origin;
  }
  /** The single choke point. Any path outside the allowlist is refused before a request exists. */
  async call(path: string, key?: string): Promise<Response> {
    if (!ALLOWED.has(path)) throw new Error("keeper: gateway route not allowed");
    return this.request(`${this.origin}${path}`, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs),
      ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
    });
  }
  async liveliness(): Promise<LivelinessResult> {
    try {
      const response = await this.call(GATEWAY_ROUTES.liveliness);
      return response.status === 200 ? { kind: "ok" } : { kind: "unreachable" };
    } catch { return { kind: "unreachable" }; }
  }
  async readiness(): Promise<ReadinessResult> {
    let response: Response;
    try { response = await this.call(GATEWAY_ROUTES.readiness); } catch { return { kind: "unreachable" }; }
    if (response.status === 503) return { kind: "not-ready" };
    if (response.status !== 200) return { kind: "unreachable" };
    try {
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.status !== "string" || typeof body.db !== "string") return { kind: "unreadable" };
      return body.db === "connected" ? { kind: "ready" } : { kind: "not-ready" };
    } catch { return { kind: "unreadable" }; }
  }
  async modelInfo(key: string): Promise<ModelInfoResult> {
    let response: Response;
    try { response = await this.call(GATEWAY_ROUTES.modelInfo, key); } catch { return { kind: "unavailable" }; }
    if (response.status === 401 || response.status === 403) return { kind: "refused" };
    if (response.status !== 200) return { kind: "unavailable" };
    let body: unknown;
    try { body = await response.json(); } catch { return { kind: "invalid" }; }
    if (!isRecord(body) || !Array.isArray(body.data)) return { kind: "invalid" };
    const byAlias = new Map<string, GatewayModel["target"] | undefined>();
    for (const entry of body.data) {
      if (!isRecord(entry) || typeof entry.model_name !== "string" || !entry.model_name || entry.model_name.length > 200) return { kind: "invalid" };
      const target = targetOf(isRecord(entry.litellm_params) ? entry.litellm_params.model : undefined);
      const seen = byAlias.get(entry.model_name);
      if (seen === undefined) byAlias.set(entry.model_name, target);
      else if (seen === null || target === null || seen.provider !== target.provider || seen.model !== target.model) byAlias.set(entry.model_name, null);
    }
    return { kind: "ok", models: [...byAlias].map(([alias, target]) => ({ alias, target: target ?? null })) };
  }
}
