import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { randomUUID } from 'node:crypto';
import {
  CONVERSATION_TOO_LONG_PARTLY_DONE,
  CONVERSATION_TOO_LONG_SLACK,
  CONVERSATION_TOO_LONG_SLACK_ROOM,
  CONVERSATION_TOO_LONG_TELEGRAM,
  CONVERSATION_TOO_LONG_TELEGRAM_SCHEDULED,
  CONVERSATION_TOO_LONG_WEB,
  MODEL_CALLS_REFUSED_UNSCOPED,
  MODEL_COMPACTION_REFUSED,
  anyCallCompleted,
  conversationTooLongSlackSentence,
  isConversationTooLong,
  withPartlyDone,
} from '../src/conversation-too-long.js';
import * as definitionModel from '../src/definition-model.js';
import { guardDefinitionModel, modelCompactionSettled, refuseModelCompaction } from '../src/definition-model.js';
import { captureModelInvocation } from '../src/model-invocation.js';
import { respondToSessionFailed, respondToTurnFailed } from '../src/gateway-budget.js';

const failedWith = (message: string, code = 'MODEL_CALL_FAILED') => ({ outcome: 'failed', error: { code, message, id: 'err_fixture' } });
const thrownBy = (fn: () => unknown): string => {
  try { fn(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error('did not throw');
};

describe('the refusal and its recogniser cannot drift apart', () => {
  it('the model seam re-exports the one constant, not a copy', () => {
    expect(definitionModel.MODEL_COMPACTION_REFUSED).toBe(MODEL_COMPACTION_REFUSED);
  });

  it('the hook refusal, as thrown, is recognised', () => {
    const message = thrownBy(() => refuseModelCompaction('drift-hook-session'));
    modelCompactionSettled('drift-hook-session');
    expect(isConversationTooLong(message)).toBe(true);
    // As eve words a hook's error on the turn it fails (`<hook> failed: <message>`).
    expect(isConversationTooLong(`context.started failed: ${message}`)).toBe(true);
  });

  it("the model guard's refusal of the summary call, as thrown, is recognised and never reaches the provider", async () => {
    const provider = vi.fn(async () => { throw new Error('PROVIDER REACHED'); });
    const invocation = captureModelInvocation(
      { type: 'step.started', data: { turnId: randomUUID(), sequence: 1, stepIndex: 2 } },
      { id: 'drift-guard-session', auth: { current: { authenticator: 'fixture', principalId: 'fixture-person', principalType: 'user' as const, attributes: {} }, initiator: null } },
      'fixture-brain',
    );
    const model = guardDefinitionModel(new MockLanguageModelV3({ doGenerate: provider, doStream: provider }), async () => undefined, invocation);
    expect(() => refuseModelCompaction('drift-guard-session')).toThrow();
    try {
      const refused = await model.doGenerate({ prompt: [] } as never).then(() => 'resolved', (error: Error) => error.message);
      expect(isConversationTooLong(refused)).toBe(true);
      expect(provider).not.toHaveBeenCalled();
    } finally { modelCompactionSettled('drift-guard-session'); }
  });
});

describe('isConversationTooLong', () => {
  it('matches the refusal exactly, or as the tail of a wrapped message', () => {
    expect(isConversationTooLong(MODEL_COMPACTION_REFUSED)).toBe(true);
    expect(isConversationTooLong(`DefinitionFailedError: ${MODEL_COMPACTION_REFUSED}`)).toBe(true);
  });

  it('matches nothing else', () => {
    for (const message of [
      undefined, null, 42, '',
      'Model compaction requires a fresh trusted invocation, and more',
      `${MODEL_COMPACTION_REFUSED}.`,
      `prefix${MODEL_COMPACTION_REFUSED}`,
      'model compaction requires a fresh trusted invocation',
      "The agent's system prompt, tools, memory and context take ~210000 tokens, over this model's ~180000-token compaction limit. Shorten the instructions, remove tools or trim memory.",
      'Model provider API request failed (HTTP 400).',
      'Dynamic model selection is required before model-dependent work begins',
      // The guard's degraded refusal says nothing about the conversation's length.
      MODEL_CALLS_REFUSED_UNSCOPED,
      `Hook "context.started" failed: ${MODEL_CALLS_REFUSED_UNSCOPED}`,
    ]) expect(isConversationTooLong(message)).toBe(false);
  });
});

describe('what each door is told', () => {
  it('the sentences are the owner-approved ones, word for word', () => {
    expect(CONVERSATION_TOO_LONG_WEB).toBe('This conversation has grown too long for me to continue. Start a new conversation and send your message again there.');
    expect(CONVERSATION_TOO_LONG_SLACK).toBe('This thread has grown too long for me to continue. Please send your message again as a new message, not as a reply in this thread.');
    expect(CONVERSATION_TOO_LONG_TELEGRAM).toBe('This conversation has grown too long for me to continue, so your next message will start a new one. Please send your last message again.');
    expect(CONVERSATION_TOO_LONG_SLACK_ROOM).toBe('This thread has grown too long for me to continue. Please send your message again as a new message that mentions me, not as a reply in this thread.');
    expect(CONVERSATION_TOO_LONG_TELEGRAM_SCHEDULED).toBe('This conversation has grown too long for me to continue, so your next message will start a new one. A scheduled update was not delivered.');
    expect(CONVERSATION_TOO_LONG_PARTLY_DONE).toBe('Part of what you asked may already have been done, so check before asking again.');
  });

  it('Slack: the direct-message sentence only for a conversation known to have started in a direct message', () => {
    const slack = (channel_id: string) => ({ authenticator: 'slack-webhook', attributes: { channel_id } });
    expect(conversationTooLongSlackSentence({ session: { auth: { initiator: slack('D0FIXTURE'), current: slack('D0FIXTURE') } } })).toBe(CONVERSATION_TOO_LONG_SLACK);
    // Read from where it STARTED: a room conversation stays a room whoever answers in it.
    expect(conversationTooLongSlackSentence({ session: { auth: { initiator: slack('C0FIXTURE'), current: slack('D0FIXTURE') } } })).toBe(CONVERSATION_TOO_LONG_SLACK_ROOM);
    expect(conversationTooLongSlackSentence({ session: { initiator: slack('D0FIXTURE') } })).toBe(CONVERSATION_TOO_LONG_SLACK);
    expect(conversationTooLongSlackSentence({ session: { auth: { initiator: null, current: slack('D0FIXTURE') } } })).toBe(CONVERSATION_TOO_LONG_SLACK);
    // Cannot tell: the room wording, which is true in a direct message too.
    for (const ctx of [undefined, {}, { session: {} }, { session: { auth: { initiator: { authenticator: 'app', attributes: {} } } } },
      { session: { auth: { initiator: { authenticator: 'slack-webhook', attributes: {} } } } }]) {
      expect(conversationTooLongSlackSentence(ctx)).toBe(CONVERSATION_TOO_LONG_SLACK_ROOM);
    }
  });

  it("reads a completed call off the failed turn's own rows, in the view a channel handler is given", async () => {
    // eve's own fold with the retention its server checkpoints and channel observers use
    // (`operational`): it drops closed rows of older turns, but keeps the latest turn's rows until
    // the next turn starts. So at that turn's `turn.settled`, a call it completed is still there.
    const projection = (file: string) => new URL(`../node_modules/eve/dist/src/protocol/session-projection/${file}`, import.meta.url).href;
    const { emptySessionView, foldEvents } = (await import(projection('fold.js'))) as {
      emptySessionView(): object;
      foldEvents(view: object, events: readonly unknown[], options?: { retention?: string }): unknown;
    };
    // The tables as eve publishes them to a handler (`ctx.view`).
    const { snapshotOf } = (await import(projection('session-view.js'))) as { snapshotOf(view: object): import('eve/events').SessionView };
    const { calls } = await import('eve/events');
    const at = '2026-11-12T10:00:00.000Z';
    let line = 0;
    const fact = (type: string, turnId: string, data: Record<string, unknown>) => ({ type, scope: { turnId }, data, meta: { position: { line: line++, index: 0 }, at, endOfLine: true } });
    const turn = (turnId: string, outcome: string) => [
      fact('turn.started', turnId, { turnId, cause: { deliveryId: `d-${turnId}` }, follows: null }),
      fact('call.requested', turnId, { callId: `call-${turnId}`, owner: { turnId }, capability: { kind: 'tool', name: 'gmail_send' }, input: {} }),
      fact('call.started', turnId, { callId: `call-${turnId}` }),
      fact('call.settled', turnId, { callId: `call-${turnId}`, outcome }),
    ];
    const tables = emptySessionView();
    foldEvents(tables, [...turn('turn_0', 'completed'), ...turn('turn_1', 'completed'),
      fact('turn.settled', 'turn_1', { turnId: 'turn_1', outcome: 'failed', error: { code: 'MODEL_CALL_FAILED', message: MODEL_COMPACTION_REFUSED } })], { retention: 'operational' });
    const view = snapshotOf(tables);

    expect(anyCallCompleted(calls(view, { turnId: 'turn_1' }))).toBe(true);
    // The older turn's closed rows are dropped, as operational retention promises: absence proves nothing,
    // which is why only a positive answer adds the sentence.
    expect(calls(view, { turnId: 'turn_0' })).toEqual([]);
    expect(anyCallCompleted(calls(view, { turnId: 'turn_9' }))).toBe(false);
  });

  it('adds the partly-done sentence only when the failed turn shows a completed call', () => {
    expect(anyCallCompleted([{ state: 'completed' }])).toBe(true);
    expect(anyCallCompleted([{ state: 'failed' }, { state: 'rejected' }, { state: 'running' }])).toBe(false);
    expect(anyCallCompleted([])).toBe(false);
    expect(anyCallCompleted(undefined)).toBe(false);
    expect(withPartlyDone(CONVERSATION_TOO_LONG_WEB, true)).toBe(`${CONVERSATION_TOO_LONG_WEB} ${CONVERSATION_TOO_LONG_PARTLY_DONE}`);
    expect(withPartlyDone(CONVERSATION_TOO_LONG_WEB, false)).toBe(CONVERSATION_TOO_LONG_WEB);
  });

  it('a failed turn for this cause gets its door\'s sentence, plain or wrapped', () => {
    for (const message of [MODEL_COMPACTION_REFUSED, `context.started failed: ${MODEL_COMPACTION_REFUSED}`]) {
      for (const code of ['MODEL_CALL_FAILED', 'HOOK_FAILED']) {
        expect(respondToTurnFailed(failedWith(message, code), { refusalText: 'FIXED', dialect: 'slack' }))
          .toEqual({ kind: 'conversation-too-long', text: CONVERSATION_TOO_LONG_SLACK });
        expect(respondToTurnFailed(failedWith(message, code), { refusalText: 'FIXED', dialect: 'telegram' }))
          .toEqual({ kind: 'conversation-too-long', text: CONVERSATION_TOO_LONG_TELEGRAM });
      }
    }
  });

  it('only a FAILED turn: the same message on any other outcome is silent, as before', () => {
    for (const outcome of ['completed', 'cancelled']) {
      expect(respondToTurnFailed({ outcome, error: { code: 'X', message: MODEL_COMPACTION_REFUSED } }, { refusalText: 'FIXED', dialect: 'telegram' }).kind).toBe('silent');
    }
  });

  it('every other failure keeps eve\'s own text', () => {
    for (const message of ['Model provider API request failed (HTTP 400).', `${MODEL_COMPACTION_REFUSED}, and more`]) {
      expect(respondToTurnFailed(failedWith(message), { refusalText: 'FIXED', dialect: 'slack' }).kind).toBe('default');
      expect(respondToTurnFailed(failedWith(message), { refusalText: 'FIXED', dialect: 'telegram' }).kind).toBe('default');
    }
  });

  it("the session's end is not this cause's path, and keeps eve's own text", () => {
    // The refusal fails the turn and leaves the conversation open; it never ends a session.
    expect(respondToSessionFailed(failedWith(MODEL_COMPACTION_REFUSED), { refusalText: 'FIXED', dialect: 'slack' }).kind).toBe('default');
  });
});
