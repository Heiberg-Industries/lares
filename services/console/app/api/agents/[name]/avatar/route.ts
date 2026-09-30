import { cookies } from "next/headers";
import { verify } from "../../../../../lib/auth";
import { pool } from "../../../../../lib/db";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  if (!(await verify((await cookies()).get("lares_session")?.value)))
    return new Response(null, { status: 401 });
  const { name } = await params;
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name))
    return new Response(null, { status: 400 });
  try {
    const result = await pool.query<{ image: Buffer }>(
      "SELECT image FROM agent_avatars WHERE name=$1",
      [name],
    );
    if (!result.rows[0]) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(result.rows[0].image), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response(null, { status: 503 });
  }
}
