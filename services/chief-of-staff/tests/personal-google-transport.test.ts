/** Actual installed OAuth2Client/Gaxios + Gmail SDK, fake fetch only. No provider traffic.
 * Unlike the catalogue API factory fixtures, these exercise real refresh retry config,
 * option preparation and abort handling at the transport boundary.
 */
import { describe, expect, it, vi } from 'vitest';
import { google } from 'googleapis';
import { buildOAuth2Client } from '@lares/agent-kit/google-auth';
import { bindPersonalGoogleDeadline } from '../lib/google.js';
const tokenResponse = () => new Response(JSON.stringify({ access_token: 'fixture-access', expires_in: 3600 }), {
  status: 200, headers: { 'content-type': 'application/json' },
});
function setup(signal: AbortSignal, fetchImplementation: typeof fetch) {
  const auth = buildOAuth2Client({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }, 'fixture-refresh');
  // These conflicting defaults reproduce settings the SDK may supply on individual calls.
  auth.transporter.defaults = { ...auth.transporter.defaults, fetchImplementation, timeout: 15_000, retry: true };
  bindPersonalGoogleDeadline(auth, signal);
  const gmail = google.gmail({ version: 'v1', auth, timeout: 15_000, retry: true });
  return { auth, gmail };
}

describe('personal Google transport shared deadline using the actual SDK', () => {
  it('refuses a pre-aborted deadline before fetch, including token refresh', async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>(async () => tokenResponse());
    const { gmail } = setup(controller.signal, fetcher);
    await expect(gmail.users.messages.list({ userId: 'me', maxResults: 1 })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not retry a refresh 503 despite OAuth RETRY_CONFIG', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const { gmail } = setup(new AbortController().signal, fetcher);
    await expect(gmail.users.messages.list({ userId: 'me', maxResults: 1 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not start Gmail if the shared deadline expires after successful refresh', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => tokenResponse());
    const { auth, gmail } = setup(controller.signal, fetcher);
    await auth.getAccessToken(); controller.abort();
    await expect(gmail.users.messages.list({ userId: 'me', maxResults: 1 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['refresh', 'gmail'] as const)('aborts in-flight %s and waits for transport settlement without a retry', async stage => {
    const controller = new AbortController();
    let entered!: () => void, transportSettled = false;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      signals.push(options?.signal);
      if (stage === 'gmail' && signals.length === 1) return tokenResponse();
      return new Promise<Response>((_resolve, reject) => {
        entered();
        options!.signal!.addEventListener('abort', () => {
          transportSettled = true; reject(options!.signal!.reason);
        }, { once: true });
      });
    });
    const { gmail } = setup(controller.signal, fetcher);
    const running = gmail.users.messages.list({ userId: 'me', maxResults: 1 });
    const refusal = expect(running).rejects.toThrow();
    await ready; controller.abort(); await refusal;
    expect(transportSettled).toBe(true);
    expect(signals.every(signal => signal === controller.signal)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(stage === 'refresh' ? 1 : 2);
  });
  it('does not retry a timed-out refresh after the shared deadline expires', async () => {
    const signal = AbortSignal.timeout(30);
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      expect(options!.signal).toBe(signal);
      options!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('fixture timeout'), {
        code: 'TimeoutError',
      })), { once: true });
    }));
    const { auth } = setup(signal, fetcher);
    await expect(auth.getAccessToken()).rejects.toThrow();
    expect(signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry a Gmail 503 after successful refresh', async () => {
    let count = 0;
    const fetcher = vi.fn<typeof fetch>(async () => ++count === 1 ? tokenResponse() : new Response('{}', {
      status: 503, headers: { 'content-type': 'application/json' },
    }));
    const { gmail } = setup(new AbortController().signal, fetcher);
    await expect(gmail.users.messages.list({ userId: 'me', maxResults: 1 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
