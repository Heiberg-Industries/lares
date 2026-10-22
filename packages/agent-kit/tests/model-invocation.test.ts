import { afterEach, describe, expect, it, vi } from 'vitest';
const { purposeRequest } = vi.hoisted(() => ({ purposeRequest: vi.fn() }));
vi.mock('../src/model-purpose-client.js', () => ({ modelPurposeRequest: purposeRequest }));
import { generateText } from 'ai';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureModelInvocation, claimModelDispatch, currentModelInvocation, currentModelPurposeClaim, requestAndAttachModelPurposeClaim, runModelInvocation } from '../src/model-invocation.js';
import { createGatewayProvider, type GatewayLane } from '../src/gateway-provider.js';
import { guardDefinitionModel, refuseModelCompaction } from '../src/definition-model.js';

const event = { type: 'step.started', data: { turnId: 'turn', sequence: 1, stepIndex: 2 } };
const session = () => ({ id: 'session', auth: { current: { authenticator: 'fixture', principalId: 'fixture-person', principalType: 'user' as const, attributes: { actor: 'original' } }, initiator: null } });
const capture = () => captureModelInvocation({ ...event, data: { ...event.data, turnId: randomUUID() } }, session(), 'fixture-brain');
afterEach(() => { purposeRequest.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('attaches only a Keeper-verified claim to the captured invocation and stops exposing it when the turn closes', async () => {
  purposeRequest.mockResolvedValue({ claim: 'c'.repeat(43), expiresAt: Date.now() + 30_000 });
  const invocation = captureModelInvocation(event, session(), 'validated-session-alias');
  let active = true;
  await requestAndAttachModelPurposeClaim(invocation, 't'.repeat(43), () => active);
  expect(purposeRequest).toHaveBeenCalledWith('step.claim', expect.objectContaining({ purposeAlias: 'validated-session-alias', event }));
  await runModelInvocation(invocation, async () => {
    expect(currentModelPurposeClaim()).toEqual({ claim: 'c'.repeat(43), expiresAt: expect.any(Number) });
    active = false;
    expect(currentModelPurposeClaim()).toBeUndefined();
  });
  expect('setModelPurposeClaim' in await import('../src/model-invocation.js')).toBe(false);
});

it('rejects an expired Keeper acknowledgement before attaching its claim', async () => {
  purposeRequest.mockResolvedValue({ claim: 'c'.repeat(43), expiresAt: Date.now() - 1 });
  const invocation = capture();
  await expect(requestAndAttachModelPurposeClaim(invocation, 't'.repeat(43), () => true)).rejects.toThrow('fresh trusted');
  await runModelInvocation(invocation, async () => expect(currentModelPurposeClaim()).toBeUndefined());
});

it('stops exposing an attached claim as soon as its lease expires', async () => {
  const base = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
  purposeRequest.mockResolvedValue({ claim: 'c'.repeat(43), expiresAt: base + 100 });
  const invocation = capture();
  await requestAndAttachModelPurposeClaim(invocation, 't'.repeat(43), () => true);
  await runModelInvocation(invocation, async () => {
    expect(currentModelPurposeClaim()).toEqual({ claim: 'c'.repeat(43), expiresAt: base + 100 });
    clock.mockReturnValue(base + 101);
    expect(currentModelPurposeClaim()).toBeUndefined();
  });
});

it('clones and recursively freezes exact event and auth without replacing actor by resolver', async () => {
  const ctx = session();
  const actual = { ...event, data: { ...event.data, turnId: randomUUID() } };
  const invocation = captureModelInvocation(actual, ctx, 'fixture-brain');
  ctx.auth.current.attributes.actor = 'changed';
  expect(invocation.session.auth.current?.attributes).toEqual({ actor: 'original' });
  expect(Object.isFrozen(invocation.session.auth.current?.attributes)).toBe(true);
  expect(Object.isFrozen(invocation.event.data)).toBe(true);
  expect(currentModelInvocation()).toBeUndefined();
  await runModelInvocation(invocation, async () => {
    await Promise.resolve();
    expect(currentModelInvocation()).toBe(invocation);
    expect(claimModelDispatch()).toBe(invocation);
    expect(() => claimModelDispatch()).toThrow('fresh trusted');
  });
  expect(currentModelInvocation()).toBeUndefined();
  expect(() => runModelInvocation(invocation, async () => undefined)).toThrow('fresh trusted');
});

it('does not mint a fresh claim when the same event is resolved into another model', async () => {
  const selected = { ...event, data: { ...event.data, turnId: randomUUID() } };
  const first = captureModelInvocation(selected, session(), 'fixture-brain');
  await runModelInvocation(first, async () => claimModelDispatch());
  const reconstructed = captureModelInvocation(selected, session(), 'changed-alias');
  expect(() => runModelInvocation(reconstructed, async () => claimModelDispatch())).toThrow('fresh trusted');
});

it('preserves Eve’s exact empty approval-continuation turn id without rearming its tuple', async () => {
  const actual = { type: 'step.started', data: { turnId: '', sequence: 9, stepIndex: 0 } };
  const authenticated = { id: 'approval-session', auth: { initiator: null, current: {
    authenticator: 'lares-console', principalId: 'fixture-member', principalType: 'user' as const,
    attributes: { lares_purpose: 'resolver', lares_resume_request_id: 'fixture-request', lares_resume_option: 'approve' },
  } } };
  const selected = captureModelInvocation(actual, authenticated, 'fixture-brain');
  expect(selected.event).toEqual(actual);
  await runModelInvocation(selected, async () => { expect(claimModelDispatch()).toBe(selected); });
  const duplicate = captureModelInvocation(actual, authenticated, 'fixture-brain');
  expect(() => runModelInvocation(duplicate, async () => claimModelDispatch())).toThrow('fresh trusted');
});

it('rejects missing/malformed framework event and incomplete session before execution', () => {
  for (const invalid of [undefined, {}, { type: 'turn.started', data: event.data },
    { ...event, data: { ...event.data, turnId: undefined } }, { ...event, data: { ...event.data, turnId: '   ' } }, { ...event, data: { ...event.data, sequence: -1 } },
    { ...event, data: { ...event.data, stepIndex: 0.5 } }]) {
    expect(() => captureModelInvocation(invalid, session(), 'fixture-brain')).toThrow('fresh trusted');
  }
  expect(() => captureModelInvocation(event, undefined, 'fixture-brain')).toThrow('fresh trusted');
  expect(() => captureModelInvocation(event, { id: 'session' } as never, 'fixture-brain')).toThrow('fresh trusted');
  expect(() => claimModelDispatch()).toThrow('fresh trusted');
});

it('keeps concurrent sessions isolated across awaited work and does not rearm after failure', async () => {
  const a = capture(), b = captureModelInvocation({ ...event, data: { ...event.data, turnId: 'other' } }, { ...session(), id: 'other' }, 'other');
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  await Promise.all([
    runModelInvocation(a, async () => { await gate; expect(claimModelDispatch()).toBe(a); }),
    runModelInvocation(b, async () => { expect(claimModelDispatch()).toBe(b); release(); }),
  ]);
  const failed = capture();
  await expect(runModelInvocation(failed, async () => { claimModelDispatch(); throw new Error('lost response'); })).rejects.toThrow('lost response');
  expect(() => runModelInvocation(failed, async () => claimModelDispatch())).toThrow('fresh trusted');
  expect(() => runModelInvocation({ ...capture() }, async () => claimModelDispatch())).toThrow('fresh trusted');
});

it('refuses whenever the awaited compaction event reaches its authored hook', () => {
  expect(() => refuseModelCompaction()).toThrow('compaction requires a fresh trusted invocation');
});

for (const lane of ['anthropic', 'openai-compatible'] satisfies GatewayLane[]) {
  describe(lane, () => {
    it('refuses HTTP redirects without dispatching the body to their destination', async () => {
      let initial = 0, redirected = 0;
      const server = createServer((request, response) => {
        if (request.url === '/redirect-target') { redirected++; response.end('{}'); return; }
        initial++;
        response.writeHead(307, { location: '/redirect-target' }); response.end();
      });
      const dir = mkdtempSync(join(tmpdir(), 'invocation-redirect-'));
      try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Fixture has no port');
        writeFileSync(join(dir, 'key'), 'fixture-only');
        vi.stubEnv('GATEWAY_LANE', lane);
        vi.stubEnv('GATEWAY_URL', `http://127.0.0.1:${address.port}`);
        const provider = createGatewayProvider({ defaultKeyFile: join(dir, 'key') });
        const model = guardDefinitionModel(provider.gatewayModel('fixture-brain'), async () => undefined, capture());
        await expect(generateText({ model, prompt: 'redirect canary', maxRetries: 2 })).rejects.toThrow();
        expect(initial).toBe(1);
        expect(redirected).toBe(0);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('refuses unscoped requests and dispatches once across SDK retry attempts', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'invocation-'));
      try {
        writeFileSync(join(dir, 'key'), 'fixture-only');
        vi.stubEnv('GATEWAY_LANE', lane);
        const provider = createGatewayProvider({ defaultKeyFile: join(dir, 'key') });
        const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'fixture transient', type: 'overloaded_error' } }), { status: 503, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetch);
        await expect(generateText({ model: provider.gatewayModel('fixture-brain'), prompt: 'unscoped', maxRetries: 0 })).rejects.toThrow('fresh trusted');
        expect(fetch).not.toHaveBeenCalled();
        const wrapped = guardDefinitionModel(provider.gatewayModel('fixture-brain'), async () => undefined, capture());
        await expect(generateText({ model: wrapped, prompt: 'scoped', maxRetries: 2 })).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
        await expect(generateText({ model: wrapped, prompt: 'retry', maxRetries: 0 })).rejects.toThrow('fresh trusted');
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
}
