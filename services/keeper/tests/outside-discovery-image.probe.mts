/* CI-only worker and local TLS peer for outside-discovery-image.probe.py. */
import {createHash,createHmac,randomUUID,createDecipheriv,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import https from 'node:https';
import tls from 'node:tls';
import {createConnection,isIP,type Socket} from 'node:net';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {definitionSchema,hashOf} from '../../../packages/agent-kit/src/definition.js';
import {PgGrantStore} from '../../../packages/agent-kit/src/grant-store.js';
import {AgentLifecycle} from '../lib/lifecycle.js';
import {OutsideRouteAcknowledgementError,ownedDocker} from '../lib/docker.js';
import {keeperOutsideCustodyPool,keeperPool,loadKeeperConfig} from '../lib/config.js';
import {loadBoundOutsideCustodyKey,OutsideCustodyRecoveryRequired,OutsideCustodyStore} from '../lib/outside-custody.js';
import {lockOutsideHumanSession} from '../lib/outside-custody.js';
import {withDefinitionNamespace} from '../lib/definition-namespace.js';
import {consoleSourceTransaction} from '../../../packages/agent-kit/src/console-source-transaction.js';
import {PgVaultStore} from '../../../packages/agent-kit/src/vault-area-store.js';
import {bindConsoleSession} from '../../../packages/agent-kit/src/console-turn-authority.js';
import {recordOutsideExecutionApproval,outsidePayloadHash} from '../../../packages/agent-kit/src/outside-execution-receipts.js';
import {vaultBrokerRequest,executeApprovedOutsideCall} from '../../../packages/agent-kit/src/vault-broker-client.js';
import {serveConsoleVaultBroker} from '../lib/vault-console-broker.js';
import type {DockerBoundary,OutsideRouteAcknowledgementFailure} from '../lib/docker.js';

const env=process.env;
function need(name:string):string{const value=env[name];if(!value)throw new Error('fixture input missing');return value;}
function writeReport(path:string,value:unknown):void{writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
function canonical(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object'){
    const record=value as Record<string,unknown>;
    return `{${Object.keys(record).sort((a,b)=>a.localeCompare(b)).map(key=>`${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value)??'null';
}
const pause=(milliseconds:number)=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds));
function assert(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message);}
type SafeOperationFailureCategory='request-refused'|'recovery-required'|'unknown';
function safeOperationFailureCategory(error:unknown):SafeOperationFailureCategory{
  if(error instanceof OutsideCustodyRecoveryRequired)return 'recovery-required';
  if(error instanceof Error&&error.message==='Outside credential change could not be confirmed')return 'request-refused';
  return 'unknown';
}
function safePeerDiagnostics():Record<string,boolean|number>|undefined{
  try{
    const value=JSON.parse(readFileSync(need('FIXTURE_PEER_REPORT'),'utf8')) as Partial<PeerState>;
    const methods=Array.isArray(value.methods)?value.methods.filter((method):method is string=>typeof method==='string'):[];
    return {requestCount:Number.isSafeInteger(value.requestCount)?value.requestCount!:0,
      initializeSeen:methods.includes('initialize'),initializedNotificationSeen:methods.includes('notifications/initialized'),
      toolsListCount:methods.filter(method=>method==='tools/list').length,bearerMatches:value.bearerMatches===true,
      tlsServernameMatches:value.tlsServername===true,pathMatches:value.pathMatches===true,
      protocolVersionMatches:value.protocolVersionMatches===true,initializeMatches:value.initializeMatches===true,
      paginationCursorMatches:value.paginationCursorMatches===true,sessionMatches:value.sessionMatches===true};
  }catch{return undefined;}
}
async function withRevisionTableLock<T>(pool:Pool,work:()=>Promise<T>):Promise<T>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('LOCK TABLE outside_custody_revisions IN ACCESS EXCLUSIVE MODE');
    return await work();
  }finally{
    try{await client.query('ROLLBACK');}finally{client.release();}
  }
}

export type RouteBoundaryFailure = 'runtime-stop'|'squid-validation'|'firewall-check'|'firewall-apply'|
  'proxy-reload'|'route-acknowledgement';
export function trackRouteBoundaryFailures<T extends DockerBoundary>(boundary:T):{
  docker:T; firstFailure():RouteBoundaryFailure|undefined;
  firstAcknowledgementReason():OutsideRouteAcknowledgementFailure|undefined;
}{
  let failure:RouteBoundaryFailure|undefined,acknowledgementReason:OutsideRouteAcknowledgementFailure|undefined;
  const labels:Partial<Record<keyof DockerBoundary,RouteBoundaryFailure>>={
    stop:'runtime-stop',validateSquid:'squid-validation',reloadSquid:'proxy-reload',
    acknowledgeOutsideStage:'route-acknowledgement',
  };
  const docker=new Proxy(boundary,{get(target,property){
    const method=Reflect.get(target,property,target) as unknown;
    const fixed=labels[property as keyof DockerBoundary];
    if(typeof method!=='function'||(!fixed&&property!=='firewall'))return method;
    return function(this:unknown,...args:unknown[]):unknown{
      const stage:RouteBoundaryFailure|undefined=property==='firewall'?
        (args[1]===true?'firewall-check':'firewall-apply'):fixed;
      if(!stage)return Reflect.apply(method,target,args);
      const recordFailure=(error:unknown)=>{
        if(failure!==undefined)return;
        failure=stage;
        if(stage==='route-acknowledgement'&&error instanceof OutsideRouteAcknowledgementError)
          acknowledgementReason=error.reason;
      };
      try{
        const result=Reflect.apply(method,target,args);
        if(result!==null&&typeof result==='object'&&typeof (result as {then?:unknown}).then==='function')
          return (result as Promise<unknown>).catch(error=>{recordFailure(error);throw error;});
        return result;
      }catch(error){recordFailure(error);throw error;}
    };
  }}) as T;
  return {docker,firstFailure:()=>failure,firstAcknowledgementReason:()=>acknowledgementReason};
}

type PeerState={ready:boolean;methods:string[];requestCount:number;bearerMatches:boolean;tlsServername:boolean;pathMatches:boolean;
  protocolVersionMatches:boolean;initializeMatches:boolean;paginationCursorMatches:boolean;sessionMatches:boolean;toolsCallCount:number;exactCallMatches:boolean};
function persistPeer(path:string,state:PeerState){writeReport(path,state);}
async function peer():Promise<void>{
  const path=need('FIXTURE_PEER_REPORT');
  const state:PeerState={ready:false,methods:[],requestCount:0,bearerMatches:true,tlsServername:true,pathMatches:true,
    protocolVersionMatches:true,initializeMatches:true,paginationCursorMatches:true,sessionMatches:true,toolsCallCount:0,exactCallMatches:true};
  let pageCount=0;
  const server=https.createServer({key:readFileSync('/fixture/certs/server.key'),cert:readFileSync('/fixture/certs/server.pem')},(request,response)=>{
    const chunks:Buffer[]=[];let size=0;
    request.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>32768){request.destroy();return;}chunks.push(chunk);});
    request.on('end',()=>{
      state.requestCount++;
      state.bearerMatches&&=[need('FIXTURE_BEARER'),need('FIXTURE_ROTATED_BEARER')].some(value=>request.headers.authorization===`Bearer ${value}`);
      state.pathMatches&&=request.url==='/mcp?fixture=outside-proof-v1';
      state.protocolVersionMatches&&=request.headers['mcp-protocol-version']==='2025-06-18';
      let body:Record<string,unknown>;
      try{body=JSON.parse(Buffer.concat(chunks,size).toString('utf8')) as Record<string,unknown>;}catch{response.writeHead(400).end();return;}
      const method=typeof body.method==='string'?body.method:'';
      state.sessionMatches&&=method==='initialize'?request.headers['mcp-session-id']===undefined:request.headers['mcp-session-id']==='fixture-session';
      if(method==='initialize')pageCount=0;
      state.methods.push(method);persistPeer(path,state);
      response.setHeader('mcp-session-id','fixture-session');
      if(method==='notifications/initialized'){
        response.writeHead(202,{'content-length':'0'});response.end();return;
      }
      const id=body.id;
      if(method==='initialize'&&typeof id==='number'){
        state.initializeMatches&&=(body.params as {protocolVersion?:unknown}|undefined)?.protocolVersion==='2025-06-18';
        response.writeHead(200,{'content-type':'application/json'});
        response.end(JSON.stringify({jsonrpc:'2.0',id,result:{protocolVersion:'2025-06-18',serverInfo:{name:'local-fixture',version:'1'}}}));return;
      }
      if(method==='tools/list'&&typeof id==='number'){
        const cursor=(body.params as {cursor?:unknown}|undefined)?.cursor;
        state.paginationCursorMatches&&=(++pageCount===1
          ?cursor===undefined:cursor==='fixture-page-2');
        persistPeer(path,state);
        const result=cursor===undefined?{tools:[{name:'lookup_alpha',description:'Neutral lookup A',inputSchema:{type:'object',properties:{}}}],nextCursor:'fixture-page-2'}:
          {tools:[{name:'lookup_beta',description:'Neutral lookup B',inputSchema:{type:'object',properties:{}}}]};
        const rpc={jsonrpc:'2.0',id,result};
        response.writeHead(200,{'content-type':cursor===undefined?'application/json':'text/event-stream'});
        response.end(cursor===undefined?JSON.stringify(rpc):`event: message\ndata: ${JSON.stringify(rpc)}\n\n`);return;
      }
      if(method==='tools/call'&&typeof id==='number'){
        const params=body.params as {name?:unknown;arguments?:unknown}|undefined;
        const expectedBearer=state.toolsCallCount<3?need('FIXTURE_BEARER'):need('FIXTURE_ROTATED_BEARER');
        state.toolsCallCount++;state.exactCallMatches&&=request.headers.authorization===`Bearer ${expectedBearer}`&&params?.name==='lookup_alpha'&&canonical(params.arguments)==='{"fixture":"outside-execution-v1"}';
        persistPeer(path,state);response.writeHead(200,{'content-type':'application/json'});
        response.end(JSON.stringify({jsonrpc:'2.0',id,result:{content:[{type:'text',text:'fixture-approved'}]}}));return;
      }
      response.writeHead(400).end();
    });
  });
  server.on('secureConnection',(socket)=>{state.tlsServername&&=socket.servername==='mcp.example.org';persistPeer(path,state);});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(443,'0.0.0.0',()=>resolve());});
  state.ready=true;persistPeer(path,state);
  await new Promise<void>((resolve,reject)=>{server.once('close',resolve);server.once('error',reject);});
}
async function controlPeer():Promise<void>{
  const path=need('FIXTURE_PEER_REPORT'),address=need('FIXTURE_ROUTED_TARGET_IP');
  const state={ready:false};
  const server=https.createServer({key:readFileSync('/fixture/certs/server.key'),cert:readFileSync('/fixture/certs/server.pem')},(_request,response)=>{
    response.writeHead(204,{'content-length':'0'});response.end();
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(443,address,()=>resolve());});
  state.ready=true;writeReport(path,state);
  await new Promise<void>((resolve,reject)=>{server.once('close',resolve);server.once('error',reject);});
}

type DirectErrorCategory='none'|'dns-failure'|'connection-refused'|'network-unreachable'|'connection-reset'|
  'socket-timeout'|'deadline-triggered'|'tls-error'|'request-error'|'socket-close-timeout';
type CounterFailureCategory='none'|'command-timeout'|'command-not-found'|'permission-denied'|
  'command-failed'|'counter-missing'|'counter-invalid'|'projection-mismatch'|'stage-unavailable';
type ProjectionDiagnostic={family:'inet'|'bridge';reason:'generated-table-unrecognized'|'live-table-unrecognized'|
  'hook-mismatch'|'rule-mismatch'|'rule-count-mismatch'|'counter-missing';generatedHash:string;liveHash:string;
  mismatchIndex?:number;generatedLine?:string;liveLine?:string};
type CounterEvidence={packets?:number;failure:CounterFailureCategory;exactPackets?:bigint;projectionHash?:string;
  diagnostic?:ProjectionDiagnostic};
type CounterReport={packets?:number;failure:CounterFailureCategory;projectionHash?:string;diagnostic?:ProjectionDiagnostic};
type FirewallCounters={inet:CounterEvidence;bridge:CounterEvidence};
type FirewallCounterReports={inet:CounterReport;bridge:CounterReport};
type DirectPathPredicateDiagnostics={
  controlTlsComplete:boolean;controlSocketClosed:boolean;controlLookupMatchesTarget:boolean;controlSourceMatchesConfigured:boolean;
  controlPeerMatchesTarget:boolean;directLookupMatchesTarget:boolean;directSourceMatchesConfiguredOrMissing:boolean;
  directPeerMatchesTargetOrMissing:boolean;directTlsDidNotComplete:boolean;directSocketClosed:boolean;
  beforeCountersAvailable:boolean;afterCountersAvailable:boolean;requiredFamilyIncreased:boolean;otherFamilyDidNotIncrease:boolean;
  exactRequiredCounterComparisonMatches:boolean;exactOtherCounterComparisonMatches:boolean;blocked:boolean;
};
function counterReport(value:CounterEvidence):CounterReport{
  return value.failure==='none'?{packets:value.packets,failure:value.failure,projectionHash:value.projectionHash}:
    {failure:value.failure,...(value.diagnostic?{diagnostic:value.diagnostic}:{})};
}
function counterReports(value:FirewallCounters):FirewallCounterReports{
  return {inet:counterReport(value.inet),bridge:counterReport(value.bridge)};
}
function directErrorCategory(error:unknown):DirectErrorCategory{
  const code=error&&typeof error==='object'&&'code' in error?String((error as {code?:unknown}).code):'';
  if(code==='ENOTFOUND'||code==='EAI_AGAIN')return 'dns-failure';
  if(code==='ECONNREFUSED')return 'connection-refused';
  if(code==='ENETUNREACH'||code==='EHOSTUNREACH')return 'network-unreachable';
  if(code==='ECONNRESET')return 'connection-reset';
  if(code==='ETIMEDOUT')return 'socket-timeout';
  if(code.startsWith('ERR_TLS_')||code.startsWith('CERT_'))return 'tls-error';
  return 'request-error';
}

type SocketObservation={tlsCompleted:boolean;socketClosed:boolean;errorCategory:DirectErrorCategory;
  lookupAddress:string|null;assignedSourceAddress:string|null;connectedPeerAddress:string|null};
function socketAddresses(socket:Socket|undefined):{assignedSourceAddress:string|null;connectedPeerAddress:string|null}{
  return {assignedSourceAddress:typeof socket?.localAddress==='string'?socket.localAddress:null,
    connectedPeerAddress:typeof socket?.remoteAddress==='string'?socket.remoteAddress:null};
}
async function directTargetEvidence(host:string,path:string,targetAddress:string,sourceAddress:string,port=443):Promise<SocketObservation>{
  return await new Promise(resolve=>{
    let tlsCompleted=false,socketClosed=false,requestClosed=false,socket:Socket|undefined,settled=false,deadlineTriggered=false,
      errorCategory:DirectErrorCategory='none',lookupAddress:string|null=null,assignedSourceAddress:string|null=null,
      connectedPeerAddress:string|null=null;
    const observe=()=>{const current=socketAddresses(socket);assignedSourceAddress??=current.assignedSourceAddress;
      connectedPeerAddress??=current.connectedPeerAddress;};
    let closeTimeout:ReturnType<typeof setTimeout>|undefined,requestTimer:ReturnType<typeof setTimeout>|undefined;
    const finish=()=>{
      if(settled||!requestClosed)return;
      if(requestTimer)clearTimeout(requestTimer);
      if(socket&&!socketClosed){
        if(!closeTimeout)closeTimeout=setTimeout(()=>{settled=true;resolve({tlsCompleted,socketClosed:false,
          errorCategory:errorCategory==='none'?'socket-close-timeout':errorCategory,lookupAddress,assignedSourceAddress,connectedPeerAddress});},1500);
        return;
      }
      observe();settled=true;if(closeTimeout)clearTimeout(closeTimeout);resolve({tlsCompleted,socketClosed:true,errorCategory,lookupAddress,assignedSourceAddress,connectedPeerAddress});
    };
    const request=https.get({hostname:host,servername:'mcp.example.org',port,path,agent:false,rejectUnauthorized:true,
      localAddress:sourceAddress,lookup:(_hostname,options,callback)=>{
        lookupAddress=targetAddress;
        if(typeof options==='object'&&options.all)callback(null,[{address:targetAddress,family:4}]);
        else callback(null,targetAddress,4);
      }},response=>{
      tlsCompleted=true;response.destroy();request.destroy();
    });
    request.once('socket',value=>{
      socket=value;
      observe();
      value.once('connect',observe);
      value.once('secureConnect',()=>{tlsCompleted=true;});
      value.once('close',()=>{observe();socketClosed=true;finish();});
    });
    request.once('error',(error:NodeJS.ErrnoException)=>{observe();if(!deadlineTriggered)errorCategory=directErrorCategory(error);});
    request.once('close',()=>{requestClosed=true;finish();});
    requestTimer=setTimeout(()=>{deadlineTriggered=true;errorCategory='deadline-triggered';request.destroy();},1200);
  });
}
async function tlsControlEvidence(host:string,targetAddress:string,sourceAddress:string,port=443):Promise<SocketObservation>{
  return await new Promise(resolve=>{
    let tlsCompleted=false,socketClosed=false,settled=false,deadlineTriggered=false,socket:tls.TLSSocket|undefined,
      errorCategory:DirectErrorCategory='none',lookupAddress:string|null=null,assignedSourceAddress:string|null=null,
      connectedPeerAddress:string|null=null;
    const observe=()=>{const current=socketAddresses(socket);assignedSourceAddress??=current.assignedSourceAddress;
      connectedPeerAddress??=current.connectedPeerAddress;};
    let closeTimeout:ReturnType<typeof setTimeout>|undefined,requestTimer:ReturnType<typeof setTimeout>|undefined;
    const finish=(socketClosedNow:boolean)=>{
      socketClosed||=socketClosedNow;
      if(settled)return;
      if(requestTimer)clearTimeout(requestTimer);
      if(socket&&!socketClosed){
        if(!closeTimeout)closeTimeout=setTimeout(()=>{settled=true;resolve({tlsCompleted,socketClosed:false,
          errorCategory:errorCategory==='none'?'socket-close-timeout':errorCategory,lookupAddress,assignedSourceAddress,connectedPeerAddress});},1500);
        return;
      }
      observe();settled=true;if(closeTimeout)clearTimeout(closeTimeout);resolve({tlsCompleted,socketClosed:true,errorCategory,lookupAddress,assignedSourceAddress,connectedPeerAddress});
    };
    const transport=createConnection({host,port,localAddress:sourceAddress,
      lookup:(_hostname,options,callback)=>{
        lookupAddress=targetAddress;
        if(typeof options==='object'&&options.all)callback(null,[{address:targetAddress,family:4}]);
        else callback(null,targetAddress,4);
      }});
    transport.once('connect',observe);
    socket=tls.connect({socket:transport,servername:'mcp.example.org',rejectUnauthorized:true});
    observe();
    socket.once('connect',observe);
    socket.once('secureConnect',()=>{observe();tlsCompleted=true;socket!.destroy();});
    socket.once('error',(error:NodeJS.ErrnoException)=>{observe();if(!deadlineTriggered)errorCategory=directErrorCategory(error);});
    socket.once('close',()=>{observe();finish(true);});
    requestTimer=setTimeout(()=>{deadlineTriggered=true;errorCategory='deadline-triggered';socket!.destroy();},1200);
  });
}

function firewallTableProjection(text:string,family:'inet'|'bridge',normalizeBridgePayload:boolean):
  {hook:string;rules:string[];packets?:bigint}|undefined{
  const lines=text.split(/\r?\n/),tableLine=`table ${family} lares_egress {`,starts=lines
    .map((line,index)=>line.trim()===tableLine?index:-1).filter(index=>index>=0);
  if(starts.length!==1)return undefined;
  const tableStart=starts[0]!;let depth=1,chainStart=-1,chainEnd=-1,tableEnd=-1,chainCount=0;
  for(let index=tableStart+1;index<lines.length;index++){
    const line=lines[index]!.trim();
    if(line==='chain forward {'&&depth===1){chainCount++;chainStart=index;}
    depth+=(line.match(/{/g)?.length??0)-(line.match(/}/g)?.length??0);
    if(chainStart>=0&&chainEnd<0&&depth===1)chainEnd=index;
    if(depth===0){tableEnd=index;break;}
    if(depth<0)return undefined;
  }
  if(tableEnd<0||chainCount!==1||chainStart<0||chainEnd<=chainStart||
      lines.slice(tableStart+1,chainStart).some(line=>line.trim())||
      lines.slice(chainEnd+1,tableEnd).some(line=>line.trim()))return undefined;
  const body=lines.slice(chainStart+1,chainEnd).map(line=>line.trim()).filter(Boolean);
  if(body.length<2)return undefined;
  const hook=canonicalFirewallHook(body[0]!,family),rules:string[]=[];
  if(!hook)return undefined;
  let packets:bigint|undefined;
  for(const raw of body.slice(1)){
    const line=raw.replace(/\s+#\s*handle\s+\d+$/,'').replace(/\s+/g,' ');
    const counter=line.match(/^counter packets (\d+) bytes \d+ drop$/);
    if(counter){
      if(packets!==undefined)return undefined;
      try{packets=BigInt(counter[1]!);}catch{return undefined;}
      rules.push('counter drop');
    }else{
      const normalized=canonicalFirewallRule(line,family,normalizeBridgePayload);
      if(!normalized)return undefined;
      rules.push(normalized);
    }
  }
  return {hook,rules,...(packets===undefined?{}:{packets})};
}
function canonicalFirewallHook(raw:string,family:'inet'|'bridge'):string|undefined{
  const match=raw.trim().replace(/\s+/g,' ').match(/^type (filter) hook (forward) priority (.+); policy (accept);$/);
  if(!match)return undefined;
  const priorities=family==='inet'?new Set(['-10','filter - 10']):new Set(['0','filter']);
  return priorities.has(match[3]!)?`type filter hook forward priority ${family==='inet'?-10:0}; policy accept;`:undefined;
}
function canonicalIPv4Prefix(value:string):string|undefined{
  const [address,prefix,...extra]=value.split('/');
  if(!address||extra.length||isIP(address)!==4)return undefined;
  if(prefix===undefined)return address;
  if(!/^\d{1,2}$/.test(prefix)||Number(prefix)>32)return undefined;
  return Number(prefix)===32?address:`${address}/${Number(prefix)}`;
}
function canonicalFirewallRule(raw:string,family:'inet'|'bridge',normalizeBridgePayload:boolean):string|undefined{
  const line=raw.trim().replace(/\s+/g,' ');
  const source=line.match(/^(ether type ip )?ip saddr != \{ (.+) \} accept$/);
  if(source){
    if(source[1]&&family!=='bridge')return undefined;
    const members=source[2]!.split(', ').map(canonicalIPv4Prefix);
    if(members.some(member=>!member)||new Set(members).size!==members.length)return undefined;
    const sortedMembers=(members as string[]).sort();
    // In bridge tables, `ip saddr` carries the IPv4 payload dependency. The
    // pinned nft listing omits the equivalent explicit EtherType guard.
    const prefix=normalizeBridgePayload&&family==='bridge'?'':source[1]??'';
    return `${prefix}ip saddr != { ${sortedMembers.join(', ')} } accept`;
  }
  const state=line.match(/^ct state (.+) accept$/);
  if(state){
    const members=state[1]!.split(',').sort();
    return members.length===2&&members[0]==='established'&&members[1]==='related'?
      'ct state established,related accept':undefined;
  }
  const destination=line.match(/^ip daddr (.+) accept$/);
  if(destination){
    const rawMembers=destination[1]!.startsWith('{ ')?destination[1]!.replace(/^\{ | \}$/g,'').split(', '):[destination[1]!];
    const members=rawMembers.map(canonicalIPv4Prefix);
    if(members.some(member=>!member)||new Set(members).size!==members.length)return undefined;
    const sortedMembers=(members as string[]).sort();
    return sortedMembers.length===1?`ip daddr ${sortedMembers[0]} accept`:
      `ip daddr { ${sortedMembers.join(', ')} } accept`;
  }
  return line;
}
function validGeneratedFirewallProjection(family:'inet'|'bridge',rules:readonly string[]):boolean{
  let index=0;
  if(family==='bridge'){
    if(rules[index++]!=='ether type != ip accept')return false;
    if(!/^ether type ip ip saddr != \{ [0-9./, ]+ \} accept$/.test(rules[index++]??''))return false;
  }else if(!/^ip saddr != \{ [0-9./, ]+ \} accept$/.test(rules[index++]??''))return false;
  if(rules[index++]!=='ct state established,related accept')return false;
  while(/^ip daddr .+ accept$/.test(rules[index]??''))index++;
  return rules[index++]==='udp dport 53 accept'&&rules[index++]==='tcp dport 53 accept'&&
    rules[index]==='counter drop'&&index===rules.length-1;
}
export function firewallProjection(stageText:string,liveText:string,family:'inet'|'bridge'):
  {hash:string;packets:bigint}|undefined{
  const generated=firewallTableProjection(stageText,family,false),
    normalizedGenerated=firewallTableProjection(stageText,family,true),live=firewallTableProjection(liveText,family,true);
  const hook=family==='inet'?'type filter hook forward priority -10; policy accept;':
    'type filter hook forward priority 0; policy accept;';
  if(!generated||!normalizedGenerated||!live||generated.hook!==hook||live.hook!==hook||
      !validGeneratedFirewallProjection(family,generated.rules)||
      JSON.stringify(normalizedGenerated.rules)!==JSON.stringify(live.rules)||live.packets===undefined)return undefined;
  const hash=createHash('sha256').update(JSON.stringify({family,hook,rules:normalizedGenerated.rules})).digest('hex');
  return {hash,packets:live.packets};
}
function firewallProjectionDiagnostic(stageText:string,liveText:string,family:'inet'|'bridge'):ProjectionDiagnostic{
  const generated=firewallTableProjection(stageText,family,false),live=firewallTableProjection(liveText,family,true);
  const rawTable=(text:string):string|undefined=>{
    if(Buffer.byteLength(text,'utf8')>128*1024)return undefined;
    const lines=text.split(/\r?\n/),start=lines.findIndex(line=>line.trim()===`table ${family} lares_egress {`);
    if(start<0)return undefined;
    let depth=1,end=-1;
    for(let index=start+1;index<lines.length;index++){
      const line=lines[index]!.trim();depth+=(line.match(/{/g)?.length??0)-(line.match(/}/g)?.length??0);
      if(depth===0){end=index;break;}if(depth<0)return undefined;
    }
    return end<0?undefined:lines.slice(start,end+1).join('\n');
  };
  const rawBody=(text:string):string[]=>{
    if(Buffer.byteLength(text,'utf8')>128*1024)return [];
    const lines=text.split(/\r?\n/),start=lines.findIndex(line=>line.trim()===`table ${family} lares_egress {`);
    if(start<0)return [];
    let depth=1,chain=-1,end=-1;
    for(let index=start+1;index<lines.length;index++){
      const line=lines[index]!.trim();
      if(line==='chain forward {'&&depth===1)chain=index;
      depth+=(line.match(/{/g)?.length??0)-(line.match(/}/g)?.length??0);
      if(depth===1&&chain>=0){end=index;break;}
      if(depth===0)break;
    }
    if(chain<0||end<=chain)return [];
    return lines.slice(chain+1,end).map(line=>line.trim()).filter(Boolean).slice(0,64);
  };
  const safeLine=(line:string|undefined):string|undefined=>line!==undefined&&line.length<=512&&
    /^[\x20-\x7e]*$/.test(line)&&[
      /^type filter hook forward priority [-0-9A-Za-z ]+; policy accept;$/,
      /^(?:ether type ip )?ip saddr != \{ [0-9./, ]+ \} accept$/,
      /^ether type != ip accept$/,
      /^ct state (?:established,related|related,established) accept$/,
      /^ip daddr (?:\{ [0-9./, ]+ \}|[0-9./]+) accept$/,
      /^(?:udp|tcp) dport 53 accept$/,
      /^counter drop$/,
      /^counter packets [0-9]+ bytes [0-9]+ drop$/,
    ].some(pattern=>pattern.test(line))?line:undefined;
  const generatedBody=rawBody(stageText),liveBody=rawBody(liveText);
  const diagnostic:ProjectionDiagnostic={family,reason:'generated-table-unrecognized',
    generatedHash:createHash('sha256').update(rawTable(stageText)??`missing:${family}`).digest('hex'),
    liveHash:createHash('sha256').update(rawTable(liveText)??`missing:${family}`).digest('hex')};
  if(generated&&live){
    if(generated.hook!==live.hook){diagnostic.reason='hook-mismatch';diagnostic.mismatchIndex=0;
      diagnostic.generatedLine=safeLine(generatedBody[0]);diagnostic.liveLine=safeLine(liveBody[0]);}
    else{
      const mismatch=generated.rules.findIndex((rule,index)=>rule!==live.rules[index]);
      if(mismatch>=0){diagnostic.reason='rule-mismatch';diagnostic.mismatchIndex=mismatch;
        diagnostic.generatedLine=safeLine(generatedBody[mismatch+1]);diagnostic.liveLine=safeLine(liveBody[mismatch+1]);}
      else if(generated.rules.length!==live.rules.length){diagnostic.reason='rule-count-mismatch';
        diagnostic.mismatchIndex=Math.min(generated.rules.length,live.rules.length);
        diagnostic.generatedLine=safeLine(generatedBody[diagnostic.mismatchIndex+1]);
        diagnostic.liveLine=safeLine(liveBody[diagnostic.mismatchIndex+1]);}
      else{diagnostic.reason='counter-missing';}
    }
  }else if(generated){
    diagnostic.reason='live-table-unrecognized';
    diagnostic.mismatchIndex=0;diagnostic.generatedLine=safeLine(generatedBody[0]);diagnostic.liveLine=safeLine(liveBody[0]);
  }else{
    diagnostic.reason='generated-table-unrecognized';
    diagnostic.mismatchIndex=0;diagnostic.generatedLine=safeLine(generatedBody[0]);diagnostic.liveLine=safeLine(liveBody[0]);
  }
  return diagnostic;
}
async function firewallDropPackets(family:'inet'|'bridge'):Promise<CounterEvidence>{
  const owner=need('FIXTURE_OWNER'),name='lares-outside-counter-'+owner.slice(0,10)+'-'+randomUUID().slice(0,6);
  let output:string,stageText:string;
  try{
    const root=need('FIXTURE_ROOT'),stage=readFileSync(`${root}/egress/installed-stage`,'ascii').trim();
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(stage))return {failure:'stage-unavailable'};
    stageText=readFileSync(`${root}/egress/${stage}.nft`,'ascii');
  }catch{return {failure:'stage-unavailable'};}
  try{
    output=execFileSync('docker',['run','--rm','--name',name,'--label','lares.proof.owner='+owner,
      '--network','host','--read-only','--cap-drop','ALL',
      '--cap-add','NET_ADMIN','--security-opt','no-new-privileges:true','--entrypoint','nft',need('FIXTURE_FIREWALL_IMAGE'),
      'list','table',family,'lares_egress'],{encoding:'utf8',timeout:30000,maxBuffer:128*1024,stdio:['ignore','pipe','ignore']});
  }catch(error){
    const code=error&&typeof error==='object'&&'code' in error?(error as {code?:unknown}).code:undefined;
    return {failure:code==='ETIMEDOUT'?'command-timeout':code==='ENOENT'?'command-not-found':
      code==='EACCES'||code==='EPERM'?'permission-denied':'command-failed'};
  }
  const projection=firewallProjection(stageText,output,family);
  if(!projection)return {failure:'projection-mismatch',diagnostic:firewallProjectionDiagnostic(stageText,output,family)};
  const exactPackets=projection.packets;
  if(exactPackets<0n)return {failure:'counter-invalid'};
  return {packets:Number(exactPackets>1_000_000_000_000n?1_000_000_000_000n:exactPackets),
    exactPackets,failure:'none',projectionHash:projection.hash};
}

async function firewallCounters():Promise<FirewallCounters>{
  const [inet,bridge]=await Promise.all([firewallDropPackets('inet'),firewallDropPackets('bridge')]);
  return {inet,bridge};
}
function familyCounterIncreased(before:CounterEvidence,after:CounterEvidence):boolean{
  return before.failure==='none'&&after.failure==='none'&&after.exactPackets!>before.exactPackets!;
}
function exactCounterIncreaseMatches(before:CounterEvidence,after:CounterEvidence,reported:boolean):boolean{
  return before.failure==='none'&&after.failure==='none'&&before.exactPackets!==undefined&&after.exactPackets!==undefined&&
    (after.exactPackets>before.exactPackets)===reported;
}

// Packaged fixture only. Admission, receipts, custody, route leases and protocol dispatch are
// the production implementations; the peer and generated members/metadata are disposable.
const EXECUTION_REFUSALS=['member','session','agent','tool','payload','connection','credential-version','runtime-incarnation',
 'expired','revoked','replay','cross-member-custody','permission-revoked','rotation','removal'] as const;
type ExecutionProof={complete:boolean;positiveCalls:number;peerRequests:number;peerToolCalls:number;failedApplyPreserved:boolean;
 rotationRejected:boolean;removalRejected:boolean;refusals:string[]};
async function proveSignedExecution(c:{main:Pool;outside:Pool;proof:Pool;store:OutsideCustodyStore;root:string;secretsDir:string;
 agent:string;incarnation:string;owner:string;editor:string;org:string;sessionToken:string;definition:ReturnType<typeof definitionSchema.parse>;
 definitionHash:string;accountId:string;activeRevision:number;generation:number;routePolicyHash:string;phase:(name:string)=>void;evidence:(value:ExecutionProof)=>void}):Promise<ExecutionProof>{
 const {main,outside,proof,store,root,agent,incarnation,owner,editor,org}=c;
 const secretFree=(value:unknown)=>{const encoded=canonical(value);assert(![need('FIXTURE_BEARER'),need('FIXTURE_ROTATED_BEARER')].some(secret=>encoded.includes(secret)),
  'credential reached a non-custody projection')};
 assert(need('FIXTURE_BEARER')!==need('FIXTURE_ROTATED_BEARER'),'replacement token did not change');
 const result:ExecutionProof={complete:false,positiveCalls:0,peerRequests:0,peerToolCalls:0,failedApplyPreserved:false,
  rotationRejected:false,removalRejected:false,refusals:[]};
 c.evidence(result);
 const peer=()=>JSON.parse(readFileSync(need('FIXTURE_PEER_REPORT'),'utf8')) as PeerState;
 const initialPeer=peer();
 const secretsDir=resolve(root,'execution-broker-secrets');mkdirSync(secretsDir,{mode:0o700});
 const signingKey=randomBytes(32).toString('hex'),runtimeKey=randomBytes(32).toString('hex');
 const signerPath=resolve(secretsDir,'console-key'),runtimePath=resolve(secretsDir,agent+'-runtime-control');
 writeFileSync(signerPath,signingKey,{mode:0o600});writeFileSync(runtimePath,runtimeKey,{mode:0o600});
 // The current runtime ownership/incarnation was established by the fixture above. This
 // generated per-runtime signing key has the same custody layout the real broker reads.
 process.env.LARES_AGENT_NAME=agent;process.env.LARES_AGENT_INCARNATION=incarnation;
 process.env.LARES_RUNTIME_CONTROL_SECRET_FILE=runtimePath;
 process.env.LARES_VAULT_RUNTIME_SOCKET=resolve(root,'execution-broker','runtime.sock');
 const consoleSocket=resolve(root,'execution-console.sock');
 const vault=new PgVaultStore(main),backingId=randomUUID(),areaId=randomUUID();
 await vault.provisionBacking(owner,{id:backingId,kind:'git'},{designatedOwnerMemberId:owner});
 const area=await vault.provisionArea(owner,{id:areaId,kind:'shared',owner:{kind:'organisation',id:org},backingStoreId:backingId,
  relativePath:`vault/shared/${areaId}`},{designatedOwnerMemberId:owner});
 await vault.configureAccess(owner,{areaId,expectedRevision:area.accessRevision,
  grants:[{principal:{kind:'organisation',id:org},permission:'use',expiresAt:null}]},{designatedOwnerMemberId:owner});
 const inventoryPath='/srv/lares/installation/vault-storage.json';
 assert(!existsSync(inventoryPath),'disposable worker unexpectedly contains a storage inventory');
 mkdirSync('/srv/lares/installation',{recursive:true,mode:0o755});
 writeFileSync(inventoryPath,JSON.stringify({version:1,planId:randomUUID(),organisationId:org,provisionerMemberId:owner,
  backing:{id:backingId,kind:'git',root:'/srv'},areas:[{areaId,kind:'shared',owner:{kind:'organisation',id:org},
   relativePath:`vault/shared/${areaId}`,origin:`/var/lib/lares-vault-git/${areaId}.git`}]}),{mode:0o600});
 const stop=await serveConsoleVaultBroker(main,signerPath,secretsDir,process.env.LARES_VAULT_RUNTIME_SOCKET,{consoleSocket,outsideCustody:store});
 type Point={turnCapability:string;turnId:string;sequence:number;sessionId:string;memberId:string;admissionNonce:string};
 const open=async(memberId=owner):Promise<Point>=>{
  const sessionId='proof_'+randomBytes(12).toString('hex'),admissionNonce=randomBytes(32).toString('base64url');
  const binding=await bindConsoleSession({agent,incarnation,sessionId,memberId,admissionNonce},main);
  const rawBodyHash=createHash('sha256').update('{"message":"fixture"}').digest('hex');
  const input={agent,incarnation,session:sessionId,member:memberId,admissionNonce,method:'POST',path:`/eve/v1/session/${sessionId}`,
   rawBodyHash,policyRevision:binding.policyRevision,definitionHash:c.definitionHash};
  const challenge=await new Promise<{challenge:string;expiry:number}>((resolveChallenge,reject)=>{
   const socket=createConnection(consoleSocket);let data='';socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('fixture admission timed out'))});
   socket.once('error',reject);socket.once('connect',()=>socket.write(JSON.stringify({op:'challenge',input})+'\n'));
   socket.on('data',chunk=>{data+=chunk.toString();if(!data.includes('\n'))return;socket.destroy();
    try{const reply=JSON.parse(data);assert(reply.ok===true,'fixture challenge refused');resolveChallenge(reply)}catch{reject(new Error('fixture challenge refused'))}});
  });
  const encoded=Buffer.from(JSON.stringify({version:1,purpose:'human',...input,challenge:challenge.challenge,
   nonce:randomBytes(32).toString('base64url'),expiry:challenge.expiry})).toString('base64url');
  const capsule=encoded+'.'+createHmac('sha256',Buffer.from(signingKey,'hex')).update(encoded).digest('base64url');
  const admitted=await vaultBrokerRequest<{pendingReceipt:string}>('request.admit',{capsule,receipt:{method:input.method,path:input.path,rawBodyHash}});
  const turnId='turn_'+randomBytes(12).toString('hex'),sequence=1;
  const opened=await vaultBrokerRequest<{turnCapability:string}>('turn.open',{pendingReceipt:admitted.pendingReceipt,sessionId,memberId,admissionNonce,
   turnId,sequence,definition:{definition:c.definition,dutiesMd:'',voiceMd:'',hash:c.definitionHash}});
  return {turnCapability:opened.turnCapability,turnId,sequence,sessionId,memberId,admissionNonce};
 };
 let point:Point;
 type Call=Parameters<typeof executeApprovedOutsideCall>[1];
 const approve=async(revision=c.activeRevision,accountId=c.accountId):Promise<Call>=>{
  const input={fixture:'outside-execution-v1'},call={callId:randomUUID(),requestId:randomUUID(),sessionId:point.sessionId,memberId:point.memberId,
   approverMemberId:point.memberId,agent,incarnation,definitionHash:c.definitionHash,connectionName:'fixture',accountId,credentialRevision:revision,
   toolName:'lookup_alpha',input};
  // Authenticated fixture human gives exact consent; use the durable production receipt API,
  // not an assumed success row or an execution bypass.
  await consoleSourceTransaction(outside,async db=>{const human=await lockOutsideHumanSession(db,c.sessionToken);
   assert(human.memberId===point.memberId,'approval fixture member mismatch');
   const {input:approvedInput,...selectors}=call;
   await recordOutsideExecutionApproval(db,{...selectors,payloadHash:outsidePayloadHash(call.toolName,approvedInput),expiresAt:Date.now()+60_000});
  });return call;
 };
 const execute=(call:Call,p=point)=>executeApprovedOutsideCall<{content:unknown[]}>(p,call);
 const positive=async(call:Call)=>{const before=peer();const response=await execute(call),after=peer();
  assert(after.requestCount===before.requestCount+3&&after.toolsCallCount===before.toolsCallCount+1&&after.exactCallMatches,
   'signed broker did not reach exactly one physical approved tools/call');
  assert(canonical(response)==='{"content":[{"text":"fixture-approved","type":"text"}]}','signed broker returned an unexpected fixture projection');
  secretFree(response);result.positiveCalls++;
 };
 const refuse=async(label:typeof EXECUTION_REFUSALS[number],work:()=>Promise<unknown>)=>{const before=peer();let denied=false;
  try{await work()}catch{denied=true}const after=peer();
  assert(denied&&after.requestCount===before.requestCount&&after.toolsCallCount===before.toolsCallCount,'refusal reached the physical peer');
  if(!result.refusals.includes(label))result.refusals.push(label);
 };
 try{
  c.phase('signed outside execution');point=await open();
  const first=await approve();await positive(first);await refuse('replay',()=>execute(first));
  const pending=await approve();
  for(const [label,changed] of [
   ['member',{memberId:editor}],['session',{sessionId:'another_session'}],['agent',{agent:'other-agent'}],
   ['tool',{toolName:'lookup_beta'}],['payload',{input:{fixture:'changed'}}],['connection',{connectionName:'other-connection'}],
   ['credential-version',{credentialRevision:c.activeRevision+1}],
  ] as const)await refuse(label,()=>execute({...pending,...changed}));
  await refuse('member',()=>execute(pending,{...point,memberId:editor}));
  await refuse('session',()=>execute(pending,{...point,sessionId:'another_session'}));
  const originalIncarnation=process.env.LARES_AGENT_INCARNATION;process.env.LARES_AGENT_INCARNATION=randomUUID();
  try{await refuse('runtime-incarnation',()=>execute(pending))}finally{process.env.LARES_AGENT_INCARNATION=originalIncarnation}
  await positive(pending);
  const expired=await approve();await proof.query("UPDATE outside_execution_approvals SET expires_at=created_at+interval '1 millisecond' WHERE call_id=$1",[expired.callId]);
  await pause(5);await refuse('expired',()=>execute(expired));
  const foreignAccount=randomUUID();await proof.query(`INSERT INTO outside_custody_accounts(account_id,owner_member_id,resource_id,connection_name,consent_generation,state)
   VALUES($1,$2,$3,'fixture',1,'active')`,[foreignAccount,editor,agent]);
  const foreign=await approve(c.activeRevision,foreignAccount);await refuse('cross-member-custody',()=>execute(foreign));

  c.phase('outside replacement preservation');
  const capture=await store.previewDiscovery(c.sessionToken,{agentName:agent,connectionName:'fixture'},{deadlineAtMs:Date.now()+7000});
  const requestId=randomUUID(),claimOperationId=randomUUID(),credential=Buffer.from(need('FIXTURE_ROTATED_BEARER'),'ascii');
  try{await store.consentAndDiscover(c.sessionToken,{requestId,operationId:claimOperationId,accountId:c.accountId,agentName:agent,connectionName:'fixture',
   expectedGeneration:c.generation,expectedCandidateRevision:null,expectedDefinitionHash:c.definitionHash,expectedAccessRevision:capture.agent.accessRevision,
   expectedDestinationHash:createHash('sha256').update(JSON.stringify(['lares-outside-endpoint-v1',capture.outside.connection.url])).digest('hex'),
   expectedRoutePolicyHash:c.routePolicyHash,consentGeneration:3,credential},{deadlineAtMs:Date.now()+7000})}finally{credential.fill(0)}
  const projection={version:1,connectionName:'fixture',scope:capture.outside.scope,allow:[...capture.outside.connection.allow].sort(),
   read:[...capture.outside.connection.read].sort(),tools:[
    {name:'lookup_alpha',description:'Neutral lookup A',inputSchema:{type:'object',properties:{}}},
    {name:'lookup_beta',description:'Neutral lookup B',inputSchema:{type:'object',properties:{}}}]};
  const publicationId=randomUUID(),publicationHash=createHash('sha256').update(canonical(projection)).digest('hex');
  await store.publishDiscoveredDescriptorReview(c.sessionToken,{accountId:c.accountId,agentName:agent,connectionName:'fixture',requestId,
   claimOperationId,operationId:publicationId,expectedGeneration:c.generation,expectedDescriptorHash:publicationHash},{deadlineAtMs:Date.now()+7000});
  const acceptanceId=randomUUID(),acceptance=await store.acceptPublishedDescriptorReview(c.sessionToken,{accountId:c.accountId,publicationId,
   operationId:acceptanceId,expectedPublicationHash:publicationHash},{deadlineAtMs:Date.now()+7000});
  const activation={accountId:c.accountId,agentName:agent,connectionName:'fixture',requestId,claimOperationId,publicationId,acceptanceId,
   expectedGeneration:c.generation,expectedCandidateRevision:null,expectedConsentGeneration:4,expectedDefinitionHash:c.definitionHash,
   expectedAccessRevision:capture.agent.accessRevision,expectedPublicationHash:publicationHash,expectedAcceptanceHash:acceptance.acceptanceHash};
  const review=await store.previewExecutableActivation(c.sessionToken,{...activation,operationId:randomUUID()},{deadlineAtMs:Date.now()+7000});
  secretFree({capture,acceptance,review});
  const stageOperationId=randomUUID(),staged=await store.stage(c.sessionToken,{...activation,operationId:stageOperationId,
   expectedPolicyHash:review.policyHash,activationReviewId:review.reviewId,expectedActivationReviewHash:review.reviewHash},{deadlineAtMs:Date.now()+7000});
  assert(staged.credentialRevision!==null,'replacement candidate missing');
  const apply={...activation,operationId:randomUUID(),expectedPolicyHash:review.policyHash,activationReviewId:review.reviewId,
   expectedActivationReviewHash:review.reviewHash,stageOperationId,candidateRevision:staged.credentialRevision};
  const originalCipher=(await proof.query('SELECT nonce,ciphertext FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2',[c.accountId,c.activeRevision])).rows[0];
  const before=(await proof.query('SELECT generation::text,active_revision::text,candidate_revision::text,consent_generation::text FROM outside_custody_accounts WHERE account_id=$1',[c.accountId])).rows[0];
  const failure=await withRevisionTableLock(proof,async()=>{
   const use=store.apply(c.sessionToken,apply,{deadlineAtMs:Date.now()+2500}).then(()=>false,()=>true);let blocked=false;
   for(let attempt=0;attempt<180;attempt++){const rows=await proof.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM outside_custody_operations c LEFT JOIN outside_custody_revisions%'");
    if(rows.rowCount){blocked=true;break}await pause(10)}return {blocked,denied:await use};
  });
  assert(failure.blocked&&failure.denied,'replacement Apply failure did not reach the actual locked lifecycle path');
  const after=(await proof.query('SELECT generation::text,active_revision::text,candidate_revision::text,consent_generation::text FROM outside_custody_accounts WHERE account_id=$1',[c.accountId])).rows[0];
  assert(canonical(before)===canonical(after)&&after.active_revision===String(c.activeRevision),'failed replacement Apply changed the active head');
  assert((await proof.query('SELECT 1 FROM outside_custody_operations WHERE operation_id=$1',[apply.operationId])).rowCount===0,'failed replacement Apply recorded success');
  const retainedCipher=(await proof.query('SELECT nonce,ciphertext FROM outside_custody_revisions WHERE account_id=$1 AND credential_revision=$2',[c.accountId,c.activeRevision])).rows[0];
  assert(originalCipher.nonce.equals(retainedCipher.nonce)&&originalCipher.ciphertext.equals(retainedCipher.ciphertext),'failed Apply replaced the last working ciphertext');
  await positive(await approve());result.failedApplyPreserved=true;
  const stale=await approve();const rotated=await store.apply(c.sessionToken,{...apply,operationId:randomUUID()},{deadlineAtMs:Date.now()+7000});
  assert(rotated.outcome==='applied'&&rotated.credentialRevision===staged.credentialRevision,'replacement activation did not succeed');
  await refuse('rotation',()=>execute(stale));result.rotationRejected=true;
  await positive(await approve(staged.credentialRevision));

  c.phase('outside execution revocation');
  const revoked=await approve(staged.credentialRevision);
  await proof.query('UPDATE console_session_bindings SET revoked_at=clock_timestamp() WHERE session_id=$1',[point.sessionId]);
  await refuse('revoked',()=>execute(revoked));point=await open();
  const permission=await approve(staged.credentialRevision);
  await proof.query("UPDATE org_member_policy SET allowed_capabilities=ARRAY[]::text[] WHERE user_id=$1",[owner]);
  await refuse('permission-revoked',()=>execute(permission));
  await proof.query("UPDATE org_member_policy SET allowed_capabilities=ARRAY['outside','vault']::text[] WHERE user_id=$1",[owner]);
  // Policy invalidation permanently retires the old binding. Open a fresh admitted turn;
  // never restore its nonce or revive a retired capability.
  point=await open();const removal=await approve(staged.credentialRevision);
  const removed=await store.revoke({agent,incarnation,sessionId:point.sessionId,memberId:owner,admissionNonce:point.admissionNonce},
   {accountId:c.accountId,operationId:randomUUID(),expectedGeneration:rotated.generation},{deadlineAtMs:Date.now()+7000});
  assert(removed.outcome==='revoked','connection removal was not acknowledged');
  await refuse('removal',()=>execute(removal));result.removalRejected=true;
  const final=peer();assert(final.bearerMatches&&final.sessionMatches&&final.exactCallMatches,'physical peer contract changed');
  result.peerRequests=final.requestCount-initialPeer.requestCount;result.peerToolCalls=final.toolsCallCount-initialPeer.toolsCallCount;
  assert(result.positiveCalls===4&&result.peerRequests===16&&result.peerToolCalls===4,'physical peer counter totals differ');
  assert(EXECUTION_REFUSALS.every(label=>result.refusals.includes(label)),'execution refusal coverage incomplete');
  const traces=await proof.query(`SELECT d.definition::text AS definition,d.duties,d.voice,a.payload_hash::text AS payload
    FROM agent_definitions d LEFT JOIN approval_asks a ON a.agent=d.name WHERE d.name=$1`,[agent]);
  secretFree(traces.rows);
  for(const table of ['audit','keeper_audit','outside_execution_approvals']){
   const rows=await proof.query(`SELECT row_to_json(t) AS entry FROM ${table} t`);secretFree(rows.rows);
  }
  secretFree(result);
  result.complete=true;return result;
 }finally{await stop()}
}

async function runConfigured():Promise<void>{
  const output=need('FIXTURE_WORKER_REPORT');
  const partial:{success:boolean;executionProof?:ExecutionProof;firewallApplied:boolean;directTargetBlocked:boolean;directPathDiagnostics?:{
    control:SocketObservation|{status:'not-attempted'};before:FirewallCounterReports;direct:SocketObservation|{status:'not-attempted'};
    after:FirewallCounterReports|{status:'not-attempted'};inetCounterIncreased:boolean;bridgeCounterIncreased:boolean};
    routedPathDiagnostics?:{control:SocketObservation|{status:'not-attempted'};before:FirewallCounterReports;
      direct:SocketObservation|{status:'not-attempted'};after:FirewallCounterReports|{status:'not-attempted'};
      inetCounterIncreased:boolean;bridgeCounterIncreased:boolean};
    directPathPredicateDiagnostics?:{sameBridge?:DirectPathPredicateDiagnostics;routed?:DirectPathPredicateDiagnostics};
    previewResponseDiagnostics?:{agentDefinitionHashPresent:boolean;agentAccessRevisionPresent:boolean;outsideConnectionPresent:boolean;
      allowListPresent:boolean;readListPresent:boolean};
    discoveryResponseDiagnostics?:{protocolVersionMatches:boolean;serverNameMatches:boolean;toolCountMatches:boolean;
      firstToolMatches:boolean;secondToolMatches:boolean};checks:string[]}={
    success:false,firewallApplied:false,directTargetBlocked:false,checks:[]};
  let main:Pool|undefined,outside:Pool|undefined,admin:Pool|undefined,proof:Pool|undefined,store:OutsideCustodyStore|undefined,
    key:Buffer|undefined,proofKey:Buffer|undefined,credential:Buffer|undefined;
  let routeBoundaryFailure:(()=>RouteBoundaryFailure|undefined)|undefined;
  let routeAcknowledgementReason:(()=>OutsideRouteAcknowledgementFailure|undefined)|undefined;
  let failureRecord:{phase:string;reason:string;category:SafeOperationFailureCategory;routeBoundary?:RouteBoundaryFailure;
    acknowledgementReason?:OutsideRouteAcknowledgementFailure}|undefined;
  let phase='configuration';
  const startPhase=(next:string):void=>{
    phase=next;
    writeReport(resolve(output,'../worker-stage.json'),{phase});
  };
  startPhase(phase);
  try{
    const root=need('FIXTURE_ROOT'),agent=need('FIXTURE_AGENT'),owner='outside-proof-owner',editor='outside-proof-editor',org='outside-proof-org';
    const incarnation=need('FIXTURE_INCARNATION');
    const config=loadKeeperConfig(root+'/config/keeper.json');
    assert(config.mode==='rendered'&&config.lifecycle&&config.outsideCustody,'actual Keeper config did not load');
    main=keeperPool(config.db,{max:4,connectionTimeoutMillis:3000,query_timeout:12000});
    outside=keeperOutsideCustodyPool(config,{max:4,connectionTimeoutMillis:3000,query_timeout:12000});
    admin=keeperPool(config.lifecycle.adminDb,{max:1,connectionTimeoutMillis:3000,query_timeout:12000});
    assert(outside,'configured outside custody pool was not created');
    key=loadBoundOutsideCustodyKey(config.outsideCustody.keyFile,config.outsideCustody.keyFingerprint);
    const routeDocker=trackRouteBoundaryFailures(ownedDocker({...config.lifecycle,project:config.project,dir:config.dir}));
    routeBoundaryFailure=routeDocker.firstFailure;
    routeAcknowledgementReason=routeDocker.firstAcknowledgementReason;
    const lifecycle=new AgentLifecycle(main,admin,config.lifecycle,{mode:'rendered',agentsDir:config.agentsDir,
      secretsDir:config.secretsDir,outsideCustody:config.outsideCustody},routeDocker.docker);
    store=new OutsideCustodyStore(outside,key,{mainPool:main,lifecycle});
    key.fill(0);key=undefined;
    proofKey=Buffer.from(need('FIXTURE_KEY_HEX'),'hex');
    delete env.FIXTURE_KEY_HEX;
    proof=new Pool({host:'proof-db',port:5432,database:'proof',user:'proof',password:need('PROOF_ADMIN_PASSWORD'),
      max:2,connectionTimeoutMillis:3000,query_timeout:12000});

    startPhase('role identities');
    const appIdentity=await main.query('SELECT current_user,session_user');
    const outsideIdentity=await outside.query('SELECT current_user,session_user');
    assert(appIdentity.rows[0]?.current_user==='lares_app'&&appIdentity.rows[0]?.session_user==='lares_app','application pool identity mismatch');
    assert(outsideIdentity.rows[0]?.current_user==='lares_outside_custody'&&outsideIdentity.rows[0]?.session_user==='lares_outside_custody','outside pool identity mismatch');
    partial.checks.push('actual configured lares_app and lares_outside_custody logins');

    startPhase('neutral authorization fixture');
    const session=need('FIXTURE_SESSION_TOKEN'),editorSession=randomBytes(32).toString('base64url');
    const sessionHash=createHash('sha256').update(session).digest('hex');
    const template=JSON.parse(readFileSync(new URL('../../../packages/agent-kit/templates/chief-of-staff/definition.json',import.meta.url),'utf8')) as Record<string,unknown>;
    const definition=definitionSchema.parse({...template,name:agent,role:'chief-of-staff',channels:[],doors:[],
      grants:[{capability:'outside',scope:'read'},{capability:'vault',scope:'read',areas:['shared']}],autonomy:{outside:'gated'},skills:[],
      outsideTools:[{name:'fixture',url:'https://mcp.example.org/mcp?fixture=outside-proof-v1',description:'Neutral bounded CI lookup',token:true,
        tools:{allow:['lookup_alpha','lookup_beta'],read:['lookup_alpha','lookup_beta']}}]});
    const duties='',voice='',definitionHash=hashOf({definition,dutiesMd:duties,voiceMd:voice});
    await proof.query("INSERT INTO orgs(id,display_name) VALUES($1,'Outside proof organization')",[org]);
    await proof.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES($1,'Fixture owner',$3,'owner','active'),($2,'Fixture editor',$3,'member','active')",[owner,editor,org]);
    await proof.query("INSERT INTO org_member_policy(user_id,allowed_capabilities,may_create_agents) VALUES($1,ARRAY['outside','vault'],true),($2,ARRAY['outside','vault'],false)",[owner,editor]);
    await proof.query('INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\')',
      [randomUUID(),owner,sessionHash]);
    await proof.query('INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\')',
      [randomUUID(),editor,createHash('sha256').update(editorSession).digest('hex')]);
    startPhase('outside custody organisation gate contention');
    for(const [firstToken,secondToken,direction] of [[session,editorSession,'owner-first'],[editorSession,session,'editor-first']] as const){
      let enteredResolve!:()=>void,releaseResolve!:()=>void;
      const entered=new Promise<void>(resolve=>{enteredResolve=resolve;}),hold=new Promise<void>(resolve=>{releaseResolve=resolve;});
      let second:Promise<unknown>|undefined;
      const first=consoleSourceTransaction(outside,async db=>{
        await lockOutsideHumanSession(db,firstToken);enteredResolve();await hold;
      },undefined,{deadlineAtMs:Date.now()+5000});
      try{
        await entered;
        const applicationName=`outside_gate_${direction}_${randomUUID().replaceAll('-','')}`;
        second=consoleSourceTransaction(outside,async db=>{
          await db.query("SELECT set_config('application_name',$1,true)",[applicationName]);
          await lockOutsideHumanSession(db,secondToken);
        },undefined,{deadlineAtMs:Date.now()+5000});
        let waitingAtGate=false;
        for(let attempt=0;attempt<24;attempt++){
          const activity=await proof.query<{wait_event_type:string|null;query:string}>(
            'SELECT wait_event_type,query FROM pg_stat_activity WHERE application_name=$1',[applicationName]);
          if(activity.rows[0]?.wait_event_type==='Lock'&&activity.rows[0].query.includes('pg_advisory_xact_lock')){waitingAtGate=true;break;}
          await pause(15);
        }
        assert(waitingAtGate,`reciprocal ${direction} actor did not wait at the shared organisation gate`);
      }finally{
        releaseResolve();await Promise.allSettled([first,...(second?[second]:[])]);
      }
    }
    partial.checks.push('reciprocal authenticated actors wait at the shared organisation gate before member and session locks');
    await proof.query("INSERT INTO agent_definitions(name,definition,duties,voice,hash,status) VALUES($1,$2::jsonb,$3,$4,$5,'valid')",
      [agent,JSON.stringify(definition),duties,voice,definitionHash]);
    await proof.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,applied_definition,pending) VALUES($1,$2::inet,$3,'owned',$4,$4,'ready',$5::jsonb,false)",
      [agent,need('FIXTURE_AGENT_IP'),'lares_'+randomUUID().replaceAll('-',''),incarnation,JSON.stringify(definition)]);
    const grants=new PgGrantStore(main);
    const adopted=await grants.adoptAgent(owner,{agentName:agent,expectedDefinitionHash:definitionHash},{designatedOwnerMemberId:owner});
    const access=await grants.updateAgentAccess(owner,{agentName:agent,expectedRevision:adopted.accessRevision,
      grants:[{principal:{kind:'organisation',id:org},permission:'use',expiresAt:null},
        {principal:{kind:'member',id:editor},permission:'edit',expiresAt:'2099-06-03T00:00:00.123456Z'}]});
    assert(access.accessRevision>adopted.accessRevision,'real grant store did not establish use access');
    partial.checks.push('neutral definition, finite human session and real owner adoption/use grant');

    startPhase('same-bridge direct-path control');
    const controlCounters=await firewallCounters();
    partial.directPathDiagnostics={control:{status:'not-attempted'},before:counterReports(controlCounters),direct:{status:'not-attempted'},
      after:counterReports(controlCounters),inetCounterIncreased:false,bridgeCounterIncreased:false};
    partial.routedPathDiagnostics={control:{status:'not-attempted'},before:counterReports(controlCounters),direct:{status:'not-attempted'},
      after:counterReports(controlCounters),inetCounterIncreased:false,bridgeCounterIncreased:false};
    const bridgeControl=await tlsControlEvidence('mcp.example.org',need('FIXTURE_PEER_IP'),need('FIXTURE_SOURCE_IP'));
    partial.directPathDiagnostics.control=bridgeControl;
    assert(bridgeControl.tlsCompleted&&bridgeControl.socketClosed&&bridgeControl.lookupAddress===need('FIXTURE_PEER_IP')&&
      bridgeControl.assignedSourceAddress===need('FIXTURE_SOURCE_IP')&&bridgeControl.connectedPeerAddress===need('FIXTURE_PEER_IP'),
      'same-bridge direct-path control did not verify the bound source and peer');
    startPhase('routed direct-path control');
    const routedControl=await tlsControlEvidence('routed.mcp.example.org',need('FIXTURE_ROUTED_TARGET_IP'),
      need('FIXTURE_SOURCE_IP'),443);
    partial.routedPathDiagnostics.control=routedControl;
    assert(routedControl.tlsCompleted&&routedControl.socketClosed&&routedControl.lookupAddress===need('FIXTURE_ROUTED_TARGET_IP')&&
      routedControl.assignedSourceAddress===need('FIXTURE_SOURCE_IP')&&routedControl.connectedPeerAddress===need('FIXTURE_ROUTED_TARGET_IP'),
      'routed direct-path control did not verify the bound source and published gateway peer');

    startPhase('generated route admission');
    await withDefinitionNamespace(main,()=>lifecycle.saved(agent,definition));
    partial.firewallApplied=true;
    const route=await lifecycle.reviewOutsideRoute('https://mcp.example.org/mcp?fixture=outside-proof-v1',Date.now()+5000);
    assert(route.sourceAddress===need('FIXTURE_SOURCE_IP')&&route.proxyUrl==='http://lares-egress-proxy:8888/','actual route did not match configured source/proxy');
    partial.checks.push('public saved lifecycle installed and acknowledged generated route without native authority');

    startPhase('direct-path firewall counter');
    const directBefore=await firewallCounters();
    partial.directPathDiagnostics.before=counterReports(directBefore);
    partial.directPathDiagnostics.after=counterReports(directBefore);
    partial.routedPathDiagnostics.before=counterReports(directBefore);
    partial.routedPathDiagnostics.after=counterReports(directBefore);
    assert(directBefore.inet.failure==='none'&&directBefore.bridge.failure==='none','generated firewall drop counter is unavailable');
    const direct=await directTargetEvidence('mcp.example.org','/mcp?fixture=outside-proof-v1',need('FIXTURE_PEER_IP'),need('FIXTURE_SOURCE_IP'));
    partial.directPathDiagnostics.direct=direct;
    const directAfter=await firewallCounters();
    partial.directPathDiagnostics.after=counterReports(directAfter);
    const routedBefore=directAfter;
    partial.routedPathDiagnostics.before=counterReports(routedBefore);
    const inetCounterIncreased=familyCounterIncreased(directBefore.inet,directAfter.inet);
    const bridgeCounterIncreased=familyCounterIncreased(directBefore.bridge,directAfter.bridge);
    partial.directPathDiagnostics.inetCounterIncreased=inetCounterIncreased;
    partial.directPathDiagnostics.bridgeCounterIncreased=bridgeCounterIncreased;
    const bridgeTargetBlocked=directBefore.inet.failure==='none'&&directBefore.bridge.failure==='none'&&
      directAfter.inet.failure==='none'&&directAfter.bridge.failure==='none'&&
      !direct.tlsCompleted&&direct.socketClosed&&direct.lookupAddress===need('FIXTURE_PEER_IP')&&
      (!direct.assignedSourceAddress||direct.assignedSourceAddress===need('FIXTURE_SOURCE_IP'))&&
      (!direct.connectedPeerAddress||direct.connectedPeerAddress===need('FIXTURE_PEER_IP'))&&
      bridgeCounterIncreased&&!inetCounterIncreased;
    partial.directPathPredicateDiagnostics={sameBridge:{
      controlTlsComplete:bridgeControl.tlsCompleted,
      controlSocketClosed:bridgeControl.socketClosed,
      controlLookupMatchesTarget:bridgeControl.lookupAddress===need('FIXTURE_PEER_IP'),
      controlSourceMatchesConfigured:bridgeControl.assignedSourceAddress===need('FIXTURE_SOURCE_IP'),
      controlPeerMatchesTarget:bridgeControl.connectedPeerAddress===need('FIXTURE_PEER_IP'),
      directLookupMatchesTarget:direct.lookupAddress===need('FIXTURE_PEER_IP'),
      directSourceMatchesConfiguredOrMissing:!direct.assignedSourceAddress||direct.assignedSourceAddress===need('FIXTURE_SOURCE_IP'),
      directPeerMatchesTargetOrMissing:!direct.connectedPeerAddress||direct.connectedPeerAddress===need('FIXTURE_PEER_IP'),
      directTlsDidNotComplete:!direct.tlsCompleted,directSocketClosed:direct.socketClosed,
      beforeCountersAvailable:directBefore.inet.failure==='none'&&directBefore.bridge.failure==='none',
      afterCountersAvailable:directAfter.inet.failure==='none'&&directAfter.bridge.failure==='none',
      requiredFamilyIncreased:bridgeCounterIncreased,otherFamilyDidNotIncrease:!inetCounterIncreased,
      exactRequiredCounterComparisonMatches:exactCounterIncreaseMatches(directBefore.bridge,directAfter.bridge,bridgeCounterIncreased),
      exactOtherCounterComparisonMatches:exactCounterIncreaseMatches(directBefore.inet,directAfter.inet,inetCounterIncreased),
      blocked:bridgeTargetBlocked,
    }};
    assert(bridgeTargetBlocked,'same-bridge direct target attempt did not produce a closed socket and bridge-family drop');

    startPhase('routed direct-path firewall counter');
    const routed=await directTargetEvidence('routed.mcp.example.org','/',need('FIXTURE_ROUTED_TARGET_IP'),
      need('FIXTURE_SOURCE_IP'),443);
    partial.routedPathDiagnostics.direct=routed;
    const routedAfter=await firewallCounters();
    partial.routedPathDiagnostics.after=counterReports(routedAfter);
    const routedInetCounterIncreased=familyCounterIncreased(routedBefore.inet,routedAfter.inet);
    const routedBridgeCounterIncreased=familyCounterIncreased(routedBefore.bridge,routedAfter.bridge);
    partial.routedPathDiagnostics.inetCounterIncreased=routedInetCounterIncreased;
    partial.routedPathDiagnostics.bridgeCounterIncreased=routedBridgeCounterIncreased;
    const routedTargetBlocked=routedBefore.inet.failure==='none'&&routedBefore.bridge.failure==='none'&&
      routedAfter.inet.failure==='none'&&routedAfter.bridge.failure==='none'&&
      !routed.tlsCompleted&&routed.socketClosed&&routed.lookupAddress===need('FIXTURE_ROUTED_TARGET_IP')&&
      (!routed.assignedSourceAddress||routed.assignedSourceAddress===need('FIXTURE_SOURCE_IP'))&&
      (!routed.connectedPeerAddress||routed.connectedPeerAddress===need('FIXTURE_ROUTED_TARGET_IP'))&&
      routedInetCounterIncreased&&!routedBridgeCounterIncreased;
    partial.directPathPredicateDiagnostics={...partial.directPathPredicateDiagnostics,routed:{
      controlTlsComplete:routedControl.tlsCompleted,
      controlSocketClosed:routedControl.socketClosed,
      controlLookupMatchesTarget:routedControl.lookupAddress===need('FIXTURE_ROUTED_TARGET_IP'),
      controlSourceMatchesConfigured:routedControl.assignedSourceAddress===need('FIXTURE_SOURCE_IP'),
      controlPeerMatchesTarget:routedControl.connectedPeerAddress===need('FIXTURE_ROUTED_TARGET_IP'),
      directLookupMatchesTarget:routed.lookupAddress===need('FIXTURE_ROUTED_TARGET_IP'),
      directSourceMatchesConfiguredOrMissing:!routed.assignedSourceAddress||routed.assignedSourceAddress===need('FIXTURE_SOURCE_IP'),
      directPeerMatchesTargetOrMissing:!routed.connectedPeerAddress||routed.connectedPeerAddress===need('FIXTURE_ROUTED_TARGET_IP'),
      directTlsDidNotComplete:!routed.tlsCompleted,directSocketClosed:routed.socketClosed,
      beforeCountersAvailable:routedBefore.inet.failure==='none'&&routedBefore.bridge.failure==='none',
      afterCountersAvailable:routedAfter.inet.failure==='none'&&routedAfter.bridge.failure==='none',
      requiredFamilyIncreased:routedInetCounterIncreased,otherFamilyDidNotIncrease:!routedBridgeCounterIncreased,
      exactRequiredCounterComparisonMatches:exactCounterIncreaseMatches(routedBefore.inet,routedAfter.inet,routedInetCounterIncreased),
      exactOtherCounterComparisonMatches:exactCounterIncreaseMatches(routedBefore.bridge,routedAfter.bridge,routedBridgeCounterIncreased),
      blocked:routedTargetBlocked,
    }};
    partial.directTargetBlocked=bridgeTargetBlocked&&routedTargetBlocked;
    assert(partial.directTargetBlocked,'direct paths did not both close before TLS with their required family counters');
    partial.checks.push('same-bridge direct target closes before TLS and increments the bridge-family drop counter',
      'routed direct target closes before TLS and increments the inet-family drop counter after a verified positive control');

    const deadlineAtMs=Date.now()+7000;
    startPhase('outside discovery preview');
    const capture=await store.previewDiscovery(session,{agentName:agent,connectionName:'fixture'},{deadlineAtMs});
    startPhase('outside discovery preview response');
    partial.previewResponseDiagnostics={agentDefinitionHashPresent:typeof capture?.agent?.definitionHash==='string',
      agentAccessRevisionPresent:Number.isSafeInteger(capture?.agent?.accessRevision),
      outsideConnectionPresent:typeof capture?.outside?.connection==='object'&&capture.outside.connection!==null,
      allowListPresent:Array.isArray(capture?.outside?.connection?.allow),readListPresent:Array.isArray(capture?.outside?.connection?.read)};
    startPhase('prepare outside consent request');
    const endpointHash=createHash('sha256').update(JSON.stringify(['lares-outside-endpoint-v1','https://mcp.example.org/mcp?fixture=outside-proof-v1'])).digest('hex');
    const accountId=randomUUID(),requestId=randomUUID(),claimOperationId=randomUUID();
    credential=Buffer.from(need('FIXTURE_BEARER'),'ascii');
    startPhase('outside consent and discover');
    const document=await store.consentAndDiscover(session,{requestId,operationId:claimOperationId,accountId,agentName:agent,
      connectionName:'fixture',expectedGeneration:0,expectedCandidateRevision:null,
      expectedDefinitionHash:capture.agent.definitionHash,expectedAccessRevision:capture.agent.accessRevision,
      expectedDestinationHash:endpointHash,expectedRoutePolicyHash:route.policyHash,consentGeneration:1,credential},{deadlineAtMs});
    credential.fill(0);credential=undefined;
    startPhase('outside consent and discover response');
    partial.discoveryResponseDiagnostics={protocolVersionMatches:document?.protocolVersion==='2025-06-18',
      serverNameMatches:document?.serverInfo?.name==='local-fixture',toolCountMatches:Array.isArray(document?.tools)&&document.tools.length===2,
      firstToolMatches:document?.tools?.[0]?.name==='lookup_alpha',secondToolMatches:document?.tools?.[1]?.name==='lookup_beta'};
    assert(new URL('https://mcp.example.org/mcp?fixture=outside-proof-v1').port===''&&
      document.protocolVersion==='2025-06-18'&&document.serverInfo.name==='local-fixture'&&document.tools.length===2&&
      document.tools[0]?.name==='lookup_alpha'&&document.tools[1]?.name==='lookup_beta',
      'default HTTPS discovery without an explicit port did not complete');
    partial.checks.push('default HTTPS URL without an explicit port completed the guarded discovery exchange');

    startPhase('outside custody human review and activation');
    const allowed=[...capture.outside.connection.allow].sort(),read=[...capture.outside.connection.read].sort();
    const byName=new Map(document.tools.map(tool=>[tool.name,tool]));
    const projection={version:1 as const,connectionName:'fixture',scope:capture.outside.scope,allow:allowed,read,
      tools:allowed.map(name=>{const tool=byName.get(name);assert(tool,`published tool missing: ${name}`);
        return {name:tool.name,...(tool.description===undefined?{}:{description:tool.description}),inputSchema:tool.inputSchema};})};
    const expectedDescriptorHash=createHash('sha256').update(canonical(projection)).digest('hex');
    const publicationId=randomUUID();
    const publication=await store.publishDiscoveredDescriptorReview(session,{accountId,agentName:agent,connectionName:'fixture',requestId,
      claimOperationId,operationId:publicationId,expectedGeneration:1,expectedDescriptorHash},{deadlineAtMs:Date.now()+10000});
    assert(publication.publicationId===publicationId&&publication.publicationHash===expectedDescriptorHash&&
      canonical(publication.descriptor)===canonical(projection),'authenticated descriptor publication differs from discovered scope');
    const reviewed=await store.readPublishedDescriptorReview(editorSession,{accountId,publicationId,expectedPublicationHash:expectedDescriptorHash},
      {deadlineAtMs:Date.now()+10000});
    assert(reviewed.resourceId===agent&&reviewed.connectionName==='fixture'&&canonical(reviewed.descriptor)===canonical(projection),
      'current editor could not read the exact published descriptor');
    const acceptanceId=randomUUID();
    const acceptance=await store.acceptPublishedDescriptorReview(editorSession,{accountId,publicationId,operationId:acceptanceId,
      expectedPublicationHash:expectedDescriptorHash},{deadlineAtMs:Date.now()+10000});
    assert(acceptance.acceptanceId===acceptanceId&&acceptance.publicationHash===expectedDescriptorHash&&
      /^[a-f0-9]{64}$/.test(acceptance.acceptanceHash),'editor acceptance did not return its immutable evidence hash');
    const activation={accountId,agentName:agent,connectionName:'fixture',requestId,claimOperationId,publicationId,acceptanceId,
      expectedGeneration:1,expectedCandidateRevision:null,expectedConsentGeneration:2,expectedDefinitionHash:capture.agent.definitionHash,
      expectedAccessRevision:access.accessRevision,expectedPublicationHash:expectedDescriptorHash,
      expectedAcceptanceHash:acceptance.acceptanceHash};
    const activationReview=await store.previewExecutableActivation(session,{...activation,operationId:randomUUID()},{deadlineAtMs:Date.now()+10000});
    assert(activationReview.policyHash.length===64&&activationReview.reviewHash.length===64&&activationReview.consentGeneration===2,
      'custodian activation preview did not produce a bounded current review');
    const stageOperationId=randomUUID();
    const stageInput={...activation,operationId:stageOperationId,expectedPolicyHash:activationReview.policyHash,
      activationReviewId:activationReview.reviewId,expectedActivationReviewHash:activationReview.reviewHash};
    const custodyStore=store,proofPool=proof;
    assert(custodyStore&&proofPool,'custody expiry fixture pools are unavailable');
    const stageExpiry=await withRevisionTableLock(proofPool,async()=>{
      const deadlineAtMs=Date.now()+2500,expiryInput={...stageInput,operationId:randomUUID()};
      const pending=custodyStore.stage(session,expiryInput,{deadlineAtMs}).then(()=> 'completed' as const,()=> 'rejected' as const);
      let blocked=false;
      for(let attempt=0;attempt<180;attempt++){
        const wait=await proofPool.query<{wait_event_type:string|null;query:string}>(
          "SELECT wait_event_type,query FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%outside_custody_revisions%'");
        if(wait.rows.some(row=>row.query.includes('FROM outside_custody_operations c LEFT JOIN outside_custody_revisions'))){blocked=true;break;}
        await pause(10);
      }
      return {blocked,outcome:await pending,operationId:expiryInput.operationId};
    });
    assert(stageExpiry.blocked&&stageExpiry.outcome==='rejected','stage did not stop after its discovery revision read expired under a real PostgreSQL lock');
    const expiredStageRows=await proofPool.query('SELECT count(*)::text AS count FROM outside_custody_operations WHERE operation_id=$1',[stageExpiry.operationId]);
    assert(expiredStageRows.rows[0]?.count==='0','expired stage recorded a receipt after its blocked database read');
    const staged=await store.stage(session,stageInput,{deadlineAtMs:Date.now()+10000});
    assert(staged.outcome==='staged'&&staged.credentialRevision!==null,'final-consent stage did not append an executable candidate');
    const candidateRevision=staged.credentialRevision;
    const stagedReplay=await store.stage(session,stageInput,{deadlineAtMs:Date.now()+10000});
    assert(stagedReplay.operationId===staged.operationId&&stagedReplay.credentialRevision===staged.credentialRevision,
      'exact stage replay did not return its existing receipt');
    const applyExpiry=await withRevisionTableLock(proofPool,async()=>{
      const deadlineAtMs=Date.now()+2500,expiryInput={...activation,operationId:randomUUID(),expectedPolicyHash:activationReview.policyHash,
        activationReviewId:activationReview.reviewId,expectedActivationReviewHash:activationReview.reviewHash,
        stageOperationId,candidateRevision};
      const pending=custodyStore.apply(session,expiryInput,{deadlineAtMs}).then(()=> 'completed' as const,()=> 'rejected' as const);
      let blocked=false;
      for(let attempt=0;attempt<180;attempt++){
        const wait=await proofPool.query<{wait_event_type:string|null;query:string}>(
          "SELECT wait_event_type,query FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%outside_custody_revisions%'");
        if(wait.rows.some(row=>row.query.includes('FROM outside_custody_operations c LEFT JOIN outside_custody_revisions'))){blocked=true;break;}
        await pause(10);
      }
      return {blocked,outcome:await pending,operationId:expiryInput.operationId};
    });
    assert(applyExpiry.blocked&&applyExpiry.outcome==='rejected','apply did not stop after its discovery revision read expired under a real PostgreSQL lock');
    const expiredApplyRows=await proofPool.query('SELECT count(*)::text AS count FROM outside_custody_operations WHERE operation_id=$1',[applyExpiry.operationId]);
    const pendingAfterExpiry=await proofPool.query('SELECT generation::text,active_revision::text,candidate_revision::text FROM outside_custody_accounts WHERE account_id=$1',[accountId]);
    assert(expiredApplyRows.rows[0]?.count==='0'&&pendingAfterExpiry.rows[0]?.generation==='1'&&
      pendingAfterExpiry.rows[0]?.candidate_revision===String(staged.credentialRevision)&&pendingAfterExpiry.rows[0]?.active_revision===null,
      'expired apply recorded a receipt or changed the staged head');
    partial.checks.push('stage and apply request deadlines expire while a PostgreSQL lock blocks the discovery revision read');
    const applyInput={...activation,operationId:randomUUID(),expectedPolicyHash:activationReview.policyHash,
      activationReviewId:activationReview.reviewId,expectedActivationReviewHash:activationReview.reviewHash,
      stageOperationId,candidateRevision:staged.credentialRevision};
    const applied=await store.apply(session,applyInput,{deadlineAtMs:Date.now()+10000});
    assert(applied.outcome==='applied'&&applied.credentialRevision===staged.credentialRevision,
      'custodian apply did not activate the exact staged candidate');
    const appliedReplay=await store.apply(session,applyInput,{deadlineAtMs:Date.now()+10000});
    assert(appliedReplay.operationId===applied.operationId&&appliedReplay.generation===applied.generation&&
      appliedReplay.credentialRevision===applied.credentialRevision,'exact apply replay did not return its existing receipt');
    const alteredApplyRequests=[
      {...applyInput,requestId:randomUUID()},
      {...applyInput,claimOperationId:randomUUID()},
      {...applyInput,expectedAcceptanceHash:'f'.repeat(64)},
    ];
    for(const altered of alteredApplyRequests){
      let denied=false;
      try{await store.apply(session,altered,{deadlineAtMs:Date.now()+10000});}catch{denied=true;}
      assert(denied,'apply replay accepted a changed validated request selector');
    }
    const afterAlteredReplay=await proof.query(`SELECT
      (SELECT count(*)::text FROM outside_custody_operations WHERE operation_id=$1) AS receipts,
      generation::text,active_revision::text,candidate_revision::text
      FROM outside_custody_accounts WHERE account_id=$2`,[applyInput.operationId,accountId]);
    assert(afterAlteredReplay.rows[0]?.receipts==='1'&&afterAlteredReplay.rows[0]?.generation===String(applied.generation)&&
      afterAlteredReplay.rows[0]?.active_revision===String(applied.credentialRevision)&&afterAlteredReplay.rows[0]?.candidate_revision===null,
      'changed apply replay selectors mutated the receipt or active custody head');
    partial.checks.push('changed apply replay selectors are denied without changing the receipt or active head');
    partial.checks.push('exact stage and apply replays recover receipts while current custody and editor grants remain valid');
    await proof.query('UPDATE member_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',
      [createHash('sha256').update(editorSession).digest('hex')]);
    let loggedOutReadDenied=false,loggedOutAcceptanceDenied=false;
    try{await store.readPublishedDescriptorReview(editorSession,{accountId,publicationId,expectedPublicationHash:expectedDescriptorHash},
      {deadlineAtMs:Date.now()+10000});}catch{loggedOutReadDenied=true;}
    try{await store.acceptPublishedDescriptorReview(editorSession,{accountId,publicationId,operationId:randomUUID(),
      expectedPublicationHash:expectedDescriptorHash},{deadlineAtMs:Date.now()+10000});}catch{loggedOutAcceptanceDenied=true;}
    assert(loggedOutReadDenied&&loggedOutAcceptanceDenied,'revoked editor session retained read or acceptance authority');
    const loggedOutEditorReplay=await store.apply(session,applyInput,{deadlineAtMs:Date.now()+10000});
    assert(loggedOutEditorReplay.operationId===applied.operationId,'historical acceptance stopped working after the editor logged out');
    const revokedEditorGrant=await proof.query("UPDATE resource_grants SET revoked_at=clock_timestamp() WHERE resource_kind='agent' AND resource_id=$1 AND principal_member_id=$2 AND permission='edit' AND revoked_at IS NULL RETURNING id",
      [agent,editor]);
    assert(revokedEditorGrant.rows.length===1,'fixture did not revoke exactly the current editor grant');
    let revokedEditGrantReplayDenied=false;
    try{await store.apply(session,applyInput,{deadlineAtMs:Date.now()+10000});}catch{revokedEditGrantReplayDenied=true;}
    assert(revokedEditGrantReplayDenied,'apply replay accepted after the current editor grant was revoked');
    partial.checks.push('historical acceptance survives editor logout and current edit grant revocation blocks replay');
    partial.checks.push('authenticated publication, current editor acceptance and exact custodian preview/stage/apply complete');

    const head=await proof.query('SELECT generation::text,active_revision::text,candidate_revision::text,consent_generation::text,state FROM outside_custody_accounts WHERE account_id=$1',[accountId]);
    assert(head.rows.length===1&&head.rows[0].generation==='2'&&head.rows[0].active_revision===String(staged.credentialRevision)&&
      head.rows[0].candidate_revision===null&&head.rows[0].consent_generation==='2'&&head.rows[0].state==='active','applied candidate head differs from the exact consented revision');
    const operations=await proof.query("SELECT operation_id::text,request_id::text,event_phase,operation_kind,evidence_kind,actor_member_id,outcome,expected_generation::text,result_generation::text,credential_revision::text,result_nonce,result_ciphertext FROM outside_custody_operations WHERE account_id=$1 ORDER BY event_phase,operation_kind",[accountId]);
    const claim=operations.rows.find(row=>row.event_phase==='claim'),result=operations.rows.find(row=>row.event_phase==='result');
    const lifecycleEvidence=operations.rows.filter(row=>row.event_phase==='operation');
    assert(operations.rows.length===7&&lifecycleEvidence.length===5&&
      lifecycleEvidence.some(row=>row.operation_kind==='publish'&&row.outcome==='published'&&row.evidence_kind==='descriptor-publication-v1')&&
      lifecycleEvidence.some(row=>row.operation_kind==='accept'&&row.outcome==='accepted'&&row.actor_member_id===editor&&row.evidence_kind==='descriptor-acceptance-v1')&&
      lifecycleEvidence.some(row=>row.operation_kind==='activation-preview'&&row.outcome==='previewed')&&
      lifecycleEvidence.some(row=>row.operation_kind==='stage'&&row.outcome==='staged'&&row.evidence_kind==='activation-review-v1')&&
      lifecycleEvidence.some(row=>row.operation_kind==='apply'&&row.outcome==='applied')&&
      claim?.outcome==='claimed'&&result?.outcome==='completed'&&claim.request_id===requestId&&result.request_id===requestId&&
      claim.expected_generation==='0'&&claim.result_generation==='1'&&result.expected_generation==='0'&&result.result_generation==='1',
      'durable discovery and authenticated custody lifecycle evidence differ from the expected outcomes');
    const revision=await proof.query("SELECT generation::text,credential_revision::text,consent_generation::text,encode(policy_hash,'hex') AS policy_hash FROM outside_custody_revisions WHERE account_id=$1 AND revision_purpose='discovery'",[accountId]);
    assert(revision.rows.length===1,'discovery credential revision missing');
    const executableRevision=await proof.query("SELECT generation::text,credential_revision::text,consent_generation::text,revision_purpose FROM outside_custody_revisions WHERE account_id=$1 AND revision_purpose='executable'",[accountId]);
    assert(executableRevision.rows.length===1&&executableRevision.rows[0]?.generation==='2'&&
      executableRevision.rows[0]?.credential_revision===String(staged.credentialRevision)&&executableRevision.rows[0]?.consent_generation==='2',
      'executable candidate revision does not match the applied consent');
    const coordinates={ownerMemberId:owner,accountId,agentName:agent,connectionName:'fixture',requestId,
      claimOperationId, resultOperationId:result.operation_id,generation:Number(revision.rows[0].generation),
      credentialRevision:Number(revision.rows[0].credential_revision),consentGeneration:Number(revision.rows[0].consent_generation),
      policyHash:revision.rows[0].policy_hash};
    const aad=Buffer.from(canonical(['lares-outside-discovery-result-v1',coordinates]));
    const decipher=createDecipheriv('aes-256-gcm',proofKey,result.result_nonce as Buffer);
    decipher.setAAD(aad);decipher.setAuthTag((result.result_ciphertext as Buffer).subarray(-16));
    const plaintext=Buffer.concat([decipher.update((result.result_ciphertext as Buffer).subarray(0,-16)),decipher.final()]);
    assert(plaintext.toString('utf8')===canonical(document),'authenticated result plaintext differs from returned projection');
    let alteredAadRejected=false;
    try{
      const altered={...coordinates,requestId:randomUUID()};
      const tampered=createDecipheriv('aes-256-gcm',proofKey,result.result_nonce as Buffer);
      tampered.setAAD(Buffer.from(canonical(['lares-outside-discovery-result-v1',altered])));
      tampered.setAuthTag((result.result_ciphertext as Buffer).subarray(-16));
      tampered.update((result.result_ciphertext as Buffer).subarray(0,-16));tampered.final();
    }catch{alteredAadRejected=true;}
    plaintext.fill(0);
    assert(alteredAadRejected,'changing authenticated result coordinates was accepted');
    partial.checks.push('durable result decrypts under generated key/AAD and rejects changed request identity');
    const peer=JSON.parse(readFileSync(need('FIXTURE_PEER_REPORT'),'utf8')) as PeerState;
    assert(peer.methods.join(',')==='initialize,notifications/initialized,tools/list,tools/list'&&peer.requestCount===4&&peer.bearerMatches&&
      peer.tlsServername&&peer.pathMatches&&peer.protocolVersionMatches&&peer.initializeMatches&&peer.paginationCursorMatches&&peer.sessionMatches,
      'local peer did not observe exact authorized TLS discovery exchange');
    const unchanged=await proof.query('SELECT d.hash,d.definition,r.applied_definition,r.ownership_token,r.runtime_control_token,r.pending FROM agent_definitions d JOIN agent_resources r USING(name) WHERE d.name=$1',[agent]);
    assert(unchanged.rows.length===1&&unchanged.rows[0].hash===definitionHash&&canonical(unchanged.rows[0].definition)===canonical(definition)&&
      canonical(unchanged.rows[0].applied_definition)===canonical(definition)&&unchanged.rows[0].ownership_token===incarnation&&
      unchanged.rows[0].runtime_control_token===incarnation&&unchanged.rows[0].pending===false,'saved executable definition/resource changed');
    partial.checks.push('executable definition, ownership and applied state remain unchanged');
    partial.executionProof=await proveSignedExecution({main,outside,proof,store,root,secretsDir:config.secretsDir,agent,incarnation,
      owner,editor,org,sessionToken:session,definition,definitionHash,accountId,activeRevision:candidateRevision,generation:applied.generation,
      routePolicyHash:route.policyHash,phase:startPhase,evidence:value=>{partial.executionProof=value}});
    partial.checks.push('signed broker executes exact approvals and refuses stale or mismatched work without peer dispatch');
    partial.success=true;
    writeReport(output,partial);
  }catch(error){
    const safePhases=new Set(['configuration','role identities','neutral authorization fixture','outside custody organisation gate contention',
      'outside custody human review and activation','signed outside execution','outside replacement preservation','outside execution revocation','same-bridge direct-path control',
      'routed direct-path control','generated route admission','outside discovery preview','outside discovery preview response',
      'prepare outside consent request','outside consent and discover','outside consent and discover response','direct-path firewall counter',
      'routed direct-path firewall counter','database discovery','durable result verification']);
    const failure:{phase:string;reason:string;recoveryStage?:NonNullable<OutsideCustodyRecoveryRequired['stage']>;
      routeBoundary?:RouteBoundaryFailure;
      acknowledgementReason?:OutsideRouteAcknowledgementFailure;category:SafeOperationFailureCategory}={
      phase:safePhases.has(phase)?phase:'worker',reason:'configured outside discovery worker failed',
      category:safeOperationFailureCategory(error)};
    if(error instanceof OutsideCustodyRecoveryRequired&&error.stage)failure.recoveryStage=error.stage;
    if(phase==='generated route admission'){
      const boundary=routeBoundaryFailure?.();
      if(boundary){
        failure.routeBoundary=boundary;
        const acknowledgement=routeAcknowledgementReason?.();
        if(boundary==='route-acknowledgement'&&acknowledgement)failure.acknowledgementReason=acknowledgement;
      }
    }
    failureRecord=failure;
    const peerDiagnostics=safePeerDiagnostics();
    writeReport(output,{...partial,...(peerDiagnostics?{peerDiagnostics}:{}),failure});
    throw new Error('configured outside discovery proof failed');
  }finally{
    key?.fill(0);
    proofKey?.fill(0);
    credential?.fill(0);
    store?.close();
    let shutdownFailed=false;
    try{await store?.drainForShutdown();}catch{shutdownFailed=true;}
    const pools=[main,outside,admin,proof].filter((pool):pool is Pool=>Boolean(pool));
    const ended=await Promise.allSettled(pools.map(pool=>pool.end()));
    if(shutdownFailed||ended.some(result=>result.status==='rejected')){
      writeReport(output,{...partial,success:false,shutdownFailure:true,
        failure:failureRecord??{phase:'worker',reason:'configured outside discovery worker failed',category:'unknown'}});
      throw new Error('configured outside discovery pool shutdown failed');
    }
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='peer')await peer();
  else if(process.argv[2]==='control-peer')await controlPeer();
  else if(process.argv[2]==='run')await runConfigured();
  else throw new Error('fixture mode required');
}
