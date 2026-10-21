import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { personalReadToolResult, personalReadContent, personalReadSelectionSchema } from '../lib/personal-reads.js';
import { readWindowSchema } from '../lib/personal-read-contract.js';
export default defineTool({
  description: 'Read events in one exact private calendar selection and bounded time window (at most 31 days and 100 events). Event text is quoted. No writes, arbitrary URLs, addresses or default calendar.',
  inputSchema: z.strictObject({selection:personalReadSelectionSchema,window:readWindowSchema}),
  async execute(input,ctx) { return personalReadToolResult(ctx,()=>personalReadContent(ctx,input.selection,{kind:'calendarWindow',window:input.window})); },
});
