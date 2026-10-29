"use server";
import { cookies } from 'next/headers';
import { memberAuditAddress,sessionMember } from '../../lib/auth';
import { keeper,KeeperRefusedError } from '../../lib/keeper-client';
import { PgAccountStore } from '@lares/agent-kit/account-store';
import { pool } from '../../lib/db';
import { randomUUID } from 'node:crypto';

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const name=(v:unknown):v is string=>typeof v==='string'&&/^[a-z][a-z0-9-]{1,30}$/.test(v);
async function admitted(){
  const member=await sessionMember((await cookies()).get('lares_session')?.value),token=(await cookies()).get('lares_session')?.value;
  if(!token||!member)throw new Error('Sign in again to manage private metadata access.');
  const audit=await memberAuditAddress(member.id);if(!audit)throw new Error('Sign in again to manage private metadata access.');
  return {sessionToken:token,audit,member};
}

/** Create a member-owned private dataset identity. Both identifiers are generated server-side;
 * neither a model nor the browser can claim another member's dataset. */
export async function createPrivateMetadataDataset():Promise<{accountId:string;generation:number;resourceBindingId:string;datasetId:string}>{
  const {member}=await admitted();
  try{
    const adapter={connectorId:'lares-private-metadata-v1',verifyAccount:async()=>({issuer:'lares-private-metadata-v1',subject:randomUUID(),label:'Private metadata'}),
      verifyResource:async()=>({resourceKind:'dataset',externalId:randomUUID(),providerLabel:'Private metadata dataset'})};
    const store=new PgAccountStore(pool),account=await store.forTrustedAdapter(adapter).createPersonalAccount(member.id,null,undefined,[null]);
    const resources=await store.listResources(member.id,account.id,account.generation);
    if(resources.length!==1||resources[0]!.resourceKind!=='dataset')throw new Error('Invalid private dataset result');
    return {accountId:account.id,generation:account.generation,resourceBindingId:resources[0]!.id,datasetId:resources[0]!.externalId};
  }catch{throw new Error('Private metadata dataset could not be created. Refresh membership and try again.');}
}
export async function previewPrivateMetadataTarget(agentName:string):Promise<{agentName:string;connectionName:string;descriptorFingerprint:string;tools:string[];purpose:string}>{
  const {sessionToken,audit}=await admitted();
  if(!name(agentName))throw new Error('Invalid private metadata agent selection.');
  try{
    const result=await keeper<unknown>('private-metadata.target-preview',{sessionToken,agentName},audit);
    if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Invalid response');
    const row=result as Record<string,unknown>;
    if(Object.keys(row).sort().join(',')!=='agentName,connectionName,descriptorFingerprint,purpose,tools'||row.agentName!==agentName||
        row.connectionName!=='mac-private-metadata'||!hash(row.descriptorFingerprint)||row.purpose!=='read-only private metadata lookup'||
        !Array.isArray(row.tools)||!row.tools.every(t=>typeof t==='string'))throw new Error('Invalid response');
    return {agentName,connectionName:'mac-private-metadata',descriptorFingerprint:row.descriptorFingerprint,purpose:row.purpose,tools:row.tools as string[]};
  }catch(error){return unavailable(error);}
}
function unavailable(error:unknown):never{
  if(error instanceof KeeperRefusedError)throw new Error('Private metadata access was refused. Refresh membership and review the connection again.');
  throw new Error('Private metadata access is unavailable. Refresh membership before trying again.');
}

/** Explicit member consent creates an upload-only credential shown once for manual CLI entry. */
export async function issuePrivateMetadataDevice(value:unknown):Promise<{deviceId:string;deviceGeneration:number;accountGeneration:number;uploadToken:string}>{
  const {sessionToken,audit}=await admitted();
  const input=value as Record<string,unknown>;
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!==
      'accountId,agentName,connectionName,consent,expectedDescriptorFingerprint,resourceBindingId'||
      !uuid(input.accountId)||!uuid(input.resourceBindingId)||!name(input.agentName)||input.connectionName!=='mac-private-metadata'||
      input.consent!==true||!hash(input.expectedDescriptorFingerprint))throw new Error('Invalid private metadata consent request.');
  try{
    const result=await keeper<unknown>('private-metadata.device-issue',{sessionToken,...input},audit);
    if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Invalid response');
    const row=result as Record<string,unknown>;
    if(Object.keys(row).sort().join(',')!=='accountGeneration,deviceGeneration,deviceId,uploadToken'||!uuid(row.deviceId)||
        !Number.isSafeInteger(row.deviceGeneration)||Number(row.deviceGeneration)<1||!Number.isSafeInteger(row.accountGeneration)||
        Number(row.accountGeneration)<0||typeof row.uploadToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(row.uploadToken))throw new Error('Invalid response');
    return {deviceId:row.deviceId,deviceGeneration:row.deviceGeneration as number,accountGeneration:row.accountGeneration as number,uploadToken:row.uploadToken};
  }catch(error){return unavailable(error);}
}

export async function revokePrivateMetadataDevice(deviceId:string,expectedGeneration:number):Promise<{revoked:true;generation:number}>{
  const {sessionToken,audit}=await admitted();
  if(!uuid(deviceId)||!Number.isSafeInteger(expectedGeneration)||expectedGeneration<1)throw new Error('Invalid private metadata revocation request.');
  try{
    const result=await keeper<unknown>('private-metadata.device-revoke',{sessionToken,deviceId,expectedGeneration},audit);
    if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).sort().join(',')!=='generation,revoked'||
        (result as Record<string,unknown>).revoked!==true||!Number.isSafeInteger((result as Record<string,unknown>).generation))throw new Error('Invalid response');
    return {revoked:true,generation:(result as {generation:number}).generation};
  }catch(error){return unavailable(error);}
}

export async function privateMetadataDeviceStatus(agentName:string):Promise<{
  accountId:string;resourceBindingId:string;datasetId:string;accountGeneration:number;deviceId:string;deviceGeneration:number;state:'active'|'revoked'
}|null>{
  const {sessionToken,audit}=await admitted();
  if(!name(agentName))throw new Error('Invalid private metadata agent selection.');
  try{
    const result=await keeper<unknown>('private-metadata.device-status',{sessionToken,agentName},audit);
    if(result===null)return null;
    if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Invalid status');
    const row=result as Record<string,unknown>;
    if(Object.keys(row).sort().join(',')!=='accountGeneration,accountId,datasetId,deviceGeneration,deviceId,resourceBindingId,state'||
      !uuid(row.accountId)||!uuid(row.resourceBindingId)||typeof row.datasetId!=='string'||!row.datasetId||!uuid(row.deviceId)||
      !Number.isSafeInteger(row.accountGeneration)||Number(row.accountGeneration)<0||!Number.isSafeInteger(row.deviceGeneration)||
      Number(row.deviceGeneration)<1||!['active','revoked'].includes(String(row.state)))throw new Error('Invalid status');
    return row as Awaited<ReturnType<typeof privateMetadataDeviceStatus>>;
  }catch(error){return unavailable(error);}
}
