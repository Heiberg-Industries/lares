import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ actingAddress: vi.fn(), keeper: vi.fn(), cookie: vi.fn(), notionAgents: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../lib/auth', () => ({ actingAddress: mocks.actingAddress }));
vi.mock('../lib/keeper-client', async original => ({ ...await original<typeof import('../lib/keeper-client')>(), keeper: mocks.keeper }));
vi.mock('../lib/notion-agents', () => ({ notionAgents: mocks.notionAgents }));
import { POST } from '../app/api/credentials/notion/preview/route';
import { KeeperRefusedError, KeeperUnavailableError } from '../lib/keeper-client';

const origin = 'https://console.example.test', url = `${origin}/api/credentials/notion/preview`;
const post = (body: unknown, from: string | null = origin) =>
  POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(from ? { origin: from } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const preview = { agent: 'chief', purpose: 'clipping', inventoryRevision: 'b'.repeat(64), consumers: [{ name: 'chief', category: 'owned-agent', incarnation: '11111111-1111-4111-8111-111111111111' }] };

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('CONSOLE_OAUTH_REDIRECT', `${origin}/api/auth/callback`); vi.stubEnv('NODE_ENV', 'production');
  mocks.cookie.mockReturnValue({ value: 'signed-cookie' }); mocks.actingAddress.mockResolvedValue('owner@example.test');
  mocks.notionAgents.mockResolvedValue([{ name: 'chief', displayName: 'Chief' }, { name: 'second', displayName: 'Second' }]);
  mocks.keeper.mockResolvedValue(preview);
});
afterEach(() => vi.unstubAllEnvs());

describe('previewing one agent switched on for Notion (read-only, through the keeper)', () => {
  it('asks the keeper to preview the grant for that agent, purpose clipping, as the owner', async () => {
    const res = await post({ agent: 'chief' });
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, preview });
    expect(mocks.actingAddress).toHaveBeenCalledWith('owner');
    expect(mocks.keeper).toHaveBeenCalledExactlyOnceWith('credential.preview_grant', { slot: 'notion:shared', agent: 'chief', purpose: 'clipping' }, 'owner@example.test');
  });
  it('signed out, or not the owner: refused before anything is read', async () => {
    mocks.actingAddress.mockResolvedValue(null);
    expect((await post({ agent: 'chief' })).status).toBe(401);
    expect(mocks.notionAgents).not.toHaveBeenCalled(); expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it.each([null, 'https://other.example.test'])('requires the exact Origin %s', async from => {
    expect((await post({ agent: 'chief' }, from)).status).toBe(403); expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it.each([[{}], [{ agent: 'Not A Name' }], [{ agent: 5 }], ['not json']])('rejects %j', async body => {
    expect((await post(body)).status).toBe(400); expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it('an agent that is not a chief of staff on this installation is refused without asking the keeper', async () => {
    const res = await post({ agent: 'writer' });
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ ok: false, code: 'not-a-notion-agent' });
    expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it('an unreadable agent list is unavailable', async () => {
    mocks.notionAgents.mockRejectedValue(new Error('down'));
    expect((await post({ agent: 'chief' })).status).toBe(503); expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it('a keeper refusal and a keeper outage are told apart, and neither echoes the keeper message', async () => {
    mocks.keeper.mockRejectedValue(new KeeperRefusedError('synthetic-leak'));
    const refused = await post({ agent: 'chief' });
    expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ ok: false, code: 'request-refused' });
    mocks.keeper.mockRejectedValue(new KeeperUnavailableError('socket synthetic-leak', true));
    const down = await post({ agent: 'chief' });
    expect(down.status).toBe(503); expect(await down.json()).toEqual({ ok: false, code: 'unavailable-before-send' });
  });
  it.each([null, {}, { ...preview, token: 'x' }, { ...preview, inventoryRevision: 'short' }])('a keeper answer in the wrong shape is unavailable, never shown: %j', async answer => {
    mocks.keeper.mockResolvedValue(answer);
    const res = await post({ agent: 'chief' });
    expect(res.status).toBe(503); expect(await res.json()).toEqual({ ok: false, code: 'unavailable' });
  });
});
