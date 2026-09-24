import { readFileSync } from "node:fs";
import { eveChannel } from "eve/channels/eve";
import {
  localDev,
  verifyHttpBasic,
  withAuthChallenges,
  type AuthFn,
} from "eve/channels/auth";

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

/** HTTP Basic against the box secret. Returns null (skip, → 401) on a missing or wrong
 *  credential; never throws for a bad credential, so the walk stays a walk. Tries every
 *  accepted username with eve's own constant-time comparison — never a comparison by hand. */
export const basicFromSecretFile: AuthFn<Request> = (request) => {
  const password = routePassword();
  for (const username of ACCEPTED_USERNAMES) {
    const result = verifyHttpBasic(request.headers.get("authorization"), {
      username,
      password,
    });
    if (result.ok) return result.sessionAuth;
  }
  return null;
};

export default eveChannel({
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
