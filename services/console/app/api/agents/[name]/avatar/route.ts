import { withConsoleAdmission } from "../../../../../lib/admission-error";
import { cookies } from "next/headers";
import { requireConsoleAgentUse } from "@lares/agent-kit/console-turn-authority";
import { mayUse, signedInMember } from "../../../../../lib/auth";
import { pool } from "../../../../../lib/db";
export const runtime = "nodejs";
async function mayChatWith(name: string, memberId: string): Promise<boolean> {
  try { await requireConsoleAgentUse(name, memberId, pool); return true; } catch { return false; }
}
async function handleGET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const member = await signedInMember();
  if (!mayUse(member, "member")) return new Response(null, { status: 401 });
  const memberId = member.id;
  const { name } = await params;
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name))
    return new Response(null, { status: 400 });
  // Owners and admins see every agent's picture. A member sees it only for an agent they may chat
  // with: the same check the chat page makes.
  const seesEveryAgent = mayUse(member, "admin");
  if (!seesEveryAgent && !(await mayChatWith(name, memberId)))
    return new Response(null, { status: 403 });
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

export const GET = withConsoleAdmission(handleGET);
