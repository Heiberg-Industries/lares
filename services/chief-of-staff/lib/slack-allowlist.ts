/**
 * The one Slack-only helper this role keeps beside its allow-list. The Slack allow-list itself
 * (`allowedSlackUserIds`, `isAllowedSlackUserId`) is the kit's (`@lares/agent-kit/principals`).
 */
const loggedNotConnected = new Set<string>();

/**
 * The one line a Slack-dependent schedule logs when it skips because no Slack user is configured
 * (Slack is not connected). Once per schedule per process: these schedules tick every few minutes
 * and the same sentence on every tick would bury the log.
 */
export function logSlackNotConnected(schedule: string): void {
  if (loggedNotConnected.has(schedule)) return;
  loggedNotConnected.add(schedule);
  console.log(`${schedule}: skipping, Slack is not connected (no SLACK_ALLOWED_USER_IDS configured); it starts on its own once Slack is connected`);
}
