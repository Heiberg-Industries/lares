import { afterEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('@lares/agent-kit/model-purpose-client', () => ({ modelPurposeRequest: requestMock }));
// The real model resolver keeps its pinned alias in eve session state and reads the stream
// position off eve's session view; both exist only inside a live eve step. An in-memory store
// and a view that carries its own position stand in. The private-console checks read the
// database and are another module's subject.
const sessionState = vi.hoisted(() => new Map<string, unknown>());
vi.mock('eve/context', () => ({ defineState: (key: string, initial: () => unknown) => ({
  get: () => (sessionState.has(key) ? sessionState.get(key) : initial()),
  update: (fn: (value: unknown) => unknown) => { sessionState.set(key, fn(sessionState.has(key) ? sessionState.get(key) : initial())); },
}) }));
vi.mock('eve/events', async (actual) => ({ ...(await actual<typeof import('eve/events')>()), position: (view: { line: number }) => view.line }));
vi.mock('@lares/agent-kit/private-console-surface', () => ({ verifyPrivateConsoleModel: async () => undefined, verifyPrivateConsoleSession: async () => true }));

import { claimModelPurposeForInvocation, closeModelPurposeTurn, openModelPurposeTurn, prepareModelPurposeInvocation } from '../agent/lib/model-purpose.js';
import { captureModelInvocation } from '@lares/agent-kit/model-invocation';

const incarnation = '123e4567-e89b-42d3-a456-426614174000';
const receipt = 'r'.repeat(43);
const human = (attributes: Record<string, unknown> = {}) => ({ authenticator: 'lares-console', attributes: {
  lares_member_id: 'member-1', lares_admission_nonce: 'n'.repeat(43), lares_purpose: 'human', ...attributes,
} });
const context = (turnId = 'eve-turn-1', sequence = 1, current: unknown = human(), initiator: unknown = null) => ({
  id: `session-${turnId || 'resume'}`, turn: { id: turnId, sequence }, auth: { current, initiator },
});
const event = (turnId = 'eve-turn-1', sequence = 1) => ({ type: 'turn.started', data: { turnId, sequence } });

afterEach(() => { requestMock.mockReset(); sessionState.clear(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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
    current.attributes = { ...current.attributes, lares_model_purpose_required: '1', lares_model_pending_receipt: receipt } as typeof current.attributes;
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
    // eve 0.60.1's approval coordinator emitted an empty raw turnId while its session turn read
    // turn_1 (eve 1.0 does not). The adapter still retains the exact coordinates it is given.
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

  // eve 1.0's own turn events carry `turnId` and no `sequence`; the hook's session context
  // carries the framework's turn. eve mints the id as `turn_<sequence>`.
  it('opens and closes a human turn from eve 1.0 turn events, which carry no sequence', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    requestMock.mockImplementation(async (op: string) => op === 'turn.open'
      ? { capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 } : { closed: true });
    const auth = human({ lares_model_purpose_required: '1', lares_model_pending_receipt: receipt });
    const session = { id: 'session-v27-human', turn: { id: 'turn_3', sequence: 3 }, auth: { current: auth, initiator: auth } };
    await openModelPurposeTurn({ type: 'turn.started', data: { turnId: 'turn_3', cause: { deliveryId: 'delivery_3' }, follows: 'turn_2' } }, session as never);
    expect(requestMock).toHaveBeenLastCalledWith('turn.open', expect.objectContaining({
      context: { session: expect.objectContaining({ id: 'session-v27-human', turn: { id: 'turn_3', sequence: 3 } }) },
    }));
    // When the turn has settled, the hook's own session turn may already describe the next one:
    // the position is taken from the event's turn id alone.
    const after = { ...session, turn: { id: 'turn_4', sequence: 4 } };
    await closeModelPurposeTurn({ type: 'turn.settled', data: { turnId: 'turn_3', outcome: 'completed' } }, after as never);
    expect(requestMock).toHaveBeenLastCalledWith('turn.close', { turnCapability: 'c'.repeat(43), turnId: 'turn_3', sequence: 3 });
  });

  it('refuses a turn whose position cannot be read or does not agree with the framework context', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    const auth = human({ lares_model_purpose_required: '1', lares_model_pending_receipt: receipt });
    const started = (turnId: string) => ({ type: 'turn.started', data: { turnId, cause: { deliveryId: 'delivery' }, follows: null } });
    const session = (id: string, turn: unknown) => ({ id, turn, auth: { current: auth, initiator: auth } });
    // An id eve does not mint, with no sequence beside it.
    await expect(openModelPurposeTurn(started('not-an-eve-turn'), session('s-shape', { id: 'not-an-eve-turn', sequence: 0 }) as never)).rejects.toThrow('Model purpose authority');
    // The id says turn 5; the framework context says another turn.
    await expect(openModelPurposeTurn(started('turn_5'), session('s-disagree', { id: 'turn_6', sequence: 6 }) as never)).rejects.toThrow('Model purpose authority');
    await expect(openModelPurposeTurn(started('turn_5'), session('s-sequence', { id: 'turn_5', sequence: 4 }) as never)).rejects.toThrow('Model purpose authority');
    // No framework turn at all.
    await expect(openModelPurposeTurn(started('turn_5'), session('s-missing', undefined) as never)).rejects.toThrow('Model purpose authority');
    expect(requestMock).not.toHaveBeenCalled();
  });

  // This replaces a test that drove eve 0.60.1's internal tool loop
  // (`dist/src/harness/tool-loop.js`, gone in 1.0) through an approval resume. What it pinned
  // still holds on 1.0 shapes, proven here through the REAL model resolver and the real chief
  // adapter: a purpose-bound approval resume is reserved before verification, opened once on
  // Keeper, claimed per model call under the coordinates read off eve's session view, and
  // closed by the turn's own settle event. Driving eve's own runtime through an approval needs
  // a built agent; that proof belongs to the packet that can run one.
  it('follows an eve 1.0 approval resume through the real model resolver and the chief purpose adapter', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    requestMock.mockImplementation(async (op: string) => {
      if (op === 'turn.open') return { capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 };
      if (op === 'step.claim') return { claim: 'k'.repeat(43), expiresAt: Date.now() + 30_000 };
      return { closed: true };
    });
    const initial = human();
    const resolver = { authenticator: 'lares-console', attributes: {
      lares_resolver_member_id: 'member-1', lares_resume_request_id: 'approval-eve-1', lares_resume_option: 'approve',
      lares_purpose: 'resolver', lares_model_purpose_required: '1', lares_model_pending_receipt: receipt,
    } };
    const { definitionModelResolver } = await import('@lares/agent-kit/definition-model');
    const order: string[] = [];
    const select = definitionModelResolver({
      resolveAlias: async () => { order.push('definition'); return 'lares-brain'; },
      preparePurpose: (event, session) => { prepareModelPurposeInvocation(event, session as never); order.push('reserved'); },
      claimPurpose: async (invocation) => { await claimModelPurposeForInvocation(invocation); order.push('claimed'); },
      provider: () => ({ specificationVersion: 'v3', provider: 'fixture', modelId: 'lares-brain' }) as never,
    });
    // What eve 1.0 hands a dynamic model: the session (id and both authentications), the latest
    // turn, and the session view. The answered approval continues turn_1.
    const modelContext = (line: number) => ({
      session: { id: 'session-eve-1-resume', auth: { current: resolver, initiator: initial } },
      turn: { id: 'turn_1', status: 'paused', input: [] }, view: { line },
    }) as never;
    await select(modelContext(14));
    await select(modelContext(19));
    expect(order).toEqual(['reserved', 'definition', 'claimed', 'reserved', 'claimed']);

    const calls = requestMock.mock.calls;
    expect(calls.map(([op]) => op)).toEqual(['turn.open', 'step.claim', 'step.claim']);
    expect(calls[0]![1]).toMatchObject({ pendingReceipt: receipt,
      context: { session: { id: 'session-eve-1-resume', turn: { id: 'turn_1', sequence: 1 }, auth: { current: resolver, initiator: initial } } } });
    expect(calls[1]![1]).toMatchObject({ purposeAlias: 'lares-brain', event: { type: 'step.started', data: { turnId: 'turn_1', sequence: 1, stepIndex: 14 } } });
    expect(calls[2]![1]).toMatchObject({ purposeAlias: 'lares-brain', event: { type: 'step.started', data: { turnId: 'turn_1', sequence: 1, stepIndex: 19 } } });

    const hookSession = { id: 'session-eve-1-resume', turn: { id: 'turn_1', sequence: 1 }, auth: { current: resolver, initiator: initial } };
    await closeModelPurposeTurn({ type: 'turn.settled', data: { turnId: 'turn_1', outcome: 'failed' } }, hookSession as never);
    expect(requestMock).toHaveBeenLastCalledWith('turn.close', { turnCapability: 'c'.repeat(43), turnId: 'turn_1', sequence: 1 });
    // A closed turn's coordinates are burned: nothing can be reserved or selected on them again.
    await expect(select(modelContext(23))).rejects.toThrow('Model purpose authority');
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
