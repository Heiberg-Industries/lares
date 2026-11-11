import { defineHook, type HookContext, type HookEvent } from 'eve/hooks';
import { closeModelPurposeTurn, openModelPurposeTurn } from '../lib/model-purpose.js';

type SessionContext = HookContext & {
  session?: { id?: string; turn?: { id?: string; sequence?: number }; auth?: { current?: unknown; initiator?: unknown } | null };
};

// eve 1.0's `turn.started` carries `{ turnId, cause, follows }` and no sequence; the sequence lives
// on `ctx.session.turn`. The model-purpose seam keys every capability on (session, turn id, sequence),
// so the pair is rebuilt here, and only when `ctx.session.turn` is THIS event's turn. If it is not,
// no sequence is passed and the seam refuses the turn (it throws for a private turn that cannot be
// placed, which fails the turn: nothing is allowed through).
const MAX_REMEMBERED = 512;
const sequences = new Map<string, number>();
const slot = (sessionId: string, turnId: string) => `${sessionId}\0${turnId}`;

function sequenceFor(ctx: SessionContext, turnId: unknown): number | undefined {
  const turn = ctx.session?.turn;
  return typeof turnId === 'string' && turn?.id === turnId && Number.isSafeInteger(turn.sequence) ? turn.sequence : undefined;
}

/** The event as the seam reads it: the turn id from the event, the sequence from the session. */
function seamEvent(type: string, data: { turnId?: unknown } | undefined, sequence: number | undefined) {
  return { type, data: { turnId: data?.turnId, sequence } };
}

async function open(event: HookEvent<'turn.started'>, ctx: HookContext): Promise<void> {
  const context = ctx as SessionContext;
  const sequence = sequenceFor(context, event.data?.turnId);
  const sessionId = context.session?.id;
  if (sequence !== undefined && typeof sessionId === 'string' && typeof event.data.turnId === 'string') {
    if (sequences.size >= MAX_REMEMBERED) sequences.delete(sequences.keys().next().value as string);
    sequences.set(slot(sessionId, event.data.turnId), sequence);
  }
  await openModelPurposeTurn(seamEvent('turn.started', event.data, sequence), context.session);
}

/** Closes whatever this process holds for the turn: on every outcome, and when a turn pauses for a person. */
async function close(event: HookEvent<'turn.settled'> | HookEvent<'turn.paused'>, ctx: HookContext): Promise<void> {
  const context = ctx as SessionContext;
  const sessionId = context.session?.id;
  const turnId = event.data?.turnId;
  if (typeof sessionId !== 'string' || typeof turnId !== 'string') return;
  const remembered = sequences.get(slot(sessionId, turnId));
  const sequence = remembered ?? sequenceFor(context, turnId);
  await closeModelPurposeTurn(seamEvent(event.type, event.data, sequence), context.session);
  if (event.type === 'turn.settled') sequences.delete(slot(sessionId, turnId));
}

export default defineHook({ events: {
  'turn.started': open,
  // Every outcome (`completed`, `failed`, `cancelled`) ends the turn's capability.
  'turn.settled': close,
  // In 0.60 a turn that parked for an approval ended there (`turn.completed`) and its capability
  // closed with it. In 1.0 the same turn continues after the answer, so the park point is closed
  // explicitly: a capability never stays open while a person is being asked.
  'turn.paused': close,
} });
