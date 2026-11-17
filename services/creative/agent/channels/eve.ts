import { assertPrivateConsoleRequest, assertVerifiedPrivateConsoleMessage } from "@lares/agent-kit/private-console-envelope";
import { consoleRouteAdmission, consoleAdmission } from "@lares/agent-kit/console-turn-authority";
import { readFileSync } from "node:fs";
import { eveChannel } from "eve/channels/eve";
import {
  localDev,
  verifyHttpBasic,
  withAuthChallenges,
  type AuthFn,
} from "eve/channels/auth";

import { CONSOLE_AUTHENTICATOR } from "@lares/agent-kit/principals";

// Route auth (INBOUND): who may reach this agent's HTTP session routes.
// GET /eve/v1/health is always public and never walks this policy.
//
// Self-hosted, no Vercel deployment: vercelOidc() is omitted per eve's own auth docs
// ("omit vercelOidc() unless you specifically want to accept Vercel-issued tokens").
// This replaces the scaffold's placeholderAuth(), which rejects everything in production
// and which the scaffold itself flags as replace-before-reachable.

/** The role-neutral username every installation may use. */
export const ROUTE_USERNAME = "eve";
/** Usernames this role still accepts, neutral first. This role has no installation-named
 *  spelling, so this is just the neutral one. */
export const ACCEPTED_USERNAMES: readonly string[] = [ROUTE_USERNAME];

const DEFAULT_PASSWORD_FILE = "/run/secrets/eve-route-password";

/** The secret-file path, neutral variable first. Exported for the test only. */
export function routePasswordPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["EVE_ROUTE_PASSWORD_FILE"] ?? DEFAULT_PASSWORD_FILE;
}

// Read on first REQUEST, never at import — the same rule (and the same trap) as the gateway
// key in lib/gateway-provider.ts. `eve build` evaluates this module to compile the agent, and
// a build has no secrets and must not need any; reading here at module scope would fail the
// image build outright. This is also why the password cannot be handed to eve's `httpBasic()`
// helper, which takes its credentials as a plain value at construction: we call the same
// verifier it uses, `verifyHttpBasic`, at request time instead. That keeps eve's constant-time
// comparison — the password is never compared by hand.
let cachedPassword: string | undefined;

function routePassword(): string {
  if (cachedPassword !== undefined) return cachedPassword;
  const path = routePasswordPath();
  try {
    cachedPassword = readFileSync(path, "utf8").trim();
  } catch {
    // Path only — never the file contents — matching the gateway provider's error shape.
    throw new Error(`secret file not readable: ${path}`);
  }
  if (cachedPassword.length === 0) {
    // An empty password would otherwise authenticate anyone who sends an empty one.
    throw new Error(`secret file is empty: ${path}`);
  }
  return cachedPassword;
}

/**
 * Who a web chat request is, comes ONLY from the console's admission: the stable member id, an
 * admission nonce and the purpose (`x-lares-member-id`, `x-lares-admission`, `x-lares-purpose`),
 * read once the route password is verified. The admission is believed because the request knew
 * that password, so anyone holding it can name any member (the same sentence is in
 * `docs/decisions/0022-the-tested-install-path.md`); what `consoleRouteAdmission`
 * (`@lares/agent-kit/console-turn-authority`) checks in the database is that the member named is an
 * active member with use of this agent, and, on a Slack or Telegram conversation, its owner. No
 * header naming a member by address is read: a request that knows the route password but carries
 * no admission stays eve's plain `http-basic` context, which names nobody and approves nothing,
 * whatever else it sends.
 */

/** eve's own `SessionAuthContext`, named without a second import path: it is exactly what an
 *  `AuthFn` may return. */
type DoorSessionAuth = NonNullable<Awaited<ReturnType<AuthFn<Request>>>>;

/**
 * eve's own session auth with the console's admitted member stamped on it.
 *
 * `verifyHttpBasic` returns `{attributes: {}, authenticator: "http-basic", principalId: <username>,
 * principalType: "user"}` (bundled dist, eve 1.0, `dist/src/channel/auth/http-basic.js`'s
 * `authenticateHttpBasicStrategy` → `createRuntimeSessionAuthContext`), which says only "this
 * caller knows the route password". That is deliberately NOT a door in `lib/principals.ts`, so an
 * operator with the password can start a session and still approve nothing. Only the
 * `lares-console` stamp below is a door. The member is the admitted stable id; on a native (Slack,
 * Telegram) conversation the console reads or answers for the owner, and the admission also gives
 * `attributes.user_id`, the owner's address read from the verified users row — the same key eve's
 * own Slack and Telegram channels use for who.
 */
function withAdmittedMember(sessionAuth: DoorSessionAuth, attributes: Record<string, string>): DoorSessionAuth {
  const member = attributes.lares_member_id ?? attributes.user_id;
  return {
    ...sessionAuth,
    authenticator: CONSOLE_AUTHENTICATOR,
    ...(member ? { principalId: member, principalType: "user" as const } : {}),
    attributes: { ...sessionAuth.attributes, ...attributes },
  };
}

/** HTTP Basic against the box secret. Returns null (skip, → 401) on a missing or wrong
 *  credential; never throws for a bad credential, so the walk stays a walk. Tries every
 *  accepted username with eve's own constant-time comparison — never a comparison by hand.
 *
 *  `trustedForwarders` is deliberately NOT configured on the channel below, and that is what keeps
 *  the console's admission the ONLY way a member can be asserted: eve answers 403 to a `forwardedPrincipal`
 *  field in a request BODY whenever a channel declares no forwarder predicate
 *  (`dist/src/channel/forwarded-principal.js`'s `resolveForwardedPrincipal`). So a browser cannot
 *  smuggle an identity through the body the console passes along, and the console does not have to
 *  parse that body to stop it. */
export const basicFromSecretFile: AuthFn<Request> = async (request) => {
  const password = routePassword();
  for (const username of ACCEPTED_USERNAMES) {
    const result = verifyHttpBasic(request.headers.get("authorization"), {
      username,
      password,
    });
    if (result.ok) {
      try {
        if (request.headers.has("x-lares-member-id") || request.headers.has("x-lares-admission") || request.headers.has("x-lares-purpose")) await assertPrivateConsoleRequest(request);
        const attributes = await consoleRouteAdmission(request);
        if (!attributes) return result.sessionAuth;
        return withAdmittedMember(result.sessionAuth, attributes);
      } catch { return null; }
    }
  }
  return null;
};

export default eveChannel({
  onMessage: async (ctx, message) => {
    const caller = ctx.eve.caller;
    const tagged = caller?.attributes?.lares_member_id !== undefined;
    if (tagged) assertVerifiedPrivateConsoleMessage(ctx.eve.request, message);
    if (tagged && consoleAdmission(caller)?.purpose !== "human") throw new Error("Conversation authority is not available");
    return { auth: caller };
  },
  auth: [
    // Open on localhost for `eve dev` and the REPL; inert under `eve start`.
    localDev(),
    // `withAuthChallenges` makes a rejection advertise `Basic`, so a caller is told HOW to
    // authenticate instead of just being refused.
    withAuthChallenges(basicFromSecretFile, [
      { scheme: "Basic", parameters: { realm: "lares" } },
    ]),
  ],
});
