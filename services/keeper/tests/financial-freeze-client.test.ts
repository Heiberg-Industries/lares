import {afterEach,expect,it} from 'vitest';
import {createServer,type Server,type Socket} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requestFinancialFreeze} from '../bin/budget-financial.js';
const roots:string[]=[],servers:Server[]=[],clients:Socket[]=[];
async function server(handle:(socket:Socket)=>void){const root=mkdtempSync(join(tmpdir(),'lares-freeze-'));roots.push(root);const socket=join(root,'host.sock');const s=createServer({allowHalfOpen:true},client=>{clients.push(client);handle(client);});servers.push(s);await new Promise<void>(resolve=>s.listen(socket,resolve));return socket;}
afterEach(async()=>{for(const client of clients.splice(0))client.destroy();for(const s of servers.splice(0))await new Promise<void>(resolve=>s.close(()=>resolve()));for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('accepts the actual half-closed request then bounded host acknowledgement',async()=>{
  let request='';const socket=await server(client=>{client.on('data',chunk=>request+=chunk.toString());client.on('end',()=>client.end(JSON.stringify({ok:true,result:{frozen:true}})+'\n'));});
  await expect(requestFinancialFreeze(socket)).resolves.toBe(true);expect(JSON.parse(request)).toEqual({action:'budget.freeze',input:{}});
});
it('allows lock-acquiring fallback only for an absent listener',async()=>{
  const root=mkdtempSync(join(tmpdir(),'lares-freeze-'));roots.push(root);await expect(requestFinancialFreeze(join(root,'missing.sock'))).resolves.toBe(false);
});
it.each(['refused','early-end','oversize'])('does not permit fallback for %s',async mode=>{
  const socket=await server(client=>{client.on('data',()=>{});client.on('end',()=>client.end(mode==='refused'?'{"ok":false}\n':mode==='oversize'?'x'.repeat(4097):''));});
  await expect(requestFinancialFreeze(socket)).rejects.toThrow();
});
it('enforces an absolute deadline even while the peer keeps sending bytes',async()=>{
  let timer:ReturnType<typeof setInterval>|undefined;
  const socket=await server(client=>{client.on('data',()=>{});client.on('error',()=>{});timer=setInterval(()=>client.write(' '),2);});
  try{await expect(requestFinancialFreeze(socket,30)).rejects.toThrow('timed out');}finally{if(timer)clearInterval(timer);}
});
