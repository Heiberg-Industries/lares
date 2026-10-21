import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { personalReadToolResult, listPersonalResources } from '../lib/personal-reads.js';
export default defineTool({
  description: 'List your Google and Microsoft calendar selections in this private console turn. Returns only owned account ID, generation, connector, stored status, resource binding ID and display labels. Copy exact IDs into personal_calendar_events. Status does not establish live provider health.',
  inputSchema: z.strictObject({}),
  async execute(input,ctx) { return personalReadToolResult(ctx,()=>listPersonalResources(ctx,'calendar')); },
});
