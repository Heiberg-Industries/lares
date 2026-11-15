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
import { clearAcceptedAnswersForTests, RefusedAnswersError, rememberAcceptedAnswer, settleAcceptedAnswer, takeAcceptedAnswers } from '../src/private-console-resume.js';

const ENV = { LARES_AGENT_NAME: 'chief-of-staff', LARES_AGENT_INCARNATION: '00000000-0000-4000-8000-000000000001' } as NodeJS.ProcessEnv;
const POINT = { sessionId: 'sess_store', turnId: 'turn_2', sequence: 2, incarnation: ENV.LARES_AGENT_INCARNATION! };
const receipt = (c: string) => c.repeat(43);
const answer = (decision: 'approve' | 'deny', memberId = 'member-1', r = receipt(decision === 'approve' ? 'A' : 'D'), card = 'int_1') =>
  rememberAcceptedAnswer({ request: { interactionId: card }, response: { decision, principal: { attributes: { lares_model_pending_receipt: r } } },
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
    expect(() => takeAcceptedAnswers(POINT)).toThrow(RefusedAnswersError);
    expect(takeAcceptedAnswers(POINT)).toEqual([]); // used up: nothing left to open later
  });

  it('a card nobody decided (withdrawn, expired, invalid) opens nothing', () => {
    answer('approve');
    settleAcceptedAnswer('int_1', POINT.sessionId, undefined, ENV);
    expect(() => takeAcceptedAnswers(POINT)).toThrow(RefusedAnswersError);
  });

  it('a card answered by two different members opens nothing', () => {
    answer('approve');
    answer('approve', 'member-2');
    answer('approve'); // the first member again does not undo it
    settleAcceptedAnswer('int_1', POINT.sessionId, 'approve', ENV);
    expect(() => takeAcceptedAnswers(POINT)).toThrow(RefusedAnswersError);
  });

  it('an answer is not used before its own card has settled', () => {
    answer('approve');
    expect(takeAcceptedAnswers(POINT)).toEqual([]);
    settleAcceptedAnswer('int_1', POINT.sessionId, 'approve', ENV);
    expect(takeAcceptedAnswers(POINT)).toEqual([expect.objectContaining({ requestId: 'int_1', state: 'confirmed' })]);
  });
});

/**
 * D5, several cards in one step. eve settles them one after another, and each settle hook may try
 * to open the continuation. Before this change the FIRST card's settle took every answer, so the
 * second card's answer was used before its own settle had checked it against what eve applied.
 */
describe('several cards answered in one step', () => {
  const A = receipt('A'), B = receipt('B');
  for (const [first, second] of [['int_a', 'int_b'], ['int_b', 'int_a']] as const) {
    it(`both confirmed, settled ${first} then ${second}: nothing is taken until the last settle, then both`, () => {
      answer('approve', 'member-1', A, 'int_a');
      answer('deny', 'member-1', B, 'int_b');
      const applied = { int_a: 'approve', int_b: 'deny' } as const;
      settleAcceptedAnswer(first, POINT.sessionId, applied[first], ENV);
      expect(takeAcceptedAnswers(POINT)).toEqual([]);
      settleAcceptedAnswer(second, POINT.sessionId, applied[second], ENV);
      expect(takeAcceptedAnswers(POINT).map(a => [a.requestId, a.optionId])).toEqual([['int_a', 'approve'], ['int_b', 'deny']]);
    });

    it(`the second card's stored answer disagrees with eve (settled ${first} then ${second}): nothing opens`, () => {
      answer('approve', 'member-1', A, 'int_a');
      answer('deny', 'member-1', B, 'int_b');
      // eve applied Approve to int_a and, unlike what was stored, Approve to int_b.
      const applied = { int_a: 'approve', int_b: 'approve' } as const;
      settleAcceptedAnswer(first, POINT.sessionId, applied[first], ENV);
      expect(takeAcceptedAnswers(POINT)).toEqual([]);
      settleAcceptedAnswer(second, POINT.sessionId, applied[second], ENV);
      expect(() => takeAcceptedAnswers(POINT)).toThrow(RefusedAnswersError);
      expect(takeAcceptedAnswers(POINT)).toEqual([]);
    });
  }
});
