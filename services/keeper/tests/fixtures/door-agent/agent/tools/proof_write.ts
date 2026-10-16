import {appendFileSync} from 'node:fs';
import {defineTool} from 'eve/tools';
import {boardApproval} from '@lares/agent-kit/board-approval';
import {z} from 'zod';
// Deliberately differs from LARES_AGENT_NAME, as a neutral role image does.
const manifest={name:'creative',model:'test-brain',persona:'agent/instructions.md',grants:[{capability:'gmail',scope:'write-with-confirm'}],autonomy:{gmail:'gated'}};
export default defineTool({description:'A disposable proof write',inputSchema:z.object({}),approval:boardApproval(manifest,'gmail_send'),execute:async()=>{appendFileSync(process.env.PROOF_WRITE_LOG!,'EXECUTED\n');return 'written';}});
