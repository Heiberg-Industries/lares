/**
 * Who this agent trusts, by Slack user id.
 *
 * Thin Slack-only re-export. The actual list lives in `lib/principals.ts`, which holds the
 * channel→allowed-ids map shared with Telegram and with the approval re-check
 * (`lib/approvals.ts`) — one list, both enforcement points, no drift. This module survives
 * as a stable Slack-specific import path for `agent/channels/slack.ts` and
 * `tests/gate.test.ts`, both of which already depend on these exact names.
 */
export { allowedSlackUserIds, isAllowedSlackUserId, slackUserIdOf } from "./principals.js";

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
