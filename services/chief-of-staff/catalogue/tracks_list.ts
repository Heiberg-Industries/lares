import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { tracksHome } from '../lib/tracks.js';

export default defineTool({
  description: 'List owner-defined workflows from the shared Vault, including each track’s current steps.',
  inputSchema: z.strictObject({}),
  async execute(_input, ctx) { return { tracks: await tracksHome(ctx as never).listTracks() }; },
});
