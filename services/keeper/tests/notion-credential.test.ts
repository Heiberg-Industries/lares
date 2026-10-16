import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { notionCredentialTester, NOTION_CREDENTIAL_ENDPOINT, NOTION_CREDENTIAL_TIMEOUT_MS, NOTION_CREDENTIAL_VERSION } from '../lib/notion-credential.js';

const credential = { kind: 'api_key' as const, integration: 'notion', secretFile: '/protected/synthetic-file' };
const secret = 'synthetic-token-only';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bot = { object: 'user', id, type: 'bot', name: secret, bot: { owner: { type: 'workspace', workspace: true }, workspace_name: secret } };
const proxy = 'http://proxy.example.invalid:8888';
function fixture(body: unknown = bot, status = 200) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const tester = notionCredentialTester(proxy, fetch);
  const read = vi.fn(() => secret);
  return { fetch, read, tester, run: () => tester.test(credential, read) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('uses official SDK users.me, exactly one GET and pinned API version; emits only validated bot identity', async () => {
  const f = fixture();
  const log = vi.spyOn(console, 'warn'), error = vi.spyOn(console, 'error');
  expect(await f.run()).toEqual({ outcome: 'passed', identity: { kind: 'internal-bot', botId: id } });
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1);
  const [url, init] = f.fetch.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string> }];
  expect(url).toBe(NOTION_CREDENTIAL_ENDPOINT); expect(init.method).toBe('GET');
  expect(init.headers['Notion-Version']).toBe(NOTION_CREDENTIAL_VERSION);
  expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${secret}`);
  expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
it.each([
  [401, 'unauthorized', 'refused'], [403, 'restricted_resource', 'refused'],
  [429, 'rate_limited', 'rate-limited'], [500, 'internal_server_error', 'unavailable'],
  [503, 'service_unavailable', 'unavailable'], [504, 'gateway_timeout', 'unavailable'],
  [529, 'service_overload', 'unavailable'], [400, 'validation_error', 'unexpected'],
  [404, 'object_not_found', 'unexpected'],
])('maps HTTP %s to fixed evidence with zero retries or SDK logs', async (status, code, outcome) => {
  const f = fixture({ object: 'error', status, code, message: `${secret} SQL host-path` }, status as number);
  const log = vi.spyOn(console, 'warn'), error = vi.spyOn(console, 'error');
  const result = await f.run();
  expect(result).toEqual({ outcome }); expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
it.each([{}, null, [], { ...bot, id: secret }, { ...bot, bot: {} }, { ...bot, bot: { owner: { type: 'workspace' } } }])('rejects malformed identity without echoing it', async body => {
  expect(await fixture(body).run()).toEqual({ outcome: 'unexpected' });
});
it.each([{ object: 'user', id, type: 'person', person: { email: secret } }, { ...bot, bot: { owner: { type: 'user', user: { id } } } }])('refuses person/public-connection identity instead of accepting another token kind', async body => {
  expect(await fixture(body).run()).toEqual({ outcome: 'refused' });
});
it('invalid JSON and network errors return fixed, different results and log nothing', async () => {
  const error = vi.spyOn(console, 'error'), warn = vi.spyOn(console, 'warn');
  expect(await notionCredentialTester(proxy, async () => new Response(secret)).test(credential, () => secret)).toEqual({ outcome: 'unexpected' });
  expect(await notionCredentialTester(proxy, async () => { throw new Error(`${secret} SQL host-path`); }).test(credential, () => secret)).toEqual({ outcome: 'unavailable' });
  expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
});
it.each([undefined, 'https://proxy.example.invalid', 'http://user:password@proxy.example.invalid', 'http://proxy.example.invalid/path', 'http://proxy.example.invalid/?key=value'])('fails closed for absent/unsafe egress before reading bytes or making requests', async url => {
  const f = fixture(); const tester = notionCredentialTester(url, f.fetch);
  expect(tester.ready()).toBe(false);
  expect(await tester.test(credential, f.read)).toEqual({ outcome: 'unavailable' });
  expect(f.read).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
});
it('rejects a different credential type before reading or requesting', async () => {
  const f = fixture();
  expect(await f.tester.test({ ...credential, integration: 'other' }, f.read)).toEqual({ outcome: 'refused' });
  expect(f.read).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
});
it.each(['headers', 'body'] as const)('bounds stalled %s to the single request budget', async where => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => where === 'headers' ? new Promise<Response>(() => {}) : {
    ok: true, status: 200, headers: {}, text: () => new Promise<string>(() => {}),
  });
  const pending = notionCredentialTester(proxy, fetch).test(credential, () => secret);
  await vi.advanceTimersByTimeAsync(NOTION_CREDENTIAL_TIMEOUT_MS);
  expect(await pending).toEqual({ outcome: 'unavailable' }); expect(fetch).toHaveBeenCalledTimes(1);
});
it('pins real transport to the root-selected proxy with no direct fallback', async () => {
  // A local CONNECT refusal exercises real undici wiring without contacting Notion.
  const server = createServer(); const targets: string[] = [];
  server.on('connect', (req, socket) => { targets.push(req.url!); socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect(await notionCredentialTester(url).test(credential, () => secret)).toEqual({ outcome: 'unavailable' });
    expect(targets).toEqual(['api.notion.com:443']);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
it('probe fails local credential preparation rather than claiming live unavailability', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./live/notion-credential.live.mts', import.meta.url)), '--expect', 'unavailable'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, LARES_NOTION_PROBE_APPROVED: '1',
      NOTION_TEST_TOKEN_FILE: '/synthetic-absent-test-key', NOTION_TEST_PROXY_URL: 'http://127.0.0.1:1' },
  });
  expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(result.stderr).toContain('probe refused or failed');
  expect(result.stderr).not.toContain('/synthetic-absent-test-key');
});
it('probe refuses any network use without separate explicit approval', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./live/notion-credential.live.mts', import.meta.url)), '--synthetic-invalid', '--expect', 'refused'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, NOTION_TEST_PROXY_URL: 'http://127.0.0.1:1' },
  });
  expect(result.status).toBe(1); expect(result.stdout).toBe('');
});
it('probe observation separates HTTP evidence from local transport failures without retaining bodies', async () => {
  const events: unknown[] = [];
  const fetch = vi.fn(async () => new Response(JSON.stringify(bot)));
  expect(await notionCredentialTester(proxy, fetch, event => events.push(event)).test(credential, () => secret)).toMatchObject({ outcome: 'passed' });
  expect(events).toEqual([{ kind: 'request' }, { kind: 'response', status: 200 }]);
});
