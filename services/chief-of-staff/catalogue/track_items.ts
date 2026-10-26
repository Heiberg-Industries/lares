import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { tracksHome } from '../lib/tracks.js';

export default defineTool({
  description: 'List open items in an owner-defined workflow, optionally filtered by person or organisation id.',
  inputSchema: z.strictObject({ trackId: z.string().min(1), personId: z.string().optional(), organisationId: z.string().optional() }),
  async execute(input, ctx) {
    const who = input.personId || input.organisationId ? { ...(input.personId ? { personId: input.personId } : {}), ...(input.organisationId ? { organisationId: input.organisationId } : {}) } : undefined;
    return { items: await tracksHome(ctx as never).listItems(input.trackId, who) };
  },
});
