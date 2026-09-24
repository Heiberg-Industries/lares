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
