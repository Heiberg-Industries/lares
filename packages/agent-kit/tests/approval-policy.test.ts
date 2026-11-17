// The approval rules, written once in the kit and bound by each role: both roles' real bindings side
// by side, on the inputs where the roles differ and on the ones where they agree.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedApproverError } from '../src/approval-policy.js';

vi.mock('../src/db.js', () => ({ getPool: () => ({ query: async () => { throw new Error('no database in this test'); } }) }));

const chief = await import(new URL('../../../services/chief-of-staff/lib/approvals.ts', import.meta.url).href);
const creative = await import(new URL('../../../services/creative/lib/approvals.ts', import.meta.url).href);
const ROLES = [['chief-of-staff', chief], ['creative', creative]] as const;

const OWNER = 'U0EXAMPLEOWNER', OTHER = 'U0EXAMPLEOTHER';
const slack = (user: string) => ({ authenticator: 'slack-webhook', principalType: 'user', principalId: user, attributes: { user_id: user } });
const answer = (principal: unknown, decision: unknown = 'approve', interactionId?: string, sessionId?: string) => ({
  request: { ...(interactionId ? { interactionId } : {}), callId: 'call-1', toolName: 'some_tool', toolInput: {} },
  response: { decision, principal },
  session: { ...(sessionId ? { id: sessionId } : {}), turn: { id: 'turn-1', sequence: 1 } },
});

beforeEach(() => {
  process.env['SLACK_ALLOWED_USER_IDS'] = `${OWNER},${OTHER}`;
  process.env['TELEGRAM_PRINCIPAL_ID'] = '100';
  chief.clearNativeAnswersForTests();
});
afterEach(() => {
  delete process.env['SLACK_ALLOWED_USER_IDS'];
  delete process.env['TELEGRAM_PRINCIPAL_ID'];
  chief.clearNativeAnswersForTests();
});

describe('the native answer check', () => {
  // [case, answer, chief, creative]
  const rows = [
    ['the owner, tied to a card in a conversation', () => answer(slack(OWNER), 'approve', 'int-1', 's-1'), 'allowed', 'allowed'],
    ["the owner's Deny", () => answer(slack(OWNER), 'deny', 'int-2', 's-1'), 'allowed', 'allowed'],
    ['an allowed person who is not the owner', () => answer(slack(OTHER), 'approve', 'int-3', 's-1'), "only the agent's owner can answer this card", "only the agent's owner can answer this card"],
    ['no identity', () => answer(null, 'approve', 'int-4', 's-1'), "only the agent's owner can answer this card", "only the agent's owner can answer this card"],
    ['neither Approve nor Deny', () => answer(slack(OWNER), 'maybe', 'int-5', 's-1'), 'this answer is neither Approve nor Deny', 'this answer is neither Approve nor Deny'],
    // The roles differ here: the chief of staff keeps who answered and refuses an answer it cannot keep.
    ['the owner, with no card or conversation id', () => answer(slack(OWNER)), 'this answer is not tied to a card in a conversation', 'allowed'],
  ] as const;
  it.each(rows)('%s', (_name, make, chiefWants, creativeWants) => {
    const outcome = (r: { status: string; reason?: string }) => r.status === 'allowed' ? 'allowed' : r.reason;
    expect(outcome(chief.nativeAnswerDecision(make()))).toBe(chiefWants);
    expect(outcome(creative.nativeAnswerDecision(make()))).toBe(creativeWants);
  });
  it('a busy conversation: the chief of staff refuses the seventeenth waiting answer, the creative role keeps none and allows it', () => {
    for (let i = 0; i < 16; i++) expect(chief.nativeAnswerDecision(answer(slack(OWNER), 'approve', `int-${i}`, 's-busy'))).toEqual({ status: 'allowed' });
    expect(chief.nativeAnswerDecision(answer(slack(OWNER), 'approve', 'int-16', 's-busy'))).toEqual({ status: 'rejected', reason: 'too many answers are waiting to be applied; please answer again in a moment' });
    for (let i = 0; i < 17; i++) expect(creative.nativeAnswerDecision(answer(slack(OWNER), 'approve', `int-${i}`, 's-busy'))).toEqual({ status: 'allowed' });
  });
});

describe('a web chat reservation that cannot be made', () => {
  const member = { authenticator: 'lares-console', principalId: 'member-a', principalType: 'user',
    attributes: { lares_member_id: 'member-a', lares_admission_nonce: 'a'.repeat(43), lares_purpose: 'human' } };
  const ctx = () => ({ callId: 'call-1', toolInput: {}, session: { id: 's-web', turn: { id: 'turn-1', sequence: 0 }, auth: { current: member, initiator: member } } });
  it('the chief of staff answers a denial with a reason; the creative role throws', async () => {
    await expect(chief.catalogueApprovalRequest('lares_read_public_doc', ctx(), () => 'user-approval'))
      .resolves.toEqual({ type: 'denied', reason: expect.stringMatching(/could not be prepared for approval/) });
    await expect(creative.catalogueApprovalRequest('lares_read_public_doc', ctx(), () => 'user-approval'))
      .rejects.toThrow('Exact approval is unavailable for this action target');
  });
});

describe('who approved', () => {
  it('a schedule-opened session: the chief of staff reads the declared approver, the creative role does not', () => {
    const initiator = { authenticator: 'app', attributes: { approverChannel: 'telegram', approverPrincipalId: '100' } };
    expect(chief.approverFrom({ current: null, initiator })).toEqual({ authenticator: 'telegram-webhook', userId: '100' });
    expect(creative.approverFrom({ current: null, initiator })).toEqual({ authenticator: 'app' });
  });
  it.each(ROLES)('%s: the owner and an allowed person pass, a stranger is refused with the kit error', (_role, role) => {
    expect(() => role.assertApprover(role.approverFrom({ current: slack(OWNER) }))).not.toThrow();
    expect(() => role.assertApprover(role.approverFrom({ current: slack(OTHER) }))).not.toThrow();
    expect(() => role.assertApprover(role.approverFrom({ current: slack('U0STRANGER') }))).toThrow(UnauthorizedApproverError);
    expect(() => role.assertOwnerAnswerer(role.approverFrom({ current: slack(OTHER) }))).toThrow(UnauthorizedApproverError);
  });
  it("each role's refusal names its own doors", () => {
    const said = (role: typeof chief) => { try { role.assertApprover({}); } catch (error) { return (error as Error).message; } return ''; };
    expect(said(chief)).toBe('approval refused: an unidentified principal is not an allowed approver for this agent. A Slack or Telegram approval button can be clicked by anyone who can see the message, so the approver is re-checked here against packages/agent-kit/src/principals.ts.');
    expect(said(creative)).toBe('approval refused: an unidentified principal is not an allowed approver for this agent. A Slack approval button can be clicked by anyone who can see the message, so the approver is re-checked here against packages/agent-kit/src/principals.ts.');
  });
});
