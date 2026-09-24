/**
 * Who this agent trusts, by Slack user id.
 *
 * Thin Slack-only re-export. The actual list lives in `lib/principals.ts`, which holds the
 * channel→allowed-ids map shared with the approval re-check (`lib/approvals.ts`) — one list,
 * both enforcement points, no drift. This module exists as a stable Slack-specific import path
 * for `agent/channels/slack.ts` (Task 6) and the tests, matching eve-saga's layout so the
 * Slack door can be ported across with its imports unchanged.
 */
export { allowedSlackUserIds, isAllowedSlackUserId, slackUserIdOf } from "./principals.js";
