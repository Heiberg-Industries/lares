import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "./lib/safe-next";

// External origin the browser uses; derived from the OAuth redirect so redirects
// don't leak the container hostname (Next standalone resolves req.url to it).
const BASE_URL = process.env.CONSOLE_OAUTH_REDIRECT
  ? new URL(process.env.CONSOLE_OAUTH_REDIRECT).origin
  : undefined;

export async function middleware(req: NextRequest) {
  // Exact platform webhook paths only; bounded relay preserves original platform authentication.
  if (req.method === "POST" && /^\/api\/doors\/[a-z][a-z0-9-]{1,30}\/(slack|telegram)\/events$/.test(req.nextUrl.pathname)) return NextResponse.next();
  // Exact machine RPC paths only. Keeper verifies the original HMAC over exact bytes.
  if(req.method==='POST'&&!req.nextUrl.search&&/^\/v1\/gateway-budget\/(admit|settle)$/.test(req.nextUrl.pathname))return NextResponse.next();
  // SameSite cookies still accompany requests from other origins on the same site.
  // Protect raw routes as well as server actions; never trust forwarded host headers
  // to decide which browser origin may mutate data. OAuth callbacks use GET.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const expectedOrigin = BASE_URL ?? (process.env.NODE_ENV !== "production" ? req.nextUrl.origin : undefined);
    if (!expectedOrigin) {
      return NextResponse.json({ error: "Console public origin is not configured." }, { status: 503 });
    }
    if (req.headers.get("origin") !== expectedOrigin) {
      return NextResponse.json({ error: "Request origin is not allowed." }, { status: 403 });
    }
  }
  if (/^\/api\/auth\/(login|callback|logout)$/.test(req.nextUrl.pathname)) return NextResponse.next();
  // Cookie presence is only a navigation hint. Every Node entry checks current DB admission.
  const hasCookie = /^[A-Za-z0-9_-]{43}$/.test(req.cookies.get("lares_session")?.value ?? "");
  if (req.nextUrl.pathname === "/sign-in" || req.nextUrl.pathname === "/invite") {
    const page = NextResponse.next();
    page.headers.set("Cache-Control", "no-store");
    page.headers.set("Referrer-Policy", "no-referrer");
    return page;
  }
  if (!hasCookie) {
    // Send visitors to the sign-in page, remembering where they were headed.
    const to = new URL("/sign-in", BASE_URL ?? req.url);
    const back = req.nextUrl.pathname + req.nextUrl.search;
    const next = safeNext(back);
    if (next !== "/") to.searchParams.set("next", next);
    return NextResponse.redirect(to);
  }
  // Signed-in pages must never be kept by the browser, or the back button would show
  // console data after sign-out.
  const res = NextResponse.next();
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
