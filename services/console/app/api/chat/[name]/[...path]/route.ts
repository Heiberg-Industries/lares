/**
 * `/api/chat/<agent>/eve/v1/...` — the same-origin prefix eve's browser client is pointed at
 * (`useEveAgent({ host: "/api/chat/<agent>" })`, W8B-s3).
 *
 * Every decision lives in `lib/chat-proxy.ts`; this file only supplies the three things it needs
 * from the runtime: the session, the pool and the mounted secret. It is NOT exempted in
 * `middleware.ts` — unlike `/api/doors/...`, which carries its own platform signature, this route
 * is for a signed-in person and is behind the console's ordinary sign-in check, and `forwardChat`
 * checks the session again itself.
 */
import { cookies } from "next/headers";
import { pool } from "../../../../../lib/db";
import { verify } from "../../../../../lib/auth";
import { readSecret } from "../../../../../lib/secrets";
import { forwardChat, type ChatDeps } from "../../../../../lib/chat-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deps: ChatDeps = {
  query: (sql, values) => {
    // Built as a variable, exactly as app/api/doors/[name]/[kind]/events/route.ts does: `pg`'s
    // published QueryConfig type does not name `query_timeout`, which its runtime honours.
    const config = { text: sql, values, query_timeout: 3000 };
    return pool.query(config);
  },
  fetch,
  routePassword: () => readSecret("EVE_ROUTE_PASSWORD"),
  signedInEmail: async () => verify((await cookies()).get("lares_session")?.value),
};

type Context = { params: Promise<{ name: string; path: string[] }> };

async function handle(request: Request, context: Context): Promise<Response> {
  const { name, path } = await context.params;
  return forwardChat(request, name, (path ?? []).join("/"), deps);
}

export const GET = handle;
export const POST = handle;
