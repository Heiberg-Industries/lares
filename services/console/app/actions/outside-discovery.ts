"use server";
import { cookies } from "next/headers";
import { memberAuditAddress,sessionMember } from "../../lib/auth";
import { keeper, KeeperRefusedError, KeeperUnavailableError } from "../../lib/keeper-client";
import { parseOutsideDiscoveryDocument,parseOutsideDiscoveryInspection,parseOutsideDiscoveryPreview,parseOutsideDiscoveryTargets,
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
