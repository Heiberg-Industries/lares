/**
 * tests/live/slack-dm-channel.live.mts — the LIVE probe for the one Slack answer scheduled cards
 * now depend on: `conversations.open` with a user id returns that person's direct-message
 * channel, an id starting with `D`.
 *
 * Per the repository rule: "a fixture is what we believe an API does; only a live call is what it
 * does." `tests/eve-slack-schedule-card-address.test.ts` proves the plumbing with a fake Slack. It
 * cannot tell us whether THIS installation's Slack app is allowed to make the call, or what Slack
 * really sends back. Both directions matter:
 *
 *   - the LEAK — if Slack answered with something that is not a `D…` id and the lookup passed it
 *     on, a scheduled card would again be posted where its buttons reach nothing. The lookup
 *     refuses any other shape; this probe shows whether Slack ever gives it one.
 *   - the OVER-REJECTION — if the app cannot make the call at all (the usual cause is a missing
 *     `im:write` bot scope, which Slack reports as `missing_scope`), every scheduled Slack
 *     conversation stops with an error instead of being posted. That is loud and safe, but it is
 *     an outage of scheduled Slack messages, so it has to be known BEFORE this change is deployed.
 *
 * It runs the real `slackDmChannelId` from `lib/slack-dm-channel.ts`, so the request goes out the
 * way the door's own calls do, through the door's proxy routing.
 *
 * NOT part of `pnpm test` and never run in CI: it needs the installation's Slack bot token. Run it
 * by hand, where the agent runs (inside the agent's container the token file is mounted and the
 * proxy is already configured), whenever `lib/slack-dm-channel.ts` changes, the Slack app's scopes
 * change, or eve's Slack channel is upgraded:
 *
 *   SLACK_BOT_TOKEN_FILE=<path-to-the-bot-token-file> SLACK_DM_PROBE_USER_ID=<owner-slack-user-id> \
 *     pnpm -C services/chief-of-staff exec tsx tests/live/slack-dm-channel.live.mts
 *
 * Outside the container, also set SLACK_PROXY_URL to an HTTP proxy that can reach slack.com.
 * SLACK_DM_PROBE_USER_ID may be left out where SLACK_ALLOWED_USER_IDS is set: the first id on that
 * list, the owner's, is used.
 *
 * WHAT IT DOES TO SLACK: `conversations.open` returns the direct-message channel between the app
 * and that person, opening it if it was never opened. It posts nothing and reads no message.
 *
 * WHAT IT PRINTS: one line, PASS or FAIL. On FAIL, Slack's error code (`missing_scope`,
 * `user_not_found`, ...), which names a cause and no person. It never prints the token, the user
 * id or the channel id. Exit status is 0 on PASS and 1 on FAIL.
 */
import { readFileSync } from "node:fs";

import { allowedSlackUserIds } from "../../lib/principals.js";
import { SlackDmChannelError, slackDmChannelId } from "../../lib/slack-dm-channel.js";

function fail(reason: string): never {
  console.log(`FAIL: ${reason}`);
  process.exit(1);
}

const tokenFile = process.env["SLACK_BOT_TOKEN_FILE"];
if (!tokenFile) fail("SLACK_BOT_TOKEN_FILE is not set (the path of the file holding the bot token)");

const userId = process.env["SLACK_DM_PROBE_USER_ID"] || allowedSlackUserIds()[0];
if (!userId) fail("no user id: set SLACK_DM_PROBE_USER_ID, or SLACK_ALLOWED_USER_IDS");
// A channel id here would be answered from the lookup's own shortcut, without asking Slack.
if (!/^[UW][A-Z0-9]+$/.test(userId)) fail("the id given is not a Slack user id (those start with U or W)");

let token: string;
try {
  token = readFileSync(tokenFile, "utf8").trim();
} catch {
  fail("the bot token file could not be read");
}
if (token.length === 0) fail("the bot token file is empty");

try {
  // The token is read here rather than through the door's credentials so the probe asks Slack
  // exactly one question and needs no database. Everything after the token is the real lookup.
  const channelId = await slackDmChannelId(userId, { botToken: async () => token });
  // `slackDmChannelId` only ever returns an id that starts with "D"; say so rather than show it.
  console.log(
    channelId.startsWith("D")
      ? 'PASS: conversations.open returned a direct-message channel id (starts with "D")'
      : "FAIL: the lookup returned an id that does not start with \"D\"",
  );
  process.exit(channelId.startsWith("D") ? 0 : 1);
} catch (error) {
  if (error instanceof SlackDmChannelError) fail(`conversations.open did not return a direct-message channel: ${error.slackError}`);
  fail("the lookup threw an unexpected error");
}
