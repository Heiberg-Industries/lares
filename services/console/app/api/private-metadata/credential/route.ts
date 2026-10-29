import { keeper, KeeperRefusedError, KeeperUnavailableError } from '../../../../lib/keeper-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  'cache-control': 'no-store, private', pragma: 'no-cache', 'referrer-policy': 'no-referrer',
} });
const denied = () => response({ ok: false, code: 'credential-refused' }, 401);

async function POSTHandler(req: Request): Promise<Response> {
  if (new URL(req.url).search || req.headers.get('content-type')?.split(';')[0] !== 'application/json')
    return response({ ok: false, code: 'invalid-request' }, 400);
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) return denied();
  let input: unknown;
  try {
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength > 256) return response({ ok: false, code: 'invalid-request' }, 400);
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return response({ ok: false, code: 'invalid-request' }, 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
      !['upload', 'read'].includes((input as { scope?: string }).scope ?? ''))
    return response({ ok: false, code: 'invalid-request' }, 400);
  const scope = (input as { scope: 'upload' | 'read' }).scope;
  try {
    const result = await keeper<unknown>('private-metadata.credential.validate', { token, scope }, 'private-metadata-server@localhost.invalid');
    if (!result || typeof result !== 'object' || Array.isArray(result)) return denied();
    const value = result as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'accountId,datasetId,generation,scope' ||
        typeof value.accountId !== 'string' || typeof value.datasetId !== 'string' || value.scope !== scope ||
        !Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return denied();
    return response({ ok: true, accountId: value.accountId, datasetId: value.datasetId, scope, generation: value.generation });
  } catch (error) {
    if (error instanceof KeeperRefusedError) return denied();
    if (error instanceof KeeperUnavailableError) return response({ ok: false, code: 'unavailable' }, 503);
    return response({ ok: false, code: 'unavailable' }, 503);
  }
}

export const POST = POSTHandler;
