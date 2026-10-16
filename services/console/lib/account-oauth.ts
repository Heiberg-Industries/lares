// services/console/lib/account-oauth.ts
// Pure helpers for the add-account OAuth flow — kept out of the route handlers so they're unit-testable.
import { google } from "googleapis";
import { GOOGLE_SCOPES } from "./accounts";

/**
 * The console's external origin — derived from CONSOLE_OAUTH_REDIRECT, NOT the request URL.
 * Behind a proxy (tailscale serve / Next standalone) req.url leaks the container host, so the
 * OAuth redirect_uri + post-flow redirects MUST come from the configured value (same approach
 * the login route uses). Falls back to localhost for dev.
 */
export function consoleOrigin(): string {
  return new URL(
    process.env.CONSOLE_OAUTH_REDIRECT ?? "http://localhost:3000/api/auth/callback",
  ).origin;
}

export function buildConsentUrl(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  state: string;
  loginHint?: string;
}): string {
  const oauth = new google.auth.OAuth2(args.clientId, args.clientSecret, args.redirectUri);
  return oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state: args.state,
    ...(args.loginHint ? { login_hint: args.loginHint } : {}),
  });
}

/** Build the redirect back to the Integrations page with a one-shot success/error flash param. */
export function callbackRedirect(origin: string, result: { added?: string; error?: string }): string {
  const u = new URL("/integrations", origin);
  if (result.added) u.searchParams.set("added", result.added);
  if (result.error) u.searchParams.set("error", result.error);
  return u.toString();
}
