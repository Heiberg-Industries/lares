import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayRawRequestHash } from '../src/gateway-admission-protocol.js';

const transport = vi.hoisted(() => ({ request: vi.fn(), dispatch: vi.fn() }));
vi.mock('../src/model-purpose-client.js', () => ({
  modelPurposeRequest: transport.request,
  modelPurposeDispatchRequest: transport.dispatch,
  MODEL_PURPOSE_DISPATCH_BODY_MAX: 8 * 1024 * 1024,
}));

import { currentOwnerJob, dispatchOwnerJob, hasOwnerJob, prepareOwnerJobIntent, withOwnerJob } from '../src/owner-job.js';

beforeEach(() => {
  transport.request.mockReset();
  transport.dispatch.mockReset();
  transport.request.mockResolvedValue({ ticket: 'T'.repeat(43), expiresAt: Date.now() + 15_000 });
  transport.dispatch.mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('owner-job context', () => {
  it('is only present inside withOwnerJob and carries the requested alias', async () => {
    expect(hasOwnerJob()).toBe(false);
    await withOwnerJob('lares-utility', async () => {
      expect(hasOwnerJob()).toBe(true);
      expect(currentOwnerJob()).toEqual({ alias: 'lares-utility' });
    });
    expect(currentOwnerJob()).toBeUndefined();
  });

  it.each(['', 'Upper', 'has space', '-lead', 'x'.repeat(80)])('refuses the alias %j', alias => {
    expect(() => withOwnerJob(alias, async () => undefined)).toThrow('Owner job authority is not available');
  });
});

describe('owner-job tickets', () => {
  it('asks Keeper for a job.consume ticket naming only the alias and the exact request', async () => {
    const body = Buffer.from('{"model":"lares-embed","input":["a"]}');
    const ticket = await prepareOwnerJobIntent('lares-embed', 'POST', '/v1/embeddings', body);
    expect(ticket.ticket).toBe('T'.repeat(43));
    expect(transport.request).toHaveBeenCalledWith('job.consume', {
      alias: 'lares-embed',
      request: { method: 'POST', path: '/v1/embeddings', requestHash: gatewayRawRequestHash('POST', '/v1/embeddings', body) },
    });
  });

  it('refuses a malformed or expired answer', async () => {
    transport.request.mockResolvedValueOnce({ ticket: 'short', expiresAt: Date.now() + 5000 });
    await expect(prepareOwnerJobIntent('lares-embed', 'POST', '/v1/embeddings', Buffer.from('{}'))).rejects.toThrow('Owner job authority');
    transport.request.mockResolvedValueOnce({ ticket: 'T'.repeat(43), expiresAt: Date.now() - 1 });
    await expect(prepareOwnerJobIntent('lares-embed', 'POST', '/v1/embeddings', Buffer.from('{}'))).rejects.toThrow('Owner job authority');
  });

  it('dispatches the same bytes with the ticket and strips any credential header', async () => {
    const body = Buffer.from('{"model":"lares-utility"}');
    await dispatchOwnerJob({ alias: 'lares-utility', path: '/v1/messages', rawBody: body, headers: { 'x-api-key': 'k', authorization: 'Bearer k', accept: 'application/json' } });
    const sent = transport.dispatch.mock.calls[0]![0];
    expect(sent).toMatchObject({ ticket: 'T'.repeat(43), path: '/v1/messages', method: 'POST' });
    expect(Buffer.from(sent.rawBody)).toEqual(body);
    const headers = new Headers(sent.headers);
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('accept')).toBe('application/json');
  });

  it('never dispatches when the ticket is refused', async () => {
    transport.request.mockRejectedValueOnce(new Error('Model purpose authority is not available'));
    await expect(dispatchOwnerJob({ alias: 'lares-utility', path: '/v1/messages', rawBody: Buffer.from('{}') })).rejects.toThrow();
    expect(transport.dispatch).not.toHaveBeenCalled();
  });
});
