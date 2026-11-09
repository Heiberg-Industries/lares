import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), audit: vi.fn(), keeper: vi.fn(), cookie: vi.fn(), owner: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../lib/auth', () => ({ sessionMember: mocks.session, memberAuditAddress: mocks.audit, isConsoleOwner: mocks.owner }));
vi.mock('../lib/keeper-client', async original => ({ ...await original<typeof import('../lib/keeper-client')>(), keeper: mocks.keeper }));
import { POST } from '../app/api/provider-key/route';
import { KeeperRefusedError, KeeperUnavailableError } from '../lib/keeper-client';

const origin = 'https://console.example.test', url = `${origin}/api/provider-key`, secret = 'sk-example-never-echo';
const status = { name: 'writer', own: true, setAt: '2026-11-09T10:00:00.000Z', setBy: 'owner' };
const save = { operation: 'save', name: 'writer', key: secret };
const post = (body: unknown = save, from: string | null = origin, raw?: string) => POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(from ? { origin: from } : {}) }, body: raw ?? JSON.stringify(body) }));
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('CONSOLE_OAUTH_REDIRECT', `${origin}/api/auth/callback`); vi.stubEnv('NODE_ENV', 'production');
  mocks.cookie.mockReturnValue({ value: 'signed-cookie' }); mocks.session.mockResolvedValue({ id: 'm1' }); mocks.owner.mockReturnValue(true);
  mocks.audit.mockResolvedValue('owner@example.invalid');
  mocks.keeper.mockImplementation(async (action: string) => action === 'provider-key.status' ? status : { name: 'writer' });
});
afterEach(() => vi.unstubAllEnvs());

it('needs a signed-in session before anything is sent', async () => {
  mocks.session.mockResolvedValue(null);
  expect((await post()).status).toBe(401); expect(mocks.keeper).not.toHaveBeenCalled();
});
it.each([null, 'null', 'https://other.example.test', `${origin}:444`, `${origin}/path`])('requires the exact Origin %s', async from => {
  expect((await post(save, from)).status).toBe(403); expect(mocks.keeper).not.toHaveBeenCalled();
});
it('refuses a signed-in member who is not the designated owner', async () => {
  mocks.owner.mockReturnValue(false);
  const response = await post(); expect(response.status).toBe(403); expect(await response.json()).toEqual({ ok: false, code: 'owner-required' });
  expect(mocks.keeper).not.toHaveBeenCalled();
});
it('passes the refusal of the keeper on, without the key', async () => {
  mocks.keeper.mockRejectedValue(new KeeperRefusedError(`not the owner ${secret}`));
  const response = await post(); expect(response.status).toBe(409);
  const text = await response.text(); expect(text).toBe(JSON.stringify({ ok: false, code: 'request-refused' })); expect(text).not.toContain(secret);
});
it('refuses a body over 16 KB, other fields, a bad key and a query string, sending nothing', async () => {
  expect((await post(null, origin, JSON.stringify({ ...save, key: 'k'.repeat(20_000) }))).status).toBe(400);
  for (const change of [{ extra: 1 }, { key: 'has space' }, { key: '' }, { name: 'Bad Name' }, { operation: 'apply' }])
    expect((await post({ ...save, ...change })).status).toBe(400);
  expect((await POST(new Request(`${url}?x=1`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(save) }))).status).toBe(400);
  expect(mocks.keeper).not.toHaveBeenCalled();
});
it('saves with the session token and the strict command, and returns only the status', async () => {
  const response = await post(); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mocks.keeper.mock.calls).toEqual([
    ['provider-key.save', { sessionToken: 'signed-cookie', name: 'writer', key: secret }, 'owner@example.invalid'],
    ['provider-key.status', { sessionToken: 'signed-cookie', name: 'writer' }, 'owner@example.invalid'],
  ]);
  const text = await response.text(); expect(JSON.parse(text)).toEqual({ ok: true, status }); expect(text).not.toContain(secret);
});
it('removes through the owner-only removal action', async () => {
  expect((await post({ operation: 'remove', name: 'writer' })).status).toBe(200);
  expect(mocks.keeper.mock.calls[0]).toEqual(['provider-key.remove-own', { sessionToken: 'signed-cookie', name: 'writer' }, 'owner@example.invalid']);
});
it.each([false, true])('tells unavailable before send from unknown after send (%s)', async afterSend => {
  mocks.keeper.mockRejectedValue(new KeeperUnavailableError(secret, afterSend));
  expect(await (await post()).json()).toEqual({ ok: false, code: afterSend ? 'outcome-unknown' : 'unavailable-before-send' });
});
