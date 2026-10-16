import { defineDynamic, defineInstructions } from 'eve/instructions';
import { fixtureDefinition } from '../../lib/definition.js';
export default defineDynamic({ events: {
  'session.started': async (_event: unknown, ctx?: { session?: { id?: string } }) => {
    if (!process.env.LARES_DEFINITION_DIR) return null;
    const { loaded } = await fixtureDefinition(ctx?.session?.id);
    return defineInstructions({ markdown: `${loaded.voiceMd}\n${loaded.dutiesMd}` });
  },
}});
