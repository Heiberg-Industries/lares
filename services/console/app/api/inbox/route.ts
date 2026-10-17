import { cookies } from "next/headers";
import { verify } from "../../../lib/auth";
import { readInbox, unreadCount } from "../../../lib/web-inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * GET /api/inbox            -> { unread: <count across every agent> }          (the navigation dot)
 * GET /api/inbox?agent=name -> { unread: <count>, messages: [...unread] }      (the panel above a chat)
 *
 * The console looks when a page is open and visible; nothing is pushed.
 */
export async function GET(req: Request): Promise<Response> {
  if (!(await verify((await cookies()).get("lares_session")?.value))) {
    return Response.json({ error: "sign-in-required" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const agent = new URL(req.url).searchParams.get("agent");
  if (agent === null) {
    return Response.json({ unread: await unreadCount() }, { headers: { "cache-control": "no-store" } });
  }
  if (!AGENT.test(agent)) return Response.json({ error: "invalid-request" }, { status: 400 });
  const { unread } = await readInbox(agent);
  return Response.json({ unread: unread.length, messages: unread }, { headers: { "cache-control": "no-store" } });
}
