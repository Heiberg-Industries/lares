import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), keeper: vi.fn(), cookie: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../lib/auth', () => ({ verify: mocks.verify }));
vi.mock('../lib/keeper-client', async original => ({ ...await original<typeof import('../lib/keeper-client')>(), keeper: mocks.keeper }));
import { GET, POST } from '../app/api/credentials/notion/route';
import { KeeperRefusedError, KeeperUnavailableError } from '../lib/keeper-client';
import { getCredentialView } from '../lib/credentials';
import type { CredentialStatus } from '@lares/agent-kit/credential-lifecycle';

const origin = 'https://console.example.test', url = `${origin}/api/credentials/notion`, secret = 'synthetic-never-echo';
const status: CredentialStatus = { slot: 'notion:shared', state: 'not-configured', phase: 'not-configured', guidance: null, revision: 0,
  activeRevision: null, candidateRevision: null, test: null, consumers: [], activation: [], rollback: [], inventoryRevision: 'a'.repeat(64) };
const command = { operation: 'test_save', slot: 'notion:shared', expectedRevision: 0, token: secret };
const post = (body: unknown = command, from: string | null = origin) => POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(from ? { origin: from } : {}) }, body: JSON.stringify(body) }));
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('CONSOLE_OAUTH_REDIRECT', `${origin}/api/auth/callback`); vi.stubEnv('NODE_ENV', 'production');
  mocks.cookie.mockReturnValue({ value: 'signed-cookie' }); mocks.verify.mockResolvedValue('admin@example.invalid'); mocks.keeper.mockResolvedValue(status);
});
afterEach(() => vi.unstubAllEnvs());
it.each([null, 'invalid', 'expired'])('reverifies %s sessions before keeper reads or writes', async session => {
  mocks.cookie.mockReturnValue(session ? { value: session } : undefined); mocks.verify.mockResolvedValue(null);
  expect((await GET(new Request(url))).status).toBe(401); expect((await post()).status).toBe(401); expect(mocks.keeper).not.toHaveBeenCalled();
  expect(mocks.verify).toHaveBeenCalledTimes(2);
});
it.each([null, 'null', 'https://other.example.test', `${origin}:444`, `${origin}/path`])('requires exact mutation Origin %s independently of middleware', async from => {
  expect((await post(command, from)).status).toBe(403); expect(mocks.keeper).not.toHaveBeenCalled();
});
it('fails closed without public origin even when forwarded headers name the console', async () => {
  vi.stubEnv('CONSOLE_OAUTH_REDIRECT', ''); expect((await post()).status).toBe(403); expect(mocks.keeper).not.toHaveBeenCalled();
});
it('refuses allowlisted non-admin reads and mutations through keeper authority', async () => {
  mocks.verify.mockResolvedValue('member@example.invalid'); mocks.keeper.mockRejectedValue(new KeeperRefusedError('Credential administrator required'));
  expect((await GET(new Request(url))).status).toBe(403); expect((await post()).status).toBe(403);
  expect(mocks.keeper.mock.calls.every(call => call[0] === 'credential.status' && call[2] === 'member@example.invalid')).toBe(true);
});
it('derives actor from session, forwards one strict secret command, and returns only status', async () => {
  const response = await post(); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mocks.verify).toHaveBeenCalledWith('signed-cookie');
  expect(mocks.keeper.mock.calls).toEqual([['credential.status', { slot: 'notion:shared' }, 'admin@example.invalid'], ['credential.test_save', { slot: 'notion:shared', expectedRevision: 0, token: secret }, 'admin@example.invalid']]);
  expect(await response.text()).not.toContain(secret);
});
it.each([{ actor: 'injected' }, { path: '/arbitrary' }, { url: 'https://provider.invalid' }, { slot: 'other' }, { token: 'a b' }, { token: 'a'.repeat(8193) }])('rejects arbitrary or invalid command fields %j without sending a write', async change => {
  expect((await post({ ...command, ...change })).status).toBe(400);
  expect(mocks.keeper).toHaveBeenCalledTimes(1); expect(mocks.keeper.mock.calls[0]![0]).toBe('credential.status');
});
it.each(['test_current', 'test_pending', 'discard', 'apply', 'disconnect'])('forwards supported %s only after explicit administrator check', async operation => {
  const body = { operation, slot: 'notion:shared', expectedRevision: 0,
    ...(['apply', 'disconnect'].includes(operation) ? { expectedActiveRevision: null, inventoryRevision: 'a'.repeat(64), confirmRestart: true } : {}) };
  expect((await post(body)).status).toBe(200); expect(mocks.keeper.mock.calls[1]![0]).toBe(`credential.${operation}`);
});
it('requires restart confirmation for Apply and Disconnect', async () => {
  for (const operation of ['apply', 'disconnect']) expect((await post({ operation, slot: 'notion:shared', expectedRevision: 0, expectedActiveRevision: null, inventoryRevision: 'a'.repeat(64), confirmRestart: false })).status).toBe(400);
  expect(mocks.keeper.mock.calls.every(call => call[0] === 'credential.status')).toBe(true);
});
it.each([false, true])('distinguishes unavailable before send from unknown after send (%s)', async afterSend => {
  mocks.keeper.mockResolvedValueOnce(status).mockRejectedValueOnce(new KeeperUnavailableError(secret, afterSend));
  const response = await post(); expect(await response.json()).toEqual({ ok: false, code: afterSend ? 'outcome-unknown' : 'unavailable-before-send' });
  expect(mocks.keeper).toHaveBeenCalledTimes(2);
});
it('reports failed status preflight as before-send without forwarding a mutation', async () => {
  mocks.keeper.mockRejectedValue(new KeeperUnavailableError(secret, true));
  expect(await (await post()).json()).toEqual({ ok: false, code: 'unavailable-before-send' });
  expect(mocks.keeper).toHaveBeenCalledOnce();
  expect(mocks.keeper.mock.calls[0]![0]).toBe('credential.status');
});
it('maps audited uncertainty to fixed copy and never returns raw keeper failures', async () => {
  mocks.keeper.mockResolvedValueOnce(status).mockRejectedValueOnce(new KeeperRefusedError(`keeper: action outcome uncertain ${secret}`));
  expect(await (await post()).json()).toEqual({ ok: false, code: 'outcome-unknown' });
});
it.each([null, {}, { ...status, token: secret }])('malformed successful keeper results remain unavailable/unknown, never empty success', async result => {
  mocks.keeper.mockResolvedValue(result);
  expect(await getCredentialView()).toEqual({ kind: 'unavailable' });
  mocks.keeper.mockResolvedValueOnce(status).mockResolvedValueOnce(result);
  expect(await (await post()).json()).toEqual({ ok: false, code: 'outcome-unknown' });
});
it('GET accepts no query secrets and only requests metadata', async () => {
  expect((await GET(new Request(`${url}?token=${secret}`))).status).toBe(400); expect(mocks.keeper).not.toHaveBeenCalled();
  expect((await GET(new Request(url))).status).toBe(200); expect(mocks.keeper).toHaveBeenCalledOnce(); expect(mocks.keeper.mock.calls[0]![0]).toBe('credential.status');
});
it('bounds the request body before parsing or forwarding', async () => {
  expect((await post({ ...command, token: 'a'.repeat(17000) })).status).toBe(400); expect(mocks.keeper).toHaveBeenCalledOnce();
});
