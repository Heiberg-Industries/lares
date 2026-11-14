/**
 * THE TURN POSITION AN ANSWER IS RECORDED UNDER IS THE ONE ITS CONTINUATION LOOKS UP.
 *
 * On eve 1.0 an answered card starts no new turn. The response policy records the accepted answer
 * under its own `ctx.session.turn` (`rememberAcceptedAnswer`), and the model call that continues
 * the turn looks it up under `modelStepCoordinates(ctx)`, built from the dynamic model context's
 * `ctx.turn`. Two different eve readers produce those two values:
 *
 *  - the response policy's `session.turn` is eve's session provider
 *    (`dist/src/context/providers/session.js`: `turnPosition` + `activeTurnId`), handed on by
 *    `buildCallbackContext` (`harness/hitl/responders.js`);
 *  - a dynamic value's `ctx.turn` is `latestTurn(tables)` (`dist/src/definitions/turn.js`, called
 *    from `definitions/frame.js` `sessionFrameOf` with the same tables its `ctx.view` snapshots).
 *
 * If they ever disagree, every continuation after an answered card is refused. So this test runs
 * eve's own code for both, over a stream folded by eve's own `foldEvents`, with turn ids minted the
 * way eve mints them (`harness/session-machine/transitions.js`: `activeTurnId(turnPosition(...))`
 * between turns). The internal modules are imported by file path because eve does not export
 * them; if eve moves or changes them, this test fails with it rather than passing on a copy.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emptySessionView, foldEvents, type SessionView } from 'eve/events';
import { modelStepCoordinates } from '../src/definition-model.js';
import { clearAcceptedAnswersForTests, rememberAcceptedAnswer, settleAcceptedAnswer, takeAcceptedAnswers } from '../src/private-console-resume.js';

const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'));
const internal = <T>(path: string): Promise<T> => import(pathToFileURL(join(eveRoot, 'dist/src', path)).href) as Promise<T>;
type SessionValue = { sessionId: string; turn: { id: string; sequence: number } };
const { sessionProvider } = await internal<{ sessionProvider: { create(ctx: unknown, input: { state: unknown }): { value: SessionValue } } }>('context/providers/session.js');
const { SESSION_PROJECTION_STATE_KEY, activeTurnId, turnPosition } = await internal<{
  SESSION_PROJECTION_STATE_KEY: string;
  activeTurnId(position: unknown): string;
  turnPosition(projection: unknown): unknown;
}>('harness/session-machine/view.js');
const { latestTurn } = await internal<{ latestTurn(tables: unknown): { id: string; status: string } | null }>('definitions/turn.js');
// The public view is a snapshot over eve's internal tables; eve's own readers take the tables.
const { sessionTables } = await internal<{ sessionTables(view: SessionView): { calls: Record<string, { owner?: unknown }> } }>('protocol/session-projection/session-view.js');

const ENV = { LARES_AGENT_NAME: 'chief-of-staff', LARES_AGENT_INCARNATION: '00000000-0000-4000-8000-000000000001' } as NodeJS.ProcessEnv;
const SESSION = 'sess_position';

/** A session stream folded by eve, with each new turn's id minted by eve's own rule. */
function stream() {
  let line = 0;
  let view: SessionView = emptySessionView();
  const projection = () => ({ counters: { changes: 0, runs: 0 }, view: sessionTables(view) });
  const push = (type: string, data: Record<string, unknown>, turnId?: string) => {
    view = foldEvents(view, [{ type, data, ...(turnId ? { scope: { turnId } } : {}),
      meta: { position: { line: line++, index: 0 }, at: new Date().toISOString(), endOfLine: true } } as never]);
  };
  return {
    get view() { return view; },
    /** The session value eve hands a response policy, a hook or a tool at this point. */
    sessionValue(): SessionValue {
      const auth = { authenticator: 'test', principalType: 'user', principalId: 'asker' };
      const ctx = { require: (k: unknown) => (String(k).includes('SessionId') ? SESSION : auth), get: () => undefined };
      return sessionProvider.create(new Proxy(ctx, {}), { state: { [SESSION_PROJECTION_STATE_KEY]: projection() } }).value;
    },
    startSession() { push('session.started', { parent: null, predecessor: null }); },
    startTurn(): string {
      const turnId = activeTurnId(turnPosition(projection()));
      push('turn.started', { turnId, cause: { deliveryId: `d_${turnId}` }, follows: null }, turnId);
      return turnId;
    },
    askCard(turnId: string, callId: string, interactionId: string) {
      push('call.requested', { callId, owner: { turnId }, capability: { kind: 'tool', name: 'remember' }, input: {} }, turnId);
      push('interaction.opened', { interactionId, subject: { callId },
        request: { kind: 'approval', prompt: 'Approve?', options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }] } }, turnId);
    },
    settleCard(turnId: string, interactionId: string) {
      push('interaction.settled', { interactionId, outcome: 'accepted', response: { optionId: 'approve' } }, turnId);
    },
    settleTurn(turnId: string) { push('turn.settled', { turnId, outcome: 'completed' }, turnId); },
  };
}

afterEach(() => clearAcceptedAnswersForTests());

describe('the turn position an answer is recorded under', () => {
  for (const earlierTurns of [0, 1, 3]) {
    it(`is the position its continuation looks up (${earlierTurns} earlier turns)`, () => {
      const s = stream();
      s.startSession();
      for (let i = 0; i < earlierTurns; i += 1) s.settleTurn(s.startTurn());
      const turnId = s.startTurn();
      expect(turnId).toBe(`turn_${earlierTurns}`);
      s.askCard(turnId, 'call_1', 'int_1');

      // The response policy accepts the answer while the turn waits on the card.
      const atAnswer = s.sessionValue();
      expect(atAnswer.turn).toEqual({ id: turnId, sequence: earlierTurns });
      rememberAcceptedAnswer({ request: { interactionId: 'int_1' }, response: { decision: 'approve', principal: { attributes: {} } },
        session: { id: SESSION, turn: atAnswer.turn } }, { memberId: 'member-1', admissionNonce: 'nonce-1' }, ENV);

      // eve settles the card; the paused turn carries on (no new turn starts).
      s.settleCard(turnId, 'int_1');
      settleAcceptedAnswer('int_1', SESSION, 'approve', ENV); // the settle hook confirms the answer eve applied
      const turn = latestTurn(sessionTables(s.view));
      expect(turn).toMatchObject({ id: turnId, status: 'running' });

      // The continuation's model call: the point it looks up holds exactly that answer.
      const step = modelStepCoordinates({ turn, view: s.view } as never);
      expect(step.data).toMatchObject({ turnId: atAnswer.turn.id, sequence: atAnswer.turn.sequence });
      const taken = takeAcceptedAnswers({ sessionId: SESSION, turnId: step.data.turnId, sequence: step.data.sequence, incarnation: ENV.LARES_AGENT_INCARNATION! });
      expect(taken.map(a => a.requestId)).toEqual(['int_1']);

      // A tool or hook in the continuation sees the same turn as the card's own owner (`scope.turnId`).
      const afterSettle = s.sessionValue();
      expect(afterSettle.turn).toEqual(atAnswer.turn);
      expect(sessionTables(s.view).calls['call_1']?.owner).toEqual({ turnId: afterSettle.turn.id });
    });
  }
});
