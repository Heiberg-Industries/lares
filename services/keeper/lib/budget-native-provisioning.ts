/** Closed native credential provisioning. This service writes only a blocked native key
 * and an active-but-financially-closed binding; it never opens budget accounts or keys. */
import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {canonicalBudgetMoney} from '@lares/agent-kit/budget-admission-store';
import {definitionSchema,hashOf,parseDefinition} from '@lares/agent-kit/definition';
import {gatewayCanonical,gatewayHash} from '@lares/agent-kit/gateway-admission-protocol';
import {PgGrantStore} from '@lares/agent-kit/grant-store';
import {consoleSourceTransaction,gateConsoleOrganisation,noteBudgetFinancialChange,requireConsoleSourceOwner,retainSourceTransactionDeadline,type SourceDatabase,type SourcePool,type SourceTransactionBoundary} from '@lares/agent-kit/console-source-transaction';
import {BudgetNativeCredentialClient,MAX_BUDGET_NATIVE_REQUEST_BYTES,type NativeKeyExpectation,type NativeTeamExpectation,type NativeTeamPolicyExpectation,type NativeUserExpectation} from './budget-native-client.js';
import {BudgetNativeCustodyStore,budgetNativeReviewedPolicySchema,type BudgetNativeReviewedPolicy,type NativeCustodyGate,type NativeOperation} from './budget-native-custody.js';
import {HostFinancialJournal,isJournaledAbort} from './financial-journal.js';
import {JournalBudgetFinancialWriter} from './budget-financial-writer.js';

const uuid=z.string().uuid(),generation=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value=>BigInt(value)<=9_223_372_036_854_775_807n);
const memberId=z.string().min(1).max(128).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const agent=z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),purpose=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
const endpointSchema=z.object({origin:z.string().max(512),hash}).strict().superRefine((value,ctx)=>{
  try{const url=new URL(value.origin);if(!['http:','https:'].includes(url.protocol)||url.origin!==value.origin||url.username||url.password||url.pathname!=='/'||url.search||url.hash)ctx.addIssue({code:'custom',message:'Invalid endpoint origin'});}
  catch{ctx.addIssue({code:'custom',message:'Invalid endpoint origin'});}
});
export const budgetNativeProvisionRequestSchema=z.object({bindingId:uuid,credentialGeneration:generation,memberId,agent,incarnation:uuid,purposeAlias:purpose}).strict();
const refuse=()=>new Error('Native budget provisioning refused; reconciliation may be required');
export function nativeProvisioningDeadline(startedAt=Date.now()):{deadlineAtMs:number;check:(now?:number)=>void} {
  const deadlineAtMs=startedAt+20_000;
  return {deadlineAtMs,check:(now=Date.now())=>{if(!Number.isFinite(now)||now>=deadlineAtMs)throw refuse();}};
}
const exact=(a:unknown,b:unknown)=>gatewayCanonical(a).equals(gatewayCanonical(b));
const uuidString=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
type Target=z.infer<typeof endpointSchema>;
type Snapshot={installationId:string;memberAccountId:string;definitionHash:string};
type DbRow=Record<string,any>;

function moneyNumber(value:string):number {
  const expected=canonicalBudgetMoney(value),number=Number(expected);
  if(!Number.isFinite(number)||number<=0||number>1_000_000_000||canonicalBudgetMoney(String(number))!==expected)throw refuse();
  return number;
}
function nativePolicy(policy:BudgetNativeReviewedPolicy):{team:NativeTeamPolicyExpectation;user:NativeUserExpectation;membership:NativeTeamExpectation;key:NativeKeyExpectation} {
  const checked=budgetNativeReviewedPolicySchema.parse(policy),teamBudget=moneyNumber(checked.team.maxBudget),userBudget=moneyNumber(checked.user.maxBudget),memberBudget=moneyNumber(checked.membership.maxBudget),keyBudget=moneyNumber(checked.key.maxBudget);
  if(checked.team.models.length>16||checked.membership.allowedModels.length>16||checked.key.models.length!==1||!checked.capability.aliases.includes(checked.key.models[0]!))throw refuse();
  return {
    team:{teamId:'',teamMaxBudget:teamBudget,teamBudgetDuration:checked.team.budgetDuration,teamModels:checked.team.models},
    user:{userId:'',maxBudget:userBudget,userRole:checked.user.userRole},
    membership:{teamId:'',teamMaxBudget:teamBudget,teamBudgetDuration:checked.team.budgetDuration,teamModels:checked.team.models,
      memberUserId:'',memberMaxBudget:memberBudget,memberBudgetDuration:checked.membership.budgetDuration,memberModels:checked.membership.allowedModels,memberRole:checked.membership.role},
    key:{keyAlias:'',teamId:'',userId:'',maxBudget:keyBudget,budgetDuration:checked.key.budgetDuration,models:checked.key.models},
  };
}
function validateNativeLimits(policy:BudgetNativeReviewedPolicy,alias:string,bindingId:string):void {
  const values=nativePolicy(policy),teamId='00000000-0000-4000-8000-000000000000',userId=teamId;
  const fits=(body:unknown)=>Buffer.byteLength(JSON.stringify(body),'utf8')<=MAX_BUDGET_NATIVE_REQUEST_BYTES;
  if(!fits({team_id:teamId,max_budget:values.team.teamMaxBudget,models:policy.team.models,budget_duration:policy.team.budgetDuration})||
    !fits({user_id:userId,max_budget:values.user.maxBudget,auto_create_key:false,user_role:policy.user.userRole})||
    !fits({team_id:teamId,max_budget_in_team:values.membership.memberMaxBudget,budget_duration:policy.membership.budgetDuration,
      allowed_models:policy.membership.allowedModels,member:{role:'user',user_id:userId}})||
    !fits({key:`sk-${'a'.repeat(43)}`,key_alias:bindingId,key_type:'llm_api',team_id:teamId,user_id:userId,max_budget:values.key.maxBudget,
      budget_duration:policy.key.budgetDuration,models:[alias],blocked:true}))throw refuse();
}
async function currentMonth(db:SourceDatabase):Promise<{startsAt:string;endsAt:string}> {
  const row=(await db.query(`WITH m AS (SELECT date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AS s)
    SELECT to_char(s,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,to_char(s+interval '1 month','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at FROM m`)).rows[0];
  if(typeof row?.starts_at!=='string'||typeof row?.ends_at!=='string')throw refuse();return {startsAt:row.starts_at,endsAt:row.ends_at};
}
async function sourceState(db:SourceDatabase,journal:HostFinancialJournal,policy:BudgetNativeReviewedPolicy,request:z.infer<typeof budgetNativeProvisionRequestSchema>,expected?:Snapshot,keyFingerprint?:string,deadlineAtMs?:number):Promise<Snapshot> {
  if(deadlineAtMs!==undefined&&deadlineAtMs<=Date.now())throw refuse();
  await gateConsoleOrganisation(db,request.memberId,undefined,{lock:'update'});requireConsoleSourceOwner(db);
  if(deadlineAtMs!==undefined)retainSourceTransactionDeadline(db,new Date(deadlineAtMs).toISOString());
  const userRows=(await db.query('SELECT id,org_id,status FROM users WHERE id=$1 FOR UPDATE',[request.memberId])).rows;
  if(userRows.length!==1||userRows[0]!.status!=='active'||typeof userRows[0]!.org_id!=='string')throw refuse();
  const providers=(await db.query(`SELECT issuer,subject,tenant_id FROM member_provider_identities WHERE member_id=$1 ORDER BY issuer,subject,tenant_id LIMIT 65 FOR UPDATE`,[request.memberId])).rows;
  if(providers.length<1||providers.length>64||providers.some((p:DbRow)=>typeof p.issuer!=='string'||typeof p.subject!=='string'||typeof p.tenant_id!=='string'))throw refuse();
  const suppression=journal.suppression({canonicalMemberId:request.memberId,providers:providers.map((p:DbRow)=>({issuer:p.issuer,subject:p.subject,tenantId:p.tenant_id}))});
  const month=await currentMonth(db);retainSourceTransactionDeadline(db,month.endsAt);
  const installRows=(await db.query(`SELECT * FROM budget_accounts WHERE kind='installation' ORDER BY id LIMIT 2 FOR UPDATE`)).rows;
  if(installRows.length!==1)throw refuse();const installation=installRows[0]!;
  if(!uuidString(installation.id)||installation.installation_account_id!==installation.id||installation.state!=='closed'||installation.reason!=='unreconciled'||installation.selected_endpoint!==null||installation.recovery_epoch!==null)throw refuse();
  const memberRows=(await db.query(`SELECT * FROM budget_accounts WHERE installation_account_id=$1 AND kind='member' AND (live_member_id=$2 OR canonical_suppression_hash=$3) ORDER BY id LIMIT 3 FOR UPDATE`,[installation.id,request.memberId,suppression.canonicalSuppressionHash])).rows;
  if(memberRows.length!==1)throw refuse();const member=memberRows[0]!;
  const storedProviders=Array.isArray(member.provider_suppression_hashes)?[...member.provider_suppression_hashes].sort():[];
  if(!uuidString(member.id)||member.installation_account_id!==installation.id||member.live_member_id!==request.memberId||member.organisation_id!==userRows[0]!.org_id||
    member.canonical_suppression_hash!==suppression.canonicalSuppressionHash||!exact(storedProviders,suppression.providerSuppressionHashes)||member.state!=='closed'||member.reason!=='unreconciled'||member.selected_endpoint!==null||member.recovery_epoch!==null)throw refuse();
  for(const account of [installation,member]){
    const windows=(await db.query(`SELECT id,starts_at,ends_at FROM budget_windows WHERE account_id=$1 AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz ORDER BY id LIMIT 2 FOR UPDATE`,[account.id,month.startsAt,month.endsAt])).rows;
    if(windows.length!==1||windows[0]!.id!==account.active_window_id||!(await db.query('SELECT 1 WHERE $1::timestamptz=$2::timestamptz AND $3::timestamptz=$4::timestamptz',[windows[0]!.starts_at,month.startsAt,windows[0]!.ends_at,month.endsAt])).rows.length)throw refuse();
  }
  const rows=(await db.query(`SELECT d.definition,d.duties,d.voice,d.hash,d.status,r.ownership,r.ownership_token,r.runtime_control_token,r.state,r.applied_definition,r.pending
    FROM agent_definitions d JOIN agent_resources r ON r.name=d.name WHERE d.name=$1 FOR UPDATE OF d,r`,[request.agent])).rows;
  if(rows.length!==1)throw refuse();const row=rows[0]!;
  let definition,applied;try{definition=parseDefinition(definitionSchema.parse(row.definition));applied=parseDefinition(definitionSchema.parse(row.applied_definition));}catch{throw refuse();}
  const definitionHash=hashOf({definition,dutiesMd:row.duties,voiceMd:row.voice});
  if(row.status!=='valid'||row.hash!==definitionHash||row.ownership!=='owned'||definition.model!==request.purposeAlias||applied.model!==request.purposeAlias||!policy.capability.aliases.includes(request.purposeAlias)||
    row.ownership_token!==request.incarnation||row.runtime_control_token!==request.incarnation||row.state!=='ready'||row.pending!==false||!exact(applied,definition))throw refuse();
  const grant=await new PgGrantStore().captureUseWithExpiry(request.memberId,request.agent,{db:db as unknown as import('pg').PoolClient});
  if(!grant)throw refuse();if(grant.validUntil)retainSourceTransactionDeadline(db,grant.validUntil);
  const conflicts=(await db.query(`SELECT id FROM budget_gateway_bindings WHERE id=$1 OR
    (installation_account_id=$2 AND member_account_id=$3 AND agent=$4 AND incarnation=$5 AND purpose_alias=$6) OR ($7::text IS NOT NULL AND key_fingerprint=$7)
    LIMIT 2 FOR UPDATE`,[request.bindingId,installation.id,member.id,request.agent,request.incarnation,request.purposeAlias,keyFingerprint??null])).rows;
  if(conflicts.length)throw refuse();
  if(expected&&(expected.installationId!==installation.id||expected.memberAccountId!==member.id||expected.definitionHash!==definitionHash))throw refuse();
  if(policy.pricing.capabilityHash!==gatewayHash(gatewayCanonical(policy.capability)))throw refuse();
  return {installationId:installation.id,memberAccountId:member.id,definitionHash};
}

/** Trusted host adapter. Endpoint hash is operator-selected and must match the native
 * gateway's LARES_GATEWAY_ENDPOINT_HASH; it is never derived from the URL. */
export class BudgetNativeProvisioner {
  private readonly endpoint:Target;private readonly policy:BudgetNativeReviewedPolicy;private readonly expectations:ReturnType<typeof nativePolicy>;
  constructor(private readonly pool:SourcePool,private readonly journal:HostFinancialJournal,private readonly custody:BudgetNativeCustodyStore,
    private readonly native:BudgetNativeCredentialClient,endpoint:unknown,reviewedPolicy:unknown){
    this.endpoint=endpointSchema.parse(endpoint);this.policy=budgetNativeReviewedPolicySchema.parse(reviewedPolicy);this.expectations=nativePolicy(this.policy);
    if(native.gatewayOrigin!==this.endpoint.origin)throw refuse();
  }

  async provision(raw:unknown):Promise<{state:'bound-closed';bindingId:string;credentialGeneration:string}> {
    const deadline=nativeProvisioningDeadline(),deadlineAtMs=deadline.deadlineAtMs,fresh=deadline.check;
    const request=budgetNativeProvisionRequestSchema.parse(raw),alias=request.purposeAlias;
    if(!this.journal.prepared||!this.policy.capability.aliases.includes(alias)||this.policy.key.models.length!==1||this.policy.key.models[0]!==alias)throw refuse();
    validateNativeLimits(this.policy,alias,request.bindingId);
    const writer=new JournalBudgetFinancialWriter(this.journal);let operationId='',nativeWriteDispatched=false;
    try{
      fresh();const result=await this.custody.withGate(async gate=>{
        fresh();
        const sourceTransaction=<T>(work:(db:SourceDatabase)=>Promise<T>,boundary:SourceTransactionBoundary)=>{
          fresh();return consoleSourceTransaction(this.pool,work,boundary,{deadlineAtMs,beforeCommit:fresh});
        };
        let first:Snapshot;
        try{first=await writer.run('provision',boundary=>sourceTransaction(db=>sourceState(db,this.journal,this.policy,request,undefined,undefined,deadlineAtMs),boundary));fresh();}
        catch(error){if(isJournaledAbort(error,{journalId:writer.journalId,operation:'provision'}))return {kind:'initial-preflight-refused' as const,error};throw error;}
        const inventory=gate.inventory(),prior=inventory.operations.find((o):o is NativeOperation=>o.kind==='operation'&&o.bindingId===request.bindingId&&o.credentialGeneration===request.credentialGeneration);
        if(inventory.operations.some(o=>o.kind==='operation'&&o.bindingId===request.bindingId&&o.credentialGeneration!==request.credentialGeneration))throw refuse();
        const existingTeam=inventory.teams.find(t=>t.installationAccountId===first.installationId&&t.endpoint.hash===this.endpoint.hash);
        if(existingTeam?.createAttempt==='attempted')throw new Error('Native custody operation refused');
        const existingUser=inventory.users.find((u):u is Extract<typeof u,{kind:'user'}>=>u.kind==='user'&&u.accountId===first.memberAccountId&&u.endpoint.hash===this.endpoint.hash);
        if(existingUser&&(existingUser.userCreateAttempt==='attempted'||existingUser.membershipCreateAttempt==='attempted'||
          inventory.operations.some(o=>o.kind==='operation'&&o.userOwnershipId===existingUser.ownershipId&&o.phase!=='bound-closed'&&o.phase!=='prepared')))throw new Error('Native custody operation refused');
        const team=gate.reserveTeam(first.installationId,this.endpoint,this.policy),user=gate.reserveUser(first.memberAccountId,team.ownershipId,this.policy);
        if(team.createAttempt==='attempted'||user.userCreateAttempt==='attempted'||user.membershipCreateAttempt==='attempted'||inventory.operations.some(o=>o.kind==='operation'&&o.userOwnershipId===user.ownershipId&&o.phase!=='bound-closed'&&o.phase!=='prepared'))throw new Error('Native custody operation refused');
        const association={agent:request.agent,incarnation:request.incarnation,definitionHash:first.definitionHash,purposeAlias:alias};let key:string;
        if(prior){
          if(prior.phase!=='prepared'||prior.userOwnershipId!==user.ownershipId||!exact(prior.association,association)||prior.policyDigest!==gatewayHash(gatewayCanonical(this.policy))||
            prior.keyCreateAttempt!=='not-attempted'||!exact(prior.reviewedPolicy,this.policy))throw refuse();
          operationId=prior.operationId;key=gate.readKey(operationId);
        }else{
          key=`sk-${randomBytes(32).toString('base64url')}`;
          const prepared=gate.prepareOperation({bindingId:request.bindingId,credentialGeneration:request.credentialGeneration,userOwnershipId:user.ownershipId,association,reviewedPolicy:this.policy},key);
          operationId=prepared.operationId;
        }
        const operation=gate.readOperation(operationId);
        if(operation.phase!=='prepared'||operation.keyCreateAttempt!=='not-attempted')throw refuse();
        fresh();await writer.run('provision',boundary=>sourceTransaction(db=>sourceState(db,this.journal,this.policy,request,first,operation.keyFingerprint,deadlineAtMs),boundary));fresh();
        gate.beginProvisioning(operationId);
        const markUncertain=():never=>{try{gate.recordUncertain(operationId);}catch{}throw refuse();};
        const check=(result:{kind:string}):void=>{if(result.kind!=='match')markUncertain();};
        const checkpoint=():void=>{try{fresh();}catch(error){if(nativeWriteDispatched)markUncertain();throw error;}};

        const teamExpectation={...this.expectations.team,teamId:team.nativeTeamId} satisfies NativeTeamPolicyExpectation;
        if(team.createAttempt==='verified'){checkpoint();const read=await this.native.readTeamPolicy(teamExpectation);checkpoint();check(read);}
        else{
          if(team.createAttempt!=='not-attempted')throw refuse();
          checkpoint();const claimed=gate.claimTeamCreate(team.ownershipId);checkpoint();
          nativeWriteDispatched=true;try{await this.native.createTeam({teamId:claimed.nativeTeamId,maxBudget:teamExpectation.teamMaxBudget,budgetDuration:teamExpectation.teamBudgetDuration,models:teamExpectation.teamModels});}catch{}checkpoint();
          const read=await this.native.readTeamPolicy(teamExpectation);checkpoint();check(read);gate.verifyTeamCreated(team.ownershipId);
        }

        const userExpectation={...this.expectations.user,userId:user.nativeUserId} satisfies NativeUserExpectation;
        if(user.userCreateAttempt==='verified'){checkpoint();const read=await this.native.readUser(userExpectation);checkpoint();check(read);}
        else{
          if(user.userCreateAttempt!=='not-attempted')throw refuse();
          checkpoint();const claimed=gate.claimUserCreate(user.ownershipId);checkpoint();
          nativeWriteDispatched=true;try{await this.native.createUser({userId:claimed.nativeUserId,maxBudget:userExpectation.maxBudget,userRole:userExpectation.userRole});}catch{}checkpoint();
          const read=await this.native.readUser(userExpectation);checkpoint();check(read);gate.verifyUserCreated(user.ownershipId);
        }

        const memberExpectation={...this.expectations.membership,teamId:team.nativeTeamId,memberUserId:user.nativeUserId} satisfies NativeTeamExpectation;
        if(user.membershipCreateAttempt==='verified'){checkpoint();const read=await this.native.readTeam(memberExpectation);checkpoint();check(read);}
        else{
          if(user.membershipCreateAttempt!=='not-attempted')throw refuse();
          checkpoint();const claimed=gate.claimMembershipCreate(user.ownershipId);checkpoint();
          nativeWriteDispatched=true;try{await this.native.addMember({teamId:team.nativeTeamId,userId:user.nativeUserId,maxBudget:memberExpectation.memberMaxBudget,
            budgetDuration:memberExpectation.memberBudgetDuration,models:memberExpectation.memberModels,role:'user'});}catch{}checkpoint();
          const read=await this.native.readTeam(memberExpectation);checkpoint();check(read);gate.verifyMembershipCreated(user.ownershipId);
        }

        const related=inventory.operations.filter((o):o is NativeOperation=>o.kind==='operation'&&o.userOwnershipId===user.ownershipId);
        if(related.some(o=>!['bound-closed','prepared'].includes(o.phase)))markUncertain();
        const known=[...new Set(related.filter(o=>o.phase==='bound-closed').map(o=>o.keyFingerprint))].filter(f=>f!==operation.keyFingerprint).sort();
        checkpoint();const before=await this.native.listOwnedKeys(user.nativeUserId);checkpoint();
        if(before.kind!=='match'||!exact([...before.value].sort(),known)||known.length>=10)markUncertain();
        checkpoint();const claimed=gate.claimKeyCreate(operationId),secret=gate.readKey(operationId);checkpoint();
        nativeWriteDispatched=true;try{await this.native.createBlockedKey({key:secret,keyAlias:request.bindingId,teamId:team.nativeTeamId,userId:user.nativeUserId,maxBudget:this.expectations.key.maxBudget,
          budgetDuration:this.expectations.key.budgetDuration,models:[alias]});}catch{}checkpoint();
        const keyExpectation={...this.expectations.key,keyAlias:request.bindingId,teamId:team.nativeTeamId,userId:user.nativeUserId} satisfies NativeKeyExpectation;
        const lookup=await this.native.lookupKey(claimed.keyFingerprint,keyExpectation);checkpoint();check(lookup);
        const after=await this.native.listOwnedKeys(user.nativeUserId);checkpoint();
        if(after.kind!=='match'||!exact([...after.value].sort(),[...known,operation.keyFingerprint].sort()))markUncertain();
        gate.verifyKeyCreated(operationId);gate.recordNativeBlockedVerification(operationId);
        checkpoint();const committed=await writer.runWithReceipt('provision',async(boundary,financialOperationId)=>{
          checkpoint();
          gate.linkFinancialOperation(operationId,financialOperationId,this.journal.id);
          return sourceTransaction(async db=>{
            const current=await sourceState(db,this.journal,this.policy,request,first,operation.keyFingerprint,deadlineAtMs);
            if(current.installationId!==first.installationId||current.memberAccountId!==first.memberAccountId)throw refuse();
            const row=(await db.query(`INSERT INTO budget_gateway_bindings(id,installation_account_id,member_account_id,live_member_id,endpoint_hash,credential_generation,key_fingerprint,agent,incarnation,native_team,native_user,purpose_alias,profile_hash,maximum_liability,pricing_profile,state)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,'active') RETURNING id`,
              [request.bindingId,current.installationId,current.memberAccountId,request.memberId,this.endpoint.hash,request.credentialGeneration,operation.keyFingerprint,request.agent,request.incarnation,
                team.nativeTeamId,user.nativeUserId,alias,this.policy.pricing.capabilityHash,this.policy.maximumLiability,JSON.stringify(this.policy.pricing)])).rows[0];
            if(!row||row.id!==request.bindingId)throw refuse();noteBudgetFinancialChange(db,'budget_gateway_bindings',request.bindingId);
            return {state:'bound-closed' as const,bindingId:request.bindingId,credentialGeneration:request.credentialGeneration};
          },boundary);
        },receipt=>{gate.recordBoundClosed(operationId,receipt);return undefined;});
        return {kind:'bound-closed' as const,value:committed.value};
      });
      if(result.kind==='initial-preflight-refused')throw result.error;
      return result.value;
    }catch(error){
      if(operationId&&nativeWriteDispatched){try{await this.custody.withGate(gate=>{gate.recordUncertain(operationId);return Promise.resolve();});}catch{/* Existing custody remains frozen or records the uncertainty. */}}
      throw error instanceof Error&&error.message==='Native budget provisioning refused; reconciliation may be required'?error:refuse();
    }
  }
}
