/**
 * GET/POST /api/notion-proposals — the console's half of the 👍 loop (spec
 * §18.4/§18.6). Session-gated, same as every other mutation surface (see
 * app/api/accounts/google/start/route.ts): middleware.ts already redirects an
 * unauthenticated page load, but a direct fetch to this route re-checks the
 * session itself rather than relying on the redirect alone.
 *
 *   GET  → { proposals, frozen } — the same view app/integrations/page.tsx
 *          renders at load, callable standalone (debugging, future consumers).
 *   POST { id, action: "approve" | "reject" } → flips the proposal's state and
 *          returns { ok: true }. The engine (runApplySync) does the actual
 *          Notion/vault write on its next tick — this route only ever touches
 *          the notion_sync_proposals row, via lib/notion-proposals.ts's
 *          applyProposalAction (same semantics as the CLI's approve/reject).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verify } from "../../../lib/auth";
import { getNotionProposalsView, applyProposalAction, type ProposalAction } from "../../../lib/notion-proposals";

export const runtime = "nodejs";

async function requireSession(): Promise<string | null> {
  return verify((await cookies()).get("lares_session")?.value);
}

export async function GET(): Promise<Response> {
  if (!(await requireSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const view = await getNotionProposalsView();
    return NextResponse.json(view);
  } catch (err) {
    return NextResponse.json(
      { error: "server_error", message: (err as Error).message },
      { status: 500 },
    );
  }
}

function isProposalAction(value: unknown): value is ProposalAction {
  return value === "approve" || value === "reject";
}

export async function POST(req: Request): Promise<Response> {
  if (!(await requireSession())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON." }, { status: 400 });
  }

  const { id, action } = (body ?? {}) as { id?: unknown; action?: unknown };
  if (typeof id !== "number" || !Number.isInteger(id)) {
    return NextResponse.json({ error: "bad_request", message: "id must be an integer." }, { status: 400 });
  }
  if (!isProposalAction(action)) {
    return NextResponse.json(
      { error: "bad_request", message: 'action must be "approve" or "reject".' },
      { status: 400 },
    );
  }

  try {
    await applyProposalAction(id, action);
  } catch (err) {
    return NextResponse.json(
      { error: "bad_request", message: (err as Error).message },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true });
}
