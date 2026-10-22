/** First native key activation for one already-bound, closed budget member. */
import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {consoleSourceTransaction,gateConsoleOrganisation,noteBudgetFinancialChange,requireConsoleSourceOwner,retainSourceTransactionDeadline,checkConsoleSourceDeadlines,type SourceDatabase,type SourcePool} from '@lares/agent-kit/console-source-transaction';
import {gatewayCanonical,gatewayHash} from '@lares/agent-kit/gateway-admission-protocol';
import {canonicalBudgetMoney} from '@lares/agent-kit/budget-admission-store';
import {PgGrantStore} from '@lares/agent-kit/grant-store';
import {definitionSchema,hashOf,parseDefinition} from '@lares/agent-kit/definition';
import {HostFinancialJournal} from './financial-journal.js';
import {JournalBudgetFinancialWriter} from './budget-financial-writer.js';
import {BudgetNativeCredentialClient,type NativeKeyExpectation,type NativeRead,type NativeTeamExpectation,type NativeTeamPolicyExpectation,type NativeUserExpectation} from './budget-native-client.js';
import {BudgetNativeCustodyStore,budgetNativeReviewedPolicySchema,type BudgetNativeReviewedPolicy,type NativeCustodyGate,type NativeOperation} from './budget-native-custody.js';

const uuid=z.string().uuid(),generation=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v=>BigInt(v)<=9_223_372_036_854_775_807n);
const requestSchema=z.object({bindingId:uuid,credentialGeneration:generation}).strict();
const refuse=()=>new Error('Native custody operation refused');
const publicRefuse=()=>new Error('Native budget activation refused; reconciliation may be required');
const exact=(a:unknown,b:unknown)=>gatewayCanonical(a).equals(gatewayCanonical(b));
const uuidString=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{3,4}-[a-f0-9]{3,4}-[a-f0-9]{3,4}-[a-f0-9]{12}$/i.test(value);
type Row=Record<string,any>;
type Month={startsAt:string;endsAt:string};
type Prepared={operation:NativeOperation;month:Month;installationWindowId:string;memberWindowId:string;endpointGeneration:string;recoveryEpoch:string;firstOpen:boolean;installationCap:string;memberWindowCap:string};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function moneyNumber(value:string):number {const canonical=canonicalBudgetMoney(value),number=Number(canonical);if(!Number.isFinite(number)||number<=0||number>1_000_000_000||canonicalBudgetMoney(String(number))!==canonical)throw refuse();return number;}
function nativeKeyExpectation(op:NativeOperation,gate:NativeCustodyGate):NativeKeyExpectation {
  const user=gate.inventory().users.find(value=>value.kind==='user'&&value.ownershipId===op.userOwnershipId);
  const team=user?.kind==='user'&&gate.inventory().teams.find(value=>value.kind==='team'&&value.ownershipId===user.teamOwnershipId);
  if(!user||user.kind!=='user'||!team||team.kind!=='team')throw refuse();
  const policy=budgetNativeReviewedPolicySchema.parse(op.reviewedPolicy);
  return {keyAlias:op.bindingId,teamId:team.nativeTeamId,userId:user.nativeUserId,maxBudget:moneyNumber(policy.key.maxBudget),budgetDuration:policy.key.budgetDuration,models:policy.key.models};
}
function nativeExpectations(op:NativeOperation,gate:NativeCustodyGate):{team:NativeTeamPolicyExpectation;user:NativeUserExpectation;membership:NativeTeamExpectation;key:NativeKeyExpectation;nativeUserId:string} {
  const snapshot=gate.inventory(),user=snapshot.users.find(value=>value.kind==='user'&&value.ownershipId===op.userOwnershipId),team=user?.kind==='user'&&snapshot.teams.find(value=>value.kind==='team'&&value.ownershipId===user.teamOwnershipId);
  if(!user||user.kind!=='user'||!team||team.kind!=='team')throw refuse();
  const policy=budgetNativeReviewedPolicySchema.parse(op.reviewedPolicy),teamBudget=moneyNumber(policy.team.maxBudget);
  return {nativeUserId:user.nativeUserId,team:{teamId:team.nativeTeamId,teamMaxBudget:teamBudget,teamBudgetDuration:policy.team.budgetDuration,teamModels:policy.team.models},
    user:{userId:user.nativeUserId,maxBudget:moneyNumber(policy.user.maxBudget),userRole:policy.user.userRole},
    membership:{teamId:team.nativeTeamId,teamMaxBudget:teamBudget,teamBudgetDuration:policy.team.budgetDuration,teamModels:policy.team.models,
      memberUserId:user.nativeUserId,memberMaxBudget:moneyNumber(policy.membership.maxBudget),memberBudgetDuration:policy.membership.budgetDuration,
      memberModels:policy.membership.allowedModels,memberRole:policy.membership.role},key:nativeKeyExpectation(op,gate)};
}
function checkRead(value:NativeRead<true>):void {if(value.kind!=='match')throw refuse();}
function checkDeadline(deadline:number,gate:NativeCustodyGate,op:NativeOperation):void {
  if(Date.now()>=deadline)throw refuse();
  const current=gate.readOperation(op.operationId);
  if(current.phase!==op.phase||current.bindingId!==op.bindingId||current.credentialGeneration!==op.credentialGeneration||current.keyFingerprint!==op.keyFingerprint||current.userOwnershipId!==op.userOwnershipId)throw refuse();
}
async function month(db:SourceDatabase):Promise<Month> {
  const row=(await db.query(`WITH m AS (SELECT date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AS s)
    SELECT to_char(s,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,to_char(s+interval '1 month','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at FROM m`)).rows[0];
  if(typeof row?.starts_at!=='string'||typeof row?.ends_at!=='string')throw refuse();return {startsAt:row.starts_at,endsAt:row.ends_at};
}
async function accountWindow(db:SourceDatabase,account:Row,period:Month):Promise<{id:string;startsAt:string;endsAt:string;openingCap:string}> {
  const rows=(await db.query(`SELECT id,account_id,to_char(starts_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,to_char(ends_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at,opening_cap FROM budget_windows
    WHERE account_id=$1 AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz ORDER BY id LIMIT 2 FOR UPDATE`,[account.id,period.startsAt,period.endsAt])).rows;
  if(rows.length!==1||rows[0]!.id!==account.active_window_id||rows[0]!.account_id!==account.id)throw refuse();
  const row=rows[0]!,exactBounds=(await db.query('SELECT ($1::timestamptz=$2::timestamptz AND $3::timestamptz=$4::timestamptz) AS exact',[row.starts_at,period.startsAt,row.ends_at,period.endsAt])).rows[0]?.exact;
  if(exactBounds!==true||typeof row.starts_at!=='string'||typeof row.ends_at!=='string')throw refuse();
  return {id:row.id,startsAt:period.startsAt,endsAt:period.endsAt,openingCap:canonicalBudgetMoney(String(row.opening_cap))};
}

async function prepareSource(db:SourceDatabase,journal:HostFinancialJournal,op:NativeOperation,installationId:string,memberAccountId:string,endpointHash:string,deadline:number):Promise<Prepared> {
  const memberIdentity=(await db.query('SELECT live_member_id,organisation_id FROM budget_accounts WHERE id=$1 AND kind=\'member\'',[memberAccountId])).rows;
  if(memberIdentity.length!==1||typeof memberIdentity[0]!.live_member_id!=='string')throw refuse();const liveMemberId=memberIdentity[0]!.live_member_id as string;
  await gateConsoleOrganisation(db,liveMemberId,undefined,{lock:'update'});requireConsoleSourceOwner(db);
  const users=(await db.query('SELECT id,org_id,status FROM users WHERE id=$1 FOR UPDATE',[liveMemberId])).rows;
  if(users.length!==1||users[0]!.status!=='active'||typeof users[0]!.org_id!=='string'||users[0]!.org_id!==memberIdentity[0]!.organisation_id)throw refuse();
  const providers=(await db.query('SELECT issuer,subject,tenant_id FROM member_provider_identities WHERE member_id=$1 ORDER BY issuer,subject,tenant_id LIMIT 65 FOR UPDATE',[liveMemberId])).rows;
  if(providers.length<1||providers.length>64||providers.some((p:Row)=>typeof p.issuer!=='string'||typeof p.subject!=='string'||typeof p.tenant_id!=='string'))throw refuse();
  const suppression=journal.suppression({canonicalMemberId:liveMemberId,providers:providers.map((p:Row)=>({issuer:p.issuer,subject:p.subject,tenantId:p.tenant_id}))});
  const monthValue=await month(db);retainSourceTransactionDeadline(db,monthValue.endsAt);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('lares-budget-account-provisioning',0))");
  const installRows=(await db.query('SELECT * FROM budget_accounts WHERE kind=\'installation\' ORDER BY id LIMIT 2 FOR UPDATE')).rows;
  if(installRows.length!==1)throw refuse();const installation=installRows[0]!;
  const memberRows=(await db.query('SELECT * FROM budget_accounts WHERE id=$1 AND kind=\'member\' FOR UPDATE',[memberAccountId])).rows;
  if(memberRows.length!==1)throw refuse();const member=memberRows[0]!;
  if(!uuidString(installation.id)||installation.id!==installationId||installation.installation_account_id!==installation.id)throw refuse();
  const storedProviders=Array.isArray(member.provider_suppression_hashes)?[...member.provider_suppression_hashes].sort():[];
  if(member.installation_account_id!==installation.id||member.live_member_id!==liveMemberId||member.canonical_suppression_hash!==suppression.canonicalSuppressionHash||
    !exact(storedProviders,suppression.providerSuppressionHashes)||member.state!=='closed'||member.reason!=='unreconciled'||member.selected_endpoint!==null||member.recovery_epoch!==null||
    !uuidString(member.id)||member.id!==memberAccountId)throw refuse();
  const firstOpen=installation.state==='closed'&&installation.reason==='unreconciled'&&installation.selected_endpoint===null&&installation.recovery_epoch===null;
  // Existing open installations are accepted only when their endpoint/epoch are the exact retained binding.
  if(!firstOpen&&!(installation.state==='open'&&installation.reason==='approved'&&installation.selected_endpoint===endpointHash&&typeof installation.recovery_epoch==='string'))throw refuse();
  const policy=budgetNativeReviewedPolicySchema.parse(op.reviewedPolicy),binding=(await db.query('SELECT * FROM budget_gateway_bindings WHERE id=$1 FOR UPDATE',[op.bindingId])).rows;
  if(binding.length!==1)throw refuse();const b=binding[0]!;
  const userOwnershipId=op.userOwnershipId;
  if(b.state!=='active'||b.id!==op.bindingId||String(b.credential_generation)!==op.credentialGeneration||b.installation_account_id!==installation.id||b.member_account_id!==member.id||
    b.live_member_id!==liveMemberId||b.endpoint_hash!==endpointHash||b.key_fingerprint!==op.keyFingerprint||b.agent!==op.association.agent||b.incarnation!==op.association.incarnation||
    b.purpose_alias!==op.association.purposeAlias||b.profile_hash!==policy.pricing.capabilityHash||canonicalBudgetMoney(String(b.maximum_liability))!==policy.maximumLiability||
    !exact(b.pricing_profile,policy.pricing)||typeof userOwnershipId!=='string')throw refuse();
  if(firstOpen){if(installation.endpoint_generation!=='0'&&String(installation.endpoint_generation)!=='0')throw refuse();}
  else if(installation.selected_endpoint!==b.endpoint_hash||String(installation.endpoint_generation)==='0'||typeof installation.recovery_epoch!=='string')throw refuse();
  const rows=(await db.query(`SELECT d.definition,d.duties,d.voice,d.hash,d.status,r.ownership,r.ownership_token,r.runtime_control_token,r.state,r.applied_definition,r.pending
    FROM agent_definitions d JOIN agent_resources r ON r.name=d.name WHERE d.name=$1 FOR UPDATE OF d,r`,[op.association.agent])).rows;
  if(rows.length!==1)throw refuse();const row=rows[0]!;let definition,applied;
  try{definition=parseDefinition(definitionSchema.parse(row.definition));applied=parseDefinition(definitionSchema.parse(row.applied_definition));}catch{throw refuse();}
  const definitionHash=hashOf({definition,dutiesMd:row.duties,voiceMd:row.voice});
  if(row.status!=='valid'||row.hash!==definitionHash||definitionHash!==op.association.definitionHash||row.ownership!=='owned'||definition.model!==op.association.purposeAlias||
    applied.model!==op.association.purposeAlias||row.ownership_token!==op.association.incarnation||row.runtime_control_token!==op.association.incarnation||row.state!=='ready'||row.pending!==false||!exact(applied,definition))throw refuse();
  const grant=await new PgGrantStore().captureUseWithExpiry(liveMemberId,op.association.agent,{db:db as never});if(!grant)throw refuse();if(grant.validUntil)retainSourceTransactionDeadline(db,grant.validUntil);
  const conflicts=(await db.query(`SELECT id FROM budget_gateway_bindings WHERE (installation_account_id=$1 AND member_account_id=$2 AND agent=$3 AND incarnation=$4 AND purpose_alias=$5)
    AND id<>$6 LIMIT 2 FOR UPDATE`,[installation.id,member.id,op.association.agent,op.association.incarnation,op.association.purposeAlias,op.bindingId])).rows;
  if(conflicts.length)throw refuse();
  const installWindow=await accountWindow(db,installation,monthValue),memberWindow=await accountWindow(db,member,monthValue);
  const cap=canonicalBudgetMoney(String(installation.installation_cap));
  if(cap==='0'||installWindow.openingCap!==cap)throw refuse();
  const endpointGeneration=firstOpen?'1':String(installation.endpoint_generation),recoveryEpoch=firstOpen?randomBytes(32).toString('base64url'):String(installation.recovery_epoch);
  if(Date.now()>=deadline)throw refuse();
  return {operation:op,month:monthValue,installationWindowId:installWindow.id,memberWindowId:memberWindow.id,endpointGeneration,recoveryEpoch,firstOpen,installationCap:cap,memberWindowCap:memberWindow.openingCap};
}

/** Trusted host adapter. It activates exactly one existing bound-closed key. */
export class BudgetNativeActivator {
  constructor(private readonly pool:SourcePool,private readonly journal:HostFinancialJournal,private readonly custody:BudgetNativeCustodyStore,private readonly native:BudgetNativeCredentialClient){
    if(native.gatewayOrigin.length===0)throw publicRefuse();
  }
  async activate(raw:unknown):Promise<{state:'active';bindingId:string;credentialGeneration:string}> {
    const request=requestSchema.parse(raw),deadline=Date.now()+20_000;
    if(!this.journal.prepared)throw refuse();const writer=new JournalBudgetFinancialWriter(this.journal);let operationId='',unblockClaimed=false;
    try{return await this.custody.withGate(async gate=>{
      const matches=gate.inventory().operations.filter((value):value is NativeOperation=>value.kind==='operation'&&value.bindingId===request.bindingId&&value.credentialGeneration===request.credentialGeneration);
      if(matches.length!==1)throw refuse();const op=matches[0]!;operationId=op.operationId;
      const nativeUser=gate.inventory().users.find(v=>v.kind==='user'&&v.ownershipId===op.userOwnershipId);
      if(!nativeUser||nativeUser.kind!=='user')throw refuse();
      if(op.phase!=='bound-closed'||op.plaintext!=='present'||!op.bindingReceipt||!op.financialOperationId||!op.financialJournalId||
        op.bindingReceipt.operationId!==op.financialOperationId||op.bindingReceipt.journalId!==op.financialJournalId||op.financialJournalId!==this.journal.id||
        op.bindingReceipt.operation!=='provision'||this.native.gatewayOrigin!==nativeUser.endpoint.origin)throw refuse();
      const committed=await writer.runWithReceipt('native-activation',async(boundary,financialOperationId)=>consoleSourceTransaction(this.pool,async db=>{
        const user=nativeUser;
        const prepared=await prepareSource(db,this.journal,op,user.installationAccountId,user.accountId,user.endpoint.hash,deadline);const nativeExpected=nativeExpectations(op,gate);
        if(prepared.operation.operationId!==op.operationId||op.phase!=='bound-closed')throw refuse();
        checkDeadline(deadline,gate,op);await db.query("SELECT set_config('idle_in_transaction_session_timeout','6000ms',true)");
        const inventory=gate.inventory(),related=inventory.operations.filter((v):v is NativeOperation=>v.kind==='operation'&&v.userOwnershipId===op.userOwnershipId);
        if(related.some(v=>v.operationId!==op.operationId&&v.phase!=='bound-closed'&&v.phase!=='prepared'))throw refuse();
        const known=[...new Set(related.filter(v=>v.phase==='bound-closed').map(v=>v.keyFingerprint))].filter(v=>v!==op.keyFingerprint).sort();
        if(known.length>=10)throw refuse();
        const afterRemote=async(expected:NativeOperation)=>{checkDeadline(deadline,gate,expected);await checkConsoleSourceDeadlines(db);};
        const expectedOwned=[...known,op.keyFingerprint].sort();
        const before=await this.native.listOwnedKeys(nativeExpected.nativeUserId);await afterRemote(op);if(before.kind!=='match'||!exact([...before.value].sort(),expectedOwned))throw refuse();
        checkRead(await this.native.readTeamPolicy(nativeExpected.team));await afterRemote(op);
        checkRead(await this.native.readUser(nativeExpected.user));await afterRemote(op);
        checkRead(await this.native.readTeam(nativeExpected.membership));await afterRemote(op);
        const blocked=await this.native.lookupKey(op.keyFingerprint,nativeExpected.key);await afterRemote(op);checkRead(blocked);
        const pending=gate.beginActivation(op.operationId,{financialOperationId,journalId:this.journal.id,installationWindowId:prepared.installationWindowId,memberWindowId:prepared.memberWindowId,
          endpointGeneration:prepared.endpointGeneration,recoveryEpochHash:hash(prepared.recoveryEpoch),monthStartsAt:prepared.month.startsAt,monthEndsAt:prepared.month.endsAt,
          installationCap:prepared.installationCap,memberWindowCap:prepared.memberWindowCap});
        checkDeadline(deadline,gate,pending);
        const claim=gate.claimActivationUnblock(op.operationId);unblockClaimed=true;checkDeadline(deadline,gate,claim);
        try{await this.native.unblockKey(op.keyFingerprint);}catch{/* The exact readback below is the only acknowledgement recovery. */}
        await afterRemote(claim);
        const unblocked=await this.native.lookupUnblockedKey(op.keyFingerprint,nativeExpected.key);await afterRemote(claim);checkRead(unblocked);
        const after=await this.native.listOwnedKeys(nativeExpected.nativeUserId);await afterRemote(claim);
        if(after.kind!=='match'||!exact([...after.value].sort(),expectedOwned))throw refuse();
        gate.verifyActivationUnblocked(op.operationId);
        const installation=(await db.query('SELECT * FROM budget_accounts WHERE id=$1 FOR UPDATE',[user.installationAccountId])).rows[0];
        const member=(await db.query('SELECT * FROM budget_accounts WHERE id=$1 FOR UPDATE',[user.accountId])).rows[0];if(!installation||!member)throw refuse();
        if(prepared.firstOpen){
          const updated=(await db.query(`UPDATE budget_accounts SET state='open',reason='approved',selected_endpoint=$2,endpoint_generation=1,recovery_epoch=$3
            WHERE id=$1 AND kind='installation' AND state='closed' AND reason='unreconciled' RETURNING id`,[installation.id,user.endpoint.hash,prepared.recoveryEpoch])).rows[0];
          if(!updated)throw refuse();noteBudgetFinancialChange(db,'budget_accounts',installation.id);
        }else if(installation.state!=='open'||installation.reason!=='approved'||installation.selected_endpoint!==user.endpoint.hash||
          String(installation.endpoint_generation)!==prepared.endpointGeneration||installation.recovery_epoch!==prepared.recoveryEpoch)throw refuse();
        const opened=(await db.query(`UPDATE budget_accounts SET state='open',reason='approved' WHERE id=$1 AND kind='member' AND state='closed' AND reason='unreconciled'
          AND installation_account_id=$2 RETURNING id`,[member.id,installation.id])).rows[0];if(!opened)throw refuse();noteBudgetFinancialChange(db,'budget_accounts',member.id);
        await checkConsoleSourceDeadlines(db);if(Date.now()>=deadline)throw refuse();
        // Native policy is independently mutable. Verify the exact policy and full owned
        // key inventory again after the SQL changes, directly before this transaction commits.
        const [teamPolicy,userPolicy,membershipPolicy,finalInventory]=await Promise.all([
          this.native.readTeamPolicy(nativeExpected.team),this.native.readUser(nativeExpected.user),this.native.readTeam(nativeExpected.membership),
          this.native.listOwnedKeys(nativeExpected.nativeUserId),
        ]);
        await afterRemote(claim);
        checkRead(teamPolicy);checkRead(userPolicy);checkRead(membershipPolicy);
        if(finalInventory.kind!=='match'||!exact([...finalInventory.value].sort(),expectedOwned))throw refuse();
        await checkConsoleSourceDeadlines(db);if(Date.now()>=deadline)throw refuse();
        return {state:'active' as const,bindingId:op.bindingId,credentialGeneration:op.credentialGeneration};
      },boundary,{deadlineAtMs:deadline}),receipt=>{gate.recordActive(op.operationId,receipt);return undefined;});
      return committed.value;
    });}catch(error){
      if(operationId&&unblockClaimed){try{await this.custody.withGate(gate=>{gate.recordUncertain(operationId);return Promise.resolve();});}catch{/* Keep the frozen or uncertain custody result. */}}
      throw publicRefuse();
    }
  }
}
