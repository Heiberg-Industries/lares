/**
 * The answer a turn continues from is the answer eve APPLIED, not the first one accepted.
 *
 * eve lets the same responder revise an answer before the card settles, and applies the latest
 * (`harness/hitl/responders.js`, `revisedAnswers`). The exact response policy accepts both a Deny
 * and a later Approve (a Deny writes nothing, so the card is still open for the Approve). Keeping
 * the first answer meant: Deny then Approve, the write ran, and the continuation came from the Deny
 * receipt, which Keeper refused against an approved card. Before this change the first test failed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearAcceptedAnswersForTests, rememberAcceptedAnswer, settleAcceptedAnswer, takeAcceptedAnswers } from '../src/private-console-resume.js';

const ENV = { LARES_AGENT_NAME: 'chief-of-staff', LARES_AGENT_INCARNATION: '00000000-0000-4000-8000-000000000001' } as NodeJS.ProcessEnv;
const POINT = { sessionId: 'sess_store', turnId: 'turn_2', sequence: 2, incarnation: ENV.LARES_AGENT_INCARNATION! };
const receipt = (c: string) => c.repeat(43);
const answer = (decision: 'approve' | 'deny', memberId = 'member-1', r = receipt(decision === 'approve' ? 'A' : 'D')) =>
  rememberAcceptedAnswer({ request: { interactionId: 'int_1' }, response: { decision, principal: { attributes: { lares_model_pending_receipt: r } } },
    session: { id: POINT.sessionId, turn: { id: POINT.turnId, sequence: POINT.sequence } } }, { memberId, admissionNonce: 'nonce-1' }, ENV);

afterEach(() => clearAcceptedAnswersForTests());

describe('the accepted answer a continuation opens from', () => {
  it('Deny then Approve from the same member: eve applies Approve, and so does the continuation', () => {
    answer('deny');
    answer('approve');
    settleAcceptedAnswer('int_1', POINT.sessionId, 'approve', ENV);
    expect(takeAcceptedAnswers(POINT)).toEqual([expect.objectContaining({ optionId: 'approve', receipt: receipt('A') })]);
  });

  it('Approve then Deny: whichever eve applied is the one kept', () => {
    answer('approve');
    answer('deny');
    settleAcceptedAnswer('int_1', POINT.sessionId, 'deny', ENV);
    expect(takeAcceptedAnswers(POINT)).toEqual([expect.objectContaining({ optionId: 'deny', receipt: receipt('D') })]);
  });

  it('a stored answer that disagrees with what eve applied opens nothing', () => {
    answer('approve');
    settleAcceptedAnswer('int_1', POINT.sessionId, 'deny', ENV);
    expect(takeAcceptedAnswers(POINT)).toEqual([]);
  });

  it('a card nobody decided (withdrawn, expired, invalid) opens nothing', () => {
    answer('approve');
    settleAcceptedAnswer('int_1', POINT.sessionId, undefined, ENV);
    expect(takeAcceptedAnswers(POINT)).toEqual([]);
  });

  it('a card answered by two different members opens nothing', () => {
    answer('approve');
    answer('approve', 'member-2');
    settleAcceptedAnswer('int_1', POINT.sessionId, 'approve', ENV);
    expect(takeAcceptedAnswers(POINT)).toEqual([]);
  });
});
