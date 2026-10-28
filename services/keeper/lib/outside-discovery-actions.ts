import { z } from 'zod';
import { randomUUID } from 'node:crypto';
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
  const discovery=z.strictObject({accountId:uuid,agentName:z.string().regex(NAME),connectionName:z.string().regex(NAME),requestId:uuid,claimOperationId:uuid});
  const selectors=discovery.extend({publicationId:uuid,acceptanceId:uuid,expectedGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedCandidateRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),expectedConsentGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedDefinitionHash:hash,expectedAccessRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),expectedPublicationHash:hash,expectedAcceptanceHash:hash});
  registerAction({name:'outside.discovery-review-preview',input:z.strictObject({sessionToken,...discovery.shape}),secretFields:['sessionToken'],
    run:input=>store.previewHumanDescriptorReview(input.sessionToken,{accountId:input.accountId,agentName:input.agentName,connectionName:input.connectionName,
      requestId:input.requestId,claimOperationId:input.claimOperationId},deadline())});
  registerAction({name:'outside.discovery-review-publish',input:z.strictObject({sessionToken,...discovery.shape,expectedGeneration:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedDescriptorHash:hash}),secretFields:['sessionToken'],run:input=>{const {sessionToken,...value}=input;return store.publishDiscoveredDescriptorReview(sessionToken,
      {...value,operationId:randomUUID()},deadline());}});
  registerAction({name:'outside.discovery-review-accept',input:z.strictObject({sessionToken,accountId:uuid,publicationId:uuid,expectedPublicationHash:hash}),
    secretFields:['sessionToken'],run:input=>{const {sessionToken,...value}=input;return store.acceptPublishedDescriptorReview(sessionToken,
      {...value,operationId:randomUUID()},deadline());}});
  registerAction({name:'outside.candidate-stage',input:z.strictObject({sessionToken,...selectors.shape}),secretFields:['sessionToken'],run:async input=>{
    // The bounded review receipt is prepared inside Keeper and immediately consumed by the
    // existing stage operation. It never activates the candidate or exposes activation controls.
    const {sessionToken,...value}=input;
    const activation=await store.previewExecutableActivation(sessionToken,{...value,operationId:randomUUID()},deadline());
    const result=await store.stage(sessionToken,{...value,operationId:randomUUID(),expectedPolicyHash:activation.policyHash,
      activationReviewId:activation.reviewId,expectedActivationReviewHash:activation.reviewHash},deadline());
    if(result.outcome!=='staged'||result.credentialRevision===null)throw new Error('Outside credential change could not be confirmed');
    return {staged:true};
  }});
}
