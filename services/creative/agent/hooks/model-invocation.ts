import { defineHook } from 'eve/hooks';
import { modelCompactionSettled, refuseModelCompaction } from '@lares/agent-kit/definition-model';

// eve 1.0 names a compaction `context.started` / `context.settled` (0.60.1: `compaction.requested`)
// and awaits this hook before the summary call. A summary requires its own trusted
// purpose/coordinates; it cannot spend the main step's claim. Throwing here no longer stops the
// summary request by itself (a hook error fails the turn at its next checkpoint), so
// `refuseModelCompaction` also marks the session and the model guard refuses the call.
// `clear` is the one kind let through: it empties the conversation and calls no model. Any kind
// this code does not know is refused.
export default defineHook({ events: {
  'context.started': (event, ctx) => { if (event.data.kind !== 'clear') refuseModelCompaction(ctx.session.id); },
  'context.settled': (_event, ctx) => { modelCompactionSettled(ctx.session.id); },
} });
