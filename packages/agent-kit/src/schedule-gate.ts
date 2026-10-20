/**
 * The one gate every schedule checks first, before doing anything proactive — sending a
 * reminder, posting to a channel, firing a scheduled loop.
 *
 * `EVE_SCHEDULES_LIVE` starts at `"0"` for a new agent, so an agent's schedules stay dark until
 * its owner has checked it works and flips this to `"1"` in one place. Nothing proactive can
 * fire before that, regardless of what was linked. It is also what keeps a second agent from
 * sending the same reminder while another agent's loops are still running.
 *
 * Fails closed on anything other than the exact string `"1"`: unset, `"0"`, `"true"`, a typo —
 * all mean off.
 */
export function scheduleGate(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["EVE_SCHEDULES_LIVE"] === "1";
}
