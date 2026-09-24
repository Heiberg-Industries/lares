import {defineAgent} from 'eve';
import {mockModel} from 'eve/evals';
import {appendFileSync} from 'node:fs';
export default defineAgent({modelContextWindowTokens:200000,model:mockModel(({messages,lastUserMessage,toolResults})=>{
 appendFileSync(process.env.PROOF_MODEL_LOG!,JSON.stringify(messages)+'\n');if(lastUserMessage==='pending write'&&!toolResults.some(t=>t.name==='proof_write'))return {toolCalls:[{name:'proof_write',input:{}}]};return 'DONE:'+lastUserMessage;
})});
