import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { assertApproval } from '../lib/approvals.js';
import { approvalFor } from '../lib/board.js';
import { mutateApprovedTrack } from '../lib/tracks.js';

const steps = z.array(z.string().min(1).max(80)).min(1);
export default defineTool({
  description: 'Create an owner-defined workflow in the shared Vault (requires an approval card and current edit grant).',
  inputSchema: z.strictObject({ trackId: z.string().min(1).max(63), name: z.string().min(1).max(120), purpose: z.string().min(1).max(500), steps, closingSteps: steps }),
  approval: approvalFor('track_create'),
  async execute(input, ctx) {
    const approved = await assertApproval(ctx, 'track_create', input); if (!approved) throw new Error('Track approval is unavailable');
    return await mutateApprovedTrack(ctx as never, approved, 'track_create', input);
  },
});
