import { afterEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('@lares/agent-kit/model-purpose-client', () => ({ modelPurposeRequest: requestMock }));

import { claimModelPurposeForInvocation, closeModelPurposeTurn, openModelPurposeTurn, prepareModelPurposeInvocation } from '../agent/lib/model-purpose.js';
import { captureModelInvocation } from '@lares/agent-kit/model-invocation';
import { modelPurposeRequest } from '@lares/agent-kit/model-purpose-client';

const incarnation = '123e4567-e89b-42d3-a456-426614174000';
const receipt = 'r'.repeat(43);
const human = (attributes: Record<string, unknown> = {}) => ({ authenticator: 'lares-console', attributes: {
  lares_member_id: 'member-1', lares_admission_nonce: 'n'.repeat(43), lares_purpose: 'human', ...attributes,
} });
const context = (turnId = 'eve-turn-1', sequence = 1, current: unknown = human(), initiator: unknown = null) => ({
  id: `session-${turnId || 'resume'}`, turn: { id: turnId, sequence }, auth: { current, initiator },
});
const event = (turnId = 'eve-turn-1', sequence = 1) => ({ type: 'turn.started', data: { turnId, sequence } });

afterEach(() => { requestMock.mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('model-purpose Eve turn hooks', () => {
  it('leaves a tagged human turn alone when optional custody is absent', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    const session = context();
    await expect(openModelPurposeTurn(event(), session as never)).resolves.toBeUndefined();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('leaves an authenticated approval-resume turn alone when optional custody is absent', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    const initial = human();
    const resolver = { authenticator: 'lares-console', attributes: {
      lares_resolver_member_id: 'member-1', lares_resume_request_id: 'approval-no-custody',
      lares_resume_option: 'approve', lares_purpose: 'resolver',
    } };
    await expect(openModelPurposeTurn(event('', 0), context('', 0, resolver, initial) as never)).resolves.toBeUndefined();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('opens only the authenticated human receipt and preserves both current and initiator auth', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    requestMock.mockResolvedValue({ capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 });
    const initial = human(), current = { ...initial, attributes: { ...initial.attributes, marker: 'current' } };
    const session = context('human-turn', 3, current, initial);
    session.auth.current.attributes = { ...session.auth.current.attributes, lares_model_purpose_required: '1', lares_model_pending_receipt: receipt };
    await openModelPurposeTurn(event('human-turn', 3), session as never);
    expect(requestMock).toHaveBeenCalledWith('turn.open', expect.objectContaining({
      pendingReceipt: receipt,
      context: { session: expect.objectContaining({ auth: { current, initiator: initial } }) },
    }));
  });

  it('opens an actual empty-id resume once before claiming each automatic step', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    requestMock.mockImplementation(async (op: string) => op === 'turn.open'
      ? { capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 }
      : { claim: 'k'.repeat(43), expiresAt: Date.now() + 30_000 });
    const initial = human();
    const resolver = { authenticator: 'lares-console', attributes: {
      lares_resolver_member_id: 'member-1', lares_resume_request_id: 'approval-1', lares_resume_option: 'approve',
      lares_purpose: 'resolver', lares_model_purpose_required: '1', lares_model_pending_receipt: receipt,
    } };
    // Eve's pinned approval coordinator emits an empty raw turnId but exposes its normalized
    // session turn as turn_1. The adapter must retain the raw step event for Keeper.
    const session = { id: 'session-resume-proof', turn: { id: 'turn_1', sequence: 1 }, auth: { current: resolver, initiator: initial } };
    const step = (stepIndex: number) => ({ type: 'step.started', data: { turnId: '', sequence: 1, stepIndex } });
    prepareModelPurposeInvocation(step(0), session as never);
    const first = captureModelInvocation(step(0), session as never, 'lares-brain');
    await claimModelPurposeForInvocation(first);
    prepareModelPurposeInvocation(step(1), session as never);
    const second = captureModelInvocation(step(1), session as never, 'lares-brain');
    await claimModelPurposeForInvocation(second);

    const calls = requestMock.mock.calls;
    expect(calls.map(([op]) => op)).toEqual(['turn.open', 'step.claim', 'step.claim']);
    expect(calls[0]).toEqual(['turn.open', expect.objectContaining({
      pendingReceipt: receipt,
      context: { session: expect.objectContaining({ id: 'session-resume-proof', turn: { id: '', sequence: 1 }, auth: { current: resolver, initiator: initial } }) },
    })]);
    expect(calls[1]![1]).toMatchObject({ event: step(0), purposeAlias: 'lares-brain' });
    expect(calls[2]![1]).toMatchObject({ event: step(1), purposeAlias: 'lares-brain' });
    await expect(claimModelPurposeForInvocation(first)).rejects.toThrow('fresh trusted model invocation');
    await closeModelPurposeTurn({ type: 'turn.completed', data: { turnId: '', sequence: 1 } }, session as never);
    expect(requestMock).toHaveBeenLastCalledWith('turn.close', { turnCapability: 'c'.repeat(43), turnId: '', sequence: 1 });
  });

  it('follows Eve 0.60.1 approval resume through its real coordinator and chief purpose adapter', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    requestMock.mockImplementation(async (op: string) => {
      if (op === 'request.admit') return { pendingReceipt: receipt, expiresAt: Date.now() + 30_000 };
      if (op === 'turn.open') return { capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 };
      if (op === 'step.claim') return { claim: 'k'.repeat(43), expiresAt: Date.now() + 30_000 };
      return { closed: true };
    });
    const admitted = await modelPurposeRequest<{ pendingReceipt?: string }>('request.admit', { capsule: 'verified-capsule', receipt: { kind: 'resume' } });
    expect(admitted.pendingReceipt).toBe(receipt);

    const eveRoot = new URL('../node_modules/eve/dist/src/', import.meta.url);
    const [{ ContextContainer, contextStorage }, keys, { sessionProvider }, { createToolLoopHarness }] = await Promise.all([
      import(new URL('context/container.js', eveRoot).href),
      import(new URL('context/keys.js', eveRoot).href),
      import(new URL('context/providers/session.js', eveRoot).href),
      import(new URL('harness/tool-loop.js', eveRoot).href),
    ]) as any;
    const initial = human();
    const resolver = { authenticator: 'lares-console', attributes: {
      lares_resolver_member_id: 'member-1', lares_resume_request_id: 'approval-real-eve', lares_resume_option: 'approve',
      lares_purpose: 'resolver', lares_model_purpose_required: '1', lares_model_pending_receipt: admitted.pendingReceipt,
    } };
    const context = new ContextContainer();
    context.set(keys.AuthKey, resolver);
    context.set(keys.InitiatorAuthKey, initial);
    context.set(keys.SessionIdKey, 'session-real-eve-resume');
    const session = {
      agent: { dynamicModel: true, system: '', tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: 'eve:real-resume-proof', history: [], sessionId: 'session-real-eve-resume',
      state: {
        'eve.harness.emission': { sessionStarted: true, sequence: 1, stepIndex: 0, turnId: '' },
        'eve.runtime.pendingInputBatches': [{
          event: { sequence: 0, stepIndex: 0, turnId: 'turn_0' },
          requests: [{ kind: 'tool-approval', requestId: 'approval-real-eve', prompt: 'Fixture',
            options: [{ id: 'approve', label: 'Approve' }, { id: 'cancel', label: 'Cancel' }],
            action: { kind: 'tool-call', callId: 'call-real-eve', toolName: 'fixture', input: {} } }],
          responseMessages: [], responseAuthRequiredRequestIds: ['approval-real-eve'],
        }],
      },
    };
    context.set(keys.SessionKey, sessionProvider.create(context, { state: session.state }).value);
    const events: Array<{ type: string; data?: unknown }> = [];
    let purposeSession: any;
    const harness = createToolLoopHarness({
      mode: 'conversation',
      tools: new Map([['fixture', { description: 'Fixture', inputSchema: { type: 'object' }, approval: { response: async () => ({ status: 'allowed' }) } }]]),
      handleEvent: async (event: { type: string; data?: unknown }) => {
        events.push({ type: event.type, data: event.data });
        if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) {
          await closeModelPurposeTurn(event, purposeSession);
        }
      },
      resolveModel: async () => { throw new Error('No provider expected'); },
      dispatchDynamicModelEvent: async ({ ctx, event }: { ctx: any; event: any }) => {
        const frameworkSession = ctx.get(keys.SessionKey);
        purposeSession = { id: frameworkSession.sessionId, turn: frameworkSession.turn,
          auth: { current: ctx.get(keys.AuthKey), initiator: ctx.get(keys.InitiatorAuthKey) } };
        prepareModelPurposeInvocation(event, purposeSession);
        const invocation = captureModelInvocation(event, purposeSession, 'lares-brain');
        await claimModelPurposeForInvocation(invocation);
        // Stop at Eve's model-selection boundary so this regression makes no provider call.
        throw new Error('Regression stops before model dispatch');
      },
    });
    const input = { attributedInputResponses: [{ auth: resolver, response: { requestId: 'approval-real-eve', optionId: 'approve' } }] };
    const first = await contextStorage.run(context, () => harness(session, input));
    expect(typeof first.next).toBe('function');
    expect(events.map(event => event.type)).toContain('approval.candidate');
    const second = await contextStorage.run(context, () => first.next!(first.session));

    expect(second.next).toMatchObject({ done: true });
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining(['approval.settled', 'input.resolved', 'step.failed', 'turn.failed']));
    expect(purposeSession.turn).toEqual({ id: 'turn_1', sequence: 1 });
    const calls = requestMock.mock.calls;
    expect(calls.map(([op]) => op)).toEqual(['request.admit', 'turn.open', 'step.claim', 'turn.close']);
    expect(calls[1]![1]).toMatchObject({ context: { session: { turn: { id: '', sequence: 1 }, auth: { current: resolver, initiator: initial } } } });
    expect(calls[2]![1]).toMatchObject({ event: { type: 'step.started', data: { turnId: '', sequence: 1, stepIndex: 0 } } });
    expect(calls[3]![1]).toEqual({ turnCapability: 'c'.repeat(43), turnId: '', sequence: 1 });
    expect(() => prepareModelPurposeInvocation({ type: 'step.started', data: { turnId: '', sequence: 1, stepIndex: 0 } }, purposeSession)).toThrow('Model purpose authority');
  });

  it('tombstones a marked resume closed while model authority verification is pending', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    const initial = human();
    const resolver = { authenticator: 'lares-console', attributes: {
      lares_resolver_member_id: 'member-1', lares_resume_request_id: 'approval-preverify', lares_resume_option: 'approve',
      lares_purpose: 'resolver', lares_model_purpose_required: '1', lares_model_pending_receipt: receipt,
    } };
    const session = { id: 'session-preverify-proof', turn: { id: 'turn_1', sequence: 1 }, auth: { current: resolver, initiator: initial } };
    const step = { type: 'step.started', data: { turnId: '', sequence: 1, stepIndex: 0 } };
    prepareModelPurposeInvocation(step, session as never);
    await closeModelPurposeTurn({ type: 'turn.failed', data: { turnId: '', sequence: 1 } }, session as never);
    const invocation = captureModelInvocation(step, session as never, 'lares-brain');
    await expect(claimModelPurposeForInvocation(invocation)).rejects.toThrow('Model purpose authority');
    expect(requestMock).not.toHaveBeenCalled();
    expect(() => prepareModelPurposeInvocation(step, session as never)).toThrow('Model purpose authority');
  });

  it('refuses a claim when resolver identity or pending receipt changed after reservation', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    const initial = human();
    const resolver = { authenticator: 'lares-console', attributes: {
      lares_resolver_member_id: 'member-1', lares_resume_request_id: 'approval-bound', lares_resume_option: 'approve',
      lares_purpose: 'resolver', lares_model_purpose_required: '1', lares_model_pending_receipt: receipt,
    } };
    const session = { id: 'session-binding-proof', turn: { id: 'turn_1', sequence: 1 }, auth: { current: resolver, initiator: initial } };
    const step = { type: 'step.started', data: { turnId: '', sequence: 1, stepIndex: 0 } };
    prepareModelPurposeInvocation(step, session as never);
    const changed = structuredClone(session);
    changed.auth.current.attributes.lares_resume_request_id = 'approval-other';
    changed.auth.current.attributes.lares_model_pending_receipt = 's'.repeat(43);
    const invocation = captureModelInvocation(step, changed as never, 'lares-brain');
    await expect(claimModelPurposeForInvocation(invocation)).rejects.toThrow('Model purpose authority');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('closes a resolver reservation before a delayed open ACK can revive it', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    let acknowledge!: (value: { capability: string; expiresAt: number }) => void;
    requestMock.mockImplementation((op: string) => op === 'turn.open'
      ? new Promise(resolve => { acknowledge = resolve; })
      : Promise.resolve({ claim: 'k'.repeat(43), expiresAt: Date.now() + 30_000 }));
    const initial = human();
    const resolver = { authenticator: 'lares-console', attributes: {
      lares_resolver_member_id: 'member-1', lares_resume_request_id: 'approval-late-open', lares_resume_option: 'approve',
      lares_purpose: 'resolver', lares_model_purpose_required: '1', lares_model_pending_receipt: receipt,
    } };
    const session = { id: 'session-late-resume-proof', turn: { id: 'turn_1', sequence: 1 }, auth: { current: resolver, initiator: initial } };
    const step = { type: 'step.started', data: { turnId: '', sequence: 1, stepIndex: 0 } };
    prepareModelPurposeInvocation(step, session as never);
    const invocation = captureModelInvocation(step, session as never, 'lares-brain');
    const claiming = claimModelPurposeForInvocation(invocation);
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledWith('turn.open', expect.anything()));
    await closeModelPurposeTurn({ type: 'turn.failed', data: { turnId: '', sequence: 1 } }, session as never);
    acknowledge({ capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 });
    await expect(claiming).rejects.toThrow('Model purpose authority');
    expect(requestMock).toHaveBeenCalledWith('turn.close', { turnCapability: 'c'.repeat(43), turnId: '', sequence: 1 });
  });

  it('refuses to claim after the Keeper turn lease has expired', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    const base=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(base);
    requestMock.mockResolvedValue({ capability: 'c'.repeat(43), expiresAt: base + 10 });
    const auth=human({ lares_model_purpose_required:'1', lares_model_pending_receipt:receipt });
    const session=context('leased-turn', 4, auth);
    await openModelPurposeTurn(event('leased-turn',4),session as never);
    clock.mockReturnValue(base+11);
    await expect(claimModelPurposeForInvocation({session,event:{type:'step.started',data:{turnId:'leased-turn',sequence:4,stepIndex:0}},alias:'validated-alias'} as never)).rejects.toThrow('Model purpose authority');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('burns a late open acknowledgement before it can revive a closed or duplicate event', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    let acknowledge!: (value: { capability: string; expiresAt: number }) => void;
    requestMock.mockImplementation((op: string) => op === 'turn.open'
      ? new Promise(resolve => { acknowledge = resolve; })
      : Promise.resolve({ closed: true }));
    const session = context('late-turn', 9, human({ lares_model_purpose_required: '1', lares_model_pending_receipt: receipt }));
    const opening = openModelPurposeTurn(event('late-turn', 9), session as never);
    await closeModelPurposeTurn(event('late-turn', 9), session as never);
    acknowledge({ capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 });
    await expect(opening).rejects.toThrow('Model purpose authority');
    expect(requestMock).toHaveBeenCalledWith('turn.close', { turnCapability: 'c'.repeat(43), turnId: 'late-turn', sequence: 9 });
    await expect(openModelPurposeTurn(event('late-turn', 9), session as never)).rejects.toThrow('Model purpose authority');
  });
});
