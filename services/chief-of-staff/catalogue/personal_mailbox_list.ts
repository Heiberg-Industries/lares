import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { personalReadToolResult, personalReadContent, personalReadSelectionSchema } from '../lib/personal-reads.js';
import { readWindowSchema } from '../lib/personal-read-contract.js';
export default defineTool({
  description: 'List message IDs and received times in one exact private mailbox selection and bounded time window (at most 31 days and 100 messages). A partial result says truncated; no arbitrary queries, addresses or default account.',
  inputSchema: z.strictObject({selection:personalReadSelectionSchema,window:readWindowSchema}),
  async execute(input,ctx) { return personalReadToolResult(ctx,()=>personalReadContent(ctx,input.selection,{kind:'mailWindow',window:input.window})); },
});
