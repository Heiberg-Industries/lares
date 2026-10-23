import { NextResponse, type NextRequest } from "next/server";
import { MemberStoreError } from "@lares/agent-kit/member-store";
import { members, isConsoleOwner, SESSION_MAX_AGE } from "../../../../lib/auth";
import { consoleRedirect, startSignIn, openFlow, finishSignIn, type SignInProvider } from "../../../../lib/console-oidc";
import { safeNext, sameOriginTarget } from "../../../../lib/safe-next";
import {
  OWNER_DISCOVERY_COOKIE, ownerDiscoveryDigest, parseOwnerBootstrapSelection,
  sealOwnerDiscoveryReceipt,
} from "../../../../lib/owner-bootstrap-receipt";

export const runtime = "nodejs";
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" });
function clearFlow(res: NextResponse): NextResponse {
  for (const name of ["oauth_flow", "oauth_state", "oauth_nonce", "oauth_next", OWNER_DISCOVERY_COOKIE]) res.cookies.set(name, "", { ...cookieOptions(), maxAge: 0 });
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
function failure(): NextResponse { return clearFlow(NextResponse.redirect(new URL("/sign-in?error=failed", consoleRedirect()))); }
export async function GET(req: NextRequest, { params }: { params: Promise<{ route: string[] }> }) {
  const { route } = await params;
  if (route.length !== 1) return new NextResponse("Not found", { status: 404 });
  if (route[0] === "login") {
    const provider = req.nextUrl.searchParams.get("provider") ?? "google";
    if (provider !== "google" && provider !== "microsoft") return failure();
    const invitation = req.nextUrl.searchParams.get("invite") ?? undefined;
    if (invitation && !/^[A-Za-z0-9_-]{43}$/.test(invitation)) return failure();
    try {
      const started = await startSignIn(provider as SignInProvider, safeNext(req.nextUrl.searchParams.get("next")), invitation);
      const res = clearFlow(NextResponse.redirect(started.url));
      res.cookies.set("oauth_flow", started.cookie, { ...cookieOptions(), maxAge: 600 });
      return res;
    } catch { return failure(); }
  }
  if (route[0] !== "callback") return new NextResponse("Not found", { status: 404 });
  let providerVerified = false;
  try {
    const flow = await openFlow(req.cookies.get("oauth_flow")?.value);
    if (!flow || !req.nextUrl.searchParams.get("code") || req.nextUrl.searchParams.get("state") !== flow.state) return failure();
    // Reconstruct the callback against the registered origin, never an internal proxy host.
    const callback = new URL(consoleRedirect()); callback.search = req.nextUrl.search;
    const proof = await finishSignIn(callback, flow);
    providerVerified = true;
    if (flow.invitation) await members.acceptInvitation(flow.invitation, proof);
    else if (!(await members.memberForIdentity(proof.identity))) {
      const configured = process.env.CONSOLE_BOOTSTRAP_IDENTITY;
      const ownerId = process.env.AGENT_OWNER_USER_ID?.trim();
      if (!ownerId) return failure();
      if (configured) {
        let selection;
        try { selection = parseOwnerBootstrapSelection(JSON.parse(configured)); } catch { return failure(); }
        if (selection.ownerId !== ownerId || selection.installationOrigin !== new URL(consoleRedirect()).origin ||
            JSON.stringify(selection.identity) !== JSON.stringify(proof.identity)) return failure();
        await members.bootstrapFirstOwnerIdentity(selection.ownerId, selection.organisationId, proof);
      } else {
        const owner = await members.currentMember(ownerId);
        if (!owner || !isConsoleOwner(owner) || !await members.firstOwnerBootstrapEligible(ownerId, owner.organisationId)) return failure();
        const installationOrigin = new URL(consoleRedirect()).origin;
        const receipt = { installationOrigin, identity: proof.identity, digest: ownerDiscoveryDigest(installationOrigin, proof.identity) };
        const res = clearFlow(NextResponse.redirect(new URL("/sign-in?setup=owner", consoleRedirect())));
        res.cookies.set(OWNER_DISCOVERY_COOKIE, await sealOwnerDiscoveryReceipt(receipt), { ...cookieOptions(), maxAge: 300 });
        return res;
      }
    }
    const session = await members.createSession(proof, new Date(Date.now() + SESSION_MAX_AGE * 1000));
    const destination = isConsoleOwner(session.member) ? safeNext(flow.next) : "/membership";
    const res = clearFlow(NextResponse.redirect(sameOriginTarget(destination, consoleRedirect())));
    res.cookies.set("lares_session", session.token, { ...cookieOptions(), maxAge: SESSION_MAX_AGE });
    return res;
  } catch (error) {
    if (providerVerified && !(error instanceof MemberStoreError)) return clearFlow(NextResponse.json(
      { error: "admission-unavailable", message: "Console sign-in storage is unavailable. Try again." }, { status: 503 }));
    return failure();
  }
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ route: string[] }> }) {
  const { route } = await params;
  if (route.length !== 1 || route[0] !== "logout") return new NextResponse("Not found", { status: 404 });
  // Repeat origin enforcement here so invoking the handler directly cannot bypass it.
  if (req.headers.get("origin") !== new URL(consoleRedirect()).origin) return new NextResponse("Request origin is not allowed.", { status: 403 });
  try { await members.revokeSession(req.cookies.get("lares_session")?.value ?? ""); }
  catch { return new NextResponse("Sign-out is unavailable. Try again.", { status: 503, headers: { "cache-control": "no-store" } }); }
  const res = clearFlow(NextResponse.redirect(new URL("/sign-in?signed-out=1", consoleRedirect()), 303));
  res.cookies.set("lares_session", "", { ...cookieOptions(), maxAge: 0 });
  return res;
}
