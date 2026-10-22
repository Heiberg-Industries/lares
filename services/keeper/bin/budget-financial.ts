/** Root host command only. It never enables the production gateway budget authority. */
import {createConnection} from 'node:net';
import {lstatSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {loadKeeperConfig,keeperPool} from '../lib/config.js';
import {HostFinancialJournal} from '../lib/financial-journal.js';
import {prepareFinancialCustody} from '../lib/financial-continuity.js';
import {JournalBudgetFinancialWriter} from '../lib/budget-financial-writer.js';
import {consoleSourceTransaction,type SourcePool} from '@lares/agent-kit/console-source-transaction';
import {BudgetNativeCustodyStore,NATIVE_CUSTODY_DIRECTORY} from '../lib/budget-native-custody.js';
import {openConfiguredNativeCustody} from '../lib/budget-native-cleanup.js';
import {budgetAccountProvisionPlanSchema} from '../lib/budget-account-provisioning.js';
const directory='/var/lib/lares/budget-financial';
function absent(path:string):boolean{try{lstatSync(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return true;throw e;}}
/** Only absent/dead listeners (ENOENT/ECONNREFUSED) permit a fallback owner.
 * An action refusal, EOF without ACK, timeout or malformed response stops restore. */
export function requestFinancialFreeze(socket:string,deadlineMs=4000):Promise<boolean>{
  if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>4000)throw new Error('Invalid freeze deadline');
  return new Promise((resolve,reject)=>{
    const client=createConnection(socket);let bytes=0,text='',settled=false;
    const finish=(error:Error|null,result=false)=>{if(settled)return;settled=true;clearTimeout(deadline);client.destroy();if(error)reject(error);else resolve(result);};
    // Absolute timer: a peer trickling bytes cannot extend this deadline.
    const deadline=setTimeout(()=>finish(new Error('Financial freeze timed out')),deadlineMs);
    const response=()=>{try{if(!text.endsWith('\n')||text.slice(0,-1).includes('\n'))throw new Error();const value=JSON.parse(text.slice(0,-1));if(value.ok!==true||value.result?.frozen!==true)throw new Error();finish(null,true);}catch{finish(new Error('Financial freeze was not acknowledged'));}};
    // Half-close the request only; server uses allowHalfOpen and returns its bounded ACK.
    client.once('connect',()=>client.end(JSON.stringify({action:'budget.freeze',input:{}})+'\n'));
    client.on('data',chunk=>{if(settled)return;bytes+=chunk.length;if(bytes>4096){finish(new Error('Invalid freeze response'));return;}text+=chunk.toString();});
    client.once('end',()=>{if(!settled)response();});
    client.once('close',()=>{if(!settled)finish(new Error('Financial freeze connection closed without acknowledgement'));});
    client.once('error',(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT'||e.code==='ECONNREFUSED')finish(null,false);else finish(new Error('Financial host socket unavailable'));});
  });
}
export async function requestFinancialProvision(socket:string,input:unknown,deadlineMs=4000):Promise<{state:'closed';reason:'unreconciled';members:number;accountsCreated:number;windowsCreated:number}>{
  if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>4000)throw new Error('Invalid provision deadline');
  const plan=budgetAccountProvisionPlanSchema.parse(input);
  return new Promise((resolve,reject)=>{
    const client=createConnection(socket);let bytes=0,text='',settled=false;
    const finish=(error:Error|null,result?:{state:'closed';reason:'unreconciled';members:number;accountsCreated:number;windowsCreated:number})=>{if(settled)return;settled=true;clearTimeout(deadline);client.destroy();if(error)reject(error);else if(result)resolve(result);else reject(new Error('Budget provisioning was not acknowledged'));};
    const deadline=setTimeout(()=>finish(new Error('Budget provisioning timed out')),deadlineMs);
    const response=()=>{try{
      if(!text.endsWith('\n')||text.slice(0,-1).includes('\n'))throw new Error();
      const value=JSON.parse(text.slice(0,-1));
      if(value.ok!==true||!value.result||value.result.state!=='closed'||value.result.reason!=='unreconciled'||![value.result.members,value.result.accountsCreated,value.result.windowsCreated].every((count:unknown)=>typeof count==='number'&&Number.isSafeInteger(count)&&count>=0)||value.result.members!==plan.memberIds.length)throw new Error();
      finish(null,value.result);
    }catch{finish(new Error('Budget provisioning was not acknowledged'));}};
    client.once('connect',()=>client.end(JSON.stringify({action:'budget.provision-accounts',input:plan})+'\n'));
    client.on('data',chunk=>{if(settled)return;bytes+=chunk.length;if(bytes>4096){finish(new Error('Invalid budget provisioning response'));return;}text+=chunk.toString();});
    client.once('end',()=>{if(!settled)response();});
    client.once('close',()=>{if(!settled)finish(new Error('Budget provisioning connection closed without acknowledgement'));});
    client.once('error',()=>{finish(new Error('Budget host socket unavailable'));});
  });
}
export async function requestNativeCleanup(socket:string,deadlineMs=20_000):Promise<{status:'complete'|'pending'|'blocked';remaining:number|null}>{
  if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>20_000)throw new Error('Invalid native cleanup deadline');
  return new Promise((resolve,reject)=>{
    const client=createConnection(socket);let bytes=0,text='',settled=false;
    const finish=(error:Error|null,result?:{status:'complete'|'pending'|'blocked';remaining:number|null})=>{if(settled)return;settled=true;clearTimeout(deadline);client.destroy();if(error)reject(error);else if(result)resolve(result);else reject(new Error('Native cleanup was not acknowledged'));};
    const deadline=setTimeout(()=>finish(new Error('Native cleanup timed out')),deadlineMs);
    const response=()=>{try{
      if(!text.endsWith('\n')||text.slice(0,-1).includes('\n'))throw new Error();
      const value=JSON.parse(text.slice(0,-1));const result=value?.result;
      if(value?.ok!==true||!result||!['complete','pending','blocked'].includes(result.status)||
        !(result.remaining===null||Number.isSafeInteger(result.remaining)&&result.remaining>=0)||
        result.status==='complete'&&result.remaining!==0||result.status==='pending'&&!(result.remaining>0))throw new Error();
      finish(null,result);
    }catch{finish(new Error('Native cleanup was not acknowledged'));}};
    client.once('connect',()=>client.end(JSON.stringify({action:'budget.cleanup-native',input:{}})+'\n'));
    client.on('data',chunk=>{if(settled)return;bytes+=chunk.length;if(bytes>4096){finish(new Error('Invalid native cleanup response'));return;}text+=chunk.toString();});
    client.once('end',()=>{if(!settled)response();});
    client.once('close',()=>{if(!settled)finish(new Error('Native cleanup connection closed without acknowledgement'));});
    client.once('error',()=>{finish(new Error('Native cleanup host socket unavailable'));});
  });
}
async function readPlan():Promise<unknown>{
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of process.stdin){const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=value.length;if(size>4096)throw new Error('Provision plan is too large');chunks.push(value);}
  if(size===0)throw new Error('Provision plan is required');
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Provision plan is invalid');}
}
export async function main(argv:string[]):Promise<void>{
  if(process.getuid?.()!==0)throw new Error('Financial host command requires root');
  const configPath=argv[2]??'/etc/lares/keeper.json';
  if(argv.length>3||!['prepare-fresh','prepare-native','freeze','cleanup-native','provision-accounts'].includes(argv[0]??''))throw new Error('usage: budget-financial prepare-fresh --confirm-fresh-installation [config] | prepare-native --confirm-fresh-native-custody [config] | freeze --host [config] | cleanup-native --host [config] | provision-accounts --host [config] < plan.json');
  const config=loadKeeperConfig(configPath);
  if(argv[0]==='prepare-fresh'){
    if(argv[1]!=='--confirm-fresh-installation')throw new Error('Explicit fresh-installation confirmation required');
    if(config.budgetFinancial)throw new Error('Existing financial binding requires recovery');
    openConfiguredNativeCustody(undefined);
    mkdirSync('/var/lib/lares',{recursive:true,mode:0o700});
    const pool=keeperPool({...config.db,...(process.env.PGHOST?{host:process.env.PGHOST}:{})},{max:1,query_timeout:5000,options:'-c lock_timeout=2000 -c statement_timeout=4000'}),db=await pool.connect();
    try{await prepareFinancialCustody(directory,db);}finally{db.release();await pool.end();}
    process.stdout.write('Fresh financial custody prepared. Set budgetFinancial.directory to /var/lib/lares/budget-financial in root-owned keeper.json, then restart keeper. Spending remains closed.\n');return;
  }
  if(argv[0]==='prepare-native'){
    if(argv[1]!=='--confirm-fresh-native-custody')throw new Error('Explicit fresh native custody confirmation required');
    if(config.budgetNative)throw new Error('Existing native custody binding requires recovery');
    if(!config.budgetFinancial)throw new Error('Prepared financial custody is required before native custody');
    openConfiguredNativeCustody(undefined);
    const journal=HostFinancialJournal.openExisting(config.budgetFinancial.directory,{requirePrepared:true});
    let pool:ReturnType<typeof keeperPool>|undefined;
    let created:BudgetNativeCustodyStore|undefined;
    try{
      pool=keeperPool(config.db,{max:1,query_timeout:5000,options:'-c lock_timeout=2000 -c statement_timeout=4000'});
      const writer=new JournalBudgetFinancialWriter(journal);
      await writer.runWithReceipt('prepare',(boundary)=>consoleSourceTransaction(pool as unknown as SourcePool,async db=>{
        await db.query('LOCK TABLE budget_gateway_bindings IN ACCESS EXCLUSIVE MODE');
        const history=await db.query('SELECT EXISTS(SELECT 1 FROM budget_gateway_bindings) AS present');
        if(history.rows[0]?.present!==false)throw new Error('Existing native bindings or redacted history require reconciliation');
        // Keep the table lock and journal owner through directory creation. If SQL cannot
        // acknowledge the matching checkpoint, the created store is retained for inspection;
        // a later invocation will refuse to adopt it.
        created=BudgetNativeCustodyStore.createNew(NATIVE_CUSTODY_DIRECTORY);
        return true;
      },boundary));
      const prepared=created;if(!prepared)throw new Error('Fresh native custody creation was not acknowledged');
      prepared.close();created=undefined;
      process.stdout.write('Fresh native custody prepared. Set budgetNative.directory to /var/lib/lares/budget-native in root-owned keeper.json, then restart keeper.\n');
    }finally{try{created?.close();}finally{try{journal.close();}finally{await pool?.end();}}}
    return;
  }
  if(argv[0]==='cleanup-native'){
    if(argv[1]!=='--host'||!config.budgetNative)throw new Error('Configured native custody and a root host action are required');
    const result=await requestNativeCleanup('/run/lares-host/keeper.sock');
    process.stdout.write(result.status==='complete'?'Native key cleanup complete.\n':result.status==='pending'
      ?`Native key cleanup pending; ${result.remaining} key(s) remain. Run this command once per key.\n`
      :`Native key cleanup blocked; ${result.remaining===null?'the remaining count is unknown':`${result.remaining} key(s) remain`}. Inspection is required.\n`);
    if(result.status!=='complete')process.exitCode=1;
    return;
  }
  if(argv[1]!=='--host')throw new Error('Root host action required');
  if(argv[0]==='provision-accounts'){
    if(!config.budgetFinancial)throw new Error('Financial custody is not configured');
    const result=await requestFinancialProvision('/run/lares-host/keeper.sock',await readPlan());
    process.stdout.write(JSON.stringify(result)+'\n');return;
  }
  if(!config.budgetFinancial){
    openConfiguredNativeCustody(undefined);
    if(!absent(directory))throw new Error('Unbound financial custody requires recovery');
    process.stdout.write('Financial custody is not configured (legacy inactive path).\n');return;
  }
  if(await requestFinancialFreeze('/run/lares-host/keeper.sock'))return;
  const native=openConfiguredNativeCustody(config.budgetNative?.directory);
  let journal:HostFinancialJournal|undefined;
  try{
    journal=HostFinancialJournal.openExisting(config.budgetFinancial.directory,{requirePrepared:true});
    await native?.drainForShutdown();await journal.freezeForRestore();native?.close();
  }finally{
    try{journal?.close();}finally{if(native){try{native.close();}catch{}}}
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(()=>{process.stderr.write('Financial custody action refused; recovery may be required.\n');process.exitCode=1;});
