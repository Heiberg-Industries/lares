import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { sign, allowed, SESSION_MAX_AGE } from "../../../../lib/auth";
import { safeNext, sameOriginTarget } from "../../../../lib/safe-next";

/**
 * Fail-closed env resolution: throws in production when a required variable is
 * absent; returns a dev-only fallback in other environments.
 */
function requireEnv(name: string, devFallback = ""): string {
  const val = process.env[name];
  if (!val && process.env.NODE_ENV === "production") {
    throw new Error(`${name} is required in production`);
  }
  return val ?? devFallback;
}

const REDIRECT =
  process.env.CONSOLE_OAUTH_REDIRECT ??
  "http://localhost:3000/api/auth/callback";

// The console's external origin (e.g. http://localhost:3000). Derived from the
// OAuth redirect so post-login redirects target the host the browser actually
// uses — NOT req.url, which in Next standalone resolves to the container hostname.
const BASE_URL = new URL(REDIRECT).origin;

// Failures send the person back to the sign-in page, which says what happened in plain words.
function signInError(code: "denied" | "unverified" | "failed"): NextResponse {
  const res = NextResponse.redirect(new URL(`/sign-in?error=${code}`, BASE_URL));
  res.cookies.set("oauth_state", "", { maxAge: 0, path: "/" });
  res.cookies.set("oauth_nonce", "", { maxAge: 0, path: "/" });
  res.cookies.set("oauth_next", "", { maxAge: 0, path: "/" });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ route: string[] }> },
) {
  const { route } = await params;

  // ------------------------------------------------------------------
  // /login — redirect to Google with state + nonce
  // ------------------------------------------------------------------
  if (route[0] === "login") {
    const CID = requireEnv("GOOGLE_CLIENT_ID_CONSOLE");
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();

    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", CID);
    u.searchParams.set("redirect_uri", REDIRECT);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "openid email");
    u.searchParams.set("state", state);
    u.searchParams.set("nonce", nonce);
    // Always show Google's account picker, so signing out and back in asks which account to use
    // instead of re-admitting the last one silently.
    u.searchParams.set("prompt", "select_account");

    const res = NextResponse.redirect(u.toString());
    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/",
      maxAge: 600, // 10 minutes — long enough for the OAuth round-trip
    };
    res.cookies.set("oauth_state", state, cookieOpts);
    res.cookies.set("oauth_nonce", nonce, cookieOpts);
    // Remember the page the person was heading to; the callback returns them there.
    const next = safeNext(req.nextUrl.searchParams.get("next"));
    if (next !== "/") res.cookies.set("oauth_next", next, cookieOpts);
    return res;
  }

  // ------------------------------------------------------------------
  // /callback — verify state, exchange code, verify id_token via JWKS
  // ------------------------------------------------------------------
  if (route[0] === "callback") {
    const CID = requireEnv("GOOGLE_CLIENT_ID_CONSOLE");
    const CSECRET = requireEnv("GOOGLE_CLIENT_SECRET_CONSOLE");
    // CSRF: compare state param to stored cookie
    const stateParam = req.nextUrl.searchParams.get("state");
    const stateCookie = req.cookies.get("oauth_state")?.value;
    if (!stateParam || !stateCookie || stateParam !== stateCookie) {
      return signInError("failed");
    }

    const nonceCookie = req.cookies.get("oauth_nonce")?.value;
    if (!nonceCookie) {
      return signInError("failed");
    }

    const code = req.nextUrl.searchParams.get("code") ?? "";
    const tok = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CID,
        client_secret: CSECRET,
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }),
    }).then((r) => r.json());

    if (!tok || typeof tok.id_token !== "string") {
      return signInError("failed");
    }

    // Verify the id_token cryptographically against Google's JWKS
    let payload: { email?: string; email_verified?: boolean; nonce?: string };
    try {
      const result = await jwtVerify(tok.id_token as string, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: CID,
      });
      payload = result.payload as typeof payload;
    } catch {
      return signInError("failed");
    }

    // Verify nonce to prevent replay
    if (payload.nonce !== nonceCookie) {
      return signInError("failed");
    }

    // Require email_verified
    if (!payload.email_verified) {
      return signInError("unverified");
    }

    if (!payload.email || !allowed(payload.email)) {
      return signInError("denied");
    }

    const res = NextResponse.redirect(sameOriginTarget(safeNext(req.cookies.get("oauth_next")?.value), BASE_URL));

    // Clear the temp OAuth cookies
    res.cookies.set("oauth_state", "", { maxAge: 0, path: "/" });
    res.cookies.set("oauth_nonce", "", { maxAge: 0, path: "/" });
    res.cookies.set("oauth_next", "", { maxAge: 0, path: "/" });

    res.cookies.set("lares_session", await sign(payload.email), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
    return res;
  }

  return new NextResponse("Not found", { status: 404 });
}

// POST /logout — clear the session cookie. The session is a signed cookie with no
// server-side store, so there is nothing else to delete. The origin check for
// every POST is done in middleware.ts. Flags must match the cookie set at callback.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ route: string[] }> },
) {
  const { route } = await params;
  if (route[0] !== "logout" || route.length !== 1) {
    return new NextResponse("Not found", { status: 404 });
  }
  // 303 turns the POST into a GET of the sign-in page, which says "You're signed out."
  const res = NextResponse.redirect(new URL("/sign-in?signed-out=1", BASE_URL), 303);
  res.cookies.set("lares_session", "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
