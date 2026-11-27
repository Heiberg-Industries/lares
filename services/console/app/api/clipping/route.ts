import { withConsoleAdmission } from "../../../lib/admission-error";
import { clippingActionInput } from '@lares/agent-kit/clipping-console';
import { actingAddress } from '../../../lib/auth';
import {
  enqueueRequest, getClippingView, hasSavedSource, saveMapping, setChoice,
  type WriteResult,
} from '../../../lib/clipping';
import { jsonBody, sameOrigin } from '../../../lib/same-origin-json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failed = (code: string, status: number) => response({ ok: false, code }, status);

async function handleGET(req: Request): Promise<Response> {
  const actor = await actingAddress("admin");
  if (!actor) return failed('sign-in-required', 401);
  if (new URL(req.url).search) return failed('invalid-request', 400);
  return response({ ok: true, view: await getClippingView() });
}

const STATUS_FOR: Record<string, number> = {
  busy: 409, 'no-source': 409, 'no-schema': 409, 'mapping-mismatch': 409, 'more-than-one-source': 409,
};
async function written(result: WriteResult): Promise<Response> {
  if (!result.ok) return failed(result.code, STATUS_FOR[result.code] ?? 503);
  return response({ ok: true, view: await getClippingView() });
}
/** The buttons that act on the saved source need one. A failed read is "unavailable", not "none". */
async function needsSource(): Promise<Response | null> {
  const has = await hasSavedSource();
  if (has === null) return failed('unavailable', 503);
  return has ? null : failed('no-source', 409);
}

async function handlePOST(req: Request): Promise<Response> {
  const actor = await actingAddress("owner");
  if (!actor) return failed('sign-in-required', 401);
  if (!sameOrigin(req)) return failed('origin-refused', 403);
  let parsed;
  try { parsed = clippingActionInput.safeParse(await jsonBody(req)); } catch { return failed('invalid-request', 400); }
  if (!parsed.success) return failed('invalid-request', 400);
  const command = parsed.data;
  switch (command.action) {
    case 'read-database':
      return written(await enqueueRequest('schema', { link: command.link }, actor));
    case 'save-mapping': {
      const { action: _action, ...mapping } = command;
      return written(await saveMapping(mapping));
    }
    case 'test': case 'import': case 'add-properties': {
      const missing = await needsSource();
      if (missing) return missing;
      return written(await enqueueRequest(command.action, {}, actor));
    }
    case 'set-choice':
      return written(await setChoice(command.mode, actor));
  }
}

export const GET = withConsoleAdmission(handleGET);

export const POST = withConsoleAdmission(handlePOST);
