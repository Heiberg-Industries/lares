import {appendFileSync} from 'node:fs';
import {defineTool} from 'eve/tools';
import {always} from 'eve/tools/approval';
import {z} from 'zod';
export default defineTool({description:'A disposable proof write',inputSchema:z.object({}),approval:always(),execute:async()=>{appendFileSync(process.env.PROOF_WRITE_LOG!,'EXECUTED\n');return 'written';}});
