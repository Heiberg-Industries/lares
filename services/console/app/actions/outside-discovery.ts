"use server";
import { cookies } from "next/headers";
import { memberAuditAddress,sessionMember } from "../../lib/auth";
import { keeper, KeeperRefusedError, KeeperUnavailableError } from "../../lib/keeper-client";
import { parseOutsideDiscoveryDocument,parseOutsideDiscoveryInspection,parseOutsideDiscoveryPreview,parseOutsideDiscoveryTargets,
  parseOutsideDescriptorAcceptance,parseOutsideDescriptorPublication,parseOutsideDescriptorReview,
  parseOutsidePendingApply,type OutsidePendingApplyDto,type OutsideDescriptorAcceptanceDto,type OutsideDescriptorPublicationDto,type OutsideDescriptorReviewDto,
  type OutsideDiscoveryDocumentDto,type OutsideDiscoveryInspectionDto,type OutsideDiscoveryPreviewDto,type OutsideDiscoveryTargetDto }
  from "../../lib/outside-discovery-dto";

type RecordValue=Record<string,unknown>;
function record(value:unknown):RecordValue|undefined{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:undefined;}
function strict(value:unknown,keys:string[]):RecordValue{
  const v=record(value);if(!v||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))throw new Error('Invalid discovery input');return v;
}
function isName(value:unknown):value is string{return typeof value==='string'&&/^[a-z][a-z0-9-]{1,30}$/.test(value);}
function isUuid(value:unknown):value is string{return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);}
function isHash(value:unknown):value is string{return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);}
function isSafeInteger(value:unknown,min:number):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;}
async function admitted():Promise<{sessionToken:string;auditActor:string}>{
  const sessionToken=(await cookies()).get("lares_session")?.value;
  const member=await sessionMember(sessionToken);
  if(!sessionToken||!member)throw new Error("Sign in again to manage private discovery.");
  const auditActor=await memberAuditAddress(member.id);
  if(!auditActor)throw new Error("Sign in again to manage private discovery.");
  return {sessionToken,auditActor};
}
function unavailable(error:unknown):never{
  if(error instanceof KeeperRefusedError)throw new Error("Discovery was refused. Refresh membership and review the connection again.");
  throw new Error("Private discovery is unavailable. Refresh membership and try again.");
}

export async function listOutsideDiscoveryTargets():Promise<OutsideDiscoveryTargetDto[]> {
  const {sessionToken,auditActor}=await admitted();
  try{
    const targets=parseOutsideDiscoveryTargets(await keeper<unknown>("outside.discovery-targets",{sessionToken},auditActor));
    if(!targets)throw new Error('Invalid target response');
    return targets;
  }
  catch(error){return unavailable(error);}
}

export async function previewOutsideCredentialApply(value:unknown):Promise<OutsidePendingApplyDto>{
  const {sessionToken,auditActor}=await admitted();
  const raw=strict(value,['agentName','connectionName']);
  if(!isName(raw.agentName)||!isName(raw.connectionName))throw new Error('Invalid credential Apply input');
  try{
    const pending=parseOutsidePendingApply(await keeper<unknown>('outside.candidate-apply-preview',{sessionToken,...raw},auditActor));
    if(!pending)throw new Error('Invalid pending credential response');
    return pending;
  }catch(error){return unavailable(error);}
}

export async function previewOutsideDiscovery(value:unknown):Promise<OutsideDiscoveryPreviewDto>{
  const {sessionToken,auditActor}=await admitted();
  const raw=strict(value,['agentName','connectionName']);
  if(!isName(raw.agentName)||!isName(raw.connectionName))throw new Error('Invalid discovery input');
  const input={agentName:raw.agentName,connectionName:raw.connectionName};
  try{
    const preview=parseOutsideDiscoveryPreview(await keeper<unknown>("outside.discovery-preview",{sessionToken,...input},auditActor));
    if(!preview)throw new Error('Invalid preview response');
    return preview;
  }
  catch(error){return unavailable(error);}
}

export async function discoverOutsideTools(value:unknown):Promise<{state:"complete";document:OutsideDiscoveryDocumentDto}|{state:"unknown"}|{state:"unavailable"}>{
  const {sessionToken,auditActor}=await admitted();
  const input=strict(value,['consent','requestId','claimOperationId','accountId','agentName','connectionName','expectedGeneration',
    'expectedCandidateRevision','expectedDefinitionHash','expectedAccessRevision','expectedDestinationHash','expectedRoutePolicyHash','consentGeneration','credential']);
  if(input.consent!==true||!isUuid(input.requestId)||!isUuid(input.claimOperationId)||!isUuid(input.accountId)||!isName(input.agentName)||
      !isName(input.connectionName)||!isSafeInteger(input.expectedGeneration,0)||input.expectedCandidateRevision!==null&&
        !isSafeInteger(input.expectedCandidateRevision,1)||!isHash(input.expectedDefinitionHash)||!isSafeInteger(input.expectedAccessRevision,1)||
      !isHash(input.expectedDestinationHash)||!isHash(input.expectedRoutePolicyHash)||!isSafeInteger(input.consentGeneration,1)||
      typeof input.credential!=='string'||input.credential.length<1||input.credential.length>4096||Buffer.byteLength(input.credential)>4096)
    throw new Error('Invalid discovery input');
  try{
    const document=parseOutsideDiscoveryDocument(await keeper<unknown>("outside.discover",{sessionToken,...input},auditActor));
    return document?{state:"complete",document}:{state:"unknown"};
  }
  catch(error){
    if(error instanceof KeeperUnavailableError&&error.outcomeMayBeUnknown)return {state:"unknown"};
    if(error instanceof KeeperUnavailableError)return {state:"unavailable"};
    return unavailable(error);
  }
}

export async function inspectOutsideDiscovery(value:unknown):Promise<OutsideDiscoveryInspectionDto>{
  const {sessionToken,auditActor}=await admitted();
  const raw=strict(value,['accountId','agentName','connectionName','requestId','claimOperationId']);
  if(!isUuid(raw.accountId)||!isName(raw.agentName)||!isName(raw.connectionName)||!isUuid(raw.requestId)||!isUuid(raw.claimOperationId))
    throw new Error('Invalid discovery input');
  const input={accountId:raw.accountId,agentName:raw.agentName,connectionName:raw.connectionName,requestId:raw.requestId,claimOperationId:raw.claimOperationId};
  try{
    const inspection=parseOutsideDiscoveryInspection(await keeper<unknown>("outside.discovery-inspect",{sessionToken,...input},auditActor));
    return inspection??{state:'unresolved'};
  }
  catch(error){return unavailable(error);}
}

export async function previewOutsideDescriptorReview(value:unknown):Promise<OutsideDescriptorReviewDto>{
  const {sessionToken,auditActor}=await admitted();
  const raw=strict(value,['accountId','agentName','connectionName','requestId','claimOperationId']);
  if(!isUuid(raw.accountId)||!isName(raw.agentName)||!isName(raw.connectionName)||!isUuid(raw.requestId)||!isUuid(raw.claimOperationId))
    throw new Error('Invalid discovery review input');
  try{
    const review=parseOutsideDescriptorReview(await keeper<unknown>('outside.discovery-review-preview',{sessionToken,...raw},auditActor));
    if(!review)throw new Error('Invalid descriptor review response');
    return review;
  }catch(error){return unavailable(error);}
}

export async function publishOutsideDescriptorReview(value:unknown):Promise<OutsideDescriptorPublicationDto>{
  const {sessionToken,auditActor}=await admitted();
  const raw=strict(value,['accountId','agentName','connectionName','requestId','claimOperationId','expectedGeneration','expectedDescriptorHash']);
  if(!isUuid(raw.accountId)||!isName(raw.agentName)||!isName(raw.connectionName)||!isUuid(raw.requestId)||!isUuid(raw.claimOperationId)||
      !isSafeInteger(raw.expectedGeneration,1)||!isHash(raw.expectedDescriptorHash))throw new Error('Invalid discovery review input');
  try{
    const publication=parseOutsideDescriptorPublication(await keeper<unknown>('outside.discovery-review-publish',{sessionToken,...raw},auditActor));
    if(!publication)throw new Error('Invalid descriptor publication response');
    return publication;
  }catch(error){return unavailable(error);}
}

export async function acceptOutsideDescriptorReview(value:unknown):Promise<OutsideDescriptorAcceptanceDto>{
  const {sessionToken,auditActor}=await admitted();
  const raw=strict(value,['accountId','agentName','connectionName','requestId','claimOperationId','publicationId','expectedPublicationHash']);
  if(!isUuid(raw.accountId)||!isName(raw.agentName)||!isName(raw.connectionName)||!isUuid(raw.requestId)||!isUuid(raw.claimOperationId)||
      !isUuid(raw.publicationId)||!isHash(raw.expectedPublicationHash))throw new Error('Invalid discovery review input');
  try{
    const {agentName,connectionName,requestId,claimOperationId,...publication}=raw;
    // This slice is custodian-only: the discovery projection check also verifies that the
    // current Keeper session belongs to the member who submitted this credential.
    const preview=await keeper<unknown>('outside.discovery-review-preview',{sessionToken,accountId:raw.accountId,agentName,connectionName,requestId,claimOperationId},auditActor);
    if(!parseOutsideDescriptorReview(preview))throw new Error('Invalid descriptor review response');
    const acceptance=parseOutsideDescriptorAcceptance(await keeper<unknown>('outside.discovery-review-accept',{sessionToken,...publication},auditActor));
    if(!acceptance)throw new Error('Invalid descriptor acceptance response');
    return acceptance;
  }catch(error){return unavailable(error);}
}

export async function stageOutsideCredentialCandidate(value:unknown):Promise<{staged:true;activationReviewId:string;activationReviewHash:string;expectedPolicyHash:string;stageOperationId:string;candidateRevision:number}>{
  const {sessionToken,auditActor}=await admitted();
  const keys=['accountId','agentName','connectionName','requestId','claimOperationId','publicationId','acceptanceId','expectedGeneration',
    'expectedCandidateRevision','expectedConsentGeneration','expectedDefinitionHash','expectedAccessRevision','expectedPublicationHash','expectedAcceptanceHash'];
  const raw=strict(value,keys);
  if(!isUuid(raw.accountId)||!isName(raw.agentName)||!isName(raw.connectionName)||!isUuid(raw.requestId)||!isUuid(raw.claimOperationId)||
      !isUuid(raw.publicationId)||!isUuid(raw.acceptanceId)||!isSafeInteger(raw.expectedGeneration,1)||
      raw.expectedCandidateRevision!==null&&!isSafeInteger(raw.expectedCandidateRevision,1)||!isSafeInteger(raw.expectedConsentGeneration,1)||
      !isHash(raw.expectedDefinitionHash)||!isSafeInteger(raw.expectedAccessRevision,1)||!isHash(raw.expectedPublicationHash)||!isHash(raw.expectedAcceptanceHash))
    throw new Error('Invalid discovery review input');
  try{
    const result=await keeper<unknown>('outside.candidate-stage',{sessionToken,...raw},auditActor);
    const response=record(result);
    if(!response||Object.keys(response).sort().join(',')!=='activationReviewHash,activationReviewId,candidateRevision,expectedPolicyHash,stageOperationId,staged'||response.staged!==true||
        !isUuid(response.activationReviewId)||!isHash(response.activationReviewHash)||!isHash(response.expectedPolicyHash)||!isUuid(response.stageOperationId)||!isSafeInteger(response.candidateRevision,1))
      throw new Error('Invalid staging response');
    return {staged:true,activationReviewId:response.activationReviewId,activationReviewHash:response.activationReviewHash,
      expectedPolicyHash:response.expectedPolicyHash,stageOperationId:response.stageOperationId,candidateRevision:response.candidateRevision};
  }catch(error){return unavailable(error);}
}

export async function applyOutsideCredentialCandidate(value:unknown):Promise<{state:'applied';credentialRevision:number}>{
  const {sessionToken,auditActor}=await admitted();
  const keys=['accountId','agentName','connectionName','requestId','claimOperationId','publicationId','acceptanceId','expectedGeneration',
    'expectedCandidateRevision','expectedConsentGeneration','expectedDefinitionHash','expectedAccessRevision','expectedPublicationHash',
    'expectedAcceptanceHash','expectedPolicyHash','activationReviewId','activationReviewHash','stageOperationId','candidateRevision'];
  const raw=strict(value,keys);
  if(!isUuid(raw.accountId)||!isName(raw.agentName)||!isName(raw.connectionName)||!isUuid(raw.requestId)||!isUuid(raw.claimOperationId)||
      !isUuid(raw.publicationId)||!isUuid(raw.acceptanceId)||!isSafeInteger(raw.expectedGeneration,1)||
      raw.expectedCandidateRevision!==null&&!isSafeInteger(raw.expectedCandidateRevision,1)||!isSafeInteger(raw.expectedConsentGeneration,1)||
      !isHash(raw.expectedDefinitionHash)||!isSafeInteger(raw.expectedAccessRevision,1)||!isHash(raw.expectedPublicationHash)||
      !isHash(raw.expectedAcceptanceHash)||!isHash(raw.expectedPolicyHash)||!isUuid(raw.activationReviewId)||!isHash(raw.activationReviewHash)||
      !isUuid(raw.stageOperationId)||!isSafeInteger(raw.candidateRevision,1))throw new Error('Invalid credential Apply input');
  try{
    const result=record(await keeper<unknown>('outside.candidate-apply',{sessionToken,...raw},auditActor,{timeoutMs:90_000}));
    if(!result||result.kind!=='apply'||result.outcome!=='applied'||result.credentialRevision!==raw.candidateRevision)
      throw new Error('Invalid credential Apply response');
    return {state:'applied',credentialRevision:raw.candidateRevision};
  }catch(error){return unavailable(error);}
}
