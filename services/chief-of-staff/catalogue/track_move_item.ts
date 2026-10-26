import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { assertApproval } from '../lib/approvals.js';
import { approvalFor } from '../lib/board.js';
import { mutateApprovedTrack } from '../lib/tracks.js';

export default defineTool({
  description: 'Move an existing workflow item to a step read from its track (requires an approval card and current edit grant).',
  inputSchema: z.strictObject({ itemId: z.string().min(1).max(63), step: z.string().min(1).max(80), note: z.string().min(1).max(500), sourceSignal: z.string().min(1).max(200) }),
  approval: approvalFor('track_move_item'),
  async execute(input, ctx) { const approved = await assertApproval(ctx, 'track_move_item', input); if (!approved) throw new Error('Track approval is unavailable'); return await mutateApprovedTrack(ctx as never, approved, 'track_move_item', input); },
});
