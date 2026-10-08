import { createConnection } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { serve } from '../lib/socket-server.js';
import { Credentials, registerCredentialActions } from '../lib/credentials.js';
import { CredentialFiles } from '../lib/credential-files.js';
import { initialCredentialRecord } from '../lib/credential-state.js';
import { resetActions, type AuditRecord } from '../lib/actions.js';

const stops: Array<() => Promise<void>> = [], dirs: string[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); resetActions(); for(const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
async function fixture(administrator: string | undefined = 'owner@example.invalid') {
  // A short Unix socket path also works on macOS.
  const dir=realpathSync(mkdtempSync('/tmp/credential-socket-')); dirs.push(dir);
  const read=vi.fn(async()=>initialCredentialRecord()),locked=vi.fn(async()=>{throw new Error('unexpected write');});
  registerCredentialActions(new Credentials({administrator,slot:'notion:shared',binding:'NOTION_TOKEN_FILE',prepared:false,inventoryComplete:false,retainedConsumers:[]}, {read,locked},new CredentialFiles(dir),async()=>[]));
  const audit: AuditRecord[]=[];
  for(const host of [false,true]) {
    const socket=join(dir,host?'host/keeper.sock':'app/keeper.sock');
    stops.push(await serve({socket,host,context:{actor:'host',audit:async record=>{audit.push(record);}},ownership:{uid:process.getuid!(),gid:process.getgid!()}}));
  }
  return {dir,read,locked,audit};
}
function request(path:string,input:unknown):Promise<{ok:boolean;error?:string;result?:unknown}> {
  return new Promise((resolve,reject)=>{
    const socket=createConnection(path);let buffer='';socket.on('error',reject);
    socket.on('connect',()=>socket.write(JSON.stringify(input)+'\n'));
    socket.on('data',chunk=>{buffer+=chunk.toString();if(buffer.includes('\n')){socket.destroy();resolve(JSON.parse(buffer.split('\n')[0]));}});
  });
}
it('independently enforces admin metadata access and mutations on the actual app socket',async()=>{
  const f=await fixture();
  for(const action of ['credential.status','credential.discard']) {
    const response=await request(join(f.dir,'app/keeper.sock'),{action,input:{slot:'notion:shared',...(action.endsWith('discard')?{expectedRevision:0}:{})},actor:'member@example.invalid'});
    expect(response).toEqual({ok:false,error:'Credential administrator required'});
  }
  expect(f.read).not.toHaveBeenCalled();expect(f.locked).not.toHaveBeenCalled();
  expect(await request(join(f.dir,'app/keeper.sock'),{action:'credential.status',input:{slot:'notion:shared'},actor:'owner@example.invalid'})).toMatchObject({ok:true,result:{state:'host-administration-required',guidance:'prepare-managed-slot'}});
  expect(await request(join(f.dir,'app/keeper.sock'),{action:'credential.status',input:{slot:'notion:shared'},actor:'host'})).toMatchObject({ok:false});
});
it('host socket retains separate trusted authority; app cannot invoke host recovery or staging',async()=>{
  const f=await fixture();
  expect(await request(join(f.dir,'host/keeper.sock'),{action:'credential.status',input:{slot:'notion:shared'},actor:'member@example.invalid'})).toMatchObject({ok:true});
  expect(await request(join(f.dir,'app/keeper.sock'),{action:'credential.recover',input:{slot:'notion:shared',expectedRevision:0},actor:'owner@example.invalid'})).toMatchObject({ok:false,error:'keeper: reachable only from the host command'});
  expect(await request(join(f.dir,'app/keeper.sock'),{action:'credential.stage',input:{slot:'notion:shared',token:'synthetic-secret'},actor:'owner@example.invalid'})).toMatchObject({ok:false,error:'keeper: unknown action'});
  expect(JSON.stringify(f.audit)).not.toContain('synthetic-secret');
});
