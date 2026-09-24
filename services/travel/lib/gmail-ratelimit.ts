// lib/gmail-ratelimit.ts — rate-limit backoff for eve-marcel's Gmail readonly client.
//
// Ported VERBATIM from services/marcel/lib/gmail-ratelimit.ts (Task 4 brief) — same shared
// owner@owner.example mailbox, same PER-MAILBOX "User-rate limit exceeded" quota. With no
// backoff a fixed poll interval re-fires straight into the throttle and the window never
// clears (this is what produced old Marcel's recurring "Gmail-polling har feilet" alert).
//
// This wraps each googleapis call so a 429 is honoured (Google's "Retry after <ISO>" hint),
// backed off with jitter, and remembered as a gate so the next call holds off instead of
// hammering.

export const RL_BASE_DELAY_MS = 1_000;
export const RL_MAX_DELAY_MS = 60_000;
export const RL_MAX_RETRIES = 4;

export interface RateLimitOpts {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  maxRetries?: number;
}

const gatedUntil = new Map<string, number>();

export function __resetGmailGatesForTest(): void {
  gatedUntil.clear();
}

/** null → not a rate-limit error (rethrow). number ≥ 0 → rate-limited; explicit wait ms (0 = no hint). */
export function parseRateLimit(err: unknown, nowMs: number): number | null {
  if (err === null || typeof err !== "object") return null;
  const e = err as {
    code?: unknown; status?: unknown; message?: unknown;
    response?: { status?: unknown; headers?: Record<string, unknown> } | undefined;
  };
  const status = Number(e.code ?? e.status ?? e.response?.status ?? NaN);
  const message = typeof e.message === "string" ? e.message : "";
  const looksRateLimited =
    status === 429 || /rate.?limit|userRateLimitExceeded|rateLimitExceeded|quota/i.test(message);
  if (!looksRateLimited) return null;

  const iso = message.match(/Retry after\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i);
  if (iso) {
    const t = Date.parse(iso[1]!);
    if (Number.isFinite(t)) return Math.max(0, t - nowMs);
  }
  const raHeader = e.response?.headers?.["retry-after"];
  if (raHeader !== undefined) {
    const secs = Number(raHeader);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  return 0;
}

function backoffWait(attempt: number, hintMs: number, rand: () => number): number {
  const base = hintMs > 0 ? hintMs : RL_BASE_DELAY_MS * 2 ** attempt;
  return Math.min(base, RL_MAX_DELAY_MS) + rand() * 500;
}

/** True while the mailbox is inside an active backoff window (the poll loop skips ticks then). */
export function isGated(mailboxKey: string, nowMs: number): boolean {
  return (gatedUntil.get(mailboxKey) ?? 0) > nowMs;
}

export async function withGmailRateLimit<T>(
  mailboxKey: string,
  fn: () => Promise<T>,
  opts: RateLimitOpts = {},
): Promise<T> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const rand = opts.rand ?? Math.random;
  const maxRetries = opts.maxRetries ?? RL_MAX_RETRIES;

  const until = gatedUntil.get(mailboxKey) ?? 0;
  if (until > now()) await sleep(until - now() + rand() * 500);

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const hint = parseRateLimit(err, now());
      if (hint === null || attempt >= maxRetries) throw err;
      const wait = backoffWait(attempt, hint, rand);
      gatedUntil.set(mailboxKey, now() + wait);
      console.warn(`eve-marcel: gmail rate-limited — backing off ${Math.round(wait)}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(wait);
    }
  }
}
