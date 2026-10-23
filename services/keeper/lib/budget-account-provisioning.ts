/** Root-host account/window provisioning. New state is always closed and unreconciled. */
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {canonicalBudgetMoney} from '@lares/agent-kit/budget-admission-store';
import {checkConsoleSourceDeadlines,consoleSourceTransaction,gateConsoleOrganisation,noteBudgetFinancialChange,requireConsoleSourceOwner,retainSourceTransactionDeadline,type SourceDatabase,type SourcePool} from '@lares/agent-kit/console-source-transaction';
import {HostFinancialJournal} from './financial-journal.js';
import {JournalBudgetFinancialWriter} from './budget-financial-writer.js';

const amount=z.string().max(37).refine(value=>{
  try{return canonicalBudgetMoney(value)===value&&canonicalBudgetMoney(value)!=='0';}catch{return false;}
});
const memberId=z.string().min(1).max(128).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
export const budgetAccountProvisionPlanSchema=z.object({
  installationCap:amount,
  memberIds:z.array(memberId).min(1).max(16).refine(values=>new Set(values).size===values.length),
}).strict();
export type BudgetAccountProvisionPlan=z.infer<typeof budgetAccountProvisionPlanSchema>;
export type UtcMonth={startsAt:string;endsAt:string};
type QueryDatabase=Pick<SourceDatabase,'query'>;
const refusal=()=>new Error('Budget account provisioning refused; financial recovery may be required');
const id=()=>randomUUID();
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const canonicalMoney=(value:unknown):string=>canonicalBudgetMoney(typeof value==='string'?value:String(value));

async function conservativeMonthDeadline(db:QueryDatabase,endsAt:string,captured:number):Promise<number>{
  const row=(await db.query(`SELECT floor(extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::text AS remaining_ms`,[endsAt])).rows[0];
  const remaining=Number(row?.remaining_ms);
  if(!Number.isSafeInteger(remaining)||remaining<1)throw refusal();
  // captured precedes the SQL clock sample and the remaining value is floored, so this
  // deadline is early by at least the query latency and any sub-millisecond remainder.
  return captured+remaining;
}

async function databaseMonth(db:QueryDatabase):Promise<UtcMonth>{
  const row=(await db.query(`WITH month AS (SELECT date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AS starts_utc)
    SELECT to_char(starts_utc,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
      to_char(starts_utc+interval '1 month','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_at FROM month`)).rows[0];
  if(typeof row?.starts_at!=='string'||typeof row?.ends_at!=='string')throw refusal();
  return {startsAt:row.starts_at,endsAt:row.ends_at};
}

function overlap(a:string[],b:string[]):boolean{return a.some(value=>b.includes(value));}

async function provisionOwned(db:SourceDatabase,journal:HostFinancialJournal,plan:BudgetAccountProvisionPlan,readMonth:typeof databaseMonth,setActiveDeadline:(deadline:number)=>void):Promise<{state:'closed';reason:'unreconciled';members:number;accountsCreated:number;windowsCreated:number}>{
  const memberIds=[...plan.memberIds].sort();
  for(const member of memberIds)await gateConsoleOrganisation(db,member);
  requireConsoleSourceOwner(db);

  // Recheck all selected users in stable order before locking their exact persisted provider identities.
  const users=(await db.query(`SELECT id,org_id,status FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,[memberIds])).rows;
  if(users.length!==memberIds.length||users.some(user=>user.status!=='active'||typeof user.org_id!=='string'||user.org_id!==users[0]?.org_id))throw refusal();
  const providers=(await db.query(`SELECT member_id,issuer,subject,tenant_id FROM member_provider_identities WHERE member_id=ANY($1::text[]) ORDER BY issuer,subject,tenant_id LIMIT 1025 FOR UPDATE`,[memberIds])).rows;
  if(providers.length>1024)throw refusal();
  const identities=new Map<string,{issuer:string;subject:string;tenantId:string}[]>();
  for(const provider of providers){
    if(!memberIds.includes(provider.member_id)||typeof provider.issuer!=='string'||typeof provider.subject!=='string'||typeof provider.tenant_id!=='string')throw refusal();
    const list=identities.get(provider.member_id)??[];list.push({issuer:provider.issuer,subject:provider.subject,tenantId:provider.tenant_id});identities.set(provider.member_id,list);
  }
  if(memberIds.some(member=>!identities.get(member)?.length||identities.get(member)!.length>64))throw refusal();
  const policyRows=(await db.query(`SELECT user_id,spend_cap_usd_month FROM org_member_policy WHERE user_id=ANY($1::text[]) ORDER BY user_id FOR UPDATE`,[memberIds])).rows;
  const policies=new Map<string,string>();
  for(const policy of policyRows){
    try{const cap=canonicalMoney(policy.spend_cap_usd_month);if(cap==='0'||policies.has(policy.user_id))throw refusal();policies.set(policy.user_id,cap);}catch{throw refusal();}
  }
  if(memberIds.some(member=>!policies.has(member)))throw refusal();
  const selectedCanonical=new Map<string,{memberId:string;providerHashes:string[];canonicalHash:string;org:string;memberCap:string}>();
  for(const user of users){
    const digests=journal.suppression({canonicalMemberId:user.id,providers:identities.get(user.id)!});
    if(digests.providerSuppressionHashes.length>64)throw refusal();
    selectedCanonical.set(digests.canonicalSuppressionHash,{memberId:user.id,providerHashes:digests.providerSuppressionHashes,canonicalHash:digests.canonicalSuppressionHash,org:user.org_id,memberCap:policies.get(user.id)!});
  }
  if(selectedCanonical.size!==memberIds.length)throw refusal();
  const month=await readMonth(db);
  if(typeof month.startsAt!=='string'||typeof month.endsAt!=='string')throw refusal();
  // Begin the monotonic budget before the global lock wait. Fresh setup never enforces it.
  const deadlineStarted=performance.now();

  // Serialize installations spanning more than one organization, after source locks and before financial rows.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('lares-budget-account-provisioning',0))");
  let installation=(await db.query(`SELECT * FROM budget_accounts WHERE kind='installation' ORDER BY id FOR UPDATE`)).rows;
  if(installation.length>1)throw refusal();
  let installationCreated=0;
  if(!installation.length){
    const installationId=id();
    const row=(await db.query(`INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,installation_cap,state,reason)
      VALUES($1,$2,'installation',$1,$3,'closed','unreconciled') RETURNING *`,[installationId,installationId,plan.installationCap])).rows[0];
    if(!row)throw refusal();installation=[row];installationCreated=1;noteBudgetFinancialChange(db,'budget_accounts',row.id);
  }
  const install=installation[0]!;
  if(!uuid(install.id)||install.installation_account_id!==install.id||!uuid(install.installation_id))throw refusal();
  const installationId=install.installation_id;
  const fresh=install.state==='closed'&&install.reason==='unreconciled'&&install.selected_endpoint===null&&install.recovery_epoch===null;
  const active=install.state==='open'&&install.reason==='approved';
  if(!fresh&&!active)throw refusal();
  if(active){
    const generation=BigInt(String(install.endpoint_generation));
    if(typeof install.selected_endpoint!=='string'||!/^[a-f0-9]{64}$/.test(install.selected_endpoint)||generation<=0n||generation>=10n**18n||
      typeof install.recovery_epoch!=='string'||install.recovery_epoch.length<1||install.recovery_epoch.length>200||canonicalMoney(install.installation_cap)!==plan.installationCap)throw refusal();
    setActiveDeadline(await conservativeMonthDeadline(db,month.endsAt,deadlineStarted));
  }
  if(fresh&&canonicalMoney(install.installation_cap)!==plan.installationCap){
    const row=(await db.query(`UPDATE budget_accounts SET installation_cap=$2 WHERE id=$1 AND state='closed' AND reason='unreconciled' RETURNING *`,[install.id,plan.installationCap])).rows[0];
    if(!row)throw refusal();Object.assign(install,row);noteBudgetFinancialChange(db,'budget_accounts',install.id);
  }
  const accounts=(await db.query(`SELECT * FROM budget_accounts WHERE installation_account_id=$1 ORDER BY id LIMIT 129 FOR UPDATE`,[install.id])).rows;
  if(accounts.length>128)throw refusal();
  if(accounts.some(row=>row.installation_id!==installationId))throw refusal();
  if(active){
    const installationWindows=(await db.query(`SELECT id,account_id,opening_cap::text AS opening_cap,
        to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_utc,
        to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_utc
      FROM budget_windows WHERE account_id=$1 AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz ORDER BY id LIMIT 2 FOR UPDATE`,[install.id,month.startsAt,month.endsAt])).rows;
    if(installationWindows.length!==1)throw refusal();
    const current=installationWindows[0]!;
    if(current.starts_utc!==month.startsAt||current.ends_utc!==month.endsAt||current.id!==install.active_window_id||canonicalMoney(current.opening_cap)!==plan.installationCap)throw refusal();
    retainSourceTransactionDeadline(db,month.endsAt);
  }
  let createdAccounts=installationCreated,createdWindows=0;
  for(const [canonicalHash,desired] of [...selectedCanonical].sort(([a],[b])=>a.localeCompare(b))){
    const exact=accounts.filter(row=>row.kind==='member'&&row.canonical_suppression_hash===canonicalHash);
    const liveForMember=accounts.filter(row=>row.kind==='member'&&row.live_member_id===desired.memberId);
    if(exact.length>1||liveForMember.length>1||exact.some(row=>row!==liveForMember[0])||liveForMember.some(row=>row.canonical_suppression_hash!==canonicalHash))throw refusal();
    for(const row of accounts){
      if(row.kind!=='member')continue;
      const existingProviders=Array.isArray(row.provider_suppression_hashes)?row.provider_suppression_hashes:[];
      if(row.canonical_suppression_hash===canonicalHash&&row.live_member_id!==desired.memberId)throw refusal();
      if(overlap(existingProviders,desired.providerHashes)&&(row.live_member_id!==desired.memberId||row.canonical_suppression_hash!==canonicalHash))throw refusal();
    }
    let memberAccount=exact[0];
    const newMemberAccount=!memberAccount;
    if(memberAccount){
      const currentProviders=Array.isArray(memberAccount.provider_suppression_hashes)?[...memberAccount.provider_suppression_hashes].sort():[];
      if(memberAccount.live_member_id!==desired.memberId||memberAccount.organisation_id!==desired.org||JSON.stringify(currentProviders)!==JSON.stringify(desired.providerHashes)||memberAccount.installation_account_id!==install.id||memberAccount.state!=='closed'||memberAccount.reason!=='unreconciled'||memberAccount.selected_endpoint!==null||memberAccount.recovery_epoch!==null)throw refusal();
    }else{
      if(active&&accounts.length>=128)throw refusal();
      const accountId=id();
      memberAccount=(await db.query(`INSERT INTO budget_accounts(id,installation_id,kind,installation_account_id,live_member_id,organisation_id,canonical_suppression_hash,provider_suppression_hashes,state,reason)
        VALUES($1,$2,'member',$3,$4,$5,$6,$7,'closed','unreconciled') RETURNING *`,[accountId,installationId,install.id,desired.memberId,desired.org,canonicalHash,desired.providerHashes])).rows[0];
      if(!memberAccount)throw refusal();accounts.push(memberAccount);createdAccounts++;noteBudgetFinancialChange(db,'budget_accounts',memberAccount.id);
    }
    const accountTargets=[{row:install,cap:plan.installationCap,liveMember:null as string|null},{row:memberAccount,cap:desired.memberCap,liveMember:desired.memberId}];
    for(const target of accountTargets){
      const current=(await db.query(`SELECT id,account_id,starts_at,ends_at,opening_cap::text AS opening_cap,
          to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_utc,
          to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ends_utc
        FROM budget_windows WHERE account_id=$1 AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz ORDER BY id LIMIT 2 FOR UPDATE`,[target.row.id,month.startsAt,month.endsAt])).rows;
      if(current.length>1)throw refusal();
      let window=current[0];
      if(window){
        if(active){
          if(window.starts_utc!==month.startsAt||window.ends_utc!==month.endsAt||target.row.active_window_id!==window.id||canonicalMoney(window.opening_cap)!==target.cap)throw refusal();
        }else{
          const exactBounds=(await db.query(`SELECT ($1::timestamptz=$2::timestamptz AND $3::timestamptz=$4::timestamptz) AS exact`,[window.starts_at,month.startsAt,window.ends_at,month.endsAt])).rows[0]?.exact;
          if(exactBounds!==true||target.row.active_window_id!==window.id)throw refusal();
        }
      }else{
        if(active&&(!newMemberAccount||target.row.kind!=='member'))throw refusal();
        const windowId=id();
        const generation=BigInt(String(target.row.policy_generation));
        if(generation<0n||generation>=10n**18n)throw refusal();
        window=(await db.query(`INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision)
          VALUES($1,$2,$3,$4::timestamptz,$5::timestamptz,0,$6,$7) RETURNING id`,[windowId,target.row.id,target.liveMember,month.startsAt,month.endsAt,target.cap,String(generation+1n)])).rows[0];
        if(!window)throw refusal();createdWindows++;noteBudgetFinancialChange(db,'budget_windows',window.id);
      }
      if(!uuid(window.id))throw refusal();
      if(target.row.active_window_id!==window.id){
        if(active&&target.row.kind!=='member')throw refusal();
        const updated=(await db.query(`UPDATE budget_accounts SET active_window_id=$2 WHERE id=$1 AND state='closed' AND reason='unreconciled' RETURNING *`,[target.row.id,window.id])).rows[0];
        if(!updated)throw refusal();Object.assign(target.row,updated);noteBudgetFinancialChange(db,'budget_accounts',target.row.id);
      }
    }
  }
  if(active)await checkConsoleSourceDeadlines(db);
  return {state:'closed',reason:'unreconciled',members:memberIds.length,accountsCreated:createdAccounts,windowsCreated:createdWindows};
}

/** The journal operation opens before consoleSourceTransaction checks out its one client. */
export async function provisionBudgetAccounts(pool:SourcePool,journal:HostFinancialJournal,rawPlan:unknown,readMonth:typeof databaseMonth=databaseMonth):Promise<{state:'closed';reason:'unreconciled';members:number;accountsCreated:number;windowsCreated:number}>{
  const plan=budgetAccountProvisionPlanSchema.parse(rawPlan);
  const writer=new JournalBudgetFinancialWriter(journal);
  let activeDeadline:number|undefined;
  const result=await writer.run('provision',boundary=>consoleSourceTransaction(pool,db=>provisionOwned(db,journal,plan,readMonth,deadline=>{activeDeadline=deadline;}),boundary));
  // This is deliberately outside the source transaction and journal writer: after the
  // terminal journal fsync, an expired closed result is withheld without inventing an abort.
  if(activeDeadline!==undefined&&performance.now()>=activeDeadline)throw new Error('Budget account provisioning outcome is unavailable');
  return result;
}
