/**
 * The model guard's DEGRADED mode, in a file of its own: once a compaction cannot be scoped to its
 * conversation, every model call in this process is refused until a restart, and nothing here can
 * undo that for the tests that would follow in the same file.
 *
 * That mode says nothing about any conversation's length, so its refusal must never read as
 * "too long": every door keeps its ordinary failure text for it (and Telegram marks nothing).
 */
import { expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { randomUUID } from 'node:crypto';
import { MODEL_CALLS_REFUSED_UNSCOPED, MODEL_COMPACTION_REFUSED, isConversationTooLong } from '../src/conversation-too-long.js';
import { guardDefinitionModel, refuseModelCompaction } from '../src/definition-model.js';
import { captureModelInvocation } from '../src/model-invocation.js';
import { respondToTurnFailed } from '../src/gateway-budget.js';

const selected = (sessionId: string, provider: () => Promise<never>) => guardDefinitionModel(
  new MockLanguageModelV3({ doGenerate: provider, doStream: provider }),
  async () => undefined,
  captureModelInvocation(
    { type: 'step.started', data: { turnId: randomUUID(), sequence: 1, stepIndex: 2 } },
    { id: sessionId, auth: { current: { authenticator: 'fixture', principalId: 'fixture-person', principalType: 'user' as const, attributes: {} }, initiator: null } },
    'fixture-brain',
  ),
);
const refusalOf = async (sessionId: string, provider: () => Promise<never>) =>
  selected(sessionId, provider).doGenerate({ prompt: [] } as never).then(() => 'resolved', (error: Error) => error.message);

it('a scoped compaction still reads as too long while the guard is degraded; nothing else does, and no provider is reached', async () => {
  const provider = vi.fn(async (): Promise<never> => { throw new Error('PROVIDER REACHED'); });
  // A conversation that really is being compacted, scoped to itself, before the guard degrades.
  expect(() => refuseModelCompaction('really-long-session')).toThrow(MODEL_COMPACTION_REFUSED);

  // A compaction with no session id cannot be scoped: the guard degrades, with its own message.
  let unscoped = '';
  try { refuseModelCompaction(); } catch (error) { unscoped = (error as Error).message; }
  expect(unscoped).toBe(MODEL_CALLS_REFUSED_UNSCOPED);
  expect(isConversationTooLong(unscoped)).toBe(false);
  expect(isConversationTooLong(`Hook "context.started" failed: ${unscoped}`)).toBe(false);

  // Every other conversation is refused, as before, but never as "too long".
  const other = await refusalOf('ordinary-short-session', provider);
  expect(other).toBe(MODEL_CALLS_REFUSED_UNSCOPED);
  expect(isConversationTooLong(other)).toBe(false);
  // The conversation that really is being compacted keeps its own refusal.
  expect(await refusalOf('really-long-session', provider)).toBe(MODEL_COMPACTION_REFUSED);
  expect(provider).not.toHaveBeenCalled();

  // So the doors' failure text for it is today's ordinary one, on both native doors.
  for (const dialect of ['slack', 'telegram'] as const) {
    for (const message of [other, `Hook "context.started" failed: ${unscoped}`]) {
      expect(respondToTurnFailed({ outcome: 'failed', error: { code: 'MODEL_CALL_FAILED', message } }, { refusalText: 'FIXED', dialect }).kind).toBe('default');
    }
  }
});
