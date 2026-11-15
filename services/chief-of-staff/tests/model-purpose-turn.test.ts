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

import { claimModelPurposeForInvocation, closeModelPurposeTurn, openContinuationAfterSettle, openModelPurposeTurn, prepareModelPurposeInvocation } from '../agent/lib/model-purpose.js';
import { clearAcceptedAnswersForTests, rememberAcceptedAnswer, settleAcceptedAnswer } from '@lares/agent-kit/private-console-resume';
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
/** The answer's own Keeper receipt (the console admits the answer with it), never the message's. */
const ANSWER = 'a'.repeat(43);
/** The person who asked, as eve 1.0 keeps them on `current` (and `initiator`) for the whole turn. */
const asker = () => human({ lares_model_purpose_required: '1', lares_model_pending_receipt: receipt });
const resumeSession = (id: string, turnId = 'turn_1', sequence = 1) =>
  ({ id, turn: { id: turnId, sequence }, auth: { current: asker(), initiator: asker() } });
/** A card answered and settled: the response policy's record, then the settle hook's confirmation
 *  against what eve applied (`applied`, the stored decision unless said otherwise). */
function answered(session: { id: string; turn: { id: string; sequence: number } }, requestId: string,
  decision: 'approve' | 'deny' = 'approve', applied: 'approve' | 'deny' | undefined = decision, answerReceipt = ANSWER): void {
  rememberAcceptedAnswer({ request: { interactionId: requestId }, response: { decision, principal: { attributes: { lares_model_pending_receipt: answerReceipt } } },
    session: { id: session.id, turn: session.turn } }, { memberId: 'member-1', admissionNonce: 'n'.repeat(43) });
  settleAcceptedAnswer(requestId, session.id, applied);
}

afterEach(() => { requestMock.mockReset(); sessionState.clear(); clearAcceptedAnswersForTests(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('model-purpose Eve turn hooks', () => {
  it('leaves a tagged human turn alone when optional custody is absent', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    const session = context();
    await expect(openModelPurposeTurn(event(), session as never)).resolves.toBeUndefined();
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

  // REWRITTEN for eve 1.0 (was: a resolver principal in `auth.current`, a shape eve 1.0 never
  // produces). The turn after an answered card runs as the person who ASKED; the answer reaches the
  // seam only through the response policy's record (`rememberAcceptedAnswer`), confirmed by the
  // card's settle hook (`settleAcceptedAnswer`).
  it('leaves the turn after an answered card alone when optional custody is absent', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    const plain = human(); // no model-purpose custody on this agent: no receipt, nothing required
    const session = { id: 'session-no-custody', turn: { id: 'turn_1', sequence: 1 }, auth: { current: plain, initiator: plain } };
    answered(session, 'approval-no-custody');
    await expect(openContinuationAfterSettle('turn_1', session as never)).resolves.toBeUndefined();
    const step = { type: 'step.started' as const, data: { turnId: 'turn_1', sequence: 1, stepIndex: 0 } };
    expect(() => prepareModelPurposeInvocation(step, session as never)).not.toThrow();
    await expect(claimModelPurposeForInvocation(captureModelInvocation(step, session as never, 'lares-brain'))).resolves.toBeUndefined();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('opens the continuation once, at the settle, with the ANSWER receipt, and claims each automatic step', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    requestMock.mockImplementation(async (op: string) => op === 'turn.open'
      ? { capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 }
      : { claim: 'k'.repeat(43), expiresAt: Date.now() + 30_000 });
    const session = resumeSession('session-resume-proof');
    answered(session, 'approval-1');
    await openContinuationAfterSettle('turn_1', session as never);
    const step = (stepIndex: number) => ({ type: 'step.started' as const, data: { turnId: 'turn_1', sequence: 1, stepIndex } });
    prepareModelPurposeInvocation(step(0), session as never);
    const first = captureModelInvocation(step(0), session as never, 'lares-brain');
    await claimModelPurposeForInvocation(first);
    prepareModelPurposeInvocation(step(1), session as never);
    const second = captureModelInvocation(step(1), session as never, 'lares-brain');
    await claimModelPurposeForInvocation(second);

    const calls = requestMock.mock.calls;
    expect(calls.map(([op]) => op)).toEqual(['turn.open', 'step.claim', 'step.claim']);
    // Keeper sees the requester's own turn (current = initiator = the person who asked) and the
    // answer's receipt, never the original message's receipt.
    expect(calls[0]).toEqual(['turn.open', expect.objectContaining({
      pendingReceipt: ANSWER,
      context: { session: expect.objectContaining({ id: 'session-resume-proof', turn: { id: 'turn_1', sequence: 1 },
        auth: { current: session.auth.current, initiator: session.auth.initiator } }) },
    })]);
    expect(calls[1]![1]).toMatchObject({ event: step(0), purposeAlias: 'lares-brain' });
    expect(calls[2]![1]).toMatchObject({ event: step(1), purposeAlias: 'lares-brain' });
    // A replayed invocation is refused (the continuation path reports it as its plain refusal) and
    // reaches Keeper no more.
    await expect(claimModelPurposeForInvocation(first)).rejects.toThrow('Model purpose authority');
    expect(requestMock).toHaveBeenCalledTimes(3);
    await closeModelPurposeTurn({ type: 'turn.settled', data: { turnId: 'turn_1', sequence: 1 } }, session as never);
    expect(requestMock).toHaveBeenLastCalledWith('turn.close', { turnCapability: 'c'.repeat(43), turnId: 'turn_1', sequence: 1 });
  });

  // This replaces a test that drove eve 0.60.1's internal tool loop
  // (`dist/src/harness/tool-loop.js`, gone in 1.0) through an approval resume. What it pinned
  // still holds on 1.0 shapes, proven here through the REAL model resolver and the real chief
  // adapter: a purpose-bound approval continuation is reserved before verification, opened once on
  // Keeper, claimed per model call under the coordinates read off eve's session view, and
  // closed by the turn's own settle event. Here nothing opened it at the settle, so the first
  // model call reserves and opens it (the lazy path).
  it('follows an eve 1.0 approval continuation through the real model resolver and the chief purpose adapter', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    requestMock.mockImplementation(async (op: string) => {
      if (op === 'turn.open') return { capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 };
      if (op === 'step.claim') return { claim: 'k'.repeat(43), expiresAt: Date.now() + 30_000 };
      return { closed: true };
    });
    const asking = asker();
    const hookSession = { id: 'session-eve-1-resume', turn: { id: 'turn_1', sequence: 1 }, auth: { current: asking, initiator: asking } };
    answered(hookSession, 'approval-eve-1');
    const { definitionModelResolver } = await import('@lares/agent-kit/definition-model');
    const order: string[] = [];
    const select = definitionModelResolver({
      resolveAlias: async () => { order.push('definition'); return 'lares-brain'; },
      preparePurpose: (event, session) => { prepareModelPurposeInvocation(event, session as never); order.push('reserved'); },
      claimPurpose: async (invocation) => { await claimModelPurposeForInvocation(invocation); order.push('claimed'); },
      provider: () => ({ specificationVersion: 'v3', provider: 'fixture', modelId: 'lares-brain' }) as never,
    });
    // What eve 1.0 hands a dynamic model: the session (id and both authentications), the latest
    // turn, and the session view. The answered approval continues turn_1, still as the asker.
    const modelContext = (line: number) => ({
      session: { id: 'session-eve-1-resume', auth: { current: asking, initiator: asking } },
      turn: { id: 'turn_1', status: 'paused', input: [] }, view: { line },
    }) as never;
    await select(modelContext(14));
    await select(modelContext(19));
    expect(order).toEqual(['reserved', 'definition', 'claimed', 'reserved', 'claimed']);

    const calls = requestMock.mock.calls;
    expect(calls.map(([op]) => op)).toEqual(['turn.open', 'step.claim', 'step.claim']);
    expect(calls[0]![1]).toMatchObject({ pendingReceipt: ANSWER,
      context: { session: { id: 'session-eve-1-resume', turn: { id: 'turn_1', sequence: 1 }, auth: { current: asking, initiator: asking } } } });
    expect(calls[1]![1]).toMatchObject({ purposeAlias: 'lares-brain', event: { type: 'step.started', data: { turnId: 'turn_1', sequence: 1, stepIndex: 14 } } });
    expect(calls[2]![1]).toMatchObject({ purposeAlias: 'lares-brain', event: { type: 'step.started', data: { turnId: 'turn_1', sequence: 1, stepIndex: 19 } } });

    await closeModelPurposeTurn({ type: 'turn.settled', data: { turnId: 'turn_1', outcome: 'failed' } }, hookSession as never);
    expect(requestMock).toHaveBeenLastCalledWith('turn.close', { turnCapability: 'c'.repeat(43), turnId: 'turn_1', sequence: 1 });
    // A closed turn's coordinates are burned: nothing can be reserved or selected on them again.
    await expect(select(modelContext(23))).rejects.toThrow('Model purpose authority');
  });

  // GUARANTEE KEPT: a continuation closed while its verification is pending is tombstoned; the same
  // card cannot reopen it, even if its answer were recorded again.
  it('tombstones a reserved continuation closed while model authority verification is pending', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    const session = resumeSession('session-preverify-proof');
    answered(session, 'approval-preverify');
    const step = { type: 'step.started' as const, data: { turnId: 'turn_1', sequence: 1, stepIndex: 0 } };
    prepareModelPurposeInvocation(step, session as never);
    await closeModelPurposeTurn({ type: 'turn.failed', data: { turnId: 'turn_1', sequence: 1 } }, session as never);
    const invocation = captureModelInvocation(step, session as never, 'lares-brain');
    await expect(claimModelPurposeForInvocation(invocation)).rejects.toThrow('Model purpose authority');
    expect(requestMock).not.toHaveBeenCalled();
    // The same card's answer, recorded again, meets the tombstone.
    answered(session, 'approval-preverify');
    expect(() => prepareModelPurposeInvocation(step, session as never)).toThrow('Model purpose authority');
    await openContinuationAfterSettle('turn_1', session as never);
    expect(requestMock).not.toHaveBeenCalled();
  });

  // GUARANTEE KEPT: the claim re-checks the requester. A continuation reserved for one member and
  // admission is refused when the turn's identity changed after reservation, including when the
  // person who ANSWERED (a resolver principal) is put in `current` (S5).
  it('refuses a claim when the requester changed after reservation', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    const step = { type: 'step.started' as const, data: { turnId: 'turn_1', sequence: 1, stepIndex: 0 } };
    const resolver = { authenticator: 'lares-console', attributes: {
      lares_resolver_member_id: 'member-1', lares_resume_request_id: 'approval-bound', lares_resume_option: 'approve',
      lares_purpose: 'resolver', lares_model_purpose_required: '1', lares_model_pending_receipt: ANSWER,
    } };
    const changes: Array<[string, (s: ReturnType<typeof resumeSession>) => void]> = [
      ['another admission', s => { (s.auth.current.attributes as Record<string, unknown>).lares_admission_nonce = 'm'.repeat(43);
        (s.auth.initiator.attributes as Record<string, unknown>).lares_admission_nonce = 'm'.repeat(43); }],
      ['another member', s => { (s.auth.current.attributes as Record<string, unknown>).lares_member_id = 'member-2';
        (s.auth.initiator.attributes as Record<string, unknown>).lares_member_id = 'member-2'; }],
      ['the answerer as current', s => { (s.auth as { current: unknown }).current = resolver; }],
    ];
    for (const [label, change] of changes) {
      const session = resumeSession(`session-binding-${label.replace(/\W/g, '-')}`);
      answered(session, 'approval-bound');
      prepareModelPurposeInvocation(step, session as never);
      const changed = structuredClone(session);
      change(changed);
      await expect(claimModelPurposeForInvocation(captureModelInvocation(step, changed as never, 'lares-brain')), label).rejects.toThrow();
    }
    expect(requestMock).not.toHaveBeenCalled();
  });

  // GUARANTEE KEPT: a Keeper open acknowledgement that arrives after the turn closed cannot revive
  // the continuation; its capability is closed at once.
  it('closes a continuation reservation before a delayed open ACK can revive it', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    let acknowledge!: (value: { capability: string; expiresAt: number }) => void;
    requestMock.mockImplementation((op: string) => op === 'turn.open'
      ? new Promise(resolve => { acknowledge = resolve; })
      : Promise.resolve({ claim: 'k'.repeat(43), expiresAt: Date.now() + 30_000 }));
    const session = resumeSession('session-late-resume-proof');
    answered(session, 'approval-late-open');
    const step = { type: 'step.started' as const, data: { turnId: 'turn_1', sequence: 1, stepIndex: 0 } };
    prepareModelPurposeInvocation(step, session as never);
    const invocation = captureModelInvocation(step, session as never, 'lares-brain');
    const claiming = claimModelPurposeForInvocation(invocation);
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledWith('turn.open', expect.anything()));
    await closeModelPurposeTurn({ type: 'turn.failed', data: { turnId: 'turn_1', sequence: 1 } }, session as never);
    acknowledge({ capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 });
    await expect(claiming).rejects.toThrow();
    expect(requestMock).toHaveBeenCalledWith('turn.close', { turnCapability: 'c'.repeat(43), turnId: 'turn_1', sequence: 1 });
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

// The answer's Keeper receipt lives 30 seconds; eve runs the approved action between the settle
// and the continuation's first model call. The receipt is used at the settle (before the action),
// so a slow action no longer leaves the reply refused. Before this change the claim below was
// refused: nothing opened the Keeper turn until the model call, 45 seconds after the answer.
describe('a slow approved action', () => {
  it('does not outlive the answer: the Keeper turn opens at the settle and serves the reply after the action', async () => {
    vi.stubEnv('LARES_AGENT_NAME', 'helper');
    vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
    const base = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    requestMock.mockImplementation(async (op: string) => op === 'turn.open'
      ? { capability: 'c'.repeat(43), expiresAt: base + 5 * 60_000 }
      : op === 'step.claim' ? { claim: 'k'.repeat(43), expiresAt: Date.now() + 30_000 } : { closed: true });
    const asker = human({ lares_model_purpose_required: '1', lares_model_pending_receipt: receipt });
    const session = context('turn_5', 5, asker, asker);
    const answerReceipt = 'a'.repeat(43);
    clock.mockReturnValue(base + 1_000); // the card is answered and settles
    answered(session, 'card-slow', 'approve', 'approve', answerReceipt);
    await openContinuationAfterSettle('turn_5', session as never);
    expect(requestMock).toHaveBeenCalledWith('turn.open', expect.objectContaining({ pendingReceipt: answerReceipt }));

    clock.mockReturnValue(base + 45_000); // the approved action took 44 seconds
    const step = { type: 'step.started' as const, data: { turnId: 'turn_5', sequence: 5, stepIndex: 20 } };
    prepareModelPurposeInvocation(step, session as never);
    await expect(claimModelPurposeForInvocation(captureModelInvocation(step, session as never, 'lares-brain'))).resolves.toBeUndefined();
    expect(requestMock.mock.calls.filter(([op]) => op === 'turn.open')).toHaveLength(1);

    // The same answer cannot open a second continuation: it was used up at the settle.
    await closeModelPurposeTurn({ type: 'turn.settled', data: { turnId: 'turn_5', sequence: 5 } }, session as never);
    await openContinuationAfterSettle('turn_5', session as never);
    expect(requestMock.mock.calls.filter(([op]) => op === 'turn.open')).toHaveLength(1);
  });
});

// What the person sees when the reply in a turn that asked a card is refused (here: no accepted
// answer is in memory). The seam's refusal says only what is true, read from the durable marks:
// "your answer was applied" only when a person's answer was applied in this turn (the settle hook's
// mark); "ended without an answer" when the turn asked a card that nobody answered, for example the
// person typed a new message while it waited (eve withdraws the card and the turn carries on); the
// plain refusal when the turn asked no card. Before round 3 the steered case said "your answer was
// applied", which was untrue.
describe('the refused reply in a turn that asked a card', () => {
  const step = (turnId: string, sequence: number) => ({ type: 'step.started' as const, data: { turnId, sequence, stepIndex: 11 } });
  for (const [label, asked, applied, expected] of [
    ['an answer was applied (then the agent restarted): the fixed reply refusal', true, true, 'The reply after an approval answer was refused'],
    ['the card was withdrawn by a typed message, nobody answered: "ended without an answer"', true, false, 'The approval in this turn ended without an answer'],
    ['a turn that asked no card keeps the plain refusal', false, false, 'Model purpose authority is not available'],
  ] as const) {
    it(label, async () => {
      vi.stubEnv('LARES_AGENT_NAME', 'helper');
      vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
      if (asked) sessionState.set('lares.approval-card-turns', ['turn_4']);
      if (applied) sessionState.set('lares.approval-answered-turns', ['turn_4']);
      const session = context('turn_4', 4, asker(), asker());
      prepareModelPurposeInvocation(step('turn_4', 4), session as never);
      const invocation = captureModelInvocation(step('turn_4', 4), session as never, 'lares-brain');
      await expect(claimModelPurposeForInvocation(invocation)).rejects.toThrow(expected);
      expect(requestMock).not.toHaveBeenCalled();
    });
  }
});

// D5: several cards settled in one step. eve settles them one after another and each settle hook
// tries to open the continuation. Nothing opens before the LAST card's settle has confirmed its own
// answer, and one answer that disagrees with what eve applied opens nothing. Before round 3 the
// first card's settle used up every answer, unchecked.
describe('two cards answered in one step', () => {
  const twoCards = (session: ReturnType<typeof resumeSession>, applied: { a: 'approve' | 'deny'; b: 'approve' | 'deny' }) => {
    for (const [card, decision] of [['card-a', 'approve'], ['card-b', 'deny']] as const)
      rememberAcceptedAnswer({ request: { interactionId: card }, response: { decision, principal: { attributes: { lares_model_pending_receipt: card === 'card-a' ? ANSWER : 'b'.repeat(43) } } },
        session: { id: session.id, turn: session.turn } }, { memberId: 'member-1', admissionNonce: 'n'.repeat(43) });
    return (card: 'card-a' | 'card-b') => settleAcceptedAnswer(card, session.id, card === 'card-a' ? applied.a : applied.b);
  };
  for (const order of [['card-a', 'card-b'], ['card-b', 'card-a']] as const) {
    it(`approve + deny, settled ${order.join(' then ')}: opens once, after the last settle`, async () => {
      vi.stubEnv('LARES_AGENT_NAME', 'helper');
      vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
      requestMock.mockResolvedValue({ capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 });
      const session = resumeSession(`session-two-${order[0]}`);
      const settle = twoCards(session, { a: 'approve', b: 'deny' });
      settle(order[0]);
      await openContinuationAfterSettle('turn_1', session as never);
      expect(requestMock).not.toHaveBeenCalled();
      settle(order[1]);
      await openContinuationAfterSettle('turn_1', session as never);
      // One Keeper turn, from the first card by request id.
      expect(requestMock.mock.calls).toEqual([['turn.open', expect.objectContaining({ pendingReceipt: ANSWER })]]);
    });

    it(`the second card's answer disagrees with what eve applied, settled ${order.join(' then ')}: nothing opens`, async () => {
      vi.stubEnv('LARES_AGENT_NAME', 'helper');
      vi.stubEnv('LARES_AGENT_INCARNATION', incarnation);
      requestMock.mockResolvedValue({ capability: 'c'.repeat(43), expiresAt: Date.now() + 30_000 });
      sessionState.set('lares.approval-card-turns', ['turn_1']);
      sessionState.set('lares.approval-answered-turns', ['turn_1']);
      const session = resumeSession(`session-disagree-${order[0]}`);
      const settle = twoCards(session, { a: 'approve', b: 'approve' }); // eve applied Approve to card-b; the record says Deny
      for (const card of order) { settle(card); await openContinuationAfterSettle('turn_1', session as never); }
      const step = { type: 'step.started' as const, data: { turnId: 'turn_1', sequence: 1, stepIndex: 3 } };
      prepareModelPurposeInvocation(step, session as never); // the answers were used up (refused) at the settles
      await expect(claimModelPurposeForInvocation(captureModelInvocation(step, session as never, 'lares-brain')))
        .rejects.toThrow('The reply after an approval answer was refused');
      expect(requestMock).not.toHaveBeenCalled();
    });
  }
});
