import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { assertApproval } from '../lib/approvals.js';
import { approvalFor } from '../lib/board.js';
import { mutateApprovedTrack } from '../lib/tracks.js';

const who = z.strictObject({ personId: z.string().min(1).optional(), organisationId: z.string().min(1).optional() }).refine(v => !!v.personId || !!v.organisationId);
export default defineTool({
  description: 'Add a person or organisation to an existing workflow (requires an approval card and current edit grant).',
  inputSchema: z.strictObject({ trackId: z.string().min(1), who, step: z.string().min(1).max(80), note: z.string().min(1).max(500), sourceSignal: z.string().min(1).max(200) }),
  approval: approvalFor('track_add_item'),
  async execute(input, ctx) { const approved = await assertApproval(ctx, 'track_add_item', input); if (!approved) throw new Error('Track approval is unavailable'); return await mutateApprovedTrack(ctx as never, approved, 'track_add_item', input); },
});
