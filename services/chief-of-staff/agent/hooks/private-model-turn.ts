import { defineHook, type HookContext, type HookEvent } from 'eve/hooks';
import { closeModelPurposeTurn, openModelPurposeTurn } from '../lib/model-purpose.js';

type SessionContext = HookContext & {
  session?: { id?: string; turn?: { id?: string; sequence?: number }; auth?: { current?: unknown; initiator?: unknown } | null };
};

export default defineHook({ events: {
  'turn.started': async (event: HookEvent<'turn.started'>, context: HookContext) => {
    await openModelPurposeTurn(event, (context as SessionContext).session);
  },
  'turn.completed': async (event, context) => closeModelPurposeTurn(event, (context as SessionContext).session),
  'turn.failed': async (event, context) => closeModelPurposeTurn(event, (context as SessionContext).session),
  'turn.cancelled': async (event, context) => closeModelPurposeTurn(event, (context as SessionContext).session),
} });
