/**
 * lib/delivery-send.ts - the actual sending, per door, for a message `routeDelivery` has routed.
 *
 * Two shapes, because schedules send in two ways:
 *
 *  - `sendTurn`: the schedule hands the agent a PROMPT and the agent writes the message (the
 *    briefs, nudges, proposals). Telegram and Slack start a session with `to(channel, ...).send`.
 *    Web chat cannot be pushed into - eve 0.60.1's web channel (`eveChannel`) has no `receive`
 *    handler, so `to(eveChannel, ...)` does not exist - so for web the message text is produced by
 *    one plain model call (no tools) with the agent's voice, and written to the inbox. A turn that
 *    would ask for an approval therefore does not run: the inbox message carries the instruction
 *    as its `context`, and "Reply" opens a real web chat seeded with it, where the agent has its
 *    tools and the approval card appears in the chat and under "Waiting on you".
 *
 *  - `sendText`: the schedule already has the final text (a digest, a notice). Telegram and Slack
 *    get a raw post, no session; web chat gets an inbox row.
 */
import { callSlackApi } from "eve/channels/slack";
import { sendTelegramMessage } from "eve/channels/telegram";
import { telegramFetch } from "@lares/agent-kit/telegram-fetch";

import { slackCredentials } from "../agent/channels/slack.js";
import { telegramCredentials } from "../agent/channels/telegram.js";
import type { Routed } from "./delivery.js";
import { gatewayComplete } from "./llm-complete.js";
import { telegramPushAttributes } from "./principals.js";
import { continuityAuthAttributes, proactiveContinuityIdentity } from "./conversation-continuity.js";

/** What a schedule's `run({ to, waitUntil, appAuth })` gives it, plus the two channel objects. */
export interface TurnRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  to: (channel: any, target: any) => { send(text: string, options: any): Promise<unknown> };
  waitUntil: (p: Promise<unknown>) => void;
  appAuth: object;
  telegram: unknown;
  slack: unknown;
}

export interface TurnOptions {
  /** Attribution for the conversation log (`morning-brief`, `track-routing`, ...). */
  lane: string;
  /** Defaults to the item the gate is sending. */
  itemKey?: string;
  /** Web chat only: the inbox title. */
  title: string;
  /** Web chat only. The text to show when the schedule already knows what to say; without it the
   *  text is generated from the prompt. Used for turns that exist to ask for an approval. */
  webBody?: string;
  /** Web chat only: what "Reply" starts a chat from. Defaults to the message itself; for a turn
   *  that asks the agent to act, pass the prompt. */
  webContext?: string;
}

const WEB_PREAMBLE =
  "This message will be shown in the owner's web chat inbox, not in a chat app. You cannot use " +
  "tools for it: write only what the content below supports, in your own voice, as the finished " +
  "message and nothing else.\n\n";

export async function webTextFor(routed: Pick<Routed, "voiceMd">, prompt: string): Promise<string> {
  const voice = routed.voiceMd.trim();
  const text = await gatewayComplete(
    `${voice ? `${voice}\n\n---\n\n` : ""}${WEB_PREAMBLE}${prompt}`,
    { purpose: "writer", maxOutputTokens: 2000 },
  );
  const trimmed = text.trim();
  if (!trimmed) throw new Error("delivery: the model returned no text for the web message");
  return trimmed;
}

/** Start the agent's turn on the routed door, or write the web message. Throws on failure, which
 *  the gate treats as "not sent" (the item stays eligible). */
export async function sendTurn(routed: Routed, rt: TurnRuntime, prompt: string, o: TurnOptions): Promise<void> {
  if (routed.door === "web") {
    // Only model-generated copy gets a continuity fence, captured before generation and
    // checked again by the inbox writer. Prebuilt schedule text has no proven source boundary.
    const continuityFence = o.webBody === undefined ? await routed.captureContinuityFence() : undefined;
    const body = o.webBody ?? (await webTextFor(routed, prompt));
    await routed.inbox({
      ...(o.itemKey ? { itemKey: o.itemKey } : {}), title: o.title, body,
      ...(o.webContext ? { context: o.webContext } : {}),
      ...(continuityFence ? { continuityFence } : {}),
    });
    return;
  }
  let continuityAttributes: Record<string, string> = {};
  try {
    const identity = await proactiveContinuityIdentity(routed.door, routed.target);
    if (identity) continuityAttributes = continuityAuthAttributes(identity);
  } catch (error) {
    // A scheduled post remains deliverable if optional conversation attribution is unavailable.
    console.warn("delivery: private conversation audience unavailable; sending without continuity metadata", error instanceof Error ? error.message : "unknown error");
  }
  const task = routed.door === "telegram"
    ? rt.to(rt.telegram, { chatId: routed.target }).send(prompt, {
        auth: { ...rt.appAuth, attributes: { ...telegramPushAttributes(o.lane, routed.target), ...continuityAttributes } },
      })
    : rt.to(rt.slack, { channelId: routed.target }).send(prompt, {
        auth: { ...rt.appAuth, attributes: { lane: o.lane, ...continuityAttributes } },
      });
  rt.waitUntil(task);
  await task;
}

/** Telegram HTML (`<b>`, `<a href>`, `&amp;`...) as the plain text Slack and web chat show. */
export function plainFromTelegramHtml(html: string): string {
  return html
    .replace(/<a\s+href="([^"]*)">([^<]*)<\/a>/g, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Send finished text on the routed door. No session, no model. */
export async function sendText(
  routed: Routed,
  text: string,
  o: { itemKey?: string; title: string; context?: string },
): Promise<void> {
  if (routed.door === "web") {
    await routed.inbox({
      ...(o.itemKey ? { itemKey: o.itemKey } : {}), title: o.title, body: text,
      ...(o.context ? { context: o.context } : {}),
    });
    return;
  }
  if (routed.door === "telegram") {
    await sendTelegramMessage({
      credentials: telegramCredentials,
      chatId: routed.target,
      body: { text },
      fetch: telegramFetch,
    });
    return;
  }
  const res = await callSlackApi({
    botToken: slackCredentials.botToken,
    operation: "chat.postMessage",
    body: { channel: routed.target, text },
  });
  if (!res.ok) throw new Error(`slack send failed: ${String((res as { error?: unknown }).error)}`);
}
