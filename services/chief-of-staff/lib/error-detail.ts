/**
 * The text a failure report carries for a caught error. `String(err)` alone gave
 * "TypeError: fetch failed" and nothing else: undici puts the reason a connection never
 * completed (refused, timed out, the proxy said no) in `cause`, and Node's dual-stack connect
 * failure is an AggregateError whose own message is empty. This keeps String(err) as the first
 * line, then each cause in turn, each part of an AggregateError, and any system `code` the
 * message does not already show.
 *
 * Kept out of `signal-emit.ts` on purpose: tests mock that module down to `emitSignal` alone.
 */
const MAX_LINES = 12;

function line(err: unknown): string {
  const text = String(err);
  if (!(err instanceof Error)) return text;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && !text.includes(code) ? `${text} [${code}]` : text;
}

export function errorDetail(err: unknown): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  const walk = (e: unknown, prefix: string): void => {
    if (lines.length >= MAX_LINES || (typeof e === "object" && e !== null && seen.has(e))) return;
    seen.add(e);
    lines.push(prefix + line(e));
    if (e instanceof AggregateError) for (const part of e.errors) walk(part, "part: ");
    if (e instanceof Error && e.cause !== undefined) walk(e.cause, "caused by: ");
  };
  walk(err, "");
  return lines.join("\n");
}
