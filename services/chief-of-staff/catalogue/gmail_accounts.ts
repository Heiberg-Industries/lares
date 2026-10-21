import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { taintTurn, turnKeyFrom } from '@lares/agent-kit/origin-taint';
import { listPersonalMailboxes } from '../lib/personal-gmail.js';

export default defineTool({
  description: 'List your personal Google mailbox selections in a private console turn. Returns accountId, generation, status and mailbox resourceBindingId with display labels only. Copy the exact IDs/generation into gmail_read or gmail_search selection. A connected status does not prove live provider health. Native channels cannot use this listing.',
  inputSchema: z.strictObject({}),
  async execute(_input, ctx) {
    const result = await listPersonalMailboxes(ctx);
    const key = turnKeyFrom(ctx);
    if (key) taintTurn(key, 'third_party');
    return result;
  },
});
