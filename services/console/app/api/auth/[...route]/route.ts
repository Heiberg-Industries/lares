import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { sign, allowed, SESSION_MAX_AGE } from "../../../../lib/auth";

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
      return new NextResponse("Invalid OAuth state", { status: 400 });
    }

    const nonceCookie = req.cookies.get("oauth_nonce")?.value;
    if (!nonceCookie) {
      return new NextResponse("Missing OAuth nonce", { status: 400 });
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
      return new NextResponse("Auth failed", { status: 400 });
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
      return new NextResponse("Invalid id_token", { status: 401 });
    }

    // Verify nonce to prevent replay
    if (payload.nonce !== nonceCookie) {
      return new NextResponse("Nonce mismatch", { status: 401 });
    }

    // Require email_verified
    if (!payload.email_verified) {
      return new NextResponse("Email not verified", { status: 401 });
    }

    if (!payload.email || !allowed(payload.email)) {
      return new NextResponse("Forbidden", { status: 403 });
    }

    const res = NextResponse.redirect(new URL("/", BASE_URL));

    // Clear the temp OAuth cookies
    res.cookies.set("oauth_state", "", { maxAge: 0, path: "/" });
    res.cookies.set("oauth_nonce", "", { maxAge: 0, path: "/" });

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
