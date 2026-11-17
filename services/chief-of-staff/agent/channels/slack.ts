// Binds the kit's Slack door (`@lares/agent-kit/slack-door`) to this role. eve finds the door by this
// file's path. Below the binding, what only this role's door does.
import { slackChannel, type SlackMessage, defaultSlackAuth } from "eve/channels/slack";

import { getPool } from "@lares/agent-kit/db";
import { admitSlackMessage, slackDoor } from "@lares/agent-kit/slack-door";
import { continuityAuthAttributes, nativeConversationContinuity } from "../../lib/conversation-continuity.js";
import { markRouteDeclineQuestionSent } from "../../lib/route-decline.js";

/** Continuity is limited to a signed, allowlisted DM. App mentions can be visible to a room and
 * therefore never receive a private-history context. A registry/grant outage only removes the
 * optional context; it does not change the existing message admission decision. */
export async function admitSlackDirectMessage(
  ctx: Parameters<typeof defaultSlackAuth>[1],
  message: SlackMessage,
): Promise<{ auth: ReturnType<typeof defaultSlackAuth>; context?: string[] } | null> {
  const admitted = admitSlackMessage(ctx, message);
  if (!admitted?.auth) return admitted;
  const replyAttributes: Record<string, string> = message.threadTs !== message.ts
    ? { lares_route_decline_reply_anchor: `slack:${message.threadTs}` }
    : {};
  try {
    const continuity = await nativeConversationContinuity("slack", admitted.auth);
    return {
      auth: continuity.identity
        ? { ...admitted.auth, attributes: { ...admitted.auth.attributes, ...replyAttributes, ...continuityAuthAttributes(continuity.identity) } }
        : { ...admitted.auth, attributes: { ...admitted.auth.attributes, ...replyAttributes } },
      ...((admitted.context?.length || continuity.context.length) ? { context: [...continuity.context, ...(admitted.context ?? [])] } : {}),
    };
  } catch (error) {
    console.warn("slack continuity unavailable; continuing without archived context", error instanceof Error ? error.message : "unknown error");
    return admitted;
  }
}

/** What the reply handler reads from the event, the channel and the session. */
interface CompletedEvent {
  readonly data: { readonly kind: string; readonly phase: string; readonly value?: unknown };
}
interface ReplyContext {
  readonly channel: {
    readonly state: { triggeringUserId?: string | null };
    readonly thread: { postDirectMessage(userId: string, message: string): Promise<{ id: string }> };
  };
  readonly session: { readonly auth: { readonly current: { readonly attributes?: Record<string, unknown> } | null } };
}

/**
 * `content.completed` — EXPORTED for tests. Takes over one reply only: the question a scheduled
 * track-routing conversation asks after the owner declined a route. That question is posted as
 * its own direct message so its Slack timestamp can be saved as the anchor the owner's answer is
 * matched to. Every other part (narration, reasoning, an ordinary reply, a long reply uploaded as
 * a snippet) goes to `next()`, eve's own delivery.
 */
export async function onSlackContentCompleted(
  event: CompletedEvent,
  ctx: ReplyContext,
  next: () => Promise<void>,
): Promise<void> {
  const { kind, phase, value } = event.data;
  const attrs = ctx.session.auth.current?.attributes;
  const requestId = attrs?.["lares_route_decline_request_id"];
  if (kind !== "text" || phase !== "reply" || typeof value !== "string" || value.length === 0 || typeof requestId !== "string") {
    return next();
  }

  const address = attrs?.["lares_continuity_address"];
  const linkedUser = typeof address === "string" && address.startsWith("slack-user:")
    ? address.slice("slack-user:".length) : undefined;
  const authUser = attrs?.["user_id"];
  const userId = typeof authUser === "string" ? authUser : linkedUser ?? ctx.channel.state.triggeringUserId;
  if (!userId) throw new Error("track-routing decline question has no bound Slack recipient");
  const posted = await ctx.channel.thread.postDirectMessage(userId, value);
  if (posted.id) await markRouteDeclineQuestionSent(getPool(), requestId, `slack:${posted.id}`);
}

export const { authorizeSlackAnswer, onTurnSettled, onSessionEnded, slackDoorConfig } = slackDoor({
  role: "chief-of-staff",
  // A claim code (and "cannot act on that yet") gets a fixed line back.
  replyBeforeClaim: true,
  postsApprovalReplyRefusal: true,
  admitDirectMessage: admitSlackDirectMessage,
  events: { "content.completed": onSlackContentCompleted },
});

export default slackChannel(slackDoorConfig);
