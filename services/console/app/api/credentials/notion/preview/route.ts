import { withConsoleAdmission } from "../../../../../lib/admission-error";
import { CREDENTIAL_SLOT, credentialGrantPreviewInput, credentialGrantPreviewSchema } from '@lares/agent-kit/credential-lifecycle';
import { actingAddress } from '../../../../../lib/auth';
import { keeper, KeeperRefusedError, KeeperUnavailableError } from '../../../../../lib/keeper-client';
import { notionAgents } from '../../../../../lib/notion-agents';
import { jsonBody, sameOrigin } from '../../../../../lib/same-origin-json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failed = (code: string, status: number) => response({ ok: false, code }, status);

/** Read-only: what switching one agent on for Notion would restart, and the inventory revision the
 *  owner then confirms. The keeper's credential.preview_grant, unchanged; it writes and restarts
 *  nothing. The agent must be a chief-of-staff agent that is not retired (the keeper checks too). */
async function handlePOST(req: Request): Promise<Response> {
  const actor = await actingAddress("owner");
  if (!actor) return failed('sign-in-required', 401);
  if (!sameOrigin(req)) return failed('origin-refused', 403);
  let agent: unknown;
  try { agent = (await jsonBody(req) as { agent?: unknown } | null)?.agent; } catch { return failed('invalid-request', 400); }
  const input = credentialGrantPreviewInput.safeParse({ slot: CREDENTIAL_SLOT, agent, purpose: 'clipping' });
  if (!input.success) return failed('invalid-request', 400);
  let known: string[];
  try { known = (await notionAgents()).map((a) => a.name); } catch { return failed('unavailable', 503); }
  if (!known.includes(input.data.agent)) return failed('not-a-notion-agent', 409);
  try {
    const preview = credentialGrantPreviewSchema.safeParse(await keeper('credential.preview_grant', input.data, actor));
    if (!preview.success) return failed('unavailable', 503);
    return response({ ok: true, preview: preview.data });
  } catch (error) {
    if (error instanceof KeeperRefusedError) return failed('request-refused', 409);
    if (error instanceof KeeperUnavailableError) return failed('unavailable-before-send', 503);
    return failed('unavailable', 503);
  }
}

export const POST = withConsoleAdmission(handlePOST);
