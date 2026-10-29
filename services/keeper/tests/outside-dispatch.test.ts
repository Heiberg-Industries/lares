import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createCipheriv,createHash,randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {OutsideCustodyStore,type OutsideToolCallInput} from '../lib/outside-custody.js';
import {outsidePayloadHash} from '@lares/agent-kit/outside-execution-receipts';
const mocks=vi.hoisted(()=>({query:vi.fn(),capture:vi.fn(),session:vi.fn(),request:vi.fn(),destroy:vi.fn()}));
vi.mock('@lares/agent-kit/console-source-transaction',async original=>({...await original<typeof import('@lares/agent-kit/console-source-transaction')>(),
 consoleSourceTransaction:async(_pool:unknown,work:(db:unknown)=>Promise<unknown>)=>work({query:mocks.query}),
 requireSourceTransactionOwner:()=>{},checkConsoleSourceDeadlines:async()=>{},gateConsoleOrganisation:async()=>{},retainSourceTransactionDeadline:()=>{}}));
vi.mock('@lares/agent-kit/console-turn-authority',()=>({requireConsoleSessionBinding:mocks.session}));
vi.mock('@lares/agent-kit/grant-store',()=>({PgGrantStore:class{captureOutsideUse(...args:unknown[]){return mocks.capture(...args)}}}));
vi.mock('../lib/definition-namespace.js',()=>({requireDefinitionNamespace:()=>mocks,
 withDefinitionNamespace:async(_pool:unknown,work:(db:unknown)=>Promise<unknown>)=>work(mocks)}));
vi.mock('undici',()=>({request:mocks.request,ProxyAgent:class{destroy(){return mocks.destroy()}},Client:class{}}));
const key=Buffer.alloc(32,9),credential='DISPOSABLE_OUTSIDE_CREDENTIAL',incarnation='11111111-1111-4111-8111-111111111111',
 accountId='22222222-2222-4222-8222-222222222222',publicationId='33333333-3333-4333-8333-333333333333',
 acceptanceId='44444444-4444-4444-8444-444444444444',operationId='55555555-5555-4555-8555-555555555555';
const binding={agent:'helper',incarnation,sessionId:'session-1',memberId:'member-a',approverMemberId:'member-a',admissionNonce:'a'.repeat(43),policyRevision:2};
const call:OutsideToolCallInput={...binding,callId:'call-1',requestId:'request-1',definitionHash:'a'.repeat(64),connectionName:'registry',accountId,credentialRevision:4,toolName:'lookup',input:{company:'Example'}};
const capture={version:1,actor:{memberId:'member-a',organisationId:'org-1',role:'member'},
 agent:{name:'helper',ownerMemberId:'member-a',accessRevision:7,definitionHash:call.definitionHash},ownerPolicy:{kind:'unrestricted'},
 outside:{scope:'read',autonomy:'gated',connection:{name:'registry',url:'https://example.test/mcp',auth:'bearer',allow:['lookup'],read:['lookup'],trusted:false}},grant:{kind:'owner',validUntil:null}};
const route={policyHash:'b'.repeat(64),sourceAddress:'198.51.100.10',proxyUrl:'http://lares-egress-proxy:8888/'};
function canonical(value:unknown):string{if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value)}
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function encrypt(value:unknown,aad:unknown){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(canonical(aad)));return {nonce,ciphertext:Buffer.concat([cipher.update(Buffer.isBuffer(value)?value:Buffer.from(canonical(value))),cipher.final(),cipher.getAuthTag()])}}
function fixture(){
 let consumed=false,expired=false,revoked=false,recorded:Record<string,unknown>|undefined;
 const receipt={callId:call.callId,requestId:call.requestId,sessionId:call.sessionId,memberId:call.memberId,
  approverMemberId:call.approverMemberId,agent:call.agent,incarnation:call.incarnation,definitionHash:call.definitionHash,
  connectionName:call.connectionName,accountId:call.accountId,credentialRevision:call.credentialRevision,toolName:call.toolName,
  payloadHash:outsidePayloadHash(call.toolName,call.input)};
 const head={account_id:accountId,owner_member_id:'member-a',resource_id:'helper',connection_name:'registry',generation:'2',active_revision:'4',candidate_revision:null as string|null,consent_generation:'3',state:'active'};
 const projection={version:1,connectionName:'registry',scope:'read',allow:['lookup'],read:['lookup'],tools:[{name:'lookup',description:'Look up a company',inputSchema:{type:'object'}}]};
 const publication={version:1,organisationId:'org-1',actorMemberId:'member-a',publicationHash:hash(projection),
 source:{requestId:operationId,claimOperationId:operationId,revision:1,consentGeneration:3,policyHash:route.policyHash},definition:{hash:call.definitionHash,accessRevision:7},capture,projection};
 const acceptance={version:1,organisationId:'org-1',editorMemberId:'member-a',publicationId,publicationHash:publication.publicationHash,resourceId:'helper',connectionName:'registry',definitionHash:call.definitionHash,accessRevision:7,grant:{kind:'owner',validUntil:null}};
 const policy={version:1,purpose:'outside-executable-v1',ownerMemberId:'member-a',accountId,resourceId:'helper',connectionName:'registry',capture,route,
 publication:{id:publicationId,hash:publication.publicationHash,descriptorDigest:hash(projection),acceptedScope:{scope:'read',allow:['lookup'],read:['lookup']}},acceptance:{id:acceptanceId,hash:hash(acceptance),editorMemberId:'member-a'}};
 const sealed=encrypt(Buffer.from(credential),['lares-outside-custody-bound-v1',JSON.stringify(['lares-outside-custody-v1','member-a',accountId,'helper',2,4,3,operationId]),'registry','executable',hash(policy)]);
 const revision={owner_member_id:'member-a',generation:'2',credential_revision:'4',consent_generation:'3',revision_purpose:'executable',policy_json:JSON.stringify(policy),policy_hash:Buffer.from(hash(policy),'hex'),operation_id:operationId,...sealed};
 const evidence=(id:string,kind:string,body:unknown,outcome:string)=>{const digest=hash(body),sealed=encrypt(body,['lares-outside-custody-evidence-v1',{accountId,ownerMemberId:'member-a',resourceId:'helper',connectionName:'registry',operationId:id,kind,hash:digest}]);return {operation_id:id,account_id:accountId,owner_member_id:'member-a',operation_kind:kind==='descriptor-publication-v1'?'publish':'accept',evidence_kind:kind,evidence_hash:Buffer.from(digest,'hex'),result_nonce:sealed.nonce,result_ciphertext:sealed.ciphertext,actor_member_id:'member-a',outcome}};
 const revisions=new Map([[4,revision]]);
 const rows=new Map<string,Record<string,unknown>>([[publicationId,evidence(publicationId,'descriptor-publication-v1',publication,'published')],[acceptanceId,evidence(acceptanceId,'descriptor-acceptance-v1',acceptance,'accepted')]]);
 const expected=[call.callId,call.requestId,call.sessionId,call.memberId,call.approverMemberId,call.agent,call.incarnation,call.definitionHash,call.connectionName,call.accountId,call.credentialRevision,call.toolName,outsidePayloadHash(call.toolName,call.input)];
 mocks.query.mockImplementation(async(sql:string,params:unknown[]=[])=>{
  let result:unknown[]=[];
  if(sql.includes('SELECT member_id FROM member_sessions'))return {rows:[{member_id:'member-a'}],rowCount:1};
  if(sql.includes('FROM member_sessions s JOIN users'))return {rows:[{member_id:'member-a',finite:true,deadline:'2099-01-01T00:00:00.000000Z'}],rowCount:1};
  if(sql.includes('FROM agent_resources'))result=[{state:'ready',pending:false,ownership_token:incarnation,runtime_control_token:incarnation,hash:call.definitionHash}];
  else if(sql.includes('FROM users'))result=[{id:params[0],org_id:'org-1',org_role:'member',status:'active',automation_mode:'draft-and-ask'}];
  else if(sql.includes('SELECT account_id::text,active_revision::text'))result=[{account_id:head.account_id,active_revision:head.active_revision}];
  else if(sql.includes('FROM outside_custody_accounts'))result=[head];
  else if(sql.includes('FROM outside_custody_revisions'))result=revisions.has(Number(params[1]))?[revisions.get(Number(params[1]))]:[];
  else if(sql.includes('FROM outside_custody_operations'))result=rows.has(String(params[1]))?[rows.get(String(params[1]))]:[];
  else if(sql.includes('INSERT INTO outside_execution_approvals')){
   recorded={request_id:params[1],session_id:params[2],member_id:params[3],approver_member_id:params[4],agent:params[5],incarnation:params[6],
    definition_hash:params[7],connection_name:params[8],account_id:params[9],credential_revision:String(params[10]),tool_name:params[11],
    payload_hash:params[12],expires_at_ms:String(params[13]),consumed_at:null};
  }
  else if(sql.includes('floor(extract(epoch from expires_at)'))result=recorded?[recorded]:[];
  else if(sql.includes('SELECT call_id AS')){
   const lookup=[receipt.callId,receipt.agent,receipt.incarnation,receipt.sessionId,receipt.memberId,receipt.approverMemberId,
    receipt.definitionHash,receipt.connectionName,receipt.toolName,receipt.payloadHash];
   if(!consumed&&!expired&&!revoked&&params.every((value,index)=>value===lookup[index]))result=[{...receipt,credentialRevision:String(receipt.credentialRevision)}];
  }
  else if(sql.includes('SELECT call_id FROM outside_execution_approvals'))result=consumed&&!expired&&!revoked?[{call_id:call.callId}]:[];
  else if(sql.includes('UPDATE outside_execution_approvals')){if(!consumed&&!expired&&!revoked&&params.slice(0,13).every((v,i)=>v===expected[i])){consumed=true;result=[{call_id:call.callId}]}}
  else throw new Error('Unexpected dispatch SQL');
  return {rows:result,rowCount:result.length};
 });
 mocks.session.mockResolvedValue({policyRevision:2});mocks.capture.mockResolvedValue(structuredClone(capture));mocks.destroy.mockResolvedValue(undefined);
 mocks.request.mockImplementation(async(_url:string,options:{body:Buffer})=>{
  const message=JSON.parse(options.body.toString());
  const result=message.method==='initialize'?{protocolVersion:'2025-06-18',serverInfo:{name:'Fixture',version:'1'}}:{content:[{type:'text',text:'Example found'}]};
  return {statusCode:message.id===undefined?202:200,headers:{'content-type':'application/json'},body:Readable.from(message.id===undefined?[]:[Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))])};
 });
 const lease={assertCurrent:vi.fn(async()=>route)},lifecycle={withAppliedOutsideRoute:vi.fn(async(_url:string,_hash:string,_deadline:number,use:(lease:unknown)=>Promise<unknown>)=>use(lease))};
 const store=new OutsideCustodyStore({} as never,key,{mainPool:{} as never,lifecycle:lifecycle as never});
 const execute=(input=call,b=binding,assertCurrent?:()=>void)=>store.dispatchApproved(b,{callId:input.callId,connectionName:input.connectionName,toolName:input.toolName,input:input.input},{deadlineAtMs:Date.now()+8000,assertCurrent});
 return {store,execute,receipt,head,revision,revisions,lease,lifecycle,policy,publication,rows,evidence,expire:()=>{expired=true},revoke:()=>{revoked=true},get consumed(){return consumed}};
}
beforeEach(()=>vi.clearAllMocks());afterEach(()=>vi.restoreAllMocks());
it('dispatches the exact receipt once through the applied route with Keeper-only credential custody',async()=>{
 const f=fixture();try{
  const result=await f.execute();expect(result).toEqual({content:[{type:'text',text:'Example found'}]});expect(f.consumed).toBe(true);
  expect(mocks.request).toHaveBeenCalledTimes(3);const options=mocks.request.mock.calls[2]![1];
  expect(JSON.parse(options.body.toString())).toMatchObject({method:'tools/call',params:{name:'lookup',arguments:call.input}});
  expect(options.headers.authorization).toBe('Bearer '+credential);expect(JSON.stringify(result)).not.toContain(credential);
  expect(f.lifecycle.withAppliedOutsideRoute).toHaveBeenCalledWith('https://example.test/mcp',route.policyHash,expect.any(Number),expect.any(Function));
  expect(mocks.destroy).toHaveBeenCalledOnce();mocks.request.mockClear();await expect(f.execute()).rejects.toThrow();expect(mocks.request).not.toHaveBeenCalled();
 }finally{f.store.close()}
});
it.each([
 ['member',{memberId:'member-b'}],['session',{sessionId:'another-session'}],['agent',{agent:'another-agent'}],
 ['approver',{approverMemberId:'member-b'}],['incarnation',{incarnation:'66666666-6666-4666-8666-666666666666'}],
 ['payload',{input:{company:'Changed'}}],['connection',{connectionName:'another-connection'}],['tool',{toolName:'create'}],
 ['credential version',{credentialRevision:3}],['account',{accountId:'77777777-7777-4777-8777-777777777777'}],['definition',{definitionHash:'f'.repeat(64)}],
 ['request',{requestId:'another-request'}],['call',{callId:'another-call'}],
] as const)('refuses changed %s before any provider request',async(name,change)=>{const f=fixture();try{
 if(name==='request'){
  await expect(f.store.dispatchApproved(binding,{callId:call.callId,connectionName:call.connectionName,toolName:call.toolName,input:call.input,...change} as never,
   {deadlineAtMs:Date.now()+8000})).rejects.toThrow();
 }else if(['payload','connection','tool','call'].includes(name))await expect(f.execute({...call,...change})).rejects.toThrow();
 else{Object.assign(f.receipt,change);await expect(f.execute()).rejects.toThrow();}
 expect(mocks.request).not.toHaveBeenCalled();expect(f.consumed).toBe(false);
 }finally{f.store.close()}});
it.each(['expired','revoked','another member custody','removed connection','rotated token','missing grant','revoked session','wrong route','no runtime turn'] as const)('refuses %s before provider dispatch',async reason=>{
 const f=fixture();try{
  if(reason==='expired')f.expire();if(reason==='revoked')f.revoke();if(reason==='another member custody')f.head.owner_member_id='member-b';
  if(reason==='removed connection')f.head.state='revoked';if(reason==='rotated token')f.head.active_revision='5';
  if(reason==='missing grant')mocks.capture.mockResolvedValue(undefined);if(reason==='revoked session')mocks.session.mockRejectedValue(new Error('revoked'));
  if(reason==='wrong route')f.lease.assertCurrent.mockResolvedValue({...route,sourceAddress:'198.51.100.11'});
  await expect(f.execute(call,binding,reason==='no runtime turn'?()=>{throw new Error('turn closed')}:undefined)).rejects.toThrow();expect(mocks.request).not.toHaveBeenCalled();expect(f.consumed).toBe(false);
 }finally{f.store.close()}
});
it.each(['rotation','removal','grant revocation','turn closed','approval expiry','approval revocation'] as const)('rechecks %s after receipt consumption and before tools/call',async reason=>{
 const f=fixture();let live=true;const request=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async(...args:unknown[])=>{const result=await request(...args);if(reason==='rotation')f.head.active_revision='5';if(reason==='removal')f.head.state='revoked';if(reason==='grant revocation')mocks.capture.mockResolvedValue(undefined);if(reason==='turn closed')live=false;if(reason==='approval expiry')f.expire();if(reason==='approval revocation')f.revoke();return result});
 try{await expect(f.execute(call,binding,()=>{if(!live)throw new Error('turn closed')})).rejects.toThrow();expect(f.consumed).toBe(true);expect(mocks.request).toHaveBeenCalledTimes(1);expect(mocks.destroy).toHaveBeenCalledOnce()}finally{f.store.close()}
});

it.each(['content','structuredContent'] as const)('withholds a credential reflected by the peer in %s',async field=>{
 const f=fixture(),request=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async(url:string,options:{body:Buffer})=>{
  const message=JSON.parse(options.body.toString());if(message.method!=='tools/call')return request(url,options);
  const result=field==='content'?{content:[{type:'text',text:credential}]}:{content:[],structuredContent:{value:credential}};
  return {statusCode:200,headers:{'content-type':'application/json'},body:Readable.from([Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))])};
 });
 try{let error:unknown;try{await f.execute()}catch(e){error=e}expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain(credential);expect(f.consumed).toBe(true);expect(mocks.destroy).toHaveBeenCalledOnce()}finally{f.store.close()}
});

it('keeps the previous working active revision usable when Apply of a valid replacement fails',async()=>{
 const f=fixture(),stageId='66666666-6666-4666-8666-666666666666',previewId='77777777-7777-4777-8777-777777777777',applyId='88888888-8888-4888-8888-888888888888';
 const editorCapture={version:1,actor:capture.actor,agent:{...capture.agent,connectionName:'registry'},grant:{kind:'owner',validUntil:null}};
 const review={version:1,accountId,ownerMemberId:'member-a',resourceId:'helper',connectionName:'registry',expectedGeneration:2,expectedCandidateRevision:null,
  sourceRevision:3,sourceRequestId:operationId,sourceClaimOperationId:operationId,publicationId,publicationHash:f.policy.publication.hash,acceptanceId,
  acceptanceHash:f.policy.acceptance.hash,policyHash:hash(f.policy),capture:editorCapture,route,consentGeneration:4};
 const stage={version:1,review,reviewHash:hash(review),candidateRevision:5,candidateGeneration:3,consentGeneration:4,policyJson:f.policy};
 f.rows.set(stageId,{...f.evidence(stageId,'activation-review-v1',stage,'staged'),operation_kind:'stage'});
 f.rows.set(previewId,{...f.evidence(previewId,'activation-review-v1',review,'previewed'),operation_kind:'activation-preview'});
 // Authenticated candidate metadata/ciphertext mirrors the current stage output. The route
 // failure occurs after Apply reads this valid encrypted stage and preview evidence.
 const sealedCandidate=encrypt(Buffer.from('DISPOSABLE_REPLACEMENT_CREDENTIAL'),['lares-outside-custody-bound-v1',
  JSON.stringify(['lares-outside-custody-v1','member-a',accountId,'helper',3,5,4,stageId]),'registry','executable',hash(f.policy)]);
 f.revisions.set(5,{...f.revision,generation:'3',credential_revision:'5',consent_generation:'4',operation_id:stageId,...sealedCandidate});
 f.head.candidate_revision='5';f.head.consent_generation='4';
 const before=structuredClone(f.head),activeCiphertext=Buffer.from(f.revision.ciphertext);
 f.lifecycle.withAppliedOutsideRoute.mockRejectedValueOnce(new Error('disposable route unavailable'));
 try{
  await expect(f.store.apply('S'.repeat(43),{accountId,agentName:'helper',connectionName:'registry',requestId:operationId,claimOperationId:operationId,
   publicationId,acceptanceId,expectedGeneration:2,expectedCandidateRevision:5,expectedConsentGeneration:4,expectedDefinitionHash:call.definitionHash,
   expectedAccessRevision:7,expectedPublicationHash:f.policy.publication.hash,expectedAcceptanceHash:f.policy.acceptance.hash,expectedPolicyHash:hash(f.policy),
   operationId:applyId,activationReviewId:previewId,expectedActivationReviewHash:hash(review),stageOperationId:stageId,candidateRevision:5},
   {deadlineAtMs:Date.now()+8000})).rejects.toThrow();
  expect(f.lifecycle.withAppliedOutsideRoute).toHaveBeenCalledOnce();
  expect(f.head).toEqual(before);expect(f.head).toMatchObject({active_revision:'4',candidate_revision:'5',generation:'2',consent_generation:'4'});
  expect(f.revision).toMatchObject({generation:'2',credential_revision:'4',consent_generation:'3'});
  expect(f.revision.ciphertext).toEqual(activeCiphertext);expect(f.rows.has(applyId)).toBe(false);
  expect(mocks.query.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE outside_custody_accounts'))).toBe(false);
  expect(await f.execute()).toEqual({content:[{type:'text',text:'Example found'}]});
 }finally{f.store.close()}
});

it.each(['pending candidate','active generation changed','consent changed without pending','older pending revision','revoked after failed Apply','successfully rotated active pointer'] as const)(
 'refuses %s while preserving active-only execution',async reason=>{
 const f=fixture();f.head.candidate_revision='5';f.head.consent_generation='4';
 if(reason==='pending candidate')f.receipt.credentialRevision=5;
 if(reason==='active generation changed')f.head.generation='3';
 if(reason==='consent changed without pending')f.head.candidate_revision=null;
 if(reason==='older pending revision')f.head.candidate_revision='3';
 if(reason==='revoked after failed Apply')f.head.state='revoked';
 if(reason==='successfully rotated active pointer'){f.head.active_revision='5';f.head.candidate_revision=null;f.head.generation='3'}
 try{await expect(f.execute()).rejects.toThrow();expect(mocks.request).not.toHaveBeenCalled();expect(f.consumed).toBe(false)}finally{f.store.close()}
});
it.each(['ciphertext','evidence hash','authenticated full body','descriptor digest'] as const)('retains independent publication %s verification before dispatch',async reason=>{
 const f=fixture(),row=f.rows.get(publicationId)!;
 if(reason==='ciphertext'){
  const bytes=Buffer.from(row.result_ciphertext as Buffer);bytes[0]=bytes[0]!^1;row.result_ciphertext=bytes;
 }else if(reason==='evidence hash'){
  row.evidence_hash=Buffer.alloc(32,15);
 }else if(reason==='authenticated full body'){
  // Encrypt a different valid-shaped body with the unchanged declared digest in its AAD.
  // GCM succeeds; the exact canonical plaintext full-body hash must independently refuse.
  const sealed=encrypt({...f.publication,organisationId:'changed-org'},['lares-outside-custody-evidence-v1',
   {accountId,ownerMemberId:'member-a',resourceId:'helper',connectionName:'registry',operationId:publicationId,
    kind:'descriptor-publication-v1',hash:(row.evidence_hash as Buffer).toString('hex')}]);
  row.result_nonce=sealed.nonce;row.result_ciphertext=sealed.ciphertext;
 }else{
  f.policy.publication.descriptorDigest='f'.repeat(64);f.revision.policy_json=JSON.stringify(f.policy);f.revision.policy_hash=Buffer.from(hash(f.policy),'hex');
 }
 try{await expect(f.execute()).rejects.toThrow();expect(mocks.request).not.toHaveBeenCalled();expect(f.consumed).toBe(false)}finally{f.store.close()}
});

it('reads only current accepted metadata with no credential or provider dispatch',async()=>{
 const f=fixture();try{
  expect(await f.store.acceptedRuntimeTools(binding,call.definitionHash,'registry',{deadlineAtMs:Date.now()+2000}))
   .toEqual([{name:'lookup',description:'Look up a company',inputSchema:{type:'object'}}]);
  expect(mocks.request).not.toHaveBeenCalled();expect(f.consumed).toBe(false);
 }finally{f.store.close()}
});
it('refuses an enrolled agent-owner account when the admitted second member has no Mac custody account',async()=>{
 const f=fixture(),actor='member-b',agentOwner='member-a';
 mocks.capture.mockResolvedValue({...structuredClone(capture),actor:{...capture.actor,memberId:actor},agent:{...capture.agent,ownerMemberId:agentOwner}});
 mocks.query.mockImplementation(async(sql:string,params:unknown[]=[])=>{
  if(sql.includes('FROM outside_custody_accounts')&&sql.includes('active_revision IS NOT NULL'))return {rows:[],rowCount:0};
  throw new Error('Unexpected query before member-custody refusal');
 });
 try{
  await expect(f.store.acceptedRuntimeTools({...binding,memberId:actor},call.definitionHash,'mac-private-metadata',{deadlineAtMs:Date.now()+2000})).rejects.toThrow();
  const selection=mocks.query.mock.calls.find(([sql])=>String(sql).includes('FROM outside_custody_accounts'));
  expect(selection?.[1]).toEqual([actor,binding.agent,'mac-private-metadata-device']);
  expect(mocks.request).not.toHaveBeenCalled();
 }finally{f.store.close()}
});
it.each(['grant','definition','acceptance','active credential','session'] as const)('refuses metadata with stale %s',async reason=>{
 const f=fixture();try{
  if(reason==='grant')mocks.capture.mockResolvedValue(undefined);
  if(reason==='acceptance')f.rows.delete(acceptanceId);
  if(reason==='active credential')f.head.active_revision='5';
  if(reason==='session')mocks.session.mockRejectedValue(Error('revoked'));
  await expect(f.store.acceptedRuntimeTools(binding,reason==='definition'?'f'.repeat(64):call.definitionHash,'registry',{deadlineAtMs:Date.now()+2000})).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();expect(f.consumed).toBe(false);
 }finally{f.store.close()}
});

it('creates a receipt from current custody metadata without opening credentials or calling the provider',async()=>{
 const f=fixture(),requested={callId:call.callId,connectionName:call.connectionName,toolName:call.toolName,input:call.input};
 await expect(f.store.approveExecution(binding,requested,{requestId:call.requestId,definitionHash:call.definitionHash,expiresAt:Date.now()+60_000},
  {deadlineAtMs:Date.now()+8000})).resolves.toBeUndefined();
 const inserts=mocks.query.mock.calls.filter(([sql])=>String(sql).includes('INSERT INTO outside_execution_approvals'));
 expect(inserts).toHaveLength(1);expect(inserts[0][1]).toMatchObject({9:accountId,10:4});
 expect(mocks.request).not.toHaveBeenCalled();expect(f.consumed).toBe(false);
});
it.each(['unknown-selector','changed-member','revoked-session','changed-descriptor','expired'])(
 'refuses receipt creation for %s before provider access',async(kind)=>{
 const f=fixture(),requested={callId:call.callId,connectionName:call.connectionName,toolName:call.toolName,input:call.input};
 if(kind==='revoked-session')mocks.session.mockRejectedValueOnce(new Error('revoked'));
 if(kind==='changed-descriptor'){f.publication.projection.tools[0].description='Changed';
  f.rows.set(publicationId,f.evidence(publicationId,'descriptor-publication-v1',f.publication,'published'));}
 await expect(f.store.approveExecution(kind==='changed-member'?{...binding,memberId:'member-b'}:binding,
  kind==='unknown-selector'?{...requested,accountId:'model-selected'} as never:requested,
  {requestId:call.requestId,definitionHash:call.definitionHash,expiresAt:Date.now()+(kind==='expired'?-1:60_000)},
  {deadlineAtMs:Date.now()+8000})).rejects.toThrow('Outside credential change could not be confirmed');
 expect(mocks.request).not.toHaveBeenCalled();expect(f.consumed).toBe(false);
});
