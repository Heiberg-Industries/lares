import { clippingActionInput } from '@lares/agent-kit/clipping-console';
import { CREDENTIAL_SLOT, credentialGrantPreviewSchema } from '@lares/agent-kit/credential-lifecycle';
import { credentialActor } from '../../../lib/credentials';
import { keeper, KeeperRefusedError, KeeperUnavailableError } from '../../../lib/keeper-client';
import {
  chiefOfStaffForSwitch, enqueueRequest, getClippingView, hasSavedSource, saveMapping, setChoice,
  type WriteResult,
} from '../../../lib/clipping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failed = (code: string, status: number) => response({ ok: false, code }, status);

export async function GET(req: Request): Promise<Response> {
  const actor = await credentialActor();
  if (!actor) return failed('sign-in-required', 401);
  if (new URL(req.url).search) return failed('invalid-request', 400);
  return response({ ok: true, view: await getClippingView() });
}

// Same exact-origin rule as app/api/credentials/notion/route.ts (kept as a copy: that route stays untouched).
function sameOrigin(req: Request): boolean {
  try {
    const configured = process.env.CONSOLE_OAUTH_REDIRECT;
    const origin = configured ? new URL(configured).origin : process.env.NODE_ENV !== 'production' ? new URL(req.url).origin : null;
    return !!origin && req.headers.get('origin') === origin;
  } catch { return false; }
}
async function input(req: Request): Promise<unknown> {
  if (new URL(req.url).search || req.headers.get('content-type')?.split(';')[0] !== 'application/json' || !req.body) throw new Error('Invalid request');
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.length;
      if (length > 16_384) throw new Error('Invalid request');
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
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

export async function POST(req: Request): Promise<Response> {
  const actor = await credentialActor();
  if (!actor) return failed('sign-in-required', 401);
  if (!sameOrigin(req)) return failed('origin-refused', 403);
  let parsed;
  try { parsed = clippingActionInput.safeParse(await input(req)); } catch { return failed('invalid-request', 400); }
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
    case 'preview-grant': {
      // Read-only: what switching clipping on would restart, and the inventory revision to confirm.
      const chief = await chiefOfStaffForSwitch();
      if (!chief) return failed('unavailable', 503);
      if (chief.kind !== 'one') return failed('chief-of-staff-not-found', 409);
      try {
        const preview = credentialGrantPreviewSchema.safeParse(
          await keeper('credential.preview_grant', { slot: CREDENTIAL_SLOT, agent: chief.name, purpose: 'clipping' }, actor));
        if (!preview.success) return failed('unavailable', 503);
        return response({ ok: true, preview: preview.data });
      } catch (error) {
        if (error instanceof KeeperRefusedError) return failed('request-refused', 409);
        if (error instanceof KeeperUnavailableError) return failed('unavailable-before-send', 503);
        return failed('unavailable', 503);
      }
    }
  }
}
