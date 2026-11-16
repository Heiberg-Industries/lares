import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VAULT_BROKER_REFUSAL_REASONS, vaultBrokerListFolder, vaultBrokerRequest } from '../src/vault-broker-client.js';

const root=mkdtempSync(join(tmpdir(),'lares-vault-client-'));
const socketPath=join(root,'broker.sock'),secretPath=join(root,'runtime-key');
const sockets=new Set<Socket>();
// A reason keeper would never send, shaped like the things a reply must never be able to put in front of the model.
const UNLISTED_REASON='notes/private-plan.md is owned by member-7';
const replies:Record<string,string>={
 ok:'{"ok":true,"value":7}\n',
 oversize:'{"ok":true,"notes":["'+'n'.repeat(256*1024)+'"]}\n',
 known:'{"ok":false,"reason":"deadline"}\n',
 listing:'{"ok":false,"reason":"listing"}\n',
 unlisted:JSON.stringify({ok:false,reason:UNLISTED_REASON})+'\n',
 unauthenticated:'{"ok":false,"reason":"signature"}\n',
 structured:'{"ok":false,"reason":{"deadline":true}}\n',
 bare:'{"ok":false}\n',
 trailing:'{"ok":true}\n{"ok":true}\n',
 garbage:'not json\n',
 empty:'null\n',
 unsettled:'{"reason":"deadline"}\n',
};
let server:Server;
const listInputs:Array<Record<string,unknown>>=[];

beforeAll(async()=>{
 writeFileSync(secretPath,'3'.repeat(64));
 process.env.LARES_AGENT_NAME='proof-agent';process.env.LARES_AGENT_INCARNATION='11111111-1111-4111-8111-111111111111';
 process.env.LARES_RUNTIME_CONTROL_SECRET_FILE=secretPath;process.env.LARES_VAULT_RUNTIME_SOCKET=socketPath;
 // The client hangs up the moment it has refused a reply, often while this side is still writing; as keeper's
 // own server does, absorb that reset instead of letting it surface as an uncaught error.
 server=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));let received='';socket.on('data',chunk=>{received+=chunk.toString('utf8');if(!received.includes('\n'))return;
  const input=JSON.parse(received.slice(0,received.indexOf('\n'))).input,mode=input?.mode;
  // Keeper's paged list, as two pages joined by a cursor, or a listing that never ends.
  if(mode==='pages'||mode==='endless'){listInputs.push(input);const first=input.cursor===undefined;
   socket.end(JSON.stringify(mode==='endless'?{ok:true,notes:['f/x.md'],nextCursor:(input.cursor??0)+1}:first?{ok:true,notes:['f/a.md','f/b.md'],nextCursor:2}:{ok:true,notes:['f/c.md']})+'\n');return;}
  if(mode==='eof'){socket.end();return;}if(mode==='partial'){socket.end('{"ok":');return;}if(mode==='stall')return;
  if(typeof mode==='string'&&mode in replies){socket.end(replies[mode]);return;}
  let index=0;const bytes=Buffer.from('{"ok":true');const timer=setInterval(()=>{if(socket.destroyed){clearInterval(timer);return;}socket.write(bytes.subarray(index,index+1));index++;if(index>=bytes.length)index=0;},150);socket.once('close',()=>clearInterval(timer));
 });});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
});
afterAll(async()=>{for(const socket of sockets)socket.destroy();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
 for(const key of ['LARES_AGENT_NAME','LARES_AGENT_INCARNATION','LARES_RUNTIME_CONTROL_SECRET_FILE','LARES_VAULT_RUNTIME_SOCKET'])delete process.env[key];rmSync(root,{recursive:true,force:true});});

describe('listing a whole folder through keeper pages',()=>{
 it('joins every page, sending the folder and each page\'s cursor',async()=>{
  listInputs.length=0;
  expect(await vaultBrokerListFolder({mode:'pages',area:'shared'},'f')).toEqual(['f/a.md','f/b.md','f/c.md']);
  expect(listInputs).toEqual([{mode:'pages',area:'shared',operation:'list',folder:'f'},{mode:'pages',area:'shared',operation:'list',folder:'f',cursor:2}]);
 });
 it('stops with a named error rather than paging forever',async()=>{
  listInputs.length=0;
  await expect(vaultBrokerListFolder({mode:'endless'},'f',3)).rejects.toThrow('Vault reader unavailable (the folder has too many notes to list)');
  expect(listInputs).toHaveLength(3);
 });
});

describe('Vault broker client response bounds',()=>{
 it.each(['eof','partial','trickle','stall'])('refuses %s without hanging',async mode=>{
  const start=Date.now();await expect(vaultBrokerRequest('test',{mode})).rejects.toThrow('Vault reader unavailable');
  expect(Date.now()-start).toBeLessThan(2600);
 },8000);
});

describe('Vault broker client failure reasons',()=>{
 const message=async(mode:string,timeoutMs?:number)=>{
  try{await vaultBrokerRequest('test',{mode},timeoutMs);}catch(error){return (error as Error).message;}
  throw new Error(`${mode} was not refused`);
 };
 it('still answers a good reply',async()=>{
  expect(await vaultBrokerRequest('test',{mode:'ok'})).toEqual({ok:true,value:7});
 });
 it.each([
  ['eof','Vault reader unavailable (the connection closed early)'],
  ['partial','Vault reader unavailable (the connection closed early)'],
  ['stall','Vault reader unavailable (the keeper did not answer in time)'],
  ['trickle','Vault reader unavailable (the keeper did not answer in time)'],
  ['oversize','Vault reader unavailable (the reply was too large)'],
  ['trailing','Vault reader unavailable (the reply was not understood)'],
  ['garbage','Vault reader unavailable (the reply was not understood)'],
  ['empty','Vault reader unavailable (the reply was not understood)'],
  ['unsettled','Vault reader unavailable (the reply was not understood)'],
  ['known','Vault reader unavailable (the keeper refused: deadline)'],
  ['listing','Vault reader unavailable (the keeper refused: listing)'],
  ['bare','Vault reader unavailable (the keeper refused)'],
 ])('says why %s failed and keeps the words callers match on',async(mode,expected)=>{
  const said=await message(mode,300);
  expect(said).toBe(expected);expect(said).toContain('Vault reader unavailable');
 },8000);
 it.each(['unlisted','unauthenticated','structured'])('ignores a reason keeper does not list (%s) and never repeats it',async mode=>{
  const said=await message(mode);
  expect(said).toBe('Vault reader unavailable (the keeper refused)');
  expect(said).not.toContain('private-plan');expect(said).not.toContain('member-7');expect(said).not.toContain('signature');
 });
 it('names only its own fixed words for every reason on the list',async()=>{
  expect(VAULT_BROKER_REFUSAL_REASONS.size).toBeGreaterThan(0);
  for(const reason of VAULT_BROKER_REFUSAL_REASONS)expect(reason).toMatch(/^[a-z]{2,16}$/);
  for(const kept of ['identity','signature','not found'])expect(VAULT_BROKER_REFUSAL_REASONS.has(kept)).toBe(false);
 });
 it('says the keeper could not be reached when nothing listens, without the socket path',async()=>{
  const missing=join(root,'nobody-listens.sock');process.env.LARES_VAULT_RUNTIME_SOCKET=missing;
  try{
   const said=await message('ok');
   expect(said).toBe('Vault reader unavailable (the connection to the keeper failed)');expect(said).not.toContain(missing);
  }finally{process.env.LARES_VAULT_RUNTIME_SOCKET=socketPath;}
 });
 it('says the request was too large before sending it',async()=>{
  await expect(vaultBrokerRequest('test',{mode:'ok',content:'x'.repeat(256*1024)})).rejects.toThrow('Vault reader unavailable (the request was too large)');
 });
 it('says the agent has no keeper identity when its name or key is unusable',async()=>{
  const name=process.env.LARES_AGENT_NAME;delete process.env.LARES_AGENT_NAME;
  try{await expect(vaultBrokerRequest('test',{mode:'ok'})).rejects.toThrow('Vault reader unavailable (this agent has no keeper identity)');}
  finally{process.env.LARES_AGENT_NAME=name;}
  writeFileSync(secretPath,'not-a-key');
  try{await expect(vaultBrokerRequest('test',{mode:'ok'})).rejects.toThrow('Vault reader unavailable (this agent has no keeper identity)');}
  finally{writeFileSync(secretPath,'3'.repeat(64));}
 });
});
