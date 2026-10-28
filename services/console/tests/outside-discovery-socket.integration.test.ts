import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({member:vi.fn(),auditAddress:vi.fn(),cookie:vi.fn()}));
// The actor-boundary test uses a real socket; sandboxed test runs cannot change ownership or mode.
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,chown:async()=>{},chmod:async()=>{}};
});
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:mocks.cookie()})})}));
vi.mock('../lib/auth',()=>({sessionMember:mocks.member,memberAuditAddress:mocks.auditAddress}));
import { registerAction,resetActions,type AuditRecord } from '../../keeper/lib/actions.js';
import { registerHumanOutsideDiscoveryActions } from '../../keeper/lib/outside-discovery-actions.js';
import { serve } from '../../keeper/lib/socket-server.js';
import { KeeperRefusedError,keeper } from '../lib/keeper-client.js';
import { listOutsideDiscoveryTargets } from '../app/actions/outside-discovery.js';

const sessionToken='S'.repeat(43),memberId='11111111-1111-4111-8111-111111111111',auditActor='member@example.test';
let directory:string,stop:(()=>Promise<void>)|undefined;
const records:AuditRecord[]=[],listTargets=vi.fn(async()=>[{agentName:'worker',connectionName:'connector',credentialStatus:{
  state:'unavailable',reviewPending:false,applyPending:false,accountId:null,generation:null,hasCredentialMaterial:false,
  activeRevision:null,candidateRevision:null,discoveryRevision:null}}]);
const ownerOnly=vi.fn(async()=>({ok:true}));
beforeEach(async()=>{
  resetActions();records.length=0;listTargets.mockClear();ownerOnly.mockClear();
  mocks.cookie.mockReset().mockReturnValue(sessionToken);
  mocks.member.mockReset().mockResolvedValue({id:memberId,role:'member',status:'active'});
  mocks.auditAddress.mockReset().mockResolvedValue(auditActor);
  directory=await mkdtemp('/tmp/console-member-socket-');
  const socket=join(directory,'keeper.sock');
  registerHumanOutsideDiscoveryActions({listHumanDiscoveryTargets:listTargets} as never);
  const emptyInput={safeParse:(value:unknown)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===0?
    {success:true as const,data:{}}:{success:false as const,error:new Error('invalid input')}};
  registerAction({name:'owner.only-test',hostOnly:true,input:emptyInput as never,run:ownerOnly});
  stop=await serve({socket,host:false,context:{actor:'keeper',audit:async record=>{records.push(record);}},
    ownership:{uid:process.getuid!(),gid:process.getgid!()}});
  vi.stubEnv('LARES_KEEPER_SOCKET',socket);
});
afterEach(async()=>{
  await stop?.();stop=undefined;resetActions();vi.unstubAllEnvs();
  await rm(directory,{recursive:true,force:true});
});

it('sends the server-derived audit address for a UUID member through the real app socket',async()=>{
  await expect(listOutsideDiscoveryTargets()).resolves.toEqual([{agentName:'worker',connectionName:'connector',credentialStatus:{
    state:'unavailable',reviewPending:false,applyPending:false,accountId:null,generation:null,hasCredentialMaterial:false,
    activeRevision:null,candidateRevision:null,discoveryRevision:null}}]);
  expect(mocks.member).toHaveBeenCalledWith(sessionToken);
  expect(mocks.auditAddress).toHaveBeenCalledWith(memberId);
  expect(listTargets).toHaveBeenCalledTimes(1);
  expect(records.find(record=>record.action==='outside.discovery-targets')?.actor).toBe(auditActor);
  expect(records.some(record=>record.actor===memberId)).toBe(false);
  await expect(keeper('outside.discovery-targets',{sessionToken},memberId)).rejects.toBeInstanceOf(KeeperRefusedError);
  expect(listTargets).toHaveBeenCalledTimes(1);
});

it('keeps missing sessions and host-only actions refused on the member path',async()=>{
  mocks.member.mockResolvedValueOnce(null);
  await expect(listOutsideDiscoveryTargets()).rejects.toThrow(/Sign in again/);
  expect(mocks.auditAddress).not.toHaveBeenCalled();expect(listTargets).not.toHaveBeenCalled();
  await expect(keeper('owner.only-test',{},auditActor)).rejects.toBeInstanceOf(KeeperRefusedError);
  expect(ownerOnly).not.toHaveBeenCalled();
});
