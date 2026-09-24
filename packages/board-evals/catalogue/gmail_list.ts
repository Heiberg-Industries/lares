// A second capability makes the granted-subset proof discriminate both inclusion and exclusion.
import { defineTool } from 'eve/tools';
import { z } from 'zod';
export default defineTool({
  description: 'Synthetic mailbox list (pool fixture; no external service).',
  inputSchema: z.object({}),
  execute: async () => ({ from: 'pool', tool: 'gmail_list' }),
});
