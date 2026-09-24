import { NextResponse, type NextRequest } from "next/server";
import { verify } from "./lib/auth";

// External origin the browser uses; derived from the OAuth redirect so redirects
// don't leak the container hostname (Next standalone resolves req.url to it).
const BASE_URL = process.env.CONSOLE_OAUTH_REDIRECT
  ? new URL(process.env.CONSOLE_OAUTH_REDIRECT).origin
  : undefined;

export async function middleware(req: NextRequest) {
  // Exact platform webhook paths only; bounded relay preserves original platform authentication.
  if (req.method === "POST" && /^\/api\/doors\/[a-z][a-z0-9-]{1,30}\/(slack|telegram)\/events$/.test(req.nextUrl.pathname)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/auth")) return NextResponse.next();
  const email = await verify(req.cookies.get("lares_session")?.value);
  if (!email) return NextResponse.redirect(new URL("/api/auth/login", BASE_URL ?? req.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
