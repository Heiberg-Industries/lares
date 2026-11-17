// The Slack door, written once in the kit and bound by each role: both roles' real door files side by
// side, on what they share and on the two settings where they differ.
import { describe, expect, it, vi } from 'vitest';

const claims = vi.hoisted(() => ({ replies: [] as unknown[] }));
vi.mock('../src/door-channels.js', async (original) => ({
  ...(await original<typeof import('../src/door-channels.js')>()),
  // Every message is a claim here: record the reply the door hands the claim step, send nothing.
  interceptSlackClaim: async (_message: unknown, _db: unknown, _env: unknown, reply: unknown) => { claims.replies.push(reply); return true; },
}));
vi.mock('../src/db.js', () => ({ getPool: () => ({ query: async () => ({ rows: [] }) }) }));

import { approvalCardRenderer } from '../src/slack-approval-card.js';
import { SLACK_BUDGET_EXCEEDED_TEXT, ignoreSlackMessageEdit } from '../src/slack-door.js';
import { APPROVAL_REPLY_REFUSED, APPROVAL_REPLY_REFUSED_SENTENCE } from '../src/approval-reply-sentence.js';

const chief = await import(new URL('../../../services/chief-of-staff/agent/channels/slack.ts', import.meta.url).href);
const creative = await import(new URL('../../../services/creative/agent/channels/slack.ts', import.meta.url).href);
const ROLES = [['chief-of-staff', chief], ['creative', creative]] as const;

const thread = () => { const posted: string[] = []; return { posted, ctx: { channel: { thread: { post: async (m: string) => { posted.push(m); } } } } }; };
const failed = (message: string) => ({ data: { outcome: 'failed', turnId: 'turn-1', error: { code: 'x', message } } });

describe('what both roles share', () => {
  it.each(ROLES)('%s: the kit card renderer first, the owner-only answer check, edits start nothing', (_role, door) => {
    expect(door.slackDoorConfig.renderers?.[0]).toBe(approvalCardRenderer);
    expect(door.slackDoorConfig.renderers).toHaveLength(2);
    expect(door.slackDoorConfig.onAnswers).toBe(door.authorizeSlackAnswer);
    expect(door.slackDoorConfig.onMessageEdited).toBe(ignoreSlackMessageEdit);
    expect(door.default).toBeDefined();
  });
  it.each(ROLES)('%s: a spending cap gets the one fixed sentence', async (_role, door) => {
    for (const handler of [door.onTurnSettled, door.onSessionEnded]) {
      const t = thread(); const next = vi.fn();
      await handler(failed('budget_exceeded: Budget has been exceeded! Current cost: 15.2, Max budget: 15'), t.ctx, next);
      expect(t.posted).toEqual([SLACK_BUDGET_EXCEEDED_TEXT]);
      expect(next).not.toHaveBeenCalled();
    }
  });
  it.each(ROLES)('%s: any other failure is eve\'s to answer', async (_role, door) => {
    const t = thread(); const next = vi.fn(async () => {});
    await door.onTurnSettled(failed('something else broke'), t.ctx, next);
    expect(t.posted).toEqual([]);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('where the roles differ (kept exactly as before the door moved)', () => {
  it('a refused reply after an answered card: the chief of staff posts the sentence, the creative role leaves it to eve', async () => {
    const c = thread(); const cNext = vi.fn(async () => {});
    await chief.onTurnSettled(failed(APPROVAL_REPLY_REFUSED), c.ctx, cNext);
    expect(c.posted).toEqual([APPROVAL_REPLY_REFUSED_SENTENCE]);
    expect(cNext).not.toHaveBeenCalled();
    const r = thread(); const rNext = vi.fn(async () => {});
    await creative.onTurnSettled(failed(APPROVAL_REPLY_REFUSED), r.ctx, rNext);
    expect(r.posted).toEqual([]);
    expect(rNext).toHaveBeenCalledOnce();
  });
  it('a claim code: the chief of staff hands the claim step a reply, the creative role none (it says nothing back)', async () => {
    const message = { text: 'claim', channelId: 'D0EXAMPLE', author: { userId: OWNER_ID, isBot: false } };
    for (const handler of ['onDirectMessage', 'onAppMention'] as const) {
      claims.replies.length = 0;
      expect(await chief.slackDoorConfig[handler]!({} as never, message as never)).toBeNull();
      expect(await creative.slackDoorConfig[handler]!({} as never, message as never)).toBeNull();
      expect(claims.replies.map((reply) => typeof reply)).toEqual(['function', 'undefined']);
    }
  });
});

const OWNER_ID = 'U0EXAMPLEOWNER';
