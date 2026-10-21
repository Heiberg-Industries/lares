/** MANUAL ONLY. Never run as part of tests/CI or without a technical user's explicit pilot.
 * Read-only provider probe for the neutral Google/Microsoft transport. A refresh may rotate
 * the local encrypted credential, without advancing account generation. No mail/event data,
 * identifiers, settings, errors, or token values are printed. Output is counts/booleans only.
 *
 * pnpm -C services/chief-of-staff exec tsx tests/live/personal-provider-reads.live.mts \
 *   --config /private/operator/probe.json --allow-provider-read
 *
 * The private JSON has context (trusted server-captured current console turn), mailboxSelection,
 * calendarSelection, window {from,until,limit<=100}; and optional microsoftFiles containing
 * tenantIdFile,clientIdFile,clientSecretFile,tokenKeyFile. These are existing provisioned server
 * files, never secrets in JSON. Optional proxyUrl must name the runtime's sealed egress proxy
 * when required. DATABASE_URL and existing personal Google metadata come from that runtime.
 * The context's original human and singleton audience must still pass current DB authority.
 * Microsoft configuration is operator-supplied for this probe: production mounting is deferred.
 * A successful Microsoft run confirms explicit unchanged refresh scope response, fixed issuer,
 * same-token /me.id+Member, plaintext message content and selected-calendar UTC response.
 * Missing/changed scopes fail closed; record only that fact for the first technical-user pilot.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ProxyAgent } from 'undici';
import { closePool } from '@lares/agent-kit/db';
import { readPersonalResource,type PersonalReadRuntime } from '../../lib/personal-reads.js';
import { readWindowSchema } from '../../lib/personal-read-contract.js';
const {values}=parseArgs({options:{config:{type:'string'},'allow-provider-read':{type:'boolean'}}});
if(!values.config||!values['allow-provider-read'])throw new Error('Explicit private probe config and read permission are required');
let dispatcher:ProxyAgent|undefined;
try{
  const input=JSON.parse(readFileSync(values.config,'utf8'));
  const window=readWindowSchema.parse(input.window);
  if(input.proxyUrl)dispatcher=new ProxyAgent(input.proxyUrl);
  const files=input.microsoftFiles;
  const secret=(path:string)=>readFileSync(path,'utf8').trim();
  const runtime:PersonalReadRuntime=files?{microsoft:()=>({settings:{tenantId:secret(files.tenantIdFile),clientId:secret(files.clientIdFile),clientSecret:secret(files.clientSecretFile),tokenKeyHex:secret(files.tokenKeyFile)},dispatcher})}:{};
  const list=await readPersonalResource(input.context,input.mailboxSelection,{kind:'mailWindow',window},runtime);
  if(list.kind!=='mailWindow'||!('items' in list))throw new Error('Unexpected operation');
  console.log(JSON.stringify({mailWindowAccepted:true,messageCount:list.items.length,truncated:list.truncated}));
  if(list.items[0]){
    const read=await readPersonalResource(input.context,input.mailboxSelection,{kind:'readMail',id:list.items[0].id},runtime);
    console.log(JSON.stringify({messageReadAccepted:read.kind==='readMail'&&'message' in read&&read.message!==null}));
  }
  const calendar=await readPersonalResource(input.context,input.calendarSelection,{kind:'calendarWindow',window},runtime);
  if(calendar.kind!=='calendarWindow'||!('items' in calendar))throw new Error('Unexpected operation');
  console.log(JSON.stringify({calendarWindowAccepted:true,eventCount:calendar.items.length,truncated:calendar.truncated}));
}catch{console.log(JSON.stringify({probeAccepted:false}));process.exitCode=1;}
finally{await closePool();await dispatcher?.close();}
