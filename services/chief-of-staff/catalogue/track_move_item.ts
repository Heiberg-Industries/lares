import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { assertApproval, runApprovedTwentyTrackOnce } from '../lib/approvals.js';
import { trackItemApproval } from '../lib/board.js';
import { mutateApprovedTrack } from '../lib/tracks.js';
import { TwentyTracksHome } from '../lib/twenty-tracks.js';

export default defineTool({
  description: 'Move an existing item in an exact connected workflow. Twenty uses its existing approval gate; Vault changes require the private Console approval.',
  inputSchema: z.strictObject({ home: z.string().min(1).max(256), trackId: z.string().min(1).max(63), itemId: z.string().min(1).max(63), step: z.string().min(1).max(80), note: z.string().min(1).max(500), sourceSignal: z.string().min(1).max(200) }),
  approval: trackItemApproval('track_move_item'),
  async execute(input, ctx) {
    const approved = await assertApproval(ctx, 'track_move_item', input);
    if (input.home === 'twenty') return await runApprovedTwentyTrackOnce(approved,
      () => new TwentyTracksHome().moveItem(input.itemId, input.step, input.note, input.sourceSignal, input.trackId));
    if (!/^vault:[A-Za-z0-9_-]{1,128}$/.test(input.home)) throw new Error('Track home is unavailable');
    if (!approved) throw new Error('Vault track changes are available only through the private Console approval');
    return await mutateApprovedTrack(ctx as never, approved, 'track_move_item', input);
  },
});
