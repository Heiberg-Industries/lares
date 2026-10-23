/** Read-only startup eligibility for the guarded native model-purpose runtime. */
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {canonicalBudgetMoney} from '@lares/agent-kit/budget-admission-store';
import {consoleSourceTransaction,gateConsoleOrganisation,requireConsoleSourceOwner,retainSourceTransactionDeadline,type SourcePool} from '@lares/agent-kit/console-source-transaction';
import {gatewayCanonical,gatewayHash} from '@lares/agent-kit/gateway-admission-protocol';
import {PgGrantStore} from '@lares/agent-kit/grant-store';
import {definitionSchema,hashOf,parseDefinition} from '@lares/agent-kit/definition';
import {currentMember} from '@lares/agent-kit/member-store';
import type {BudgetNativeReviewedPolicy,BudgetNativeCustodyStore,NativeOperation} from './budget-native-custody.js';
import {budgetNativeReviewedPolicySchema} from './budget-native-custody.js';
import type {HostFinancialJournal,FinancialAtom} from './financial-journal.js';
import {financialAtomFromRow,FINANCIAL_UTC_TIMESTAMP} from './financial-projection.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid();
const identitySchema=z.object({agent:z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),incarnation:uuid,definitionHash:hash,
  purposeAlias:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)}).strict();
export type NativeRuntimeIdentity=z.infer<typeof identitySchema>;
export type NativeRuntimeState={state:'active'}|{state:'held';reason:'Native budget activation required'};
const held=():NativeRuntimeState=>({state:'held',reason:'Native budget activation required'});
const refuse=()=>new Error('Native budget activation required');
const exact=(a:unknown,b:unknown)=>gatewayCanonical(a).equals(gatewayCanonical(b));
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
type Row=Record<string,any>;

/** Compare a locked current SQL projection row to the journal's committed source image. */
export function matchesCurrentFinancialAtom(expected:FinancialAtom|undefined,actual:FinancialAtom):boolean {
  return !!expected&&expected.kind===actual.kind&&exact(expected,actual);
}

export interface NativeRuntimeAuthorityOptions {
  custody:BudgetNativeCustodyStore;
  journal:HostFinancialJournal;
  pool:SourcePool;
  /** Reload the protected reviewed-policy document for each current() authority check. */
  reviewedPolicy:BudgetNativeReviewedPolicy;
  designatedOwnerId:string;
  gatewayOrigin:string;
  endpointHash:string;
}

/** Constructed only from Keeper's verified native custody and prepared financial owner.
 * It exposes no action surface, native client, credential, or permission-bearing metadata. */
export function createNativeRuntimeAuthority(options:NativeRuntimeAuthorityOptions):{current(raw:unknown):Promise<NativeRuntimeState>} {
  const policy=budgetNativeReviewedPolicySchema.parse(options.reviewedPolicy);
  const ownerId=z.string().min(1).max(128).parse(options.designatedOwnerId);
  const gatewayOrigin=z.string().max(512).refine(value=>{
    try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&url.origin===value&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash;}
    catch{return false;}
  }).parse(options.gatewayOrigin);
  const endpointHash=hash.parse(options.endpointHash);
  if(!options.journal.prepared||!gatewayOrigin)throw refuse();

  return Object.freeze({current:async(raw:unknown):Promise<NativeRuntimeState>=>{
    let identity:NativeRuntimeIdentity;
    try{identity=identitySchema.parse(raw);}catch{throw refuse();}
    try{
      return await options.custody.withGate(async gate=>{
        try{
        const snapshot=gate.inventory();
        const matches=snapshot.operations.filter((row):row is NativeOperation=>row.kind==='operation'&&
          row.association.agent===identity.agent&&row.association.incarnation===identity.incarnation&&
          row.association.definitionHash===identity.definitionHash&&row.association.purposeAlias===identity.purposeAlias);
        if(matches.length===0)throw refuse();
        const candidates=matches.map(op=>{
          const candidate=snapshot.users.find(row=>row.kind==='user'&&row.ownershipId===op.userOwnershipId);
          const user=candidate?.kind==='user'?candidate:undefined;
          const teamCandidate=user&&snapshot.teams.find(row=>row.kind==='team'&&row.ownershipId===user.teamOwnershipId);
          return {op,user,team:teamCandidate?.kind==='team'?teamCandidate:undefined};
        });

        let retainedReference:ReturnType<HostFinancialJournal['observeGatewayRecoveryReference']>;
        let sourceDeadlineMono=Number.POSITIVE_INFINITY;
        const recoveryReferenceIsCurrent=()=>{
          if(!retainedReference)return false;
          const current=options.journal.observeGatewayRecoveryReference({installationAccountId:retainedReference.installationAccountId,
            epoch:retainedReference.epoch,endpointGeneration:retainedReference.endpointGeneration});
          return !!current&&exact(current,retainedReference);
        };
        const result=await consoleSourceTransaction(options.pool,async db=>{
          const discovered=(await db.query("SELECT id,live_member_id,organisation_id FROM budget_accounts WHERE live_member_id=$1 AND kind='member' ORDER BY id LIMIT 2",[ownerId])).rows;
          if(discovered.length!==1||discovered[0]!.live_member_id!==ownerId||typeof discovered[0]!.id!=='string'||typeof discovered[0]!.organisation_id!=='string')throw refuse();
          const discoveredAccountId=discovered[0]!.id as string,liveMemberId=discovered[0]!.live_member_id as string,discoveredOrg=discovered[0]!.organisation_id as string;
          await gateConsoleOrganisation(db,liveMemberId,undefined,{lock:'share'});requireConsoleSourceOwner(db);
          const owner=await currentMember(db as never,liveMemberId,{lock:'share'});
          if(!owner||owner.id!==ownerId||owner.role!=='owner')throw refuse();
          const memberAccount=(await db.query("SELECT id,live_member_id,organisation_id FROM budget_accounts WHERE id=$1 AND kind='member' FOR SHARE",[discoveredAccountId])).rows;
          if(memberAccount.length!==1||memberAccount[0]!.id!==discoveredAccountId||memberAccount[0]!.live_member_id!==liveMemberId||memberAccount[0]!.organisation_id!==discoveredOrg||owner.organisationId!==discoveredOrg)throw refuse();
          const selected=candidates.filter(candidate=>candidate.user?.accountId===memberAccount[0]!.id);
          if(selected.length!==1)throw refuse();
          const {op,user,team}=selected[0]!;
          if(!user||!team)throw refuse();
          const intent=op.activationIntent,activation=op.activationReceipt,bindingReceipt=op.bindingReceipt;
          if(op.phase!=='active'||op.plaintext!=='present'||!intent||!activation||!bindingReceipt||
            op.keyCreateAttempt!=='verified'||user.userCreateAttempt!=='verified'||user.membershipCreateAttempt!=='verified'||team.createAttempt!=='verified'||
            user.endpoint.origin!==gatewayOrigin||team.endpoint.origin!==gatewayOrigin||user.endpoint.hash!==endpointHash||team.endpoint.hash!==endpointHash||
            team.capabilityHash!==policy.pricing.capabilityHash||!exact(team.policy,policy.team)||!exact(user.policy,policy.user)||!exact(user.membership,policy.membership)||
            op.policyDigest!==gatewayHash(gatewayCanonical(policy))||
            !exact(op.reviewedPolicy,policy)||op.reviewedPolicy.pricing.capabilityHash!==policy.pricing.capabilityHash||
            op.association.purposeAlias!==policy.key.models[0]||intent.unblockAttempt!=='verified'||intent.journalId!==options.journal.id||
            activation.operation!=='native-activation'||activation.operationId!==intent.financialOperationId||activation.journalId!==intent.journalId||
            bindingReceipt.operation!=='provision'||bindingReceipt.operationId!==op.financialOperationId||bindingReceipt.journalId!==op.financialJournalId||
            op.financialJournalId!==options.journal.id||intent.originalBindingReceiptHash!==gatewayHash(gatewayCanonical(bindingReceipt)))throw refuse();
          const projection=options.journal.expectedProjection(),expected=(kind:FinancialAtom['kind'],id:string)=>projection.atoms.find(atom=>atom.kind===kind&&'id'in atom&&atom.id===id);
          const checkpoint=(receipt:{journalId:string;operationId:string;proposalSequence:number;proposalDigest:string})=>
            receipt.journalId===options.journal.id&&projection.checkpoints.some(row=>row.operationId===receipt.operationId&&row.sequence===receipt.proposalSequence&&row.digest===receipt.proposalDigest);
          if(!checkpoint(bindingReceipt)||!checkpoint(activation)||activation.proposalSequence<=bindingReceipt.proposalSequence)throw refuse();
          const ownerPolicy=(await db.query('SELECT spend_cap_usd_month FROM org_member_policy WHERE user_id=$1 FOR SHARE',[ownerId])).rows;
          if(ownerPolicy.length!==1||canonicalBudgetMoney(String(ownerPolicy[0]!.spend_cap_usd_month))!==intent.memberWindowCap)throw refuse();
          const providerRows=(await db.query('SELECT issuer,subject,tenant_id FROM member_provider_identities WHERE member_id=$1 ORDER BY issuer,subject,tenant_id LIMIT 65 FOR SHARE',[liveMemberId])).rows;
          if(providerRows.length<1||providerRows.length>64||providerRows.some((row:Row)=>typeof row.issuer!=='string'||typeof row.subject!=='string'||typeof row.tenant_id!=='string'))throw refuse();
          const suppression=options.journal.suppression({canonicalMemberId:liveMemberId,providers:providerRows.map((row:Row)=>({issuer:row.issuer,subject:row.subject,tenantId:row.tenant_id}))});
          const installationRows=(await db.query("SELECT * FROM budget_accounts WHERE kind='installation' ORDER BY id LIMIT 2 FOR SHARE")).rows;
          const memberRows=(await db.query("SELECT * FROM budget_accounts WHERE id=$1 AND kind='member' FOR SHARE",[user.accountId])).rows;
          if(installationRows.length!==1||memberRows.length!==1)throw refuse();
          const installation=installationRows[0]!,member=memberRows[0]!;
          if(installation.id!==user.installationAccountId||team.installationAccountId!==installation.id||member.id!==user.accountId||
            member.installation_account_id!==installation.id||member.organisation_id!==owner.organisationId||member.live_member_id!==ownerId||
            member.state!=='open'||member.reason!=='approved'||member.selected_endpoint!==null||member.recovery_epoch!==null||
            member.canonical_suppression_hash!==suppression.canonicalSuppressionHash||!exact([...(member.provider_suppression_hashes??[])].sort(),suppression.providerSuppressionHashes))throw refuse();
          if(installation.state!=='open'||installation.reason!=='approved'||installation.selected_endpoint!==user.endpoint.hash||
            installation.endpoint_generation!==intent.endpointGeneration||sha(String(installation.recovery_epoch))!==intent.recoveryEpochHash||
            intent.installationAccountId!==installation.id||intent.memberAccountId!==member.id||intent.endpointHash!==endpointHash)throw refuse();
          const bindingRows=(await db.query('SELECT * FROM budget_gateway_bindings WHERE id=$1 FOR SHARE',[op.bindingId])).rows;
          if(bindingRows.length!==1)throw refuse();const binding=bindingRows[0]!;
          if(binding.state!=='active'||binding.id!==op.bindingId||String(binding.credential_generation)!==op.credentialGeneration||
            binding.installation_account_id!==installation.id||binding.member_account_id!==member.id||binding.live_member_id!==ownerId||
            binding.agent!==identity.agent||binding.incarnation!==identity.incarnation||binding.purpose_alias!==identity.purposeAlias||
            binding.endpoint_hash!==endpointHash||binding.key_fingerprint!==op.keyFingerprint||binding.profile_hash!==policy.pricing.capabilityHash||
            canonicalBudgetMoney(String(binding.maximum_liability))!==policy.maximumLiability||!exact(binding.pricing_profile,policy.pricing))throw refuse();
          const projectedBinding=expected('binding',op.bindingId);
          if(!matchesCurrentFinancialAtom(projectedBinding,financialAtomFromRow('binding',binding)))throw refuse();
          const conflicts=(await db.query(`SELECT id FROM budget_gateway_bindings WHERE
            (installation_account_id=$1 AND member_account_id=$2 AND agent=$3 AND incarnation=$4 AND purpose_alias=$5 AND id<>$6)
            OR (key_fingerprint=$7 AND id<>$6) LIMIT 2 FOR SHARE`,[installation.id,member.id,identity.agent,identity.incarnation,identity.purposeAlias,op.bindingId,op.keyFingerprint])).rows;
          if(conflicts.length)throw refuse();
          const now=(await db.query(`WITH m AS (SELECT date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AS s)
            SELECT to_char(s,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,to_char(s+interval '1 month','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at FROM m`)).rows[0];
          if(!now?.starts_at||!now?.ends_at)throw refuse();
          retainSourceTransactionDeadline(db,now.ends_at);
          const journalReference={installationAccountId:String(installation.id),epoch:String(installation.recovery_epoch),endpointGeneration:String(installation.endpoint_generation)};
          retainedReference=options.journal.observeGatewayRecoveryReference(journalReference);
          if(!retainedReference)throw refuse();
          for(const [account,windowId,cap] of [[installation,intent.installationWindowId,intent.installationCap],[member,intent.memberWindowId,intent.memberWindowCap]] as const){
            const windows=(await db.query(`SELECT *,${FINANCIAL_UTC_TIMESTAMP('starts_at')} AS starts_utc,${FINANCIAL_UTC_TIMESTAMP('ends_at')} AS ends_utc
              FROM budget_windows WHERE account_id=$1 AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz ORDER BY id LIMIT 2 FOR SHARE`,[account.id,now.starts_at,now.ends_at])).rows;
            if(intent.monthStartsAt!==now.starts_at||intent.monthEndsAt!==now.ends_at||windows.length!==1||windows[0]!.id!==account.active_window_id||windows[0]!.id!==windowId||
              !(await db.query('SELECT 1 WHERE $1::timestamptz=$2::timestamptz AND $3::timestamptz=$4::timestamptz',[windows[0]!.starts_at,now.starts_at,windows[0]!.ends_at,now.ends_at])).rows.length)throw refuse();
            const actual=financialAtomFromRow('window',windows[0]!),recorded=expected('window',windowId);
            if(actual.kind!=='window'||!matchesCurrentFinancialAtom(recorded,actual)||actual.openingCap!==cap)throw refuse();
          }
          const actualInstall=financialAtomFromRow('account',installation),actualMember=financialAtomFromRow('account',member);
          if(!matchesCurrentFinancialAtom(expected('account',installation.id),actualInstall)||
            !matchesCurrentFinancialAtom(expected('account',member.id),actualMember)||
            !installation.installation_cap||canonicalBudgetMoney(String(installation.installation_cap))!==intent.installationCap||
            canonicalBudgetMoney(intent.installationCap)!==intent.installationCap||canonicalBudgetMoney(intent.memberWindowCap)!==intent.memberWindowCap||
            intent.installationCap==='0'||intent.memberWindowCap==='0')throw refuse();
          const definitions=(await db.query(`SELECT d.definition,d.duties,d.voice,d.hash,d.status,r.ownership,r.ownership_token,r.runtime_control_token,r.state,r.applied_definition,r.pending
            FROM agent_definitions d JOIN agent_resources r ON r.name=d.name WHERE d.name=$1 FOR SHARE OF d,r`,[identity.agent])).rows;
          if(definitions.length!==1)throw refuse();const row=definitions[0]!;let definition,applied;
          try{definition=parseDefinition(definitionSchema.parse(row.definition));applied=parseDefinition(definitionSchema.parse(row.applied_definition));}catch{throw refuse();}
          const definitionHash=hashOf({definition,dutiesMd:row.duties,voiceMd:row.voice});
          if(row.status!=='valid'||row.hash!==definitionHash||definitionHash!==identity.definitionHash||definition.model!==identity.purposeAlias||applied.model!==identity.purposeAlias||
            definition.role!=='chief-of-staff'||applied.role!=='chief-of-staff'||
            row.ownership!=='owned'||row.ownership_token!==identity.incarnation||row.runtime_control_token!==identity.incarnation||row.state!=='ready'||row.pending!==false||!exact(applied,definition))throw refuse();
          const grant=await new PgGrantStore().captureUseWithExpiry(ownerId,identity.agent,{db:db as never});if(!grant)throw refuse();
          if(grant.validUntil)retainSourceTransactionDeadline(db,grant.validUntil);
          const deadlineQueryStarted=performance.now(),deadline=(await db.query(`SELECT floor(extract(epoch FROM
            (LEAST($1::timestamptz,$2::timestamptz)-clock_timestamp()))*1000)::bigint AS remaining_ms`,[grant.validUntil??now.ends_at,now.ends_at])).rows[0];
          const remainingMs=Number(deadline?.remaining_ms);
          if(!Number.isFinite(remainingMs)||!Number.isSafeInteger(remainingMs)||remainingMs<=0)throw refuse();
          sourceDeadlineMono=deadlineQueryStarted+remainingMs;
          return true;
        },undefined,{deadlineAtMs:Date.now()+10_000,afterCommit:()=>{
          if(performance.now()>=sourceDeadlineMono||!recoveryReferenceIsCurrent())throw refuse();
        }});
        if(!result||performance.now()>=sourceDeadlineMono||!recoveryReferenceIsCurrent())return held();
        return {state:'active'};
        }catch{return held();}
      });
    }catch{return held();}
  }});
}
