import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  verify: vi.fn(), keeper: vi.fn(), cookie: vi.fn(),
  getClippingView: vi.fn(), enqueueRequest: vi.fn(), saveMapping: vi.fn(), setChoice: vi.fn(),
  hasSavedSource: vi.fn(), chiefOfStaffForSwitch: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../lib/auth', () => ({ verify: mocks.verify }));
vi.mock('../lib/keeper-client', async original => ({ ...await original<typeof import('../lib/keeper-client')>(), keeper: mocks.keeper }));
vi.mock('../lib/clipping', () => ({
  getClippingView: mocks.getClippingView, enqueueRequest: mocks.enqueueRequest, saveMapping: mocks.saveMapping,
  setChoice: mocks.setChoice, hasSavedSource: mocks.hasSavedSource, chiefOfStaffForSwitch: mocks.chiefOfStaffForSwitch,
}));
import { GET, POST } from '../app/api/clipping/route';
import { KeeperRefusedError, KeeperUnavailableError } from '../lib/keeper-client';

const origin = 'https://console.example.test', url = `${origin}/api/clipping`;
const view = { unavailable: false, source: null, sourceCount: 0, requests: {}, choice: null, chiefOfStaff: { kind: 'one', name: 'chief' }, busy: false };
const post = (body: unknown, from: string | null = origin, contentType = 'application/json') =>
  POST(new Request(url, { method: 'POST', headers: { 'content-type': contentType, ...(from ? { origin: from } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const preview = { agent: 'chief', purpose: 'clipping', inventoryRevision: 'b'.repeat(64), consumers: [{ name: 'chief', category: 'owned-agent', incarnation: '11111111-1111-4111-8111-111111111111' }] };

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('CONSOLE_OAUTH_REDIRECT', `${origin}/api/auth/callback`); vi.stubEnv('NODE_ENV', 'production');
  mocks.cookie.mockReturnValue({ value: 'signed-cookie' }); mocks.verify.mockResolvedValue('owner@example.test');
  mocks.getClippingView.mockResolvedValue(view);
  mocks.enqueueRequest.mockResolvedValue({ ok: true }); mocks.saveMapping.mockResolvedValue({ ok: true });
  mocks.setChoice.mockResolvedValue({ ok: true }); mocks.hasSavedSource.mockResolvedValue(true);
  mocks.chiefOfStaffForSwitch.mockResolvedValue({ kind: 'one', name: 'chief' }); mocks.keeper.mockResolvedValue(preview);
});
afterEach(() => vi.unstubAllEnvs());

describe('sessions and origin', () => {
  it.each([null, 'invalid', 'expired'])('reverifies %s sessions before any read or write', async session => {
    mocks.cookie.mockReturnValue(session ? { value: session } : undefined); mocks.verify.mockResolvedValue(null);
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await post({ action: 'test' })).status).toBe(401);
    expect(mocks.getClippingView).not.toHaveBeenCalled(); expect(mocks.enqueueRequest).not.toHaveBeenCalled(); expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it.each([null, 'null', 'https://other.example.test', `${origin}:444`, `${origin}/path`])('requires the exact mutation Origin %s', async from => {
    expect((await post({ action: 'test' }, from)).status).toBe(403);
    expect(mocks.enqueueRequest).not.toHaveBeenCalled(); expect(mocks.setChoice).not.toHaveBeenCalled();
  });
  it('fails closed without a public origin', async () => {
    vi.stubEnv('CONSOLE_OAUTH_REDIRECT', ''); expect((await post({ action: 'test' })).status).toBe(403);
  });
});

describe('GET', () => {
  it('returns the view, uncached', async () => {
    const res = await GET(new Request(url));
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, view });
  });
  it('an unreadable view is still a 200 that says unavailable, not an empty success', async () => {
    mocks.getClippingView.mockResolvedValue({ unavailable: true });
    expect(await (await GET(new Request(url))).json()).toEqual({ ok: true, view: { unavailable: true } });
  });
  it('takes no query string', async () => {
    expect((await GET(new Request(`${url}?x=1`))).status).toBe(400); expect(mocks.getClippingView).not.toHaveBeenCalled();
  });
});

describe('input is strict and size-limited', () => {
  it.each([
    [{}], [{ action: 'drop-tables' }], [{ action: 'test', extra: 1 }], [{ action: 'read-database' }], [{ action: 'read-database', link: '' }],
    [{ action: 'read-database', link: 'x'.repeat(2049) }], [{ action: 'read-database', link: 5 }],
    [{ action: 'save-mapping', dataSourceId: 'ds' }], [{ action: 'save-mapping', dataSourceId: 'ds', urlPropertyId: 'u', owner: 'someone' }],
    [{ action: 'save-mapping', dataSourceId: 'ds', urlPropertyId: 'u', visibility: 'private' }],
    [{ action: 'set-choice', mode: 'all' }], [{ action: 'import', agent: 'x' }], [{ action: 'preview-grant', agent: 'other' }],
    ['not json'], [''], [null], [[]],
  ])('rejects %j with no write', async body => {
    expect((await post(typeof body === 'string' ? body : body)).status).toBe(400);
    expect(mocks.enqueueRequest).not.toHaveBeenCalled(); expect(mocks.saveMapping).not.toHaveBeenCalled();
    expect(mocks.setChoice).not.toHaveBeenCalled(); expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it('rejects a body over 16 KiB, a query string and a wrong content type', async () => {
    expect((await post({ action: 'read-database', link: 'a'.repeat(20_000) })).status).toBe(400);
    expect((await POST(new Request(`${url}?a=1`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{"action":"test"}' }))).status).toBe(400);
    expect((await post({ action: 'test' }, origin, 'text/plain')).status).toBe(400);
    expect(mocks.enqueueRequest).not.toHaveBeenCalled();
  });
});

describe('actions', () => {
  it('read-database enqueues a schema request carrying only the pasted link, as the signed-in actor', async () => {
    const res = await post({ action: 'read-database', link: '  https://www.notion.so/Clips-0123456789abcdef0123456789abcdef  ' });
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ ok: true, view });
    expect(mocks.enqueueRequest).toHaveBeenCalledWith('schema', { link: 'https://www.notion.so/Clips-0123456789abcdef0123456789abcdef' }, 'owner@example.test');
  });
  it.each(['test', 'import', 'add-properties'])('%s enqueues a request with no parameters once a source is saved', async action => {
    expect((await post({ action })).status).toBe(200);
    expect(mocks.enqueueRequest).toHaveBeenCalledWith(action, {}, 'owner@example.test');
  });
  it.each(['test', 'import', 'add-properties'])('%s without a saved source is refused and enqueues nothing', async action => {
    mocks.hasSavedSource.mockResolvedValue(false);
    const res = await post({ action });
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ ok: false, code: 'no-source' });
    expect(mocks.enqueueRequest).not.toHaveBeenCalled();
  });
  it('a failed read of whether a source exists is unavailable, not "no source"', async () => {
    mocks.hasSavedSource.mockResolvedValue(null);
    const res = await post({ action: 'test' });
    expect(res.status).toBe(503); expect(await res.json()).toEqual({ ok: false, code: 'unavailable' });
  });
  it('save-mapping passes only the five mapping fields', async () => {
    await post({ action: 'save-mapping', dataSourceId: 'ds-1', urlPropertyId: 'u1', notePropertyId: null, tagsPropertyId: 't1' });
    expect(mocks.saveMapping).toHaveBeenCalledWith({ dataSourceId: 'ds-1', urlPropertyId: 'u1', notePropertyId: null, tagsPropertyId: 't1' });
  });
  it('set-choice records who chose', async () => {
    await post({ action: 'set-choice', mode: 'notion' });
    expect(mocks.setChoice).toHaveBeenCalledWith('notion', 'owner@example.test');
  });
  it.each([
    ['busy', 409], ['no-schema', 409], ['mapping-mismatch', 409], ['more-than-one-source', 409], ['unavailable', 503],
  ])('a refused write (%s) keeps its own code and status', async (code, status) => {
    mocks.saveMapping.mockResolvedValue({ ok: false, code });
    const res = await post({ action: 'save-mapping', dataSourceId: 'ds-1', urlPropertyId: 'u1' });
    expect(res.status).toBe(status); expect(await res.json()).toEqual({ ok: false, code });
  });
  it('returns the new view after a write, so the card shows the waiting state at once', async () => {
    const waiting = { ...view, busy: true };
    mocks.getClippingView.mockResolvedValue(waiting);
    expect(await (await post({ action: 'test' })).json()).toEqual({ ok: true, view: waiting });
  });
});

describe('preview-grant (read-only, through the keeper)', () => {
  it('asks the keeper to preview the grant for the one chief of staff, purpose clipping, as the actor', async () => {
    const res = await post({ action: 'preview-grant' });
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ ok: true, preview });
    expect(mocks.keeper).toHaveBeenCalledOnce();
    expect(mocks.keeper).toHaveBeenCalledWith('credential.preview_grant', { slot: 'notion:shared', agent: 'chief', purpose: 'clipping' }, 'owner@example.test');
  });
  it.each([{ kind: 'none' }, { kind: 'several' }])('refuses without exactly one chief of staff (%j) and calls no keeper', async chief => {
    mocks.chiefOfStaffForSwitch.mockResolvedValue(chief);
    const res = await post({ action: 'preview-grant' });
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ ok: false, code: 'chief-of-staff-not-found' });
    expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it('an unreadable agent list is unavailable', async () => {
    mocks.chiefOfStaffForSwitch.mockResolvedValue(null);
    expect((await post({ action: 'preview-grant' })).status).toBe(503); expect(mocks.keeper).not.toHaveBeenCalled();
  });
  it('a keeper refusal and a keeper outage are told apart, and neither echoes the keeper message', async () => {
    mocks.keeper.mockRejectedValue(new KeeperRefusedError('Credential administrator required synthetic-leak'));
    const refused = await post({ action: 'preview-grant' });
    expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ ok: false, code: 'request-refused' });
    mocks.keeper.mockRejectedValue(new KeeperUnavailableError('socket synthetic-leak', true));
    const down = await post({ action: 'preview-grant' });
    expect(down.status).toBe(503); expect(await down.json()).toEqual({ ok: false, code: 'unavailable-before-send' });
  });
  it.each([null, {}, { ...preview, token: 'x' }, { ...preview, inventoryRevision: 'short' }])('a keeper answer in the wrong shape is unavailable, never shown: %j', async answer => {
    mocks.keeper.mockResolvedValue(answer);
    const res = await post({ action: 'preview-grant' });
    expect(res.status).toBe(503); expect(await res.json()).toEqual({ ok: false, code: 'unavailable' });
  });
});
