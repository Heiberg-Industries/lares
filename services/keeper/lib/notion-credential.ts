import { Client, isHTTPResponseError, isNotionClientError, ClientErrorCode } from '@notionhq/client';
import { defineCredentialType, runCredentialTest, type ApiKeyCredential, type CredentialTestResult } from '@lares/agent-kit/credential';
import type { Requester } from '@lares/agent-kit/request';
import { ProxyAgent, fetch as proxyFetch } from 'undici';
import { z } from 'zod';

export const NOTION_CREDENTIAL_ENDPOINT = 'https://api.notion.com/v1/users/me';
export const NOTION_CREDENTIAL_VERSION = Client.defaultNotionVersion;
// Below the keeper client's 10s budget, including response-body consumption. No retries.
export const NOTION_CREDENTIAL_TIMEOUT_MS = 5_000;
type NotionFetch = NonNullable<NonNullable<ConstructorParameters<typeof Client>[0]>['fetch']>;
export type NotionCredentialOutcome = 'passed' | 'refused' | 'rate-limited' | 'unavailable' | 'unexpected';
export interface NotionCredentialEvidence {
  outcome: NotionCredentialOutcome;
  identity?: { kind: 'internal-bot'; botId: string };
}
export interface NotionCredentialTester {
  ready(): boolean;
  test(credential: ApiKeyCredential, readSecret: () => string): Promise<NotionCredentialEvidence>;
}
const user = z.object({ object: z.literal('user'), id: z.uuid(), type: z.literal('bot'),
  bot: z.object({ owner: z.object({ type: z.literal('workspace'), workspace: z.literal(true) }) }),
});
const unexpected = (): CredentialTestResult => ({ ok: false, kind: 'down', message: 'unexpected' });
function failure(error: unknown): CredentialTestResult {
  if (isHTTPResponseError(error)) {
    if (error.status === 401 || error.status === 403) return { ok: false, kind: 'not_authorised', message: 'refused' };
    if (error.status === 429) return { ok: false, kind: 'rate_limited', message: 'rate-limited' };
    if (error.status === 408 || error.status >= 500 && error.status <= 599) return { ok: false, kind: 'down', message: 'unavailable' };
    return unexpected();
  }
  if (error instanceof SyntaxError) return unexpected();
  if (isNotionClientError(error) && error.code !== ClientErrorCode.RequestTimeout) return unexpected();
  return { ok: false, kind: 'down', message: 'unavailable' };
}
// CredentialType's request dependency is for SDK-less vendors (ADR-0019). The official SDK
// owns this read; this guard ensures no second request path is accidentally introduced.
const noRequest: Requester = {
  json: async () => { throw new Error('SDK required'); },
  raw: async () => { throw new Error('SDK required'); },
};

/** File-reference credentials only. Read bytes only at explicit test time. Status has no
 * provider dependency. Missing root-selected proxy configuration fails closed. */
export function notionCredentialTester(proxyUrl: string | undefined, fetch?: NotionFetch,
  observe?: (event: { kind: 'request' } | { kind: 'response'; status: number }) => void): NotionCredentialTester {
  const ready = () => {
    try {
      const url = new URL(proxyUrl!);
      return url.protocol === 'http:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    } catch { return false; }
  };
  return { ready, async test(credential, readSecret) {
    if (!ready()) return { outcome: 'unavailable' };
    const controller = new AbortController();
    const proxy = fetch ? undefined : new ProxyAgent({ uri: proxyUrl!, proxyTunnel: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const type = defineCredentialType<ApiKeyCredential>({ kind: 'api_key',
        validate: c => c.kind === 'api_key' && c.integration === 'notion' && !!c.secretFile ? [] : ['Invalid credential reference'],
        async test(c) {
          if (this.validate(c).length) return { ok: false, kind: 'not_authorised', message: 'refused' };
          try {
            const client = new Client({ auth: readSecret(), notionVersion: NOTION_CREDENTIAL_VERSION,
              timeoutMs: NOTION_CREDENTIAL_TIMEOUT_MS, retry: false, logger: () => {},
              fetch: async (url, init) => {
                // No redirects, arbitrary hosts, extra methods or second requests.
                if (url !== NOTION_CREDENTIAL_ENDPOINT || init?.method !== 'GET') throw new SyntaxError('Unexpected request');
                observe?.({ kind: 'request' });
                if (fetch) {
                  const response = await fetch(url, init);
                  observe?.({ kind: 'response', status: response.status });
                  return response;
                }
                const response = await proxyFetch(url, { ...init, body: undefined, dispatcher: proxy,
                  signal: controller.signal, redirect: 'error' });
                observe?.({ kind: 'response', status: response.status });
                return { ok: response.ok, status: response.status, headers: response.headers,
                  text: async () => {
                    // users.me is small. Bound memory and never retain a raw response body.
                    const chunks: Buffer[] = []; let size = 0;
                    if (response.body) for await (const part of response.body) {
                      size += part.byteLength;
                      if (size > 65_536) { controller.abort(); throw new SyntaxError('Unexpected response'); }
                      chunks.push(Buffer.from(part));
                    }
                    return Buffer.concat(chunks).toString('utf8');
                  },
                };
              },
            });
            const response: unknown = await client.users.me({});
            const parsed = user.safeParse(response);
            if (!parsed.success) {
              const kind = z.object({ object: z.literal('user'), type: z.enum(['person', 'bot']),
                bot: z.object({ owner: z.object({ type: z.enum(['user', 'workspace']) }) }).optional(),
              }).safeParse(response);
              if (kind.success && (kind.data.type === 'person' || kind.data.bot?.owner.type === 'user'))
                return { ok: false, kind: 'not_authorised', message: 'refused' };
              return unexpected();
            }
            // No provider-controlled names, emails or bodies cross the boundary.
            return { ok: true, identity: parsed.data.id };
          } catch (error) { return failure(error); }
        },
      });
      const timeout = new Promise<CredentialTestResult>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ ok: false, kind: 'down', message: 'unavailable' }); }, NOTION_CREDENTIAL_TIMEOUT_MS);
      });
      const result = await Promise.race([runCredentialTest(type, credential, { request: noRequest }), timeout]);
      if (result.ok && z.uuid().safeParse(result.identity).success)
        return { outcome: 'passed', identity: { kind: 'internal-bot', botId: result.identity! } };
      // Never expose the shared abstraction's fallback exception message.
      if (!result.ok && result.kind === 'not_authorised') return { outcome: 'refused' };
      if (!result.ok && result.kind === 'rate_limited') return { outcome: 'rate-limited' };
      return { outcome: !result.ok && result.message === 'unexpected' ? 'unexpected' : 'unavailable' };
    } finally {
      clearTimeout(timer);
      controller.abort();
      // destroy aborts sockets; close could wait beyond the keeper transport budget.
      if (proxy) void proxy.destroy().catch(() => {});
    }
  } };
}
