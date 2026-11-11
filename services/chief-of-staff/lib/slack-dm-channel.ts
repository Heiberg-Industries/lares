/**
 * lib/slack-dm-channel.ts - the direct-message channel behind a Slack user id, looked up once.
 *
 * WHY THIS EXISTS. Slack accepts a person's user id (`U…`) as `chat.postMessage`'s `channel` and
 * delivers into that person's direct-message channel (`D…`). eve files a conversation under the
 * address it was GIVEN, though, and a button tap on a card carries the address Slack DELIVERED
 * to. So a scheduled conversation started at `U…` posts a card whose Approve and Deny reach no
 * conversation: the tap asks for `D…:<thread>`, nothing was ever filed there, and eve 1.0 answers
 * "This request is no longer active". Starting the conversation at `D…` in the first place makes
 * the two addresses the same one.
 *
 * The lookup is Slack's `conversations.open` with `users=<user id>`, which returns the existing
 * direct-message channel or opens it. It goes out through `callSlackApi` with the Slack door's
 * own bot token, and so through the door's proxy dispatcher, like every other call the door makes.
 *
 * THE RULE THAT MATTERS: on any failure this THROWS. It never returns the user id as a stand-in.
 * A caller that fell back to `U…` would post a card that looks right and cannot be answered,
 * which is the defect this file is here to remove. A thrown error means nothing is posted, and
 * the schedule's gate records the item as not sent, so it stays eligible for the next run.
 *
 * What this asks of the Slack app: `conversations.open` for a direct message needs the `im:write`
 * bot scope. `tests/live/slack-dm-channel.live.mts` is the committed probe that says whether a
 * given installation's app can do it; a fixture cannot.
 */
import { callSlackApi, type SlackBotToken } from "eve/channels/slack";

import { slackCredentials } from "../agent/channels/slack.js";

/** Thrown when the direct-message channel could not be established. `slackError` is Slack's own
 *  error code (`missing_scope`, `user_not_found`, ...) or a short reason of ours; never a token. */
export class SlackDmChannelError extends Error {
  override readonly name = "SlackDmChannelError";
  constructor(readonly slackError: string, options?: { cause?: unknown }) {
    super(`slack direct-message channel lookup failed: ${slackError}`, options);
  }
}

export interface SlackDmChannelDeps {
  /** The bot token to call with. Defaults to the Slack door's, read from disk per call. */
  botToken?: SlackBotToken;
  /** `callSlackApi`, injectable for tests. */
  call?: typeof callSlackApi;
}

/** Resolved channel ids, per user id, for the life of the process. A direct-message channel id
 *  does not change for a given app and person, so one successful lookup is enough. Failures are
 *  never stored: the next send asks again. */
const resolved = new Map<string, string>();
/** Lookups in progress, so two schedules firing in the same second share one request. */
const inFlight = new Map<string, Promise<string>>();

/** A Slack direct-message channel id. `conversations.open` with one user returns exactly this. */
function isDmChannelId(value: unknown): value is string {
  return typeof value === "string" && /^D[A-Z0-9]+$/.test(value);
}

async function lookUp(userId: string, deps: SlackDmChannelDeps): Promise<string> {
  let response: Awaited<ReturnType<typeof callSlackApi>>;
  try {
    response = await (deps.call ?? callSlackApi)({
      botToken: deps.botToken ?? slackCredentials.botToken,
      operation: "conversations.open",
      body: { users: userId },
    });
  } catch (cause) {
    // The request never produced a Slack answer (no token, the proxy, the network). The cause is
    // kept for the log; the message stays a fixed phrase so nothing from a credential path or a
    // response body is repeated into a place it was not meant for.
    throw new SlackDmChannelError("request_failed", { cause });
  }
  if (response.ok !== true) {
    const code = (response as { error?: unknown }).error;
    throw new SlackDmChannelError(typeof code === "string" && code.length > 0 ? code : "unknown_error");
  }
  const channelId = (response as { channel?: { id?: unknown } }).channel?.id;
  // Slack said ok but did not hand back a direct-message channel. Refuse rather than guess: an
  // address that is not `D…` is exactly the mismatch this lookup exists to prevent.
  if (!isDmChannelId(channelId)) throw new SlackDmChannelError("no_direct_message_channel_returned");
  return channelId;
}

/**
 * The direct-message channel id (`D…`) for a Slack user id, from `conversations.open`, cached per
 * user id. An id that already is a direct-message channel is returned as it is, with no call.
 *
 * Throws {@link SlackDmChannelError} when Slack refuses, answers without a `D…` channel, or cannot
 * be reached. Callers must let that stop the send.
 */
export async function slackDmChannelId(userId: string, deps: SlackDmChannelDeps = {}): Promise<string> {
  const id = userId.trim();
  if (id.length === 0) throw new SlackDmChannelError("no_user_id");
  if (isDmChannelId(id)) return id;

  const known = resolved.get(id);
  if (known !== undefined) return known;

  const pending = inFlight.get(id);
  if (pending !== undefined) return pending;

  const lookup = lookUp(id, deps)
    .then((channelId) => {
      resolved.set(id, channelId);
      return channelId;
    })
    .finally(() => {
      inFlight.delete(id);
    });
  inFlight.set(id, lookup);
  return lookup;
}

/** Tests only: forget every cached and in-flight lookup. */
export function resetSlackDmChannelCacheForTests(): void {
  resolved.clear();
  inFlight.clear();
}
