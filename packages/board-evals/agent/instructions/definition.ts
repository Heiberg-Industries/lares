// The mounted definition's voice and duties, read ONCE PER CONVERSATION. eve 1.0 runs this function
// before every model call; the memo keyed on the session keeps the first read, so a definition
// edited mid-conversation reaches the next conversation (services/*/agent/instructions/aa-definition.ts
// is the production counterpart). A read that fails keeps no memo and fails the turn.
import { defineDynamic, defineInstructions } from 'eve/instructions';
import { fixtureDefinition } from '../../lib/definition.js';
export default defineDynamic(async (ctx) => {
  if (!process.env.LARES_DEFINITION_DIR) return null;
  const content = await ctx.memo(['definition', ctx.session.id], async () => {
    const { loaded } = await fixtureDefinition(ctx.session.id);
    return `${loaded.voiceMd}\n${loaded.dutiesMd}`;
  });
  return defineInstructions({ content });
});
