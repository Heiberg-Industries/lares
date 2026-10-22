import {afterEach,expect,it} from 'vitest';
import {createServer,type Server,type Socket} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requestNativeCleanup} from '../bin/budget-financial.js';

const roots:string[]=[],servers:Server[]=[],clients:Socket[]=[];
async function server(handle:(socket:Socket)=>void){const root=mkdtempSync(join(tmpdir(),'lares-native-cleanup-'));roots.push(root);const socket=join(root,'host.sock');const value=createServer({allowHalfOpen:true},client=>{clients.push(client);handle(client);});servers.push(value);await new Promise<void>(resolve=>value.listen(socket,resolve));return socket;}
afterEach(async()=>{for(const client of clients.splice(0))client.destroy();for(const value of servers.splice(0))await new Promise<void>(resolve=>value.close(()=>resolve()));for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it('sends one host-only cleanup request and accepts a truthful pending count',async()=>{
  let request='';const socket=await server(client=>{client.on('data',chunk=>request+=chunk.toString());client.on('end',()=>client.end('{"ok":true,"result":{"status":"pending","remaining":2}}\n'));});
  await expect(requestNativeCleanup(socket)).resolves.toEqual({status:'pending',remaining:2});
  expect(JSON.parse(request)).toEqual({action:'budget.cleanup-native',input:{}});
});

it.each([
  ['refused','{"ok":false}\n'],
  ['missing EOF','{"ok":true,"result":{"status":"complete","remaining":0}}'],
  ['multiple frames','{"ok":true,"result":{"status":"complete","remaining":0}}\n{}\n'],
  ['impossible complete count','{"ok":true,"result":{"status":"complete","remaining":1}}\n'],
  ['unknown count','{"ok":true,"result":{"status":"pending","remaining":null}}\n'],
] as const)('does not acknowledge %s',async(_name,response)=>{
  const socket=await server(client=>{client.on('data',()=>{});client.on('end',()=>client.end(response));});
  await expect(requestNativeCleanup(socket)).rejects.toThrow();
});

it('bounds trickled replies by an absolute deadline',async()=>{
  let timer:ReturnType<typeof setInterval>|undefined;const socket=await server(client=>{client.on('data',()=>{});client.on('error',()=>{});timer=setInterval(()=>client.write(' '),2);});
  try{await expect(requestNativeCleanup(socket,25)).rejects.toThrow('timed out');}finally{if(timer)clearInterval(timer);}
});

it('does not fall back to a local cleanup write when the host listener is absent',async()=>{
  const root=mkdtempSync(join(tmpdir(),'lares-native-cleanup-dead-'));roots.push(root);
  await expect(requestNativeCleanup(join(root,'missing.sock'),25)).rejects.toThrow();
});
