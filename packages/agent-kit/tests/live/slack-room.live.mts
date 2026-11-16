/**
 * packages/agent-kit/tests/live/slack-room.live.mts — the LIVE probe for what Slack answers the
 * calls the framework makes when someone mentions the agent in a shared channel ("room").
 *
 * Per the repository rule: "a fixture is what we believe an API does; only a live call is what it
 * does." The real-install image check (`services/box/tests/real-install-image.probe.py`) sends a
 * mention through a stand-in for Slack (`services/box/tests/real-install/fake-internet.mjs`,
 * `ROOM_SEEN`), and that stand-in answers what this probe saw real Slack answer in a channel for
 * this app's permissions. This probe asks real Slack the same questions, so the stand-in can be
 * kept right in one place. It reads and records; it branches on nothing Lares ships, and no Slack
 * answer makes it fail.
 *
 * WHAT IT PROVES, one line each, `ok` or Slack's own error code:
 *   - `auth.test`: the token works; also the bot permissions Slack reports for it (the
 *     `x-oauth-scopes` answer header: permission names only);
 *   - `conversations.info` on the channel (the framework's privacy lookup for a mention);
 *   - `chat.postMessage (message)` and `chat.postMessage (threaded reply)` under it (how a reply
 *     in the mention's thread is posted);
 *   - `chat.update (threaded reply)` (how the framework edits a message it posted);
 *   - `assistant.threads.setStatus (set)` and `(clear)` in that thread, with the same fields the
 *     framework sends (its "Thinking..." line, set and then cleared); this probe sets it on the
 *     thread of the bot's own message, while the framework sets it on the thread of a person's
 *     mention, and whether Slack treats these differently is not known;
 *   - `conversations.replies` on that thread (the framework's thread read for shared files);
 *   - `conversations.open` with the owner's user id (the direct-message lookup; it posts nothing);
 *   - `chat.delete (threaded reply)` and `chat.delete (message)`.
 * Where Slack refuses for a missing permission it names the permission it wanted (`needed`); that
 * name is printed too. Then one machine-readable line, `SUMMARY {...}`.
 *
 * WHAT IT NEEDS:
 *   - SLACK_BOT_TOKEN_FILE: the path of a FILE holding the app's bot token (`xoxb-...`). The token
 *     is read from the file and sent only in the Authorization header to slack.com; never printed.
 *   - SLACK_ROOM_PROBE_CHANNEL: the id of a TEST channel the app has been invited to (starts with C
 *     or G; not a direct message).
 *   - SLACK_ROOM_PROBE_OWNER: the owner's Slack user id (starts with U or W).
 * Node 22.18 or newer runs this file as it is, with no install:
 *
 *     SLACK_BOT_TOKEN_FILE=<path> SLACK_ROOM_PROBE_CHANNEL=<C...> SLACK_ROOM_PROBE_OWNER=<U...> \
 *       node packages/agent-kit/tests/live/slack-room.live.mts
 *
 * NOT part of `pnpm test` and never run in CI. Run it by hand once before mentions are switched on,
 * and again whenever the Slack app's permissions or eve's Slack channel change.
 *
 * WHAT IT DOES TO SLACK: it posts TWO messages in the test channel (a message and a threaded reply
 * under it, both saying they are a probe and will be deleted), edits the reply once, sets and clears
 * the thread's status line, and deletes both messages again. `conversations.open` opens (or finds)
 * the app's direct-message channel with the owner and posts nothing there.
 *
 * WHAT IT PRINTS: step names, `ok` or Slack's error code, and permission names. Never the token, any
 * message text, the channel id, the user id or the direct-message id. If a delete fails, it says so
 * and exits 1: the probe's message is then still in the channel and must be deleted by hand.
 *
 * LAST RUN: 16 November 2026. The app held exactly the bot permissions `chat:write`, `im:history`,
 * `im:write` and `app_mentions:read`, in a public channel. The probe itself does not call eve; the
 * eve pinned in this branch is 1.0.0-rc.10. The SUMMARY line, verbatim:
 *   SUMMARY {"probe":"slack-room","results":{"auth.test":"ok","conversations.info":"missing_scope","chat.postMessage (message)":"ok","chat.postMessage (threaded reply)":"ok","chat.update (threaded reply)":"ok","assistant.threads.setStatus (set)":"ok","assistant.threads.setStatus (clear)":"ok","conversations.replies":"missing_scope","conversations.open":"ok","chat.delete (threaded reply)":"ok","chat.delete (message)":"ok"},"needed":{"conversations.info":"channels:read,groups:read,mpim:read,im:read","conversations.replies":"channels:history"},"scopes":["chat:write","im:write","app_mentions:read","im:history"],"messagesLeftInChannel":0}
 * An earlier run the same day, in the same channel, with wider permissions (among them
 * `channels:read`, `channels:history` and `assistant:write`) got `ok` for `conversations.info`,
 * `conversations.replies` and both status-line calls. The stand-in's `ROOM_SEEN` in
 * `services/box/tests/real-install/fake-internet.mjs` matches the run above; record the next run
 * here the same way and keep `ROOM_SEEN` matching it.
 */
import { readFileSync } from "node:fs";

type SlackAnswer = { ok?: unknown; error?: unknown; needed?: unknown; ts?: unknown; channel?: unknown };

function stop(reason: string): never {
  console.log(`STOPPED: ${reason}`);
  process.exit(1);
}

const tokenFile = process.env["SLACK_BOT_TOKEN_FILE"];
const channel = process.env["SLACK_ROOM_PROBE_CHANNEL"] ?? "";
const owner = process.env["SLACK_ROOM_PROBE_OWNER"] ?? "";
if (!tokenFile) stop("SLACK_BOT_TOKEN_FILE is not set (the path of the file holding the bot token)");
if (!/^[CG][A-Z0-9]+$/.test(channel)) stop("SLACK_ROOM_PROBE_CHANNEL is not a channel id (a test channel's id starts with C or G)");
if (!/^[UW][A-Z0-9]+$/.test(owner)) stop("SLACK_ROOM_PROBE_OWNER is not a Slack user id (those start with U or W)");
let token = "";
try {
  token = readFileSync(tokenFile, "utf8").trim();
} catch {
  stop("the bot token file could not be read");
}
if (!token.startsWith("xoxb-")) stop("the file does not hold a bot token (those start with xoxb-)");

const results: Record<string, string> = {};
const needed: Record<string, string> = {};
let scopes: string[] = [];

/** One Slack Web API call, form-encoded, with the token in the header only. Returns Slack's answer,
 *  or an `{ ok: false, error }` of the probe's own for a failure to reach Slack. */
async function call(method: string, fields: Record<string, string>): Promise<{ answer: SlackAnswer; headers: Headers | null }> {
  try {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const answer = (await response.json().catch(() => ({ ok: false, error: `probe_unreadable_http_${response.status}` }))) as SlackAnswer;
    return { answer, headers: response.headers };
  } catch {
    return { answer: { ok: false, error: "probe_could_not_reach_slack" }, headers: null };
  }
}

/** Records and prints one step: `ok`, or Slack's error code (and the permission it named). */
function note(step: string, answer: SlackAnswer): boolean {
  const ok = answer.ok === true;
  const code = ok ? "ok" : typeof answer.error === "string" && /^[a-z0-9_]{1,80}$/.test(answer.error) ? answer.error : "unknown_error";
  results[step] = code;
  const wanted = !ok && typeof answer.needed === "string" && /^[a-z0-9:._,-]{1,200}$/.test(answer.needed) ? answer.needed : null;
  if (wanted) needed[step] = wanted;
  console.log(`${step}: ${code}${wanted ? ` (needed: ${wanted})` : ""}`);
  return ok;
}

function skipped(step: string, because: string): void {
  results[step] = "skipped";
  console.log(`${step}: skipped (${because})`);
}

const tsOf = (answer: SlackAnswer): string | null => typeof answer.ts === "string" && answer.ts !== "" ? answer.ts : null;

const auth = await call("auth.test", {});
if (note("auth.test", auth.answer)) {
  scopes = (auth.headers?.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim()).filter((scope) => /^[a-z0-9:._-]{1,80}$/.test(scope));
  console.log(`  bot permissions Slack reports: ${scopes.join(", ") || "(none reported)"}`);
}

note("conversations.info", (await call("conversations.info", { channel })).answer);

const parent = (await call("chat.postMessage", { channel, text: "Lares room probe: this message is deleted again in a moment." })).answer;
const parentTs = note("chat.postMessage (message)", parent) ? tsOf(parent) : null;

let replyTs: string | null = null;
if (parentTs) {
  const reply = (await call("chat.postMessage", { channel, thread_ts: parentTs, text: "Lares room probe: a threaded reply, deleted again in a moment." })).answer;
  replyTs = note("chat.postMessage (threaded reply)", reply) ? tsOf(reply) : null;
  if (replyTs) {
    note("chat.update (threaded reply)", (await call("chat.update", { channel, ts: replyTs, text: "Lares room probe: a threaded reply, edited once, deleted again in a moment." })).answer);
  } else {
    skipped("chat.update (threaded reply)", "no threaded reply was posted");
  }
  // The same fields the framework sends for its status line: set with one loading message, then cleared.
  note("assistant.threads.setStatus (set)", (await call("assistant.threads.setStatus", { channel_id: channel, thread_ts: parentTs, status: "Thinking...", loading_messages: JSON.stringify(["Thinking..."]) })).answer);
  note("assistant.threads.setStatus (clear)", (await call("assistant.threads.setStatus", { channel_id: channel, thread_ts: parentTs, status: "" })).answer);
  note("conversations.replies", (await call("conversations.replies", { channel, ts: parentTs, limit: "50" })).answer);
} else {
  for (const step of ["chat.postMessage (threaded reply)", "chat.update (threaded reply)", "assistant.threads.setStatus (set)", "assistant.threads.setStatus (clear)", "conversations.replies"])
    skipped(step, "no message was posted to thread under");
}

const opened = (await call("conversations.open", { users: owner })).answer;
if (note("conversations.open", opened)) {
  const id = typeof opened.channel === "object" && opened.channel !== null ? (opened.channel as { id?: unknown }).id : undefined;
  console.log(`  the channel it returned is a direct message (id starts with D): ${typeof id === "string" && id.startsWith("D")}`);
}

let left = 0;
for (const [step, ts] of [["chat.delete (threaded reply)", replyTs], ["chat.delete (message)", parentTs]] as const) {
  if (!ts) {
    skipped(step, "nothing was posted");
    continue;
  }
  if (!note(step, (await call("chat.delete", { channel, ts })).answer)) left += 1;
}

console.log(`SUMMARY ${JSON.stringify({ probe: "slack-room", results, needed, scopes, messagesLeftInChannel: left })}`);
if (left > 0) {
  console.log(`NOTE: ${left} probe message(s) could not be deleted and are still in the test channel. Delete them by hand.`);
  process.exit(1);
}
process.exit(0);
