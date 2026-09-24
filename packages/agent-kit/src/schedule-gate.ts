/**
 * The one gate every schedule checks first, before doing anything proactive — sending a
 * reminder, posting to a channel, firing a scheduled loop.
 *
 * `EVE_SCHEDULES_LIVE` starts at `"0"` in each agent's own block of
 * `services/box/compose.yaml`, so an agent's schedules stay dark until its own cutover
 * flips this to `"1"` in one place.
 *
 * - eve-saga: gates every schedule in Tasks 10-13. Started dark while the old runtime's own
 *   reminder/digest/etc. loops kept running — two Sagas must never both send a reminder.
 * - eve-marcel: gates every schedule in Tasks 7-8 (trip-lifecycle, dream, taste-promote,
 *   flight-watch). Started dark through Task 12's cutover — pointing the real
 *   `@MarcelConciergeBot`'s webhook at eve-marcel IS the cutover, no separate shadow bot
 *   (Bendik, 2026-08-17) — until Bendik reviewed Task 12's admin-DM live-fire verification
 *   (every tool exercised once, for real, in his own private chat) and was satisfied, then
 *   flipped this to `"1"` himself. Nothing proactive (trip-lifecycle posts, dream/taste-promote,
 *   flight-watch) could fire before that, regardless of what was linked.
 *
 * Fails closed on anything other than the exact string `"1"`: unset, `"0"`, `"true"`, a typo —
 * all mean off.
 */
export function scheduleGate(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["EVE_SCHEDULES_LIVE"] === "1";
}
