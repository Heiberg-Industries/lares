/**
 * ORB-180 / LAR-36 — the one place the "due date for a statutory rule in a fiscal year" formula
 * lives.
 *
 * Split out of `lib/deadlines.ts` so `DeadlineControls.tsx`'s `MintForm` (a client component) can
 * import the SAME formula `mintYearFromMirror` mints with, instead of restating it. `lib/deadlines.ts`
 * reaches the database pool and may not enter the client bundle (that file's header states the same
 * rule `ProactivityControls.tsx` states) — this module has no pool, no proactivity import, nothing
 * but the date arithmetic, so both sides can import it.
 */
const pad = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DD` for `rule` in `fiscalYear` — `yearOffset` adds one year, month/day pass through
 *  unchanged. The mint form uses it to grey out rules already behind today; `mintYearFromMirror`
 *  uses it to compute every row it inserts. */
export function ruleDueDate(rule: { month: number; day: number; yearOffset: number }, fiscalYear: number): string {
  return `${fiscalYear + rule.yearOffset}-${pad(rule.month)}-${pad(rule.day)}`;
}
