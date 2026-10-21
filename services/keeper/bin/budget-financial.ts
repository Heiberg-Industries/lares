/** Root host command only. It never enables the production gateway budget authority. */
import {createConnection} from 'node:net';
import {lstatSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {loadKeeperConfig,keeperPool} from '../lib/config.js';
import {HostFinancialJournal} from '../lib/financial-journal.js';
import {prepareFinancialCustody} from '../lib/financial-continuity.js';
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
    const response=()=>{try{const value=JSON.parse(text);if(value.ok!==true||value.result?.frozen!==true)throw new Error();finish(null,true);}catch{finish(new Error('Financial freeze was not acknowledged'));}};
    // Half-close the request only; server uses allowHalfOpen and returns its bounded ACK.
    client.once('connect',()=>client.end(JSON.stringify({action:'budget.freeze',input:{}})+'\n'));
    client.on('data',chunk=>{if(settled)return;bytes+=chunk.length;if(bytes>4096){finish(new Error('Invalid freeze response'));return;}text+=chunk.toString();if(text.includes('\n'))response();});
    client.once('end',()=>{if(!settled)response();});
    client.once('close',()=>{if(!settled)finish(new Error('Financial freeze connection closed without acknowledgement'));});
    client.once('error',(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT'||e.code==='ECONNREFUSED')finish(null,false);else finish(new Error('Financial host socket unavailable'));});
  });
}
export async function main(argv:string[]):Promise<void>{
  if(process.getuid?.()!==0)throw new Error('Financial host command requires root');
  const configPath=argv[2]??'/etc/lares/keeper.json';
  if(argv.length>3||!['prepare-fresh','freeze'].includes(argv[0]??''))throw new Error('usage: budget-financial prepare-fresh --confirm-fresh-installation [config] | freeze --host [config]');
  const config=loadKeeperConfig(configPath);
  if(argv[0]==='prepare-fresh'){
    if(argv[1]!=='--confirm-fresh-installation')throw new Error('Explicit fresh-installation confirmation required');
    if(config.budgetFinancial)throw new Error('Existing financial binding requires recovery');
    mkdirSync('/var/lib/lares',{recursive:true,mode:0o700});
    const pool=keeperPool({...config.db,...(process.env.PGHOST?{host:process.env.PGHOST}:{})},{max:1,query_timeout:5000,options:'-c lock_timeout=2000 -c statement_timeout=4000'}),db=await pool.connect();
    try{await prepareFinancialCustody(directory,db);}finally{db.release();await pool.end();}
    process.stdout.write('Fresh financial custody prepared. Set budgetFinancial.directory to /var/lib/lares/budget-financial in root-owned keeper.json, then restart keeper. Spending remains closed.\n');return;
  }
  if(argv[1]!=='--host')throw new Error('Root host action required');
  if(!config.budgetFinancial){
    if(!absent(directory))throw new Error('Unbound financial custody requires recovery');
    process.stdout.write('Financial custody is not configured (legacy inactive path).\n');return;
  }
  if(await requestFinancialFreeze('/run/lares-host/keeper.sock'))return;
  const journal=HostFinancialJournal.openExisting(config.budgetFinancial.directory,{requirePrepared:true});
  try{await journal.freezeForRestore();}finally{journal.close();}
}
if(process.argv[1]===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(()=>{process.stderr.write('Financial custody action refused; recovery may be required.\n');process.exitCode=1;});
