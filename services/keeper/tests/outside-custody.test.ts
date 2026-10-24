import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createCipheriv,createHash,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {loadOutsideCustodyKey,OutsideCustodyStore} from '../lib/outside-custody.js';

const mocks=vi.hoisted(()=>({
  transaction:vi.fn(),
  namespace:vi.fn(),
  namespaceClient:{},
  query:vi.fn(),
  requireBinding:vi.fn(),
  captureUse:vi.fn(),
  captureUseWithExpiry:vi.fn(),
  captureOutsideUse:vi.fn(),
  gateOrganisation:vi.fn(),
  trackDecryptBuffers:false,
  decryptBuffers:[] as Buffer[],
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
  return {...actual,consoleSourceTransaction:mocks.transaction,checkConsoleSourceDeadlines:mocks.deadlines,
    retainConsoleSourceDeadline:mocks.retainDeadline,retainSourceTransactionDeadline:mocks.retainDeadline,
    requireSourceTransactionOwner:vi.fn(),gateConsoleOrganisation:mocks.gateOrganisation};
});
vi.mock('@lares/agent-kit/console-turn-authority',()=>({requireConsoleSessionBinding:mocks.requireBinding}));
vi.mock('@lares/agent-kit/grant-store',()=>({PgGrantStore:class{captureUse(...args:unknown[]){return mocks.captureUse(...args);}
  captureUseWithExpiry(...args:unknown[]){return mocks.captureUseWithExpiry(...args);}
  captureOutsideUse(...args:unknown[]){return mocks.captureOutsideUse(...args);}}}));
vi.mock('../lib/definition-namespace.js',()=>({
  withDefinitionNamespace:async(_pool:unknown,work:(client:unknown)=>Promise<unknown>)=>mocks.namespace(_pool,work),
  requireDefinitionNamespace:()=>mocks.namespaceClient,
}));
vi.mock('node:crypto',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:crypto')>();
  return {...actual,createDecipheriv:(...args:Parameters<typeof actual.createDecipheriv>)=>{
    const decipher=actual.createDecipheriv(...args);
    if(mocks.trackDecryptBuffers){
      const update=decipher.update.bind(decipher),final=decipher.final.bind(decipher);
      (decipher as unknown as {update:(...args:unknown[])=>Buffer}).update=(...updateArgs)=>{
        const value=Reflect.apply(update,decipher,updateArgs) as Buffer;mocks.decryptBuffers.push(value);return value;
      };
      (decipher as unknown as {final:(...args:unknown[])=>Buffer}).final=(...finalArgs)=>{
        const value=Reflect.apply(final,decipher,finalArgs) as Buffer;mocks.decryptBuffers.push(value);return value;
      };
    }
    return decipher;
  }};
});

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
type CapacityRow={accountId:string;ownerMemberId:string;requestId:string;kind:'discover'|'stage';phase:'operation'|'claim'|'result';outcome:string};
function capacityHarness(rows:CapacityRow[],revisionCount=0){
  const store=new OutsideCustodyStore({} as never,key);
  mocks.query.mockImplementation(async(sql:string,params:unknown[]=[]):Promise<{rows:Array<Record<string,unknown>>;rowCount:number}>=>{
    expect(params).toEqual([accountId]);
    if(sql.includes('FROM outside_custody_operations WHERE account_id=$1'))return {rows:[{count:String(rows.length)}],rowCount:1};
    if(sql.includes('FROM outside_custody_operations c')){
      expect(sql).toContain("c.operation_kind='discover' AND c.event_phase='claim'");
      expect(sql).toContain("r.event_phase='result'");
      expect(sql).toContain("r.outcome IN ('completed','unknown')");
      const outstanding=rows.filter(claim=>claim.kind==='discover'&&claim.phase==='claim'&&
        !rows.some(result=>result.kind==='discover'&&result.phase==='result'&&
          result.accountId===claim.accountId&&result.ownerMemberId===claim.ownerMemberId&&result.requestId===claim.requestId&&
          (result.outcome==='completed'||result.outcome==='unknown')));
      return {rows:[{count:String(outstanding.length)}],rowCount:1};
    }
    if(sql.includes('FROM outside_custody_revisions WHERE account_id=$1'))return {rows:[{count:String(revisionCount)}],rowCount:1};
    throw new Error(`Unexpected capacity SQL: ${sql}`);
  });
  const capacity=(store as unknown as {capacity(db:unknown,id:string,kind:'discover'|'revoke',createsRevision:boolean,reserveResult?:boolean):Promise<void>}).capacity;
  return {store,rows,discover:()=>capacity.call(store,sourceClient,accountId,'discover',true,true),revoke:()=>capacity.call(store,sourceClient,accountId,'revoke',false)};
}
const ordinaryCapacityRows=(count:number):CapacityRow[]=>Array.from({length:count},(_,index)=>({
  accountId,ownerMemberId:'member-1',requestId:`ordinary-${index}`,kind:'stage',phase:'operation',outcome:'staged',
}));
const discoveryCapacityRow=(phase:'claim'|'result',requestId:string,outcome:string,ownerMemberId='member-1',rowAccountId=accountId):CapacityRow=>({
  accountId:rowAccountId,ownerMemberId,requestId,kind:'discover',phase,outcome,
});
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

function encryptedFixture(plaintext:Buffer,coordinates:{generation?:number;credentialRevision?:number;operationId?:string;connectionName?:string;policyHash?:string}={}){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce),
    common=JSON.stringify(['lares-outside-custody-v1','member-1',accountId,'worker',coordinates.generation??1,coordinates.credentialRevision??1,7,coordinates.operationId??originalOperationId]);
  cipher.setAAD(Buffer.from(JSON.stringify(['lares-outside-custody-bound-v1',common,coordinates.connectionName??'connection','executable',coordinates.policyHash??'a'.repeat(64)])));
  return {nonce,ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()])};
}
const humanSession='S'.repeat(43),humanRequest='00000000-0000-4000-8000-000000000201',humanClaim='00000000-0000-4000-8000-000000000202',
  humanResult='00000000-0000-4000-8000-000000000203',humanEndpoint='https://example.test/mcp';
const discoveryProfile={version:2,protocolVersion:'2025-06-18',parser:'strict-json-sse-v1',operationTimeoutMs:8000,transportTimeoutMs:5000,
  connectTimeoutMs:1000,idleTimeoutMs:2000,cleanupReserveMs:1000,responseBytes:65536,totalResponseBytes:262144,headerBytes:8192,
  resultBytes:65536,maxPages:10,maxPosts:12,maxCursorBytes:1024,maxJsonDepth:16,maxTools:256,maxToolNameBytes:128,
  maxRequestBytes:16384,maxSessionIdBytes:1024,maxCredentialBytes:4096};
function canonicalJson(value:unknown):string{
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([name,item])=>`${JSON.stringify(name)}:${canonicalJson(item)}`).join(',')}}`;
}
const humanCapture={version:1,actor:{memberId:'member-1',organisationId:'org-1',role:'member' as const},
  agent:{name:'worker',ownerMemberId:'member-1',accessRevision:7,definitionHash:'a'.repeat(64)},ownerPolicy:{kind:'unrestricted' as const},
  outside:{scope:'read' as const,autonomy:'gated' as const,connection:{name:'connector',url:humanEndpoint,auth:'bearer' as const,
    allow:['read'],read:['read'],trusted:false}},grant:{kind:'owner' as const,validUntil:null}};
const humanRoute={policyHash:'b'.repeat(64),sourceAddress:'198.51.100.10',proxyUrl:'http://lares-egress-proxy:8888/'};
function humanPolicy():{policy:Record<string,unknown>;hash:string}{
  const policy={version:2,profile:discoveryProfile,purpose:'streamable-http-discovery-v1',ownerMemberId:'member-1',accountId,
    agentName:'worker',connectionName:'connector',endpoint:humanEndpoint,capture:humanCapture,route:humanRoute};
  return {policy,hash:createHash('sha256').update(canonicalJson(policy)).digest('hex')};
}
type DiscoveryAad=Partial<{ownerMemberId:string;accountId:string;agentName:string;connectionName:string;requestId:string;claimOperationId:string;
  resultOperationId:string;generation:number;credentialRevision:number;consentGeneration:number;policyHash:string}>;
function encryptDiscovery(document:unknown,policyHash:string,overrides:DiscoveryAad={}):{nonce:Buffer;ciphertext:Buffer;plaintext:Buffer}{
  return encryptDiscoveryBytes(Buffer.from(canonicalJson(document)),policyHash,overrides);
}
function encryptDiscoveryBytes(plaintext:Buffer,policyHash:string,overrides:DiscoveryAad={}):{nonce:Buffer;ciphertext:Buffer;plaintext:Buffer}{
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  const coordinates={ownerMemberId:'member-1',accountId,agentName:'worker',connectionName:'connector',requestId:humanRequest,
    claimOperationId:humanClaim,resultOperationId:humanResult,generation:1,credentialRevision:2,consentGeneration:3,policyHash,...overrides};
  cipher.setAAD(Buffer.from(canonicalJson(['lares-outside-discovery-result-v1',coordinates])));
  return {nonce,ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]),plaintext};
}
function installHumanSessionSql(query:(sql:string,params:unknown[])=>Promise<{rows:Array<Record<string,unknown>>;rowCount:number}>,
  session:{discovered?:boolean;current?:boolean}={}):void{
  mocks.query.mockImplementation(async(sql:string,params:unknown[]=[]):Promise<{rows:Array<Record<string,unknown>>;rowCount:number}>=>{
    if(sql.includes('SELECT member_id FROM member_sessions'))return session.discovered===false?{rows:[],rowCount:0}:{rows:[{member_id:'member-1'}],rowCount:1};
    if(sql.includes('FROM member_sessions s JOIN users u'))return session.current===false?{rows:[],rowCount:0}:
      {rows:[{member_id:'member-1',finite:true,deadline:'2099-01-01T00:00:00.000000Z'}],rowCount:1};
    return query(sql,params);
  });
}
function discoveryOperationRows(options:{claim?:Record<string,unknown>;result?:Record<string,unknown>;identity?:Record<string,unknown>;document?:unknown}={}){
  const {policy,hash}=humanPolicy();
  const document=options.document??{protocolVersion:'2025-06-18',serverInfo:{name:'Example',version:'1'},tools:[{name:'read',description:'Read safely',inputSchema:{type:'object'}}]};
  const encrypted=encryptDiscovery(document,hash),requestHash=Buffer.alloc(32,4);
  const identity={account_id:accountId,owner_member_id:'member-1',resource_id:'worker',connection_name:'connector',generation:'1',
    active_revision:'2',candidate_revision:null,consent_generation:'3',state:'active',...options.identity};
  const claim={operation_id:humanClaim,account_id:accountId,owner_member_id:'member-1',operation_kind:'discover',request_id:humanRequest,
    expected_generation:'0',result_generation:'1',credential_revision:'2',outcome:'claimed',request_hash:requestHash,revision_generation:'1',
    revision_consent_generation:'3',revision_purpose:'discovery',policy_hash:Buffer.from(hash,'hex'),policy_json:JSON.stringify(policy),
    claim_nonce:Buffer.alloc(12),claim_ciphertext:Buffer.alloc(16),...options.claim};
  const result={operation_id:humanResult,account_id:accountId,owner_member_id:'member-1',operation_kind:'discover',request_id:humanRequest,
    event_phase:'result',request_hash:requestHash,expected_generation:'0',result_generation:'1',credential_revision:'2',
    outcome:'completed',result_nonce:encrypted.nonce,result_ciphertext:encrypted.ciphertext,...options.result};
  return {identity,claim,result,document,plaintext:encrypted.plaintext,policy,policyHash:hash};
}
function humanStore(lifecycle:{reviewOutsideRoute:(endpoint:string,deadline:number)=>Promise<typeof humanRoute>}={
  reviewOutsideRoute:async()=>humanRoute,
}){
  return new OutsideCustodyStore({} as never,key,{mainPool:{} as never,lifecycle:lifecycle as never});
}
function installInspectSql(rows:ReturnType<typeof discoveryOperationRows>,options:{claim?:boolean;result?:boolean;identity?:boolean;
  session?:{discovered?:boolean;current?:boolean}}={}){
  installHumanSessionSql(async sql=>{
    if(sql.includes('FROM outside_custody_accounts WHERE account_id=$1'))return options.identity===false?{rows:[],rowCount:0}:
      {rows:[rows.identity],rowCount:1};
    if(sql.includes('FROM outside_custody_operations c'))return options.claim===false?{rows:[],rowCount:0}:
      {rows:[rows.claim],rowCount:1};
    if(sql.includes("FROM outside_custody_operations WHERE request_id=$1 AND account_id=$2"))return options.result===false?{rows:[],rowCount:0}:
      {rows:[rows.result],rowCount:1};
    throw new Error(`Unexpected discovery inspection SQL: ${sql}`);
  },options.session);
}
function candidateStore(){
  type CandidateHead={account_id:string;owner_member_id:string;resource_id:string;connection_name:string;generation:number;active_revision:number|null;candidate_revision:number|null;consent_generation:number;state:'active'|'revoked'};
  type CandidateRevision={credential_revision:string;generation:string;consent_generation:string;operation_id:string;revision_purpose:'discovery'|'executable';policy_json:unknown;policy_hash:Buffer;nonce:Buffer;ciphertext:Buffer};
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
      head={account_id:String(params[0]),owner_member_id:String(params[1]),resource_id:String(params[2]),connection_name:String(params[3]),generation:1,active_revision:null,candidate_revision:null,consent_generation:Number(params[4]),state:'active'};
      return {rows:[row() as Record<string,unknown>],rowCount:1};
    }
    if(sql.includes('SELECT COALESCE(max(credential_revision),0)+1 AS revision'))return {rows:[{revision:String(maxRevision+1)}],rowCount:1};
    if(sql.includes('INSERT INTO outside_custody_revisions')) {
      const [id,owner,revision,generation,consent,purposeJson,policyHash,operation,nonce,ciphertext]=params as [string,string,number,number,number,unknown,Buffer,string,Buffer,Buffer];
      if(!head||owner!==head.owner_member_id||params[4]!==7)throw new Error('Unexpected revision insert in test fixture.');
      revisions.set(Number(revision),{credential_revision:String(revision),generation:String(generation),consent_generation:String(consent),operation_id:operation,
        revision_purpose:'executable',policy_json:purposeJson,policy_hash:policyHash,nonce,ciphertext});
      maxRevision=Number(revision);
      return {rows:[],rowCount:1};
    }
    if(sql.includes('UPDATE outside_custody_accounts SET candidate_revision=$2')){
      if(!head||head.account_id!==params[0]||head.owner_member_id!==params[3]||head.generation!==Number(params[4])||head.candidate_revision!==params[5]||head.state!=='active')return {rows:[],rowCount:0};
      head.candidate_revision=Number(params[1]);head.consent_generation=Number(params[2]);return {rows:[],rowCount:1};
    }
    if(sql.includes('SELECT credential_revision::text,generation::text,consent_generation::text,revision_purpose,policy_json,policy_hash,operation_id,nonce,ciphertext')){
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
  const seedExecutableFixture=(revision=1,operation=stageOperationA,plaintext=Buffer.from('fixture-owned executable credential'))=>{
    const policyHash='a'.repeat(64),encrypted=encryptedFixture(plaintext,{generation:2,credentialRevision:revision,operationId:operation,policyHash});
    head={account_id:accountId,owner_member_id:'member-1',resource_id:'worker',connection_name:'connection',generation:1,active_revision:null,candidate_revision:revision,consent_generation:7,state:'active'};
    revisions.set(revision,{credential_revision:String(revision),generation:'2',consent_generation:'7',operation_id:operation,revision_purpose:'executable',policy_json:{purpose:'test-owned persisted executable fixture'},policy_hash:Buffer.from(policyHash,'hex'),...encrypted});
    maxRevision=revision;
    operations.set(operation,{account_id:accountId,owner_member_id:'member-1',operation_kind:'stage',request_hash:Buffer.alloc(32,1),expected_generation:'0',result_generation:'1',credential_revision:String(revision),outcome:'staged'});
    return {operationId:operation,accountId,kind:'stage' as const,outcome:'staged' as const,generation:1,credentialRevision:revision};
  };
  return {store:new OutsideCustodyStore({} as never,key),state:()=>({head,revisions,operations,statements}),removeHead:()=>{head=undefined;},seedExecutableFixture};
}

beforeEach(()=>{
  vi.clearAllMocks();
  mocks.trackDecryptBuffers=false;mocks.decryptBuffers.length=0;
  mocks.namespace.mockImplementation(async(_pool:unknown,work:(client:unknown)=>Promise<unknown>)=>work(mocks.namespaceClient));
  mocks.transaction.mockImplementation(async(_pool:unknown,work:(client:unknown)=>Promise<unknown>)=>work(sourceClient));
  mocks.query.mockResolvedValue({rows:[],rowCount:0});
  mocks.requireBinding.mockResolvedValue(binding);
  mocks.captureUse.mockResolvedValue(7);
  mocks.captureUseWithExpiry.mockResolvedValue({accessRevision:7,validUntil:null});
  mocks.captureOutsideUse.mockResolvedValue(undefined);
  mocks.gateOrganisation.mockResolvedValue(undefined);
  mocks.retainDeadline.mockReturnValue(undefined);
  mocks.deadlines.mockResolvedValue(undefined);
});
afterEach(()=>vi.restoreAllMocks());

it('runs the actual human preview for a new and an existing account inside the locked session and main namespace',async()=>{
  const route=vi.fn(async()=>humanRoute),store=humanStore({reviewOutsideRoute:route});
  mocks.captureOutsideUse.mockResolvedValue(humanCapture);
  installHumanSessionSql(async sql=>{
    if(sql.includes('FROM outside_custody_accounts WHERE owner_member_id=$1'))return {rows:[],rowCount:0};
    throw new Error(`Unexpected human preview SQL: ${sql}`);
  });
  const created=await store.previewHumanDiscovery(humanSession,{agentName:'worker',connectionName:'connector'},{deadlineAtMs:Date.now()+5000});
  expect(created).toMatchObject({agentName:'worker',connectionName:'connector',endpoint:humanEndpoint,purpose:'streamable-http-discovery-v1',
    expectedGeneration:0,expectedCandidateRevision:null,consentGeneration:1});
  expect(created.accountId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(created.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(created.claimOperationId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(route).toHaveBeenCalledExactlyOnceWith(humanEndpoint,expect.any(Number));
  expect(mocks.captureOutsideUse).toHaveBeenCalledWith('member-1','worker',expect.objectContaining({connectionName:'connector'}));

  mocks.query.mockClear();route.mockClear();
  installHumanSessionSql(async sql=>{
    if(sql.includes('FROM outside_custody_accounts WHERE owner_member_id=$1'))return {rows:[{account_id:accountId,owner_member_id:'member-1',
      resource_id:'worker',connection_name:'connector',generation:'5',active_revision:'2',candidate_revision:'4',consent_generation:'3',state:'active'}],rowCount:1};
    if(sql.includes('COALESCE(max(consent_generation),0)'))return {rows:[{consent:'6'}],rowCount:1};
    throw new Error(`Unexpected existing-account preview SQL: ${sql}`);
  });
  const existing=await store.previewHumanDiscovery(humanSession,{agentName:'worker',connectionName:'connector'},{deadlineAtMs:Date.now()+5000});
  expect(existing).toMatchObject({accountId,expectedGeneration:5,expectedCandidateRevision:4,consentGeneration:7});
  store.close();
});

it.each(['expired or revoked session','current use grant unavailable'] as const)('refuses actual human preview when the %s is absent before route review',async reason=>{
  const route=vi.fn(async()=>humanRoute),store=humanStore({reviewOutsideRoute:route});
  if(reason==='expired or revoked session')mocks.captureOutsideUse.mockResolvedValue(humanCapture);
  else mocks.captureOutsideUse.mockResolvedValue(undefined);
  installHumanSessionSql(async()=>({rows:[],rowCount:0}),reason==='expired or revoked session'?{current:false}:{});
  await expect(store.previewHumanDiscovery(humanSession,{agentName:'worker',connectionName:'connector'},{deadlineAtMs:Date.now()+5000})).rejects.toThrow();
  expect(route).not.toHaveBeenCalled();
  if(reason==='expired or revoked session')expect(mocks.captureOutsideUse).not.toHaveBeenCalled();
  else expect(mocks.captureOutsideUse).toHaveBeenCalledOnce();
  store.close();
});

it.each(['expired deadline','wrong namespace client'] as const)('refuses actual human preview with %s before route review or source transaction',async reason=>{
  const route=vi.fn(async()=>humanRoute),store=humanStore({reviewOutsideRoute:route});
  if(reason==='wrong namespace client')mocks.namespace.mockImplementation(async(_pool:unknown,work:(client:unknown)=>Promise<unknown>)=>work({}));
  const deadline=reason==='expired deadline'?Date.now()-1:Date.now()+5000;
  await expect(store.previewHumanDiscovery(humanSession,{agentName:'worker',connectionName:'connector'},{deadlineAtMs:deadline})).rejects.toThrow();
  expect(route).not.toHaveBeenCalled();expect(mocks.transaction).not.toHaveBeenCalled();
  store.close();
});

it('uses the actual inspector to recover a matching encrypted normalized result and wipes its plaintext buffers',async()=>{
  const rows=discoveryOperationRows(),route=vi.fn(async()=>humanRoute),store=humanStore({reviewOutsideRoute:route});
  mocks.trackDecryptBuffers=true;
  mocks.captureOutsideUse.mockResolvedValue(humanCapture);installInspectSql(rows);
  const inspected=await store.inspectHumanDiscovery(humanSession,{accountId,agentName:'worker',connectionName:'connector',requestId:humanRequest,
    claimOperationId:humanClaim},{deadlineAtMs:Date.now()+5000});
  expect(inspected).toEqual({state:'complete',document:rows.document});
  expect(mocks.decryptBuffers.length).toBeGreaterThanOrEqual(2);
  expect(mocks.decryptBuffers.every(buffer=>buffer.equals(Buffer.alloc(buffer.length)))).toBe(true);
  expect(route).not.toHaveBeenCalled();
  expect(mocks.captureOutsideUse).toHaveBeenCalledWith('member-1','worker',expect.objectContaining({connectionName:'connector'}));
  store.close();
});

it.each([
  ['missing account', {identity:false}],
  ['missing claim', {claim:false}],
  ['claim without result', {result:false}],
] as const)('keeps the actual inspector unresolved for a %s',async(_reason,options)=>{
  const rows=discoveryOperationRows(),store=humanStore();mocks.captureOutsideUse.mockResolvedValue(humanCapture);
  installInspectSql(rows,options);
  await expect(store.inspectHumanDiscovery(humanSession,{accountId,agentName:'worker',connectionName:'connector',requestId:humanRequest,
    claimOperationId:humanClaim},{deadlineAtMs:Date.now()+5000})).resolves.toEqual({state:'unresolved'});
  store.close();
});

it.each([
  {reason:'current session expired or revoked',session:{current:false},validGrant:true},
  {reason:'current use grant expired or revoked',grant:false},
])('refuses actual inspection when $reason is not current',async({session,grant,validGrant})=>{
  const rows=discoveryOperationRows(),route=vi.fn(async()=>humanRoute),store=humanStore({reviewOutsideRoute:route});
  if(validGrant===true)mocks.captureOutsideUse.mockResolvedValue(humanCapture);
  else if(grant===false)mocks.captureOutsideUse.mockResolvedValue(undefined);
  installInspectSql(rows,{session});
  await expect(store.inspectHumanDiscovery(humanSession,{accountId,agentName:'worker',connectionName:'connector',requestId:humanRequest,
    claimOperationId:humanClaim},{deadlineAtMs:Date.now()+5000})).rejects.toThrow();
  if(validGrant===true)expect(mocks.captureOutsideUse).not.toHaveBeenCalled();
  else expect(mocks.captureOutsideUse).toHaveBeenCalledOnce();
  expect(route).not.toHaveBeenCalled();
  store.close();
});

it.each([
  ['foreign owner on the claim',{claim:{owner_member_id:'other-member'}}],
  ['wrong claim identity',{claim:{operation_id:humanResult}}],
  ['altered stored policy',{claim:{policy_json:JSON.stringify({version:2,purpose:'wrong'})}}],
  ['wrong result request digest',{result:{request_hash:Buffer.alloc(32,9)}}],
] as const)('refuses actual encrypted inspection for %s',async(_reason,changes)=>{
  const rows=discoveryOperationRows(changes),store=humanStore();mocks.captureOutsideUse.mockResolvedValue(humanCapture);installInspectSql(rows);
  await expect(store.inspectHumanDiscovery(humanSession,{accountId,agentName:'worker',connectionName:'connector',requestId:humanRequest,
    claimOperationId:humanClaim},{deadlineAtMs:Date.now()+5000})).rejects.toThrow();
  store.close();
});
it('does not expose an encrypted result recorded under another owner',async()=>{
  const rows=discoveryOperationRows({result:{owner_member_id:'other-member'}}),store=humanStore();
  mocks.captureOutsideUse.mockResolvedValue(humanCapture);installInspectSql(rows);
  await expect(store.inspectHumanDiscovery(humanSession,{accountId,agentName:'worker',connectionName:'connector',requestId:humanRequest,
    claimOperationId:humanClaim},{deadlineAtMs:Date.now()+5000})).resolves.toEqual({state:'unresolved'});
  store.close();
});

it.each([
  ['foreign account link',{identity:{account_id:'00000000-0000-4000-8000-000000000199'}}],
  ['foreign agent link',{identity:{resource_id:'other-worker'}}],
  ['foreign connection link',{identity:{connection_name:'other-connector'}}],
] as const)('refuses actual inspection with a %s',async(_reason,changes)=>{
  const rows=discoveryOperationRows(changes),store=humanStore();mocks.captureOutsideUse.mockResolvedValue(humanCapture);installInspectSql(rows);
  await expect(store.inspectHumanDiscovery(humanSession,{accountId,agentName:'worker',connectionName:'connector',requestId:humanRequest,
    claimOperationId:humanClaim},{deadlineAtMs:Date.now()+5000})).rejects.toThrow();
  store.close();
});

const aadTamperingCases:{name:string;overrides:DiscoveryAad}[]=[
  {name:'owner',overrides:{ownerMemberId:'other-member'}},
  {name:'account',overrides:{accountId:'00000000-0000-4000-8000-000000000199'}},
  {name:'agent',overrides:{agentName:'other-worker'}},
  {name:'connection',overrides:{connectionName:'other-connector'}},
  {name:'request',overrides:{requestId:'00000000-0000-4000-8000-000000000299'}},
  {name:'claim operation',overrides:{claimOperationId:'00000000-0000-4000-8000-000000000298'}},
  {name:'result operation',overrides:{resultOperationId:'00000000-0000-4000-8000-000000000297'}},
  {name:'generation',overrides:{generation:2}},
  {name:'credential revision',overrides:{credentialRevision:3}},
  {name:'consent generation',overrides:{consentGeneration:4}},
  {name:'policy hash',overrides:{policyHash:'c'.repeat(64)}},
];
it.each(aadTamperingCases)('rejects authenticated recovery when the $name AAD coordinate differs',async({overrides})=>{
  const rows=discoveryOperationRows(),cipher=encryptDiscovery(rows.document,rows.policyHash,overrides);
  rows.result.result_nonce=cipher.nonce;rows.result.result_ciphertext=cipher.ciphertext;
  mocks.trackDecryptBuffers=true;mocks.captureOutsideUse.mockResolvedValue(humanCapture);installInspectSql(rows);
  const route=vi.fn(async()=>humanRoute),store=humanStore({reviewOutsideRoute:route});
  await expect(store.inspectHumanDiscovery(humanSession,{accountId,agentName:'worker',connectionName:'connector',requestId:humanRequest,
    claimOperationId:humanClaim},{deadlineAtMs:Date.now()+5000})).rejects.toThrow();
  expect(mocks.decryptBuffers.length).toBeGreaterThanOrEqual(1);
  expect(mocks.decryptBuffers.every(buffer=>buffer.equals(Buffer.alloc(buffer.length)))).toBe(true);
  expect(route).not.toHaveBeenCalled();
  store.close();
});

it('wipes unauthenticated decrypt output and rejects an altered GCM tag',async()=>{
  const rows=discoveryOperationRows(),ciphertext=Buffer.from(rows.result.result_ciphertext as Buffer);
  ciphertext[ciphertext.length-1]^=1;rows.result.result_ciphertext=ciphertext;
  mocks.trackDecryptBuffers=true;
  const store=humanStore();mocks.captureOutsideUse.mockResolvedValue(humanCapture);installInspectSql(rows);
  await expect(store.inspectHumanDiscovery(humanSession,{accountId,agentName:'worker',connectionName:'connector',requestId:humanRequest,
    claimOperationId:humanClaim},{deadlineAtMs:Date.now()+5000})).rejects.toThrow();
  expect(mocks.decryptBuffers).toHaveLength(1);
  expect(mocks.decryptBuffers[0]).toEqual(Buffer.alloc(mocks.decryptBuffers[0]!.length));
  store.close();
});

it.each([
  ['invalid UTF-8',Buffer.from([0xff])],
  ['invalid JSON',Buffer.from('{not-json}')],
  ['invalid normalized document',Buffer.from('{"protocolVersion":"wrong","serverInfo":{"name":"x","version":"1"},"tools":[]}')],
  ['tool-count limit',Buffer.from(JSON.stringify({protocolVersion:'2025-06-18',serverInfo:{name:'x',version:'1'},
    tools:Array.from({length:257},(_,index)=>({name:`tool-${index}`,inputSchema:{type:'object'}}))}))],
] as const)('wipes decrypted temporary buffers when inspection rejects %s',async(_reason,plaintext)=>{
  const rows=discoveryOperationRows(),encrypted=encryptDiscoveryBytes(Buffer.from(plaintext),rows.policyHash);
  rows.result.result_nonce=encrypted.nonce;rows.result.result_ciphertext=encrypted.ciphertext;
  mocks.trackDecryptBuffers=true;
  const store=humanStore();mocks.captureOutsideUse.mockResolvedValue(humanCapture);installInspectSql(rows);
  await expect(store.inspectHumanDiscovery(humanSession,{accountId,agentName:'worker',connectionName:'connector',requestId:humanRequest,
    claimOperationId:humanClaim},{deadlineAtMs:Date.now()+5000})).rejects.toThrow();
  expect(mocks.decryptBuffers.length).toBeGreaterThanOrEqual(1);
  expect(mocks.decryptBuffers.every(buffer=>buffer.equals(Buffer.alloc(buffer.length)))).toBe(true);
  store.close();
});

it('enters the bound main-pool namespace before borrowing the outside-role transaction',async()=>{
  const events:string[]=[];
  const mainPool={};
  const runtime={mainPool:mainPool as never,lifecycle:{} as never};
  const store=new OutsideCustodyStore({} as never,key,runtime);
  mocks.namespace.mockImplementation(async(pool:unknown,work:(client:unknown)=>Promise<unknown>)=>{
    expect(pool).toBe(mainPool);
    events.push('main namespace');return work(mocks.namespaceClient);
  });
  mocks.transaction.mockImplementation(async(_pool:unknown,work:(client:unknown)=>Promise<unknown>)=>{
    events.push('outside transaction');return work(sourceClient);
  });
  await expect(store.previewDiscovery('A'.repeat(43),{agentName:'worker',connectionName:'connection'},
    {deadlineAtMs:Date.now()+5000})).rejects.toThrow();
  expect(events).toEqual(['main namespace','outside transaction']);
  store.close();
});

it('does not expose claim or namespace authority helpers as runtime methods',()=>{
  const store=new OutsideCustodyStore({} as never,key);
  const methods=Object.getOwnPropertyNames(Object.getPrototypeOf(store));
  for(const name of ['mintClaimIdentity','consumeClaimIdentity','inMainNamespace','assertMainNamespace','claimDiscovery','phase2Authority'])
    expect(methods).not.toContain(name);
  store.close();
});

it('reserves two discovery rows within the 32-row cap and refuses at 31 persisted rows',async()=>{
  const atThirty=capacityHarness(ordinaryCapacityRows(30));
  await expect(atThirty.discover()).resolves.toBeUndefined();
  atThirty.store.close();
  const atThirtyOne=capacityHarness(ordinaryCapacityRows(31));
  await expect(atThirtyOne.discover()).rejects.toThrow();
  atThirtyOne.store.close();
});

it('counts each persisted unmatched discovery claim before admitting another pair',async()=>{
  const capacity=capacityHarness(ordinaryCapacityRows(28));
  await expect(capacity.discover()).resolves.toBeUndefined();
  capacity.rows.push(discoveryCapacityRow('claim','request-one','claimed'));
  await expect(capacity.discover()).resolves.toBeUndefined();
  capacity.rows.push(discoveryCapacityRow('claim','request-two','claimed'));
  await expect(capacity.discover()).rejects.toThrow();
  capacity.store.close();
});

it('keeps an unmatched spent claim reserved and counts a matching acknowledged result only once',async()=>{
  const pending=capacityHarness([...ordinaryCapacityRows(29),discoveryCapacityRow('claim','request-spent','claimed')]);
  await expect(pending.discover()).rejects.toThrow();
  pending.store.close();
  for(const outcome of ['completed','unknown']){
    const acknowledged=capacityHarness([...ordinaryCapacityRows(28),discoveryCapacityRow('claim','request-done','claimed'),
      discoveryCapacityRow('result','request-done',outcome)]);
    await expect(acknowledged.discover()).resolves.toBeUndefined();
    acknowledged.store.close();
  }
  const mismatched=capacityHarness([...ordinaryCapacityRows(28),discoveryCapacityRow('claim','request-spent','claimed'),
    discoveryCapacityRow('result','request-spent','unknown','other-member')]);
  await expect(mismatched.discover()).rejects.toThrow();
  mismatched.store.close();
});

it('preserves the 16-revision limit and emergency revoke allowance',async()=>{
  const fullRevisions=capacityHarness(ordinaryCapacityRows(28),16);
  await expect(fullRevisions.discover()).rejects.toThrow();
  fullRevisions.store.close();
  const emergency=capacityHarness(ordinaryCapacityRows(32));
  await expect(emergency.revoke()).resolves.toBeUndefined();
  emergency.rows.push({accountId,ownerMemberId:'member-1',requestId:'emergency-revoke',kind:'stage',phase:'operation',outcome:'staged'});
  await expect(emergency.revoke()).rejects.toThrow();
  emergency.store.close();
});

it('refuses before any claim or SQL while the concrete discovery exchange is unavailable and wipes the input buffer',async()=>{
  const store=new OutsideCustodyStore({} as never,key),secret=Buffer.from('never-persist-without-an-exchange');
  await expect(store.consentAndDiscover('A'.repeat(43),{requestId:operationId,operationId,accountId,agentName:'worker',
    connectionName:'connection',expectedGeneration:0,expectedCandidateRevision:null,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:7,
    expectedDestinationHash:'b'.repeat(64),expectedRoutePolicyHash:'c'.repeat(64),consentGeneration:1,credential:secret},
    {deadlineAtMs:Date.now()+5000})).rejects.toThrow('Outside credential change could not be confirmed');
  expect(secret).toEqual(Buffer.alloc(secret.length));
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
  store.close();
});

it.each(['main pool','route lifecycle','outside pool connect'] as const)('refuses before namespace or SQL when the configured %s is missing',async missing=>{
  const pool={connect:vi.fn()},mainPool={} as never,lifecycle={} as never;
  const runtime={mainPool,lifecycle};
  const store=missing==='main pool'
    ?new OutsideCustodyStore(pool as never,key,{...runtime,mainPool:undefined as never} as never)
    :missing==='route lifecycle'
      ?new OutsideCustodyStore(pool as never,key,{...runtime,lifecycle:undefined as never} as never)
      :new OutsideCustodyStore({} as never,key,runtime);
  const secret=Buffer.from(`missing-${missing}`);
  await expect(store.consentAndDiscover('A'.repeat(43),{requestId:operationId,operationId,accountId,agentName:'worker',
    connectionName:'connection',expectedGeneration:0,expectedCandidateRevision:null,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:7,
    expectedDestinationHash:'b'.repeat(64),expectedRoutePolicyHash:'c'.repeat(64),consentGeneration:1,credential:secret},
    {deadlineAtMs:Date.now()+5000})).rejects.toThrow('Outside credential change could not be confirmed');
  expect(secret).toEqual(Buffer.alloc(secret.length));
  expect(mocks.namespace).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
  if(missing==='main pool')expect(pool.connect).not.toHaveBeenCalled();
  store.close();
});

it('refuses before namespace or SQL after the configured store is closed and wipes the input buffer',async()=>{
  const store=new OutsideCustodyStore({connect:vi.fn()} as never,key,{mainPool:{} as never,lifecycle:{} as never});
  store.close();
  const secret=Buffer.from('closed-store-credential');
  await expect(store.consentAndDiscover('A'.repeat(43),{requestId:operationId,operationId,accountId,agentName:'worker',
    connectionName:'connection',expectedGeneration:0,expectedCandidateRevision:null,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:7,
    expectedDestinationHash:'b'.repeat(64),expectedRoutePolicyHash:'c'.repeat(64),consentGeneration:1,credential:secret},
    {deadlineAtMs:Date.now()+5000})).rejects.toThrow('Outside credential change could not be confirmed');
  expect(secret).toEqual(Buffer.alloc(secret.length));
  expect(mocks.namespace).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
});

it.each([{label:'expired',deadline:()=>Date.now()-1},{label:'NaN',deadline:()=>Number.NaN},
  {label:'positive infinity',deadline:()=>Number.POSITIVE_INFINITY},{label:'negative infinity',deadline:()=>Number.NEGATIVE_INFINITY}])(
  'refuses before namespace or SQL for an $label operation deadline and wipes the input buffer',async({deadline})=>{
    const store=new OutsideCustodyStore({connect:vi.fn()} as never,key,{mainPool:{} as never,lifecycle:{} as never});
    const secret=Buffer.from('invalid-deadline-credential');
    await expect(store.consentAndDiscover('A'.repeat(43),{requestId:operationId,operationId,accountId,agentName:'worker',
      connectionName:'connection',expectedGeneration:0,expectedCandidateRevision:null,expectedDefinitionHash:'a'.repeat(64),expectedAccessRevision:7,
      expectedDestinationHash:'b'.repeat(64),expectedRoutePolicyHash:'c'.repeat(64),consentGeneration:1,credential:secret},
      {deadlineAtMs:deadline()})).rejects.toThrow('Outside credential change could not be confirmed');
    expect(secret).toEqual(Buffer.alloc(secret.length));
    expect(mocks.namespace).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    store.close();
  });

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

it('refuses numeric-consent-only executable stage before touching custody state and wipes the credential',async()=>{
  const {store,state}=candidateStore(),candidate=Buffer.from('must not be stored or sent');
  await expect(store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:candidate})).rejects.toThrow();
  expect(candidate).toEqual(Buffer.alloc(candidate.length));
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(state().statements).toHaveLength(0);
  expect(state().revisions.size).toBe(0);
  expect(state().operations.size).toBe(0);
});

it('does not let the numeric stage interface create or replace any executable revision',async()=>{
  const {store,state}=candidateStore();
  const first=Buffer.from('candidate A'),replacement=Buffer.from('candidate B');
  await expect(store.stage(binding,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:first})).rejects.toThrow();
  await expect(store.stage(binding,{accountId,operationId:stageOperationB,expectedGeneration:1,expectedCandidateRevision:1,credential:replacement})).rejects.toThrow();
  expect(first).toEqual(Buffer.alloc(first.length));expect(replacement).toEqual(Buffer.alloc(replacement.length));
  expect(state().statements).toHaveLength(0);expect(state().revisions.size).toBe(0);expect(state().operations.size).toBe(0);
});

it('does not create a replay receipt when a stage operation id is reused',async()=>{
  const {store,state}=candidateStore();
  const credential=()=>Buffer.from('candidate B');
  await expect(store.stage(binding,{accountId,operationId:stageOperationB,expectedGeneration:1,expectedCandidateRevision:1,credential:credential()})).rejects.toThrow();
  await expect(store.stage(binding,{accountId,operationId:stageOperationB,expectedGeneration:1,expectedCandidateRevision:2,credential:credential()})).rejects.toThrow();
  expect(state().statements).toHaveLength(0);expect(state().revisions.size).toBe(0);expect(state().operations.size).toBe(0);
});

it('rejects stage attempts for foreign owners, resources, accounts and changed input without database access',async()=>{
  const {store,state}=candidateStore();
  for(const b of [binding,{...binding,memberId:'member-2'},{...binding,agent:'other-agent'}])
    await expect(store.stage(b,{accountId,operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:null,credential:Buffer.from('candidate A')})).rejects.toThrow();
  await expect(store.stage(binding,{accountId:'00000000-0000-4000-8000-000000000105',operationId:stageOperationA,expectedGeneration:0,expectedCandidateRevision:1,credential:Buffer.from('different credential')})).rejects.toThrow();
  expect(state().statements).toHaveLength(0);expect(state().revisions.size).toBe(0);expect(state().operations.size).toBe(0);
});

it('checks existing operation owner explicitly and refuses a receipt whose account head is missing',async()=>{
  const {store,state,removeHead,seedExecutableFixture}=candidateStore();
  seedExecutableFixture();
  const operation=state().operations.get(stageOperationA)!;
  operation.owner_member_id='member-2';
  await expect(store.inspect(binding,stageOperationA)).rejects.toThrow();
  operation.owner_member_id='member-1';
  removeHead();
  await expect(store.inspect(binding,stageOperationA)).rejects.toThrow();
});

it('keeps executable apply closed until persisted current-policy verification exists',async()=>{
  const {store,state,seedExecutableFixture}=candidateStore();
  seedExecutableFixture();
  await expect(store.apply(binding,{accountId,operationId:applyOperationA,expectedGeneration:1,candidateRevision:1,consentGeneration:7})).rejects.toThrow();
  expect(state().statements).toHaveLength(0);
  expect(state().head).toMatchObject({generation:1,active_revision:null,candidate_revision:1,state:'active'});
});

it('keeps executable rollback closed without reading or decrypting its stored revision',async()=>{
  const {store,state,seedExecutableFixture}=candidateStore();
  seedExecutableFixture();
  const rollbackId='00000000-0000-4000-8000-000000000114';
  await expect(store.rollback(binding,{accountId,operationId:rollbackId,expectedGeneration:1,sourceRevision:1,consentGeneration:7})).rejects.toThrow();
  expect(state().statements).toHaveLength(0);
  expect(state().revisions.get(1)?.ciphertext).toBeDefined();
});

it('returns an exact revoke receipt after revocation without writes',async()=>{
  const {store,state,seedExecutableFixture}=candidateStore();
  seedExecutableFixture();
  const revokeId='00000000-0000-4000-8000-000000000115';
  const revoked=await store.revoke(binding,{accountId,operationId:revokeId,expectedGeneration:1});
  expect(state().head).toMatchObject({generation:2,state:'revoked',active_revision:null,candidate_revision:null});
  const before=state(),statementCount=before.statements.length;
  await expect(store.revoke(binding,{accountId,operationId:revokeId,expectedGeneration:1})).resolves.toEqual(revoked);
  expect(state().statements.slice(statementCount).some(({sql})=>/^(INSERT|UPDATE)/.test(sql.trim()))).toBe(false);
  await expect(store.revoke({...binding,memberId:'member-2'},{accountId,operationId:revokeId,expectedGeneration:2})).rejects.toThrow();
  await expect(store.revoke({...binding,agent:'other-agent'},{accountId,operationId:revokeId,expectedGeneration:2})).rejects.toThrow();
});

it('scopes historical inspection to the linked account owner and resource while allowing advanced heads',async()=>{
  const {store,state,removeHead,seedExecutableFixture}=candidateStore();
  await expect(store.inspect(binding,operationId)).resolves.toBeUndefined();
  const staged=seedExecutableFixture();
  await expect(store.inspect(binding,stageOperationA)).resolves.toEqual(staged);
  await expect(store.inspect({...binding,memberId:'member-2'},stageOperationA)).rejects.toThrow();
  await expect(store.inspect({...binding,agent:'other-agent'},stageOperationA)).rejects.toThrow();
  removeHead();
  await expect(store.inspect(binding,stageOperationA)).rejects.toThrow();
  const revokedHead=candidateStore();
  const revokedStage=revokedHead.seedExecutableFixture();
  const revokeId='00000000-0000-4000-8000-000000000115';
  await revokedHead.store.revoke(binding,{accountId,operationId:revokeId,expectedGeneration:1});
  await expect(revokedHead.store.inspect(binding,stageOperationA)).resolves.toEqual(revokedStage);
  const foreignHead=candidateStore();
  foreignHead.seedExecutableFixture(1,stageOperationB);
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

it('awaits admitted work before wiping the key during shutdown drain',async()=>{
  let entered!:()=>void,release!:()=>void;
  const inRun=new Promise<void>(resolve=>{entered=resolve;}),runResult=new Promise<void>(resolve=>{release=resolve;});
  const result={operationId,accountId,kind:'stage' as const,outcome:'staged' as const,generation:1,credentialRevision:1};
  const store=new OutsideCustodyStore({} as never,key);
  const pending=store.runAndRecover(operationId,async()=>{entered();await runResult;return result;},async()=>undefined);
  await inRun;
  let drained=false;
  const draining=store.drainForShutdown().then(()=>{drained=true;});
  expect(drained).toBe(false);
  expect(storeKey(store)).toEqual(key);
  release();
  await expect(pending).rejects.toThrow();
  await draining;
  expect(drained).toBe(true);
  expect(storeKey(store)).toEqual(Buffer.alloc(32));
});

it('refuses a numeric-consent-only stage before waiting on custody state, sealing or writing',async()=>{
  const store=new OutsideCustodyStore({} as never,key),staged=Buffer.from('credential to wipe');
  await expect(store.stage(binding,{accountId,operationId,expectedGeneration:0,expectedCandidateRevision:null,credential:staged})).rejects.toThrow();
  store.close();
  expect(storeKey(store)).toEqual(Buffer.alloc(32));
  expect(staged).toEqual(Buffer.alloc(staged.length));
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it('keeps credential delivery closed before database reads until current policy verification exists',async()=>{
  const {store,state,seedExecutableFixture}=candidateStore();
  seedExecutableFixture();
  const use=vi.fn(async()=> 'must not escape');
  await expect(store.withCredential(binding,{accountId},use)).rejects.toThrow();
  expect(use).not.toHaveBeenCalled();
  expect(state().statements).toHaveLength(0);
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(state().revisions.get(1)?.ciphertext).toBeDefined();
});

it('refuses rollback before reading or decrypting a test-owned executable revision',async()=>{
  const {store,state,seedExecutableFixture}=candidateStore();
  seedExecutableFixture();
  await expect(store.rollback(binding,{accountId,operationId:applyOperationB,expectedGeneration:1,sourceRevision:1,consentGeneration:7})).rejects.toThrow();
  expect(state().statements).toHaveLength(0);
  expect(state().revisions.get(1)?.ciphertext).toBeDefined();
});
