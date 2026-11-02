/** Root-host account/window provisioning, where new state is always closed and unreconciled,
 * and the monthly opening that gives accounts already in use their next UTC month. */
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

export type BudgetMonthOpening={opened:number;skipped:number;blocked:number;failed:number};
const positiveCap=(value:unknown):string|null=>{
  try{const cap=canonicalMoney(value);return cap==='0'?null:cap;}catch{return null;}
};

/** Gives one account the month. Windows stay immutable and start at zero: an attempt keeps the
 * window it began in, and admission counts every unresolved attempt against the current one. */
async function openAccountMonth(db:SourceDatabase,account:Record<string,any>,cap:string,liveMember:string|null,month:UtcMonth):Promise<boolean>{
  const overlapping=(await db.query(`SELECT id,starts_at=$2::timestamptz AND ends_at=$3::timestamptz AS exact FROM budget_windows
    WHERE account_id=$1 AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz ORDER BY id LIMIT 2 FOR UPDATE`,[account.id,month.startsAt,month.endsAt])).rows;
  if(overlapping.length){
    if(overlapping.length===1&&overlapping[0]!.exact===true&&overlapping[0]!.id===account.active_window_id)return false;
    throw refusal();
  }
  // Refuses a database clock that moved back: only a month that has ended is ever replaced.
  const previous=(await db.query('SELECT ends_at<=$3::timestamptz AS ended FROM budget_windows WHERE id=$1 AND account_id=$2',[account.active_window_id,account.id,month.startsAt])).rows[0];
  if(previous?.ended!==true)throw refusal();
  const generation=BigInt(String(account.policy_generation));
  if(generation<0n||generation>=10n**18n)throw refusal();
  const windowId=id();
  await db.query(`INSERT INTO budget_windows(id,account_id,live_member_id,starts_at,ends_at,opening_liability,opening_cap,policy_revision)
    VALUES($1,$2,$3,$4::timestamptz,$5::timestamptz,0,$6,$7)`,[windowId,account.id,liveMember,month.startsAt,month.endsAt,cap,String(generation+1n)]);
  noteBudgetFinancialChange(db,'budget_windows',windowId);
  const updated=(await db.query('UPDATE budget_accounts SET active_window_id=$2 WHERE id=$1 AND state=$3 AND reason=$4 RETURNING id',[account.id,windowId,account.state,account.reason])).rows[0];
  if(!updated)throw refusal();
  noteBudgetFinancialChange(db,'budget_accounts',account.id);
  return true;
}

async function openInstallationMonth(db:SourceDatabase,installationId:string):Promise<boolean>{
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('lares-budget-account-provisioning',0))");
  const install=(await db.query(`SELECT * FROM budget_accounts WHERE id=$1 AND kind='installation' FOR UPDATE`,[installationId])).rows[0];
  if(install?.state!=='open'||install.reason!=='approved')throw refusal();
  const cap=positiveCap(install.installation_cap);if(!cap)throw refusal();
  return openAccountMonth(db,install,cap,null,await databaseMonth(db));
}

/** Same lock order as provisioning and admission: source and policy rows, then financial rows. */
async function openMemberMonth(db:SourceDatabase,installationId:string,accountId:string,memberId:string):Promise<boolean>{
  await gateConsoleOrganisation(db,memberId);requireConsoleSourceOwner(db);
  const user=(await db.query('SELECT org_id FROM users WHERE id=$1',[memberId])).rows[0];
  const policy=(await db.query('SELECT spend_cap_usd_month FROM org_member_policy WHERE user_id=$1 FOR SHARE',[memberId])).rows[0];
  const cap=positiveCap(policy?.spend_cap_usd_month);if(!cap)throw refusal();
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('lares-budget-account-provisioning',0))");
  const install=(await db.query(`SELECT * FROM budget_accounts WHERE id=$1 AND kind='installation' FOR UPDATE`,[installationId])).rows[0];
  if(install?.state!=='open'||install.reason!=='approved')throw refusal();
  const member=(await db.query(`SELECT * FROM budget_accounts WHERE id=$1 AND kind='member' AND installation_account_id=$2 FOR UPDATE`,[accountId,installationId])).rows[0];
  if(!member||member.live_member_id!==memberId||member.organisation_id!==user?.org_id||
    !(member.state==='open'&&member.reason==='approved'||member.state==='closed'&&member.reason==='unreconciled'))throw refusal();
  const month=await databaseMonth(db);
  const installationCurrent=(await db.query('SELECT 1 FROM budget_windows WHERE id=$1 AND starts_at=$2::timestamptz AND ends_at=$3::timestamptz',[install.active_window_id,month.startsAt,month.endsAt])).rows.length;
  if(!installationCurrent)throw refusal();
  return openAccountMonth(db,member,cap,memberId,month);
}

/** Opens the current UTC month for an open installation and its members, leaving frozen, retired
 * and erased accounts alone. A refused transaction spends journal records, so this read sets aside
 * whatever it can already see would be refused, without opening a journal operation. Finding
 * nothing to do writes nothing. A commit that crosses midnight is harmless: it leaves an ended
 * window that admission refuses and the next pass replaces. Runs as provisioning in the journal,
 * which an older Keeper can still read after a rollback. */
export async function openBudgetMonth(pool:SourcePool,journal:HostFinancialJournal,shouldStop:()=>boolean=()=>false):Promise<BudgetMonthOpening>{
  const result:BudgetMonthOpening={opened:0,skipped:0,blocked:0,failed:0};
  const month=await databaseMonth(pool as unknown as QueryDatabase);
  const accounts=(await pool.query(`SELECT a.id,a.kind,a.installation_account_id,a.live_member_id,u.status AS member_status,u.org_id IS NOT DISTINCT FROM a.organisation_id AS same_organisation,
      p.spend_cap_usd_month::text AS member_cap,(w.starts_at=$1::timestamptz AND w.ends_at=$2::timestamptz) AS current_month,w.ends_at<=$1::timestamptz AS ended,
      EXISTS(SELECT 1 FROM budget_windows o WHERE o.account_id=a.id AND o.starts_at<$2::timestamptz AND o.ends_at>$1::timestamptz) AS overlapping
    FROM budget_accounts a JOIN budget_accounts i ON i.id=a.installation_account_id
      LEFT JOIN budget_windows w ON w.id=a.active_window_id
      LEFT JOIN users u ON u.id=a.live_member_id
      LEFT JOIN org_member_policy p ON p.user_id=a.live_member_id
    WHERE i.kind='installation' AND i.state='open' AND i.reason='approved' AND (a.kind='installation' OR (a.live_member_id IS NOT NULL AND
      ((a.state='open' AND a.reason='approved') OR (a.state='closed' AND a.reason='unreconciled'))))
    ORDER BY a.kind,a.id LIMIT 129`,[month.startsAt,month.endsAt])).rows;
  const writer=new JournalBudgetFinancialWriter(journal);
  let installationCurrent=false,wrote=false;
  for(const account of accounts){
    if(account.current_month===true){if(account.kind==='installation')installationCurrent=true;continue;}
    if(account.overlapping===true||account.ended!==true){result.blocked++;continue;}
    if(account.kind==='member'&&(account.member_status!=='active'||!positiveCap(account.member_cap))){result.skipped++;continue;}
    if(account.kind==='member'&&(!installationCurrent||account.same_organisation!==true)){result.blocked++;continue;}
    if(shouldStop())break;
    // A gap between accounts lets a waiting grant or settlement take the journal.
    if(wrote)await new Promise(resolve=>setTimeout(resolve,20));
    wrote=true;
    try{
      const opened=await writer.run('provision',boundary=>consoleSourceTransaction(pool,db=>account.kind==='installation'
        ?openInstallationMonth(db,account.id):openMemberMonth(db,account.installation_account_id,account.id,account.live_member_id),boundary));
      if(opened)result.opened++;
      if(account.kind==='installation')installationCurrent=true;
    }catch{result.failed++;}
  }
  return result;
}

const MONTH_CHECK_MS=5*60_000,MONTH_RETRY_MIN_MS=1000,MONTH_RETRY_MAX_MS=60*60_000;
/** Keeps the month open while Keeper runs: a catch-up at start, then a pass right after each UTC
 * month ends. A failed account retries, slower each time, because a refusal spends journal records;
 * the wait never runs past the next month change. The checks in between only read. Log lines carry
 * counts, never identities. */
export function startBudgetMonthOpening(pool:SourcePool,journal:HostFinancialJournal,log:(line:string)=>void=console.warn):()=>Promise<void>{
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,running:Promise<void>=Promise.resolve(),retry=MONTH_RETRY_MIN_MS,reported='';
  const report=(line:string)=>{if(line&&line!==reported)log(line);reported=line;};
  const pass=async()=>{
    let delay=Math.min(retry,MONTH_CHECK_MS);
    try{
      const {endsAt}=await databaseMonth(pool as unknown as QueryDatabase);
      const result=await openBudgetMonth(pool,journal,()=>stopped);
      if(result.opened)log(`keeper: budget month opened for ${result.opened} accounts`);
      report(result.skipped||result.blocked||result.failed?`keeper: budget month not opened for every account: ${result.skipped} without a usable limit, ${result.blocked} blocked, ${result.failed} failed`:'');
      const row=(await pool.query(`SELECT floor(extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::text AS remaining_ms`,[endsAt])).rows[0];
      const remaining=Number(row?.remaining_ms),untilChange=Number.isFinite(remaining)?Math.max(remaining+50,100):MONTH_CHECK_MS;
      delay=Math.min(result.failed?retry:MONTH_CHECK_MS,untilChange);
      retry=result.failed?Math.min(retry*2,MONTH_RETRY_MAX_MS):MONTH_RETRY_MIN_MS;
    }catch{
      report('keeper: budget month check failed; retrying');
      retry=Math.min(retry*2,MONTH_RETRY_MAX_MS);
    }
    if(!stopped)timer=setTimeout(()=>{running=pass();},delay);
  };
  running=pass();
  return async()=>{stopped=true;if(timer)clearTimeout(timer);await running;};
}
