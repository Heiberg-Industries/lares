import { cookies } from 'next/headers';
import { withConsoleAdmission } from '../../../lib/admission-error';
import { isConsoleOwner, memberAuditAddress, sessionMember } from '../../../lib/auth';
import { keeper, KeeperRefusedError, KeeperUnavailableError } from '../../../lib/keeper-client';
import { providerKeyStatusFor } from '../../../lib/provider-key';
import { providerKeyRequest } from '../../../lib/provider-key-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failed = (code: string, status: number) => response({ ok: false, code }, status);
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
async function handlePOST(req: Request): Promise<Response> {
  const member = await sessionMember((await cookies()).get('lares_session')?.value);
  const sessionToken = (await cookies()).get('lares_session')?.value;
  if (!sessionToken || !member) return failed('sign-in-required', 401);
  if (!sameOrigin(req)) return failed('origin-refused', 403);
  if (!isConsoleOwner(member)) return failed('owner-required', 403);
  const actor = await memberAuditAddress(member.id);
  if (!actor) return failed('sign-in-required', 401);
  let parsed;
  try { parsed = providerKeyRequest.safeParse(await input(req)); } catch { return failed('invalid-request', 400); }
  if (!parsed.success) return failed('invalid-request', 400);
  const command = parsed.data;
  try {
    if (command.operation === 'save') await keeper('provider-key.save', { sessionToken, name: command.name, key: command.key }, actor);
    else await keeper('provider-key.remove-own', { sessionToken, name: command.name }, actor);
  } catch (error) {
    if (error instanceof KeeperUnavailableError) return failed(error.outcomeMayBeUnknown ? 'outcome-unknown' : 'unavailable-before-send', 503);
    if (error instanceof KeeperRefusedError) return failed('request-refused', 409);
    return failed('outcome-unknown', 503);
  }
  const view = await providerKeyStatusFor(sessionToken, command.name, actor);
  if (view.kind !== 'status') return failed('outcome-unknown', 503);
  return response({ ok: true, status: view.status });
}

export const POST = withConsoleAdmission(handlePOST);
