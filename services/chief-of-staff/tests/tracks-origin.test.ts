import { expect, it } from 'vitest';
import { currentTaint } from '@lares/agent-kit/origin-taint';
import { markTrackOrigin } from '../lib/tracks.js';

it('classifies track content from persisted origin and never taints owner or agent content', () => {
  const ctx = { session: { id: 'tracks-origin-test', turn: { id: 'stored-provenance' } } };
  const key = { sessionId: ctx.session.id, turnId: ctx.session.turn.id };
  markTrackOrigin(ctx, '---\nlares_origin: agent\n---');
  expect(currentTaint(key)).toBeUndefined();
  markTrackOrigin(ctx, '---\nlares_origin: synced\n---');
  expect(currentTaint(key)).toBe('synced');
  markTrackOrigin(ctx, '---\nlares_origin: third_party\n---');
  expect(currentTaint(key)).toBe('third_party');
});
