import { z } from 'zod';
import { registerAction } from './actions.js';
import { OutsideCustodyStore } from './outside-custody.js';

const uuid=z.string().uuid();
const NAME=/^[a-z][a-z0-9-]{1,30}$/;
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const sessionToken=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const deadline=()=>({deadlineAtMs:Date.now()+8000});

/** Private member actions. The browser can select and consent, while Keeper rechecks current
 * session and use authority inside its own transactions for every request. */
export function registerHumanOutsideDiscoveryActions(store:OutsideCustodyStore):void{
  registerAction({name:'outside.discovery-targets',input:z.strictObject({sessionToken}),secretFields:['sessionToken'],
    run:input=>store.listHumanDiscoveryTargets(input.sessionToken,deadline())});
  registerAction({name:'outside.discovery-preview',input:z.strictObject({sessionToken,agentName:z.string().regex(NAME),connectionName:z.string().regex(NAME)}),
    secretFields:['sessionToken'],run:input=>store.previewHumanDiscovery(input.sessionToken,{agentName:input.agentName,connectionName:input.connectionName},deadline())});
  registerAction({name:'outside.discover',input:z.strictObject({sessionToken,consent:z.literal(true),requestId:uuid,claimOperationId:uuid,accountId:uuid,
    agentName:z.string().regex(NAME),connectionName:z.string().regex(NAME),expectedGeneration:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    expectedCandidateRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),expectedDefinitionHash:hash,
    expectedAccessRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),expectedDestinationHash:hash,
    expectedRoutePolicyHash:hash,consentGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    credential:z.string().min(1).max(4096)}),secretFields:['sessionToken','credential'],run:input=>store.consentAndDiscover(input.sessionToken,
      {requestId:input.requestId,operationId:input.claimOperationId,accountId:input.accountId,agentName:input.agentName,
        connectionName:input.connectionName,expectedGeneration:input.expectedGeneration,expectedCandidateRevision:input.expectedCandidateRevision,
        expectedDefinitionHash:input.expectedDefinitionHash,expectedAccessRevision:input.expectedAccessRevision,
        expectedDestinationHash:input.expectedDestinationHash,expectedRoutePolicyHash:input.expectedRoutePolicyHash,
        consentGeneration:input.consentGeneration,credential:Buffer.from(input.credential,'utf8')},deadline())});
  registerAction({name:'outside.discovery-inspect',input:z.strictObject({sessionToken,accountId:uuid,agentName:z.string().regex(NAME),
    connectionName:z.string().regex(NAME),requestId:uuid,claimOperationId:uuid}),secretFields:['sessionToken'],
    run:input=>store.inspectHumanDiscovery(input.sessionToken,{accountId:input.accountId,agentName:input.agentName,
      connectionName:input.connectionName,requestId:input.requestId,claimOperationId:input.claimOperationId},deadline())});
}
