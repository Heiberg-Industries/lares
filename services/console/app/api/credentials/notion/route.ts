import { credentialMutationInput, credentialStatusSchema } from '@lares/agent-kit/credential-lifecycle';
import { credentialActor, credentialViewFor } from '../../../../lib/credentials';
import { keeper, KeeperRefusedError, KeeperUnavailableError } from '../../../../lib/keeper-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failed = (code: string, status: number) => response({ ok: false, code }, status);
export async function GET(req: Request): Promise<Response> {
  const actor = await credentialActor();
  if (!actor) return failed('sign-in-required', 401);
  if (new URL(req.url).search) return failed('invalid-request', 400);
  const view = await credentialViewFor(actor);
  if (view.kind !== 'status') return failed(view.kind, view.kind === 'administrator-required' ? 403 : 503);
  return response({ ok: true, status: view.status });
}
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
export async function POST(req: Request): Promise<Response> {
  const actor = await credentialActor();
  if (!actor) return failed('sign-in-required', 401);
  if (!sameOrigin(req)) return failed('origin-refused', 403);
  const view = await credentialViewFor(actor);
  if (view.kind !== 'status') return failed(view.kind === 'unavailable' ? 'unavailable-before-send' : view.kind, view.kind === 'administrator-required' ? 403 : 503);
  if (view.status.state === 'unavailable') return failed('unavailable-before-send', 503);
  let parsed;
  try { parsed = credentialMutationInput.safeParse(await input(req)); } catch { return failed('invalid-request', 400); }
  if (!parsed.success) return failed('invalid-request', 400);
  const { operation, ...command } = parsed.data;
  try {
    const result = await keeper(`credential.${operation}`, command, actor);
    const status = credentialStatusSchema.safeParse(result);
    if (!status.success) return failed('outcome-unknown', 503);
    return response({ ok: true, status: status.data });
  } catch (error) {
    if (error instanceof KeeperUnavailableError) return failed(error.outcomeMayBeUnknown ? 'outcome-unknown' : 'unavailable-before-send', 503);
    if (error instanceof KeeperRefusedError) return failed(error.message.includes('outcome uncertain') ? 'outcome-unknown' : 'request-refused', 409);
    return failed('outcome-unknown', 503);
  }
}
