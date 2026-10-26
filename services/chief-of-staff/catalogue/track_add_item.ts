import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { assertApproval, runApprovedTwentyTrackOnce } from '../lib/approvals.js';
import { trackItemApproval } from '../lib/board.js';
import { mutateApprovedTrack } from '../lib/tracks.js';
import { TwentyTracksHome } from '../lib/twenty-tracks.js';

const who = z.strictObject({ personId: z.string().min(1).optional(), organisationId: z.string().min(1).optional() }).refine(v => !!v.personId || !!v.organisationId);
export default defineTool({
  description: 'Add a person or organisation to an exact connected workflow. Twenty uses its existing approval gate; Vault changes require the private Console approval.',
  inputSchema: z.strictObject({ home: z.string().min(1).max(256), trackId: z.string().min(1).max(63), who, step: z.string().min(1).max(80), note: z.string().min(1).max(500), sourceSignal: z.string().min(1).max(200) }),
  approval: trackItemApproval('track_add_item'),
  async execute(input, ctx) {
    const approved = await assertApproval(ctx, 'track_add_item', input);
    if (input.home === 'twenty') return await runApprovedTwentyTrackOnce(approved,
      () => new TwentyTracksHome().addItem(input.trackId, input.who, input.step, input.note, input.sourceSignal));
    if (!/^vault:[A-Za-z0-9_-]{1,128}$/.test(input.home)) throw new Error('Track home is unavailable');
    if (!approved) throw new Error('Vault track changes are available only through the private Console approval');
    return await mutateApprovedTrack(ctx as never, approved, 'track_add_item', input);
  },
});
