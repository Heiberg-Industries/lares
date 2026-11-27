import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ actingAddress: vi.fn(), cookie: vi.fn(), enqueueRequest: vi.fn(), getMeetingsLookupView: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../lib/auth', () => ({ actingAddress: mocks.actingAddress }));
vi.mock('../lib/clipping', () => ({ enqueueRequest: mocks.enqueueRequest, getMeetingsLookupView: mocks.getMeetingsLookupView }));
import { GET, POST } from '../app/api/meetings/source/route';

const origin = 'https://console.example.test', url = `${origin}/api/meetings/source`;
const view = { unavailable: false, request: null, busy: false };
const post = (body: unknown, from: string | null = origin) =>
  POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(from ? { origin: from } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('CONSOLE_OAUTH_REDIRECT', `${origin}/api/auth/callback`); vi.stubEnv('NODE_ENV', 'production');
  mocks.cookie.mockReturnValue({ value: 'signed-cookie' }); mocks.actingAddress.mockResolvedValue('owner@example.test');
  mocks.enqueueRequest.mockResolvedValue({ ok: true }); mocks.getMeetingsLookupView.mockResolvedValue(view);
});
afterEach(() => vi.unstubAllEnvs());

describe('the Meetings page lookup', () => {
  it('GET returns the latest lookup, uncached, to anyone who may open the page', async () => {
    const res = await GET(new Request(url));
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, view });
    expect(mocks.actingAddress).toHaveBeenCalledWith('admin');
  });
  it('POST asks the chief of staff to look the link up, as the owner, and saves nothing else', async () => {
    const link = 'https://www.notion.so/example/Meetings-0123abcd45674ef08123456789abcdef';
    const res = await post({ link });
    expect(res.status).toBe(200);
    expect(mocks.actingAddress).toHaveBeenCalledWith('owner');
    expect(mocks.enqueueRequest).toHaveBeenCalledExactlyOnceWith('meetings-database', { link }, 'owner@example.test');
  });
  it('signed out: refused before anything is read or written', async () => {
    mocks.actingAddress.mockResolvedValue(null);
    expect((await GET(new Request(url))).status).toBe(401); expect((await post({ link: 'x' })).status).toBe(401);
    expect(mocks.enqueueRequest).not.toHaveBeenCalled(); expect(mocks.getMeetingsLookupView).not.toHaveBeenCalled();
  });
  it.each([null, 'https://other.example.test'])('requires the exact Origin %s', async from => {
    expect((await post({ link: 'x' }, from)).status).toBe(403); expect(mocks.enqueueRequest).not.toHaveBeenCalled();
  });
  it.each([[{}], [{ link: '' }], [{ link: 'x'.repeat(2049) }], [{ link: 'x', extra: 1 }], ['not json']])('rejects %j', async body => {
    expect((await post(body)).status).toBe(400); expect(mocks.enqueueRequest).not.toHaveBeenCalled();
  });
  it('a lookup already on its way is busy, not a second request', async () => {
    mocks.enqueueRequest.mockResolvedValue({ ok: false, code: 'busy' });
    const res = await post({ link: 'x' });
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ ok: false, code: 'busy' });
  });
});
