import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createCipheriv,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {loadOutsideCustodyKey,OutsideCustodyStore} from '../lib/outside-custody.js';

const mocks=vi.hoisted(()=>({
  transaction:vi.fn(),
  query:vi.fn(),
  requireBinding:vi.fn(),
  captureUse:vi.fn(),
  captureUseWithExpiry:vi.fn(),
  retainDeadline:vi.fn(),
  deadlines:vi.fn(),
  keyLstat:vi.fn(),
  keyOpen:vi.fn(),
  keyFstat:vi.fn(),
  keyRead:vi.fn(),
  keyClose:vi.fn(),
}));
vi.mock('node:fs',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs')>();
  return {...actual,lstatSync:mocks.keyLstat,openSync:mocks.keyOpen,fstatSync:mocks.keyFstat,readFileSync:mocks.keyRead,closeSync:mocks.keyClose};
});
vi.mock('@lares/agent-kit/console-source-transaction',async importOriginal=>{
  const actual=await importOriginal<typeof import('@lares/agent-kit/console-source-transaction')>();
  return {...actual,consoleSourceTransaction:mocks.transaction,checkConsoleSourceDeadlines:mocks.deadlines,retainConsoleSourceDeadline:mocks.retainDeadline};
});
vi.mock('@lares/agent-kit/console-turn-authority',()=>({requireConsoleSessionBinding:mocks.requireBinding}));
vi.mock('@lares/agent-kit/grant-store',()=>({PgGrantStore:class{captureUse(...args:unknown[]){return mocks.captureUse(...args);}captureUseWithExpiry(...args:unknown[]){return mocks.captureUseWithExpiry(...args);}}}));

const accountId='00000000-0000-4000-8000-000000000101';
const operationId='00000000-0000-4000-8000-000000000102';
const originalOperationId='00000000-0000-4000-8000-000000000103';
const stageOperationA='00000000-0000-4000-8000-000000000110';
const stageOperationB='00000000-0000-4000-8000-000000000111';
const applyOperationA='00000000-0000-4000-8000-000000000112';
const applyOperationB='00000000-0000-4000-8000-000000000113';
const binding={incarnation:'00000000-0000-4000-8000-000000000104',admissionNonce:'A'.repeat(43),sessionId:'session',agent:'worker',memberId:'member-1'};
const key=Buffer.alloc(32,7),credential=Buffer.from('short-lived outside credential');
const sourceClient={query:(...args:unknown[])=>mocks.query(...args)};
const storeKey=(store:OutsideCustodyStore)=>(store as unknown as {key:Buffer}).key;
const keyPath='/srv/keeper/keys/decoder.key';
const directoryStat=(uid=0,gid=0,mode=0o755,symbolic=false)=>({uid,gid,mode,isSymbolicLink:()=>symbolic,isDirectory:()=>!symbolic});
const fileStat=(overrides:Partial<{uid:number;gid:number;mode:number;nlink:number;size:number;regular:boolean}>={})=>{
  const value={uid:0,gid:0,mode:0o100400,nlink:1,size:32,regular:true,...overrides};
  return {...value,isFile:()=>value.regular};
};
function prepareKeyLoader(options:{parent?:ReturnType<typeof directoryStat>;ancestor?:ReturnType<typeof directoryStat>;file?:ReturnType<typeof fileStat>;read?:Buffer;openError?:Error;closeError?:Error}={}):void{
  mocks.keyLstat.mockImplementation((path:string)=>path==='/srv'?options.ancestor??directoryStat():path==='/srv/keeper'?directoryStat():options.parent??directoryStat(0,0,0o700));
  mocks.keyOpen.mockImplementation(()=>{if(options.openError)throw options.openError;return 77;});
  mocks.keyFstat.mockReturnValue(options.file??fileStat());
  mocks.keyRead.mockReturnValue(options.read??Buffer.alloc(32,9));
  mocks.keyClose.mockImplementation(()=>{if(options.closeError)throw options.closeError;});
}

function encryptedFixture(plaintext:Buffer){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(['lares-outside-custody-v1','member-1',accountId,'worker',1,1,7,originalOperationId])));
  return {nonce,ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()])};
}
function activeCredentialReads(encrypted:ReturnType<typeof encryptedFixture>,deferred?:{waitFor:'head'|'identity';entered:()=>void;wait:Promise<void>}):void{
  mocks.query.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM outside_custody_accounts')){
      if(deferred?.waitFor==='head'){deferred.entered();await deferred.wait;}
      return {rows:[{account_id:accountId,owner_member_id:'member-1',resource_id:'worker',generation:'1',active_revision:'1',candidate_revision:null,consent_generation:'7',state:'active'}]};
    }
    if(sql.includes('FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2'))return {rows:[{credential_revision:'1',generation:'1',consent_generation:'7',operation_id:originalOperationId,...encrypted}]};
    if(sql.includes('SELECT pg_backend_pid()')){
      if(deferred?.waitFor==='identity'){deferred.entered();await deferred.wait;}
      return {rows:[{pid:44,user:'lares_outside_custody',sessionUser:'lares_outside_custody'}]};
    }
    throw new Error(`Unexpected SQL in expiry test: ${sql}`);
  });
}
function candidateStore(){
  type CandidateHead={account_id:string;owner_member_id:string;resource_id:string;generation:number;active_revision:number|null;candidate_revision:number|null;consent_generation:number;state:'active'|'revoked'};
  type CandidateRevision={credential_revision:string;generation:string;consent_generation:string;operation_id:string;nonce:Buffer;ciphertext:Buffer};
  type CandidateOperation={account_id:string;owner_member_id:string;operation_kind:'stage'|'apply'|'rollback'|'revoke';request_hash:Buffer;expected_generation:string;result_generation:string;credential_revision:string|null;outcome:'staged'|'applied'|'rolled-back'|'revoked'};
  let head:CandidateHead|undefined;
  let maxRevision=0;
  const revisions=new Map<number,CandidateRevision>(),operations=new Map<string,CandidateOperation>(),statements:Array<{sql:string;params:unknown[]}>=[];
  const row=()=>head&&{...head,generation:String(head.generation),active_revision:head.active_revision===null?null:String(head.active_revision),candidate_revision:head.candidate_revision===null?null:String(head.candidate_revision),consent_generation:String(head.consent_generation)};
  mocks.query.mockImplementation(async(sql:string,params:unknown[]=[]):Promise<{rows:Array<Record<string,unknown>>;rowCount:number}>=>{
    statements.push({sql,params});
    if(sql.includes('FROM outside_custody_operations WHERE operation_id=$1')){
      const prior=operations.get(String(params[0]));
      return {rows:prior?[prior as unknown as Record<string,unknown>]:[],rowCount:prior?1:0};
    }
    if(sql.includes('count(*)::text AS count FROM outside_custody_operations'))return {rows:[{count:String(operations.size)}],rowCount:1};
    if(sql.includes('count(*)::text AS count FROM outside_custody_revisions'))return {rows:[{count:String(revisions.size)}],rowCount:1};
    if(sql.includes('FROM outside_custody_accounts WHERE account_id=$1'))return {rows:row()?[row() as Record<string,unknown>]:[],rowCount:head?1:0};
    if(sql.includes('INSERT INTO outside_custody_accounts')){
      head={account_id:String(params[0]),owner_member_id:String(params[1]),resource_id:String(params[2]),generation:1,active_revision:null,candidate_revision:null,consent_generation:Number(params[3]),state:'active'};
      return {rows:[row() as Record<string,unknown>],rowCount:1};
    }
    if(sql.includes('SELECT COALESCE(max(credential_revision),0)+1 AS revision'))return {rows:[{revision:String(maxRevision+1)}],rowCount:1};
    if(sql.includes('INSERT INTO outside_custody_revisions')){
      const revision=Number(params[2]);maxRevision=Math.max(maxRevision,revision);
      revisions.set(revision,{credential_revision:String(revision),generation:String(params[3]),consent_generation:String(params[4]),operation_id:String(params[5]),nonce:params[6] as Buffer,ciphertext:params[7] as Buffer});
      return {rows:[],rowCount:1};
    }
    if(sql.includes('UPDATE outside_custody_accounts SET candidate_revision=$2')){
      if(!head||head.account_id!==params[0]||head.owner_member_id!==params[3]||head.generation!==Number(params[4])||head.candidate_revision!==params[5]||head.state!=='active')return {rows:[],rowCount:0};
      head.candidate_revision=Number(params[1]);head.consent_generation=Number(params[2]);return {rows:[],rowCount:1};
    }
    if(sql.includes('SELECT credential_revision::text,generation::text,consent_generation::text,operation_id,nonce,ciphertext')){
      const revision=revisions.get(Number(params[1]));return {rows:revision?[revision as unknown as Record<string,unknown>]:[],rowCount:revision?1:0};
    }
    if(sql.includes("SET generation=$2,active_revision=NULL,candidate_revision=NULL,state='revoked'")){
      if(!head||head.account_id!==params[0]||head.generation!==Number(params[2])||head.state!=='active')return {rows:[],rowCount:0};
      head.generation=Number(params[1]);head.active_revision=null;head.candidate_revision=null;head.state='revoked';return {rows:[],rowCount:1};
    }
    if(sql.includes('SET generation=$2,active_revision=$3,candidate_revision=NULL,consent_generation=$4')&&!sql.includes('AND candidate_revision=$3')){
      if(!head||head.account_id!==params[0]||head.generation!==Number(params[4])||head.state!=='active')return {rows:[],rowCount:0};
      head.generation=Number(params[1]);head.active_revision=Number(params[2]);head.candidate_revision=null;head.consent_generation=Number(params[3]);return {rows:[],rowCount:1};
    }
    if(sql.includes('UPDATE outside_custody_accounts SET generation=$2,active_revision=$3,candidate_revision=NULL')){
      if(!head||head.account_id!==params[0]||head.generation!==Number(params[4])||head.candidate_revision!==Number(params[2])||head.state!=='active')return {rows:[],rowCount:0};
      head.generation=Number(params[1]);head.active_revision=Number(params[2]);head.candidate_revision=null;head.consent_generation=Number(params[3]);return {rows:[],rowCount:1};
    }
    if(sql.includes('INSERT INTO outside_custody_operations')){
      operations.set(String(params[0]),{account_id:String(params[1]),owner_member_id:String(params[2]),operation_kind:params[3] as CandidateOperation['operation_kind'],request_hash:params[4] as Buffer,expected_generation:String(params[5]),result_generation:String(params[6]),credential_revision:params[7]===null?null:String(params[7]),outcome:params[8] as CandidateOperation['outcome']});
      return {rows:[],rowCount:1};
    }
    throw new Error(`Unexpected candidate CAS SQL: ${sql}`);
  });
  return {store:new OutsideCustodyStore({} as never,key),state:()=>({head,revisions,operations,statements}),removeHead:()=>{head=undefined;}};
}

beforeEach(()=>{
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async(_pool:unknown,work:(client:unknown)=>Promise<unknown>)=>work(sourceClient));
  mocks.query.mockResolvedValue({rows:[],rowCount:0});
  mocks.requireBinding.mockResolvedValue(binding);
  mocks.captureUse.mockResolvedValue(7);
  mocks.captureUseWithExpiry.mockResolvedValue({accessRevision:7,validUntil:null});
  mocks.retainDeadline.mockReturnValue(undefined);
  mocks.deadlines.mockResolvedValue(undefined);
});
afterEach(()=>vi.restoreAllMocks());

it('loads only a root-owned 0400 single-link key from a root-only Keeper directory and closes the descriptor',()=>{
  prepareKeyLoader();
  const loaded=loadOutsideCustodyKey(keyPath);
  expect(loaded).toEqual(Buffer.alloc(32,9));
  expect(mocks.keyOpen).toHaveBeenCalledWith(keyPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  expect(mocks.keyRead).toHaveBeenCalledWith(77);
  expect(mocks.keyClose).toHaveBeenCalledWith(77);
});

it.each([
  '/srv//keeper/keys/decoder.key',
  '/srv/keeper/keys/./decoder.key',
  '/srv/keeper/keys/../keys/decoder.key',
  '/decoder.key',
  'srv/keeper/keys/decoder.key',
])('refuses noncanonical, root-level, or relative key path %s before filesystem access',path=>{
  prepareKeyLoader();
  expect(()=>loadOutsideCustodyKey(path)).toThrow('Outside credential is not available');
  expect(mocks.keyLstat).not.toHaveBeenCalled();
  expect(mocks.keyOpen).not.toHaveBeenCalled();
  expect(mocks.keyRead).not.toHaveBeenCalled();
});

it.each([
  ['shared runtime ownership',fileStat({gid:10_001,mode:0o100440})],
  ['group-readable mode',fileStat({mode:0o100440})],
  ['owner readable by another uid',fileStat({uid:10001})],
  ['another group',fileStat({gid:10001})],
  ['owner-writable mode',fileStat({mode:0o100600})],
  ['special permission bits',fileStat({mode:0o104400})],
  ['multiple hard links',fileStat({nlink:2})],
  ['short file',fileStat({size:31})],
  ['non-regular file',fileStat({regular:false})],
])('refuses a key with %s and closes without exposing path or key material',(_reason,file)=>{
  prepareKeyLoader({file});
  let failure:unknown;
  try{loadOutsideCustodyKey(keyPath);}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('Outside credential is not available');
  expect((failure as Error).message).not.toContain(keyPath);
  expect((failure as Error).message).not.toContain('090909');
  expect(mocks.keyRead).not.toHaveBeenCalled();
  expect(mocks.keyClose).toHaveBeenCalledTimes(1);
});

it.each([
  ['wrong owner',directoryStat(10001,0,0o700)],
  ['wrong group',directoryStat(0,10001,0o700)],
  ['shared directory mode',directoryStat(0,0,0o750)],
  ['special permission bits',directoryStat(0,0,0o2700)],
  ['symlink',directoryStat(0,0,0o700,true)],
])('refuses an immediate Keeper key directory with %s before opening the file',(_reason,parent)=>{
  prepareKeyLoader({parent});
  expect(()=>loadOutsideCustodyKey(keyPath)).toThrow('Outside credential is not available');
  expect(mocks.keyOpen).not.toHaveBeenCalled();
  expect(mocks.keyClose).not.toHaveBeenCalled();
});

it('preserves safe ancestor checks, wipes a wrong-length read, and suppresses symlink and close diagnostics',()=>{
  prepareKeyLoader({ancestor:directoryStat(0,0,0o755),read:Buffer.alloc(31,4),closeError:new Error('close diagnostic with path '+keyPath)});
  let failure:unknown;
  try{loadOutsideCustodyKey(keyPath);}catch(error){failure=error;}
  expect((failure as Error).message).toBe('Outside credential is not available');
  expect(mocks.keyClose).toHaveBeenCalledWith(77);
  const shortRead=mocks.keyRead.mock.results[0]?.value as Buffer;
  expect(shortRead).toEqual(Buffer.alloc(31));

  vi.clearAllMocks();
  prepareKeyLoader({openError:Object.assign(new Error('symlink at '+keyPath),{code:'ELOOP'})});
  try{loadOutsideCustodyKey(keyPath);throw new Error('expected refusal');}catch(error){
    expect((error as Error).message).toBe('Outside credential is not available');
  }
  expect(mocks.keyClose).not.toHaveBeenCalled();
  expect(mocks.keyRead).not.toHaveBeenCalled();
});

it('refuses a stale stage after a competing stage changes the pending candidate',async()=>{
  const {store,state}=candidateStore();
  const staged=await store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')});
  expect(staged).toMatchObject({outcome:'staged',generation:1,credentialRevision:1});
  await expect(store.stage(binding,{accountId,operationId:stageOperationB,expectedGeneration:1,expectedCandidateRevision:null,credential:Buffer.from('stale candidate')})).rejects.toThrow();
  const snapshot=state();
  expect(snapshot.head?.candidate_revision).toBe(1);
  expect(snapshot.revisions.size).toBe(1);
  expect(snapshot.operations.size).toBe(1);
  const candidateUpdate=snapshot.statements.find(statement=>statement.sql.includes('SET candidate_revision=$2'))!;
  expect(candidateUpdate.sql).toContain('candidate_revision IS NOT DISTINCT FROM $6');
  expect(candidateUpdate.params[5]).toBeNull();
});

it('allows explicit candidate replacement, refuses apply of the reviewed old candidate, and applies the exact new candidate',async()=>{
  const {store,state}=candidateStore();
  await store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')});
  const replacement=await store.stage(binding,{accountId,operationId:stageOperationB,expectedGeneration:1,expectedCandidateRevision:1,credential:Buffer.from('candidate B')});
  expect(replacement).toMatchObject({outcome:'staged',generation:1,credentialRevision:2});
  expect(state().head?.candidate_revision).toBe(2);

  await expect(store.apply(binding,{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:7})).rejects.toThrow();
  expect(state().head).toMatchObject({generation:1,active_revision:null,candidate_revision:2});
  expect(state().operations.size).toBe(2);
  expect(state().statements.some(statement=>statement.sql.includes('SET generation=$2,active_revision=$3,candidate_revision=NULL'))).toBe(false);

  const applied=await store.apply(binding,{accountId,operationId:applyOperationB,expectedGeneration:1,candidateRevision:2,consentGeneration:7});
  expect(applied).toMatchObject({outcome:'applied',generation:2,credentialRevision:2});
  expect(state().head).toMatchObject({generation:2,active_revision:2,candidate_revision:null});
  await expect(store.apply(binding,{accountId,operationId:applyOperationB,expectedGeneration:1,candidateRevision:1,consentGeneration:7})).rejects.toThrow();
  expect(state().head).toMatchObject({generation:2,active_revision:2,candidate_revision:null});
});

it('conflicts when a reused replacement operation id names a different expected candidate',async()=>{
  const {store,state}=candidateStore();
  await store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')});
  await store.stage(binding,{accountId,operationId:stageOperationB,expectedGeneration:1,expectedCandidateRevision:1,credential:Buffer.from('candidate B')});
  await expect(store.stage(binding,{accountId,operationId:stageOperationB,expectedGeneration:1,expectedCandidateRevision:2,credential:Buffer.from('candidate B')})).rejects.toThrow();
  expect(state().head?.candidate_revision).toBe(2);
  expect(state().revisions.size).toBe(2);
  expect(state().operations.size).toBe(2);
  expect(state().statements.filter(statement=>statement.sql.includes('INSERT INTO outside_custody_revisions'))).toHaveLength(2);
});

it('returns an exact initial-stage receipt only for the same owner, resource, caller inputs, and credential without writes',async()=>{
  const {store,state}=candidateStore();
  const first=await store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')});
  const before=state(),writeCount=before.statements.filter(({sql})=>/^(INSERT|UPDATE)/.test(sql.trim())).length;
  await expect(store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')})).resolves.toEqual(first);
  expect(state().statements.filter(({sql})=>/^(INSERT|UPDATE)/.test(sql.trim()))).toHaveLength(writeCount);
  expect(state().revisions.size).toBe(1);
  expect(state().operations.size).toBe(1);

  await expect(store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('different credential')})).rejects.toThrow();
  await expect(store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:1,credential:Buffer.from('candidate A')})).rejects.toThrow();
  await expect(store.stage({...binding,memberId:'member-2'},{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')})).rejects.toThrow();
  await expect(store.stage({...binding,agent:'other-agent'},{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')})).rejects.toThrow();
  await expect(store.stage(binding,{accountId:'00000000-0000-4000-8000-000000000105',operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')})).rejects.toThrow();
  expect(state().revisions.size).toBe(1);
  expect(state().operations.size).toBe(1);
});

it('checks existing operation owner explicitly and refuses a receipt whose account head is missing before creating it',async()=>{
  const {store,state,removeHead}=candidateStore();
  await store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')});
  const operation=state().operations.get(stageOperationA)!;
  operation.owner_member_id='member-2';
  await expect(store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')})).rejects.toThrow();
  operation.owner_member_id='member-1';
  removeHead();
  const before=state().statements.filter(({sql})=>sql.includes('INSERT INTO outside_custody_accounts')).length;
  await expect(store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')})).rejects.toThrow();
  expect(state().statements.filter(({sql})=>sql.includes('INSERT INTO outside_custody_accounts'))).toHaveLength(before);
});

it('returns an exact apply receipt after advancement without revision reads or writes, but refuses changed consent and wrong scope',async()=>{
  const {store,state}=candidateStore();
  await store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')});
  const applied=await store.apply(binding,{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:7});
  const before=state(),statementCount=before.statements.length;
  const writeCount=before.statements.filter(({sql})=>/^(INSERT|UPDATE)/.test(sql.trim())).length;
  await expect(store.apply(binding,{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:7})).resolves.toEqual(applied);
  expect(state().statements.slice(statementCount).some(({sql})=>sql.includes('outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2'))).toBe(false);
  expect(state().statements.filter(({sql})=>/^(INSERT|UPDATE)/.test(sql.trim()))).toHaveLength(writeCount);
  await expect(store.apply(binding,{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:8})).rejects.toThrow();
  await expect(store.apply(binding,{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:2,consentGeneration:7})).rejects.toThrow();
  await expect(store.apply({...binding,memberId:'member-2'},{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:7})).rejects.toThrow();
  await expect(store.apply({...binding,agent:'other-agent'},{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:7})).rejects.toThrow();
  mocks.captureUseWithExpiry.mockResolvedValue({accessRevision:8,validUntil:null});
  await expect(store.apply(binding,{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:7})).rejects.toThrow();
  mocks.captureUseWithExpiry.mockResolvedValue({accessRevision:7,validUntil:null});
  expect(state().head).toMatchObject({generation:2,active_revision:1,candidate_revision:null});
});

it('returns an exact rollback receipt after advancement without decrypting again and refuses changed caller consent',async()=>{
  const {store,state}=candidateStore();
  await store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')});
  await store.apply(binding,{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:7});
  const rollbackId='00000000-0000-4000-8000-000000000114';
  const rolled=await store.rollback(binding,{accountId,operationId:rollbackId,expectedGeneration:2,sourceRevision:1,consentGeneration:7});
  expect(state().head).toMatchObject({generation:3,active_revision:2,state:'active'});
  const before=state(),statementCount=before.statements.length;
  const writeCount=before.statements.filter(({sql})=>/^(INSERT|UPDATE)/.test(sql.trim())).length;
  await expect(store.rollback(binding,{accountId,operationId:rollbackId,expectedGeneration:2,sourceRevision:1,consentGeneration:7})).resolves.toEqual(rolled);
  expect(state().statements.slice(statementCount).some(({sql})=>sql.includes('outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2'))).toBe(false);
  expect(state().statements.filter(({sql})=>/^(INSERT|UPDATE)/.test(sql.trim()))).toHaveLength(writeCount);
  await expect(store.rollback(binding,{accountId,operationId:rollbackId,expectedGeneration:2,sourceRevision:1,consentGeneration:8})).rejects.toThrow();
  await expect(store.rollback(binding,{accountId,operationId:rollbackId,expectedGeneration:2,sourceRevision:2,consentGeneration:7})).rejects.toThrow();
});

it('returns an exact revoke receipt after revocation without writes',async()=>{
  const {store,state}=candidateStore();
  await store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')});
  await store.apply(binding,{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:7});
  const revokeId='00000000-0000-4000-8000-000000000115';
  const revoked=await store.revoke(binding,{accountId,operationId:revokeId,expectedGeneration:2});
  expect(state().head).toMatchObject({generation:3,state:'revoked',active_revision:null});
  const before=state(),statementCount=before.statements.length;
  await expect(store.revoke(binding,{accountId,operationId:revokeId,expectedGeneration:2})).resolves.toEqual(revoked);
  expect(state().statements.slice(statementCount).some(({sql})=>/^(INSERT|UPDATE)/.test(sql.trim()))).toBe(false);
  await expect(store.revoke({...binding,memberId:'member-2'},{accountId,operationId:revokeId,expectedGeneration:2})).rejects.toThrow();
  await expect(store.revoke({...binding,agent:'other-agent'},{accountId,operationId:revokeId,expectedGeneration:2})).rejects.toThrow();
});

it('scopes historical inspection to the linked account owner and resource while allowing advanced heads',async()=>{
  const {store,state,removeHead}=candidateStore();
  await expect(store.inspect(binding,operationId)).resolves.toBeUndefined();
  const staged=await store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')});
  await store.apply(binding,{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:7});
  await expect(store.inspect(binding,stageOperationA)).resolves.toEqual(staged);
  await expect(store.inspect({...binding,memberId:'member-2'},stageOperationA)).rejects.toThrow();
  await expect(store.inspect({...binding,agent:'other-agent'},stageOperationA)).rejects.toThrow();
  removeHead();
  await expect(store.inspect(binding,stageOperationA)).rejects.toThrow();
  const revokedHead=candidateStore();
  await revokedHead.store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')});
  await revokedHead.store.apply(binding,{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:7});
  const revokeId='00000000-0000-4000-8000-000000000115';
  await revokedHead.store.revoke(binding,{accountId,operationId:revokeId,expectedGeneration:2});
  await expect(revokedHead.store.inspect(binding,stageOperationA)).resolves.toEqual(staged);
  const foreignHead=candidateStore();
  await foreignHead.store.stage(binding,{accountId,operationId:stageOperationB,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate B')});
  foreignHead.state().head!.owner_member_id='member-2';
  await expect(foreignHead.store.inspect(binding,stageOperationB)).rejects.toThrow();
});

it('closes once, wipes an idle key, and rejects every public operation before database or callback use',async()=>{
  const store=new OutsideCustodyStore({} as never,key),staged=Buffer.from('credential to wipe');
  const use=vi.fn(async()=>{throw new Error('must not run');});
  const run=vi.fn(async()=>{throw new Error('must not run');});
  const inspect=vi.fn(async()=>undefined);
  store.close();store.close();
  expect(storeKey(store)).toEqual(Buffer.alloc(32));
  await expect(store.stage(binding,{accountId,operationId,expectedGeneration:0,expectedCandidateRevision:null,credential:staged})).rejects.toThrow();
  await expect(store.apply(binding,{accountId,operationId,expectedGeneration:1,candidateRevision:1,consentGeneration:7})).rejects.toThrow();
  await expect(store.rollback(binding,{accountId,operationId,expectedGeneration:1,sourceRevision:1,consentGeneration:7})).rejects.toThrow();
  await expect(store.revoke(binding,{accountId,operationId,expectedGeneration:1})).rejects.toThrow();
  await expect(store.withCredential(binding,{accountId},use)).rejects.toThrow();
  await expect(store.inspect(binding,operationId)).rejects.toThrow();
  await expect(store.runAndRecover(operationId,run,inspect)).rejects.toThrow();
  expect(staged).toEqual(Buffer.alloc(staged.length));
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.requireBinding).not.toHaveBeenCalled();
  expect(mocks.captureUse).not.toHaveBeenCalled();
  expect(use).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
});

it('refuses a successful runAndRecover result when close begins while run is pending',async()=>{
  let entered!:()=>void,release!:()=>void;
  const inRun=new Promise<void>(resolve=>{entered=resolve;}),runResult=new Promise<void>(resolve=>{release=resolve;});
  const result={operationId,accountId,kind:'stage' as const,outcome:'staged' as const,generation:1,credentialRevision:1};
  const run=vi.fn(async()=>{entered();await runResult;return result;}),inspect=vi.fn(async()=>undefined);
  const store=new OutsideCustodyStore({} as never,key);
  const pending=store.runAndRecover(operationId,run,inspect);
  await inRun;
  store.close();
  expect(storeKey(store)).toEqual(key);
  release();
  await expect(pending).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(1);
  expect(inspect).not.toHaveBeenCalled();
  expect(storeKey(store)).toEqual(Buffer.alloc(32));
});

it('refuses a stage that was waiting on its account lock when close begins, before sealing or writes',async()=>{
  let entered!:()=>void,release!:()=>void;
  const atLock=new Promise<void>(resolve=>{entered=resolve;}),locked=new Promise<void>(resolve=>{release=resolve;});
  mocks.query.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM outside_custody_operations'))return {rows:[]};
    if(sql.includes('FROM outside_custody_accounts')){entered();await locked;return {rows:[]};}
    throw new Error(`Unexpected SQL in disposal test: ${sql}`);
  });
  const store=new OutsideCustodyStore({} as never,key),staged=Buffer.from('credential to wipe');
  const pending=store.stage(binding,{accountId,operationId,expectedGeneration:0,expectedCandidateRevision:null,credential:staged});
  await atLock;
  store.close();
  expect(storeKey(store)).toEqual(key);
  release();
  await expect(pending).rejects.toThrow();
  expect(storeKey(store)).toEqual(Buffer.alloc(32));
  expect(staged).toEqual(Buffer.alloc(staged.length));
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes('max(credential_revision)'))).toBe(false);
  expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO outside_custody_revisions'))).toBe(false);
});

it('does not call the credential callback when close begins during the identity query',async()=>{
  const encrypted=encryptedFixture(Buffer.from('short-lived outside credential'));
  let entered!:()=>void,release!:()=>void;
  const atIdentity=new Promise<void>(resolve=>{entered=resolve;}),identityResult=new Promise<void>(resolve=>{release=resolve;});
  mocks.query.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM outside_custody_accounts'))return {rows:[{account_id:accountId,owner_member_id:'member-1',resource_id:'worker',generation:'1',active_revision:'1',candidate_revision:null,consent_generation:'7',state:'active'}]};
    if(sql.includes('FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2'))return {rows:[{credential_revision:'1',generation:'1',consent_generation:'7',operation_id:originalOperationId,...encrypted}]};
    if(sql.includes('SELECT pg_backend_pid()')){entered();await identityResult;return {rows:[{pid:44,user:'lares_outside_custody',sessionUser:'lares_outside_custody'}]};}
    throw new Error(`Unexpected SQL in identity disposal test: ${sql}`);
  });
  const store=new OutsideCustodyStore({} as never,key),use=vi.fn(async()=>undefined);
  const pending=store.withCredential(binding,{accountId},use);
  await atIdentity;
  store.close();
  expect(storeKey(store)).toEqual(key);
  release();
  await expect(pending).rejects.toThrow();
  expect(use).not.toHaveBeenCalled();
  expect(storeKey(store)).toEqual(Buffer.alloc(32));
});

it('keeps the key until an already-running credential callback drains, then wipes its credential and refuses its result',async()=>{
  const encrypted=encryptedFixture(Buffer.from('short-lived outside credential'));
  mocks.query.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM outside_custody_accounts'))return {rows:[{account_id:accountId,owner_member_id:'member-1',resource_id:'worker',generation:'1',active_revision:'1',candidate_revision:null,consent_generation:'7',state:'active'}]};
    if(sql.includes('FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2'))return {rows:[{credential_revision:'1',generation:'1',consent_generation:'7',operation_id:originalOperationId,...encrypted}]};
    if(sql.includes('SELECT pg_backend_pid()'))return {rows:[{pid:44,user:'lares_outside_custody',sessionUser:'lares_outside_custody'}]};
    throw new Error(`Unexpected SQL in callback disposal test: ${sql}`);
  });
  let entered!:()=>void,release!:()=>void;
  const inCallback=new Promise<void>(resolve=>{entered=resolve;}),callbackResult=new Promise<void>(resolve=>{release=resolve;});
  let delivered:Buffer|undefined;
  const store=new OutsideCustodyStore({} as never,key);
  const pending=store.withCredential(binding,{accountId},async credential=>{delivered=credential;entered();await callbackResult;return 'callback result';});
  await inCallback;
  store.close();
  expect(storeKey(store)).toEqual(key);
  await expect(store.inspect(binding,operationId)).rejects.toThrow();
  release();
  await expect(pending).rejects.toThrow();
  expect(delivered).toBeDefined();
  expect(delivered).toEqual(Buffer.alloc(Buffer.byteLength('short-lived outside credential')));
  expect(storeKey(store)).toEqual(Buffer.alloc(32));
});

it.each(['identity','head'] as const)('retains the exact finite grant deadline on the transaction client and refuses use after it expires while waiting on %s',async(waitFor)=>{
  const validUntil='2026-10-23 12:34:56.123456+00';
  let entered!:()=>void,release!:()=>void,expired=false;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  const encrypted=encryptedFixture(Buffer.from('short-lived outside credential'));
  activeCredentialReads(encrypted,{waitFor,entered,wait:released});
  mocks.captureUseWithExpiry.mockResolvedValue({accessRevision:7,validUntil});
  mocks.deadlines.mockImplementation(async(db:unknown)=>{expect(db).toBe(sourceClient);if(expired)throw new Error('grant deadline expired');});
  const store=new OutsideCustodyStore({} as never,key),use=vi.fn(async()=> 'must not escape');
  const pending=store.withCredential(binding,{accountId},use);
  await waiting;
  expect(mocks.captureUseWithExpiry).toHaveBeenCalledWith('member-1','worker',{db:sourceClient});
  expect(mocks.retainDeadline).toHaveBeenCalledWith(sourceClient,binding,validUntil);
  expired=true;release();
  await expect(pending).rejects.toThrow();
  expect(use).not.toHaveBeenCalled();
});

it('refuses callback output when the original finite grant expires during the callback',async()=>{
  const validUntil='2026-10-23 12:34:56.123456+00',encrypted=encryptedFixture(Buffer.from('short-lived outside credential'));
  activeCredentialReads(encrypted);
  mocks.captureUseWithExpiry.mockResolvedValue({accessRevision:7,validUntil});
  let checks=0;
  mocks.deadlines.mockImplementation(async(db:unknown)=>{expect(db).toBe(sourceClient);if(++checks===2)throw new Error('original grant deadline expired');});
  const store=new OutsideCustodyStore({} as never,key),use=vi.fn(async()=> 'must not escape');
  await expect(store.withCredential(binding,{accountId},use)).rejects.toThrow();
  expect(mocks.retainDeadline).toHaveBeenCalledWith(sourceClient,binding,validUntil);
  expect(use).toHaveBeenCalledTimes(1);
  expect(checks).toBe(2);
});

it('allows a non-expiring grant while retaining the same-client no-deadline observation',async()=>{
  const encrypted=encryptedFixture(Buffer.from('short-lived outside credential'));
  activeCredentialReads(encrypted);
  mocks.captureUseWithExpiry.mockResolvedValue({accessRevision:7,validUntil:null});
  const store=new OutsideCustodyStore({} as never,key),use=vi.fn(async()=> 'used');
  await expect(store.withCredential(binding,{accountId},use)).resolves.toBe('used');
  expect(mocks.retainDeadline).toHaveBeenCalledWith(sourceClient,binding,null);
  expect(mocks.deadlines).toHaveBeenCalledTimes(2);
  expect(use).toHaveBeenCalledTimes(1);
});

it('wipes rollback plaintext when the asynchronous next-revision query fails',async()=>{
  const secret=Buffer.from('rollback plaintext'),encrypted=encryptedFixture(secret);
  let opened:Buffer|undefined;
  const concat=Buffer.concat.bind(Buffer);
  vi.spyOn(Buffer,'concat').mockImplementation((parts,totalLength)=>{
    const result=concat(parts,totalLength);
    if(result.equals(secret))opened=result;
    return result;
  });
  mocks.query.mockImplementation(async(sql:string)=>{
    if(sql.includes('count(*)::text AS count FROM outside_custody_operations'))return {rows:[{count:'0'}]};
    if(sql.includes('count(*)::text AS count FROM outside_custody_revisions'))return {rows:[{count:'1'}]};
    if(sql.includes('FROM outside_custody_operations'))return {rows:[]};
    if(sql.includes('FROM outside_custody_accounts'))return {rows:[{account_id:accountId,owner_member_id:'member-1',resource_id:'worker',generation:'1',active_revision:'1',candidate_revision:null,consent_generation:'7',state:'active'}]};
    if(sql.includes('FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2'))return {rows:[{credential_revision:'1',generation:'1',consent_generation:'7',operation_id:originalOperationId,...encrypted}]};
    if(sql.includes('max(credential_revision)'))throw new Error('simulated asynchronous revision query failure');
    throw new Error(`Unexpected SQL in rollback cleanup test: ${sql}`);
  });
  const store=new OutsideCustodyStore({} as never,key);
  await expect(store.rollback(binding,{accountId,operationId,expectedGeneration:1,sourceRevision:1,consentGeneration:7})).rejects.toThrow();
  expect(opened).toBeDefined();
  expect(opened).toEqual(Buffer.alloc(secret.length));
  expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO outside_custody_revisions'))).toBe(false);
  store.close();
});
