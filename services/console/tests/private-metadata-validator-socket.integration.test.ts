import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,chown:async()=>{},chmod:async()=>{}};
});
import {KeeperRefusedError as KeeperActionRefusedError,type AuditRecord,registerAction,resetActions} from '../../keeper/lib/actions.js';
import {registerPrivateMetadataActions} from '../../keeper/lib/private-metadata.js';
import {serve} from '../../keeper/lib/socket-server.js';
import {POST} from '../app/api/private-metadata/credential/route';
import {middleware} from '../middleware';

const valid='V'.repeat(43),actor='private-metadata-server@localhost.invalid';
let directory:string,stop:(()=>Promise<void>)|undefined;
const records:AuditRecord[]=[];
beforeEach(async()=>{
  resetActions();records.length=0;directory=await mkdtemp('/tmp/private-metadata-validator-');
  registerPrivateMetadataActions({validatePrivateMetadataCredential:async(token:string,scope:'upload'|'read')=>{
    if(token!=='V'.repeat(43))throw new KeeperActionRefusedError('Private metadata credential refused');
    return {accountId:'account-from-token',datasetId:'dataset-from-token',scope,generation:3};
  }} as never);
  const socket=join(directory,'keeper.sock');
  stop=await serve({socket,host:false,context:{actor:'keeper',audit:async record=>{records.push(record);}},
    ownership:{uid:process.getuid!(),gid:process.getgid!()}});
  vi.stubEnv('LARES_KEEPER_SOCKET',socket);
});
afterEach(async()=>{await stop?.();stop=undefined;resetActions();vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});

const request=(token:string)=>new NextRequest('https://console.example/api/private-metadata/credential',{
  method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{"scope":"read"}'});

it('validates through actual middleware, Console socket and Keeper action with server-derived identity',async()=>{
  const req=request(valid);
  expect((await middleware(req)).headers.get('x-middleware-next')).toBe('1');
  const response=await POST(req);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ok:true,accountId:'account-from-token',datasetId:'dataset-from-token',scope:'read',generation:3});
  expect(records[0]?.actor).toBe(actor);
  expect(JSON.stringify(records)).not.toContain(valid);
  expect(records[0]?.input).toEqual({token:'<redacted>',scope:'read'});
});

it('turns a fixed token refusal into uniform 401 while preserving relay failures as unavailable',async()=>{
  const invalid=request('I'.repeat(43));
  await middleware(invalid);
  await expect(POST(invalid)).resolves.toMatchObject({status:401});
  expect(records.at(-1)?.outcome).toBe('refused');
  expect(JSON.stringify(records)).not.toContain('I'.repeat(43));
});
