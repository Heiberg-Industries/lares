/**
 * lib/telegram-tap-auth.ts — give an approval-card tap on Telegram the verified owner's identity.
 *
 * THE PROBLEM, PROVEN BY RUNNING (tests/telegram-owner-tap.test.ts). eve's Telegram channel resumes
 * a tap on an approval card with `.respond([...], { auth: null })`. For an ordinary gated tool that
 * is fine: the tool re-checks the approver itself (`approverFrom` falls back to the session's
 * initiator). An OUTSIDE tool has no code of ours to run that check, so it uses eve's approval
 * `response` policy (`outsideResponsePolicy`) — and when a response policy exists eve refuses a
 * responder with no identity BEFORE the policy runs ("Authentication is required to respond to this
 * approval", `harness/approval-delivery-coordinator.js`). A tap with `auth: null` therefore never
 * approves anything.
 *
 * THE FIX, ENGINE SIDE. The Telegram door already knows who tapped: the update carries
 * `callback_query.from.id`, the webhook secret has been checked, and `lib/telegram-tap-gate.ts`
 * reads the same field against the same allowlist. This file wraps the channel's own POST route so
 * that, for a tap by an ALLOWED approver in a private chat, the `respond(..., { auth: null })` call
 * eve makes is made with that approver's identity instead. Nothing else changes:
 *   - a tap by anyone else is left exactly as eve makes it (`auth: null`, which eve refuses);
 *   - a message, a proposal button, a body that is not JSON: untouched;
 *   - the wrapped route still runs eve's own secret-token check before it dispatches anything, so
 *     the identity is only ever used for an update Telegram really sent.
 * No eve patch is needed, so no Dockerfile or patch hash changes.
 */
import { AUTHENTICATOR_FOR, isAllowedPrincipalId } from "./principals.js";

/** eve's own prefix for a HITL card's callback data (see `telegram-tap-gate.ts`). */
const HITL_CALLBACK_PREFIX = "eve:";

/** The shape eve's `SessionAuthContext` has (`channel/types.d.ts`); declared here so this file needs no eve import. */
export interface TapAuth {
  attributes: Record<string, string>;
  authenticator: string;
  issuer: string;
  principalId: string;
  principalType: "user";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * The identity to resume an approval tap with, or null when the update is not a tap by an allowed
 * approver in a private chat. Same shape `defaultTelegramAuth` gives a private-chat message, so
 * `principalFromAuth` reads it the way it reads any Telegram principal. Never throws.
 */
export function ownerTapAuth(raw: string, env: NodeJS.ProcessEnv = process.env): TapAuth | null {
  let update: unknown;
  try {
    update = JSON.parse(raw);
  } catch {
    return null;
  }
  const query = asRecord(asRecord(update)?.["callback_query"]);
  if (query === undefined) return null;
  const data = query["data"];
  if (typeof data !== "string" || !data.startsWith(HITL_CALLBACK_PREFIX)) return null;

  const from = asRecord(query["from"]);
  if (from === undefined || from["is_bot"] === true) return null;
  const userId = asId(from["id"]);
  if (userId === undefined || !isAllowedPrincipalId("telegram", userId, env)) return null;

  // A card only ever sits in the private chat the session was opened in; anything else is not ours.
  const message = asRecord(query["message"]);
  const chat = asRecord(message?.["chat"]);
  if (chat?.["type"] !== "private") return null;

  const attributes: Record<string, string> = { chat_id: asId(chat["id"]) ?? "", chat_type: "private", user_id: userId };
  const messageId = asId(message?.["message_id"]);
  if (messageId !== undefined) attributes["message_id"] = messageId;
  return {
    attributes,
    authenticator: AUTHENTICATOR_FOR.telegram,
    issuer: "telegram",
    principalId: `telegram:${userId}`,
    principalType: "user",
  };
}

type RespondFn = (responses: unknown, options?: { auth?: unknown } & Record<string, unknown>) => unknown;

/** A channel handle whose `respond` swaps eve's `auth: null` for `auth`; everything else passes through. */
function withTapAuth<T extends object>(handle: T, auth: TapAuth): T {
  return new Proxy(handle, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "respond" && typeof value === "function") {
        const respond = value as RespondFn;
        return (responses: unknown, options?: { auth?: unknown } & Record<string, unknown>) =>
          respond.call(target, responses, options?.auth === null ? { ...options, auth } : options);
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

interface RouteLike {
  transport?: string;
  method?: string;
  handler?: unknown;
}
type RouteHandler = (request: Request, ctx: { from: (token: string) => object } & Record<string, unknown>) => unknown;

/**
 * The channel with its POST routes wrapped as described above. Returns a new object; the adapter
 * and every other field are the originals.
 */
export function withOwnerTapAuth<C extends { routes: readonly unknown[] }>(channel: C, env: NodeJS.ProcessEnv = process.env): C {
  const routes = channel.routes.map((r) => {
    const route = r as RouteLike;
    if (route.transport === "websocket" || route.method !== "POST" || typeof route.handler !== "function") return r;
    const inner = route.handler as RouteHandler;
    const handler: RouteHandler = async (request, ctx) => {
      let auth: TapAuth | null = null;
      try {
        auth = ownerTapAuth(await request.clone().text(), env);
      } catch {
        auth = null;
      }
      if (auth === null) return inner(request, ctx);
      const tapAuth = auth;
      return inner(request, { ...ctx, from: (token: string) => withTapAuth(ctx.from(token), tapAuth) });
    };
    return { ...route, handler };
  });
  return { ...channel, routes };
}
