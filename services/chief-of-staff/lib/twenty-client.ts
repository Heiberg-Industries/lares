/**
 * Generic Twenty CRM REST helpers.
 *
 * Ported from `services/agent-runtime/lib/adapters/twenty-client.ts`: REST base
 * `{baseUrl}/rest`, `Authorization: Bearer <apiKey>`. Only the generic verbs land here —
 * domain-specific methods (people/companies/notes/opportunities) are a later task's job;
 * this task is the shared plumbing they'll all import.
 *
 * ORB-51: a caller must never conflate "Twenty is unreachable" with "Twenty said no such
 * record" — `TwentyUnavailableError` (network failure, non-404 HTTP error,
 * misconfiguration) is always distinct from `TwentyNotFoundError` (a real 404).
 */
import { readFileSync } from "node:fs";

export class TwentyUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TwentyUnavailableError";
  }
}

export class TwentyNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`Twenty: not found — ${path}`);
    this.name = "TwentyNotFoundError";
  }
}

const DEFAULT_KEY_FILE = "/run/secrets/twenty-key";

// Security review (ORB-156): callers like meeting_followup_send run this AFTER the mail has
// already gone out, sequentially over several recipients — a hung Twenty must not be able to
// stall the model turn (or, on the autonomous path, the schedule tick behind it) whose real
// work is already done. A bounded timeout, not a retry: a slow/down Twenty should fail fast
// and let each caller's own containment (log-and-continue) take over, not spend a multiple of
// this budget retrying a backend that already isn't answering.
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Read on every call, same reasoning as `readApiKey`/`restBase` below — and the override
 *  hook a test needs to prove "rejects within the timeout" without a real 15s wait. Unset in
 *  every real deployment, so production always gets the 15s default. */
function requestTimeoutMs(): number {
  const raw = process.env["TWENTY_REQUEST_TIMEOUT_MS"];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** Read on every call, never at module scope — `eve build` has no secrets (matches
 *  `agent/channels/slack.ts`'s `readSecret`). */
function readApiKey(): string {
  const path = process.env["TWENTY_KEY_FILE"] ?? DEFAULT_KEY_FILE;
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new TwentyUnavailableError(`Twenty API key not readable: ${path}`);
  }
  if (value.length === 0) throw new TwentyUnavailableError(`Twenty API key file is empty: ${path}`);
  return value;
}

function restBase(): string {
  const url = process.env["TWENTY_BASE_URL"];
  if (!url) throw new TwentyUnavailableError("TWENTY_BASE_URL is not set");
  return `${url.replace(/\/+$/, "")}/rest`;
}

async function request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const apiKey = readApiKey();
  const url = `${restBase()}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(requestTimeoutMs()),
    });
  } catch (err) {
    throw new TwentyUnavailableError(
      `Twenty ${method} ${path} — network error: ${(err as Error).message}`,
      err,
    );
  }
  if (res.status === 404) throw new TwentyNotFoundError(path);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TwentyUnavailableError(`Twenty ${method} ${path} → ${res.status} ${text.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

export function twentyGet<T = unknown>(path: string): Promise<T> {
  return request<T>("GET", path);
}

export function twentyPost<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>("POST", path, body);
}

export function twentyPatch<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>("PATCH", path, body);
}
