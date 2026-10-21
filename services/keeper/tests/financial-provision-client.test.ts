import {afterEach,expect,it} from 'vitest';
import {createServer,type Server,type Socket} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requestFinancialProvision} from '../bin/budget-financial.js';

const roots:string[]=[],servers:Server[]=[],clients:Socket[]=[];
async function server(handle:(socket:Socket)=>void){const root=mkdtempSync(join(tmpdir(),'lares-provision-'));roots.push(root);const socket=join(root,'host.sock');const value=createServer({allowHalfOpen:true},client=>{clients.push(client);handle(client);});servers.push(value);await new Promise<void>(resolve=>value.listen(socket,resolve));return socket;}
const plan={installationCap:'125.5',memberIds:['member-a','member-b']};
const result={state:'closed',reason:'unreconciled',members:2,accountsCreated:3,windowsCreated:3};
afterEach(async()=>{for(const client of clients.splice(0))client.destroy();for(const value of servers.splice(0))await new Promise<void>(resolve=>value.close(()=>resolve()));for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it('sends the bounded strict plan and waits for a complete host acknowledgement',async()=>{
  let request='';const socket=await server(client=>{client.on('data',chunk=>request+=chunk.toString());client.on('end',()=>client.end(JSON.stringify({ok:true,result})+'\n'));});
  await expect(requestFinancialProvision(socket,plan)).resolves.toEqual(result);
  expect(JSON.parse(request)).toEqual({action:'budget.provision-accounts',input:plan});
});

it.each([
  ['refused','{"ok":false}\n'],
  ['missing EOF','{"ok":true,"result":{"state":"closed","reason":"unreconciled","members":2,"accountsCreated":3,"windowsCreated":3}}'],
  ['multiple frames',JSON.stringify({ok:true,result})+'\n{}\n'],
  ['wrong state',JSON.stringify({ok:true,result:{...result,state:'open'}})+'\n'],
  ['wrong member count',JSON.stringify({ok:true,result:{...result,members:1}})+'\n'],
] as const)('does not expose success for %s',async(_name,response)=>{
  const socket=await server(client=>{client.on('data',()=>{});client.on('end',()=>client.end(response));});
  await expect(requestFinancialProvision(socket,plan)).rejects.toThrow();
});

it('rejects noncanonical, zero, duplicate, and oversized plans before connecting',async()=>{
  await expect(requestFinancialProvision('/missing.sock',{installationCap:'0',memberIds:['member-a']})).rejects.toThrow();
  await expect(requestFinancialProvision('/missing.sock',{installationCap:'01',memberIds:['member-a']})).rejects.toThrow();
  await expect(requestFinancialProvision('/missing.sock',{installationCap:'1',memberIds:['member-a','member-a']})).rejects.toThrow();
  await expect(requestFinancialProvision('/missing.sock',{installationCap:'1',memberIds:Array.from({length:17},(_,i)=>`member-${i}`)})).rejects.toThrow();
});

it('enforces an absolute deadline while the peer keeps the socket open',async()=>{
  const socket=await server(client=>{client.on('data',()=>{});});
  await expect(requestFinancialProvision(socket,plan,25)).rejects.toThrow('timed out');
});
