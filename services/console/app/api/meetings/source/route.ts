import { withConsoleAdmission } from "../../../../lib/admission-error";
import { meetingsLookupInput } from '@lares/agent-kit/clipping-console';
import { actingAddress } from '../../../../lib/auth';
import { enqueueRequest, getMeetingsLookupView } from '../../../../lib/clipping';
import { jsonBody, sameOrigin } from '../../../../lib/same-origin-json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failed = (code: string, status: number) => response({ ok: false, code }, status);

/** The latest lookup of a pasted meetings database, for the Meetings page to follow. */
async function handleGET(req: Request): Promise<Response> {
  const actor = await actingAddress("admin");
  if (!actor) return failed('sign-in-required', 401);
  if (new URL(req.url).search) return failed('invalid-request', 400);
  return response({ ok: true, view: await getMeetingsLookupView() });
}

/** Ask the chief of staff to look a pasted database link up in Notion (the console cannot reach
 *  Notion). It saves nothing: the owner then saves one of the data sources it found, through the
 *  same installation setting as before (settings.notion_meetings_set). Owner only, like that setting. */
async function handlePOST(req: Request): Promise<Response> {
  const actor = await actingAddress("owner");
  if (!actor) return failed('sign-in-required', 401);
  if (!sameOrigin(req)) return failed('origin-refused', 403);
  let parsed;
  try { parsed = meetingsLookupInput.safeParse(await jsonBody(req)); } catch { return failed('invalid-request', 400); }
  if (!parsed.success) return failed('invalid-request', 400);
  const written = await enqueueRequest('meetings-database', { link: parsed.data.link }, actor);
  if (!written.ok) return failed(written.code, written.code === 'busy' ? 409 : 503);
  return response({ ok: true, view: await getMeetingsLookupView() });
}

export const GET = withConsoleAdmission(handleGET);

export const POST = withConsoleAdmission(handlePOST);
