/**
 * Who an agent trusts, by door: the one allow-list both a door's inbound check AND the approval
 * re-check read, written once for every role (ADR-0025, "the allow-list check").
 *
 * Two enforcement points, one list:
 *
 * - a door (`agent/channels/<door>.ts`) decides who may START a turn;
 * - the approval rules (`approval-policy.ts`) decide who may APPROVE a gated action — a click that,
 *   per eve's docs, is handled before any authored inbound handler and so never passes the first
 *   check at all.
 *
 * A role binds this module to the doors it has (`principalPolicy([...])`) in its own
 * `lib/principals.ts`. A door a role does not list is no door for that role: its authenticator
 * names nobody, even when the same raw id is on another list. Fail-closed everywhere: an unset or
 * blank list admits nobody, never everybody.
 */
/**
 * The doors a principal may arrive through. `console` is web chat — the agent's own HTTP door,
 * reached by the console on behalf of a signed-in member.
 *
 * WHAT THE CONSOLE CHANNEL TRUSTS. Slack and Telegram identities are verified by the platform at
 * the other end: a signature, a secret token, a user id the agent did not choose. Web chat's is
 * not: each role's `agent/channels/eve.ts` takes the member from the console's admission (the
 * stable member id, an admission nonce and the purpose), read only after the request passed the
 * agent's own route password, so anything holding that password can name any member. What the
 * agent checks is the member it names, in the database (`consoleRouteAdmission`,
 * `console-turn-authority.ts`): an active member with use of this agent, its bound conversation,
 * and on a Slack or Telegram conversation the agent's owner, whose address comes from that row. An
 * address in a request header is never read; a request with the route password and no admission
 * names nobody, so it can approve nothing.
 *
 * The allow-list below is still what decides WHO may answer a card on a native door from the
 * console: an address that is not on this agent's list is refused exactly like an unknown Slack
 * user id.
 */
export type ChannelName = "slack" | "telegram" | "console";

/**
 * eve's authenticator string per door, verified against the bundled dist (eve has no public docs
 * page naming these): `dist/src/public/channels/slack/auth.js` (`buildSlackAuthContext` →
 * `authenticator: "slack-webhook"`) and `dist/src/public/channels/telegram/defaults.js`
 * (`defaultTelegramAuth` → `authenticator: "telegram-webhook"`). Both put the door's user id under
 * `attributes.user_id` — Slack's is already a string; Telegram's is numeric (`t.id`, the Telegram
 * user id), which `principalFromAuth` below stringifies.
 *
 * `console` is OURS, not eve's. eve's `verifyHttpBasic` returns `authenticator: "http-basic"` and
 * an empty `attributes` (bundled dist, `dist/src/channel/auth/http-basic.js` →
 * `authenticateHttpBasicStrategy`), which says only "this caller knows the route password" and is
 * deliberately NOT a door: an operator with the password must not be an approver. Each role's
 * `agent/channels/eve.ts` replaces it with this string, and only this string, when the request
 * also carries a console admission the agent verified. eve's own route-auth projection types
 * `authenticator` as a free string on the channel boundary and persists it with `z.string()`,
 * which is how `"slack-webhook"` and `"telegram-webhook"` already survive the durable round trip.
 */
export const AUTHENTICATOR_FOR: Readonly<Record<ChannelName, string>> = {
  slack: "slack-webhook",
  telegram: "telegram-webhook",
  // The same string as `CONSOLE_SESSION_AUTHENTICATOR` (`door-authority.ts`), the one the gate
  // trusts; `tests/principals.test.ts` and keeper's `door-claims.test.ts` hold the two equal.
  console: "lares-console",
};

/** The authenticator web chat's door stamps on a session the console admitted. */
export const CONSOLE_AUTHENTICATOR = AUTHENTICATOR_FOR.console;

/**
 * The env var each door's allow-list reads. Slack's is plural (a comma-separated list — the
 * workspace can hold more than one trusted human); Telegram's is singular (a personal bot with one
 * owner) but parsed the same way, so a second Telegram principal only needs a comma added.
 *
 * The console's is the SAME name and the SAME list the console itself admits at sign-in
 * (`services/console/lib/auth.ts`'s `allowed`), so "signed in to the console" and "may approve
 * here" cannot be configured to disagree by accident. A second member is a comma, not a code
 * change.
 */
const ENV_VAR_FOR: Readonly<Record<ChannelName, string>> = {
  slack: "SLACK_ALLOWED_USER_IDS",
  telegram: "TELEGRAM_PRINCIPAL_ID",
  console: "CONSOLE_ALLOWED_EMAILS",
};

/** Longest member address an agent will look at. RFC 5321's own ceiling is 320 characters; a
 *  value longer than that is not an address, it is somebody probing. */
const MEMBER_MAX = 320;

/**
 * The member address a value names, or null when it says nothing usable.
 *
 * Pure, and deliberately strict: its whole job is to make sure that whatever reaches
 * `attributes.user_id` is one ordinary address on one line. A value that fails here is not an
 * error — it is simply no claim at all, which fails closed at the approval gate.
 *
 * Rejected on purpose: anything with whitespace (a value may not span lines, and a folded one
 * would smuggle a second), a comma (the allow-list splits on commas — one value, one member), a
 * control character, more or fewer than one `@`, or an empty side of it.
 */
export function consoleMember(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const member = raw.trim();
  if (member.length === 0 || member.length > MEMBER_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s,;\u0000-\u001f\u007f]/.test(member)) return null;
  const at = member.indexOf("@");
  if (at <= 0 || at !== member.lastIndexOf("@") || at === member.length - 1) return null;
  return member;
}

/** Fail-closed: unset, blank, or all-empty entries admit nobody. */
export function allowedPrincipalIds(
  channel: ChannelName,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env.LARES_AGENT_INCARNATION ? env[`LARES_${channel.toUpperCase()}_PRINCIPAL`] ?? "" : env[ENV_VAR_FOR[channel]] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function isAllowedPrincipalId(
  channel: ChannelName,
  userId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // The explicit empty-string guard matters: a list punctuated as ",," would otherwise
  // admit an author whose user id failed to parse.
  if (userId === undefined || userId.length === 0) return false;
  return allowedPrincipalIds(channel, env).includes(userId);
}

/**
 * The agent's OWNER on a door: the FIRST id on that door's allow-list. The allow-list says who may
 * START a conversation; only the owner may ANSWER an approval card raised on a native door. On a
 * keeper-managed install each list holds one id, so the two coincide; on any other install a second
 * allowed person can talk to the agent but cannot approve for the owner.
 */
export function ownerPrincipalId(channel: ChannelName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return allowedPrincipalIds(channel, env)[0];
}

/**
 * Extracts `{authenticator, userId}` from an eve session auth context — the shape
 * `ctx.session.auth.current` carries — for the approval checks.
 *
 * `absent: true` marks a null/undefined auth context, which is NOT the same as an unrecognisable
 * one: `approverFrom` (`approval-policy.ts`) is the only consumer of the marker and uses it to fall
 * back to the session's verified initiator (eve resumes a Telegram card tap with `auth: null`).
 * Everything that is PRESENT but unrecognisable (a non-object, a foreign authenticator, a missing
 * `attributes.user_id`) is refused.
 */
export function principalFromAuth(
  auth: unknown,
): { authenticator?: string; userId?: string; absent?: boolean } {
  if (auth === null || auth === undefined) return { absent: true };
  if (typeof auth !== "object") return {};
  const candidate = auth as { authenticator?: unknown; attributes?: Record<string, unknown> };
  const authenticator = typeof candidate.authenticator === "string" ? candidate.authenticator : undefined;
  const raw = candidate.attributes?.["user_id"];
  const userId = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : undefined;
  return { authenticator, userId };
}

/** The Slack allow-list. */
export function allowedSlackUserIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return allowedPrincipalIds("slack", env);
}

export function isAllowedSlackUserId(
  userId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isAllowedPrincipalId("slack", userId, env);
}

/** The Slack user id an auth context names, or undefined when it is not a Slack identity. */
export function slackUserIdOf(auth: unknown): string | undefined {
  const { authenticator, userId } = principalFromAuth(auth);
  return authenticator === AUTHENTICATOR_FOR.slack ? userId : undefined;
}

/** The checks that depend on which doors a role has. */
export interface PrincipalPolicy {
  /** The door an eve authenticator string belongs to, or undefined if this role has no such door —
   *  including authenticators the agent fronts for other purposes (e.g. `http-basic`, every holder
   *  of the route password), which must never be treated as any door's principal. */
  channelForAuthenticator(authenticator: string | undefined): ChannelName | undefined;
  /** True only when `authenticator` names one of this role's doors AND `userId` is on THAT door's
   *  allow-list: an id presented with another door's authenticator is checked against the wrong
   *  list and refused, even if the same raw id also sits on the other list. */
  isAllowedPrincipal(authenticator: string | undefined, userId: string | undefined, env?: NodeJS.ProcessEnv): boolean;
  /** True only for one of this role's doors AND that door's owner id (not merely an allowed id). */
  isOwnerPrincipal(authenticator: string | undefined, userId: string | undefined, env?: NodeJS.ProcessEnv): boolean;
}

/** The checks bound to the doors a role has, in its own `lib/principals.ts`. */
export function principalPolicy(channels: readonly ChannelName[]): PrincipalPolicy {
  const doors = [...channels];
  const channelForAuthenticator = (authenticator: string | undefined): ChannelName | undefined =>
    doors.find((channel) => authenticator === AUTHENTICATOR_FOR[channel]);
  return {
    channelForAuthenticator,
    isAllowedPrincipal(authenticator, userId, env = process.env) {
      const channel = channelForAuthenticator(authenticator);
      if (!channel) return false;
      return isAllowedPrincipalId(channel, userId, env);
    },
    isOwnerPrincipal(authenticator, userId, env = process.env) {
      const channel = channelForAuthenticator(authenticator);
      if (!channel || userId === undefined || userId.length === 0) return false;
      const owner = ownerPrincipalId(channel, env);
      return owner !== undefined && owner === userId;
    },
  };
}
