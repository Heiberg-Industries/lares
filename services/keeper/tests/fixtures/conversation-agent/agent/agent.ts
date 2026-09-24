import {defineAgent} from 'eve';
import {mockModel} from 'eve/evals';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {definitionModel,resolveDefinitionForModel} from '@lares/agent-kit/definition-model';
const provider=(alias:string)=>mockModel(({messages,lastUserMessage})=>lastUserMessage==='pending write'?{toolCalls:[{name:'proof_write',input:{}}]}:alias+'\n'+messages.filter(m=>m.role==='system').map(m=>m.text).join('\n'));
// The reply echoes the alias the STEP selected, so the probe can see which model actually ran.
// Since eve 0.60 there is no compiled fallback to shadow it and no definition-level
// modelContextWindowTokens: the window travels with each selection (agent-kit's
// `sessionGatewayModel`), and the definition is read on the session's first step.
export default defineAgent({model:definitionModel({
 resolveAlias:async()=>(await resolveDefinitionForModel(async()=>JSON.parse(readFileSync(join(process.env.LARES_DEFINITION_DIR!,'agent.json'),'utf8')))).model,
 provider,
})});
