/* CI-only worker and local TLS peer for outside-discovery-image.probe.py. */
import {createHash,randomUUID,createDecipheriv,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
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
import {loadBoundOutsideCustodyKey,OutsideCustodyStore} from '../lib/outside-custody.js';
import {lockOutsideHumanSession} from '../lib/outside-custody.js';
import {withDefinitionNamespace} from '../lib/definition-namespace.js';
import {consoleSourceTransaction} from '../../../packages/agent-kit/src/console-source-transaction.js';
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
  protocolVersionMatches:boolean;initializeMatches:boolean;paginationCursorMatches:boolean;sessionMatches:boolean};
function persistPeer(path:string,state:PeerState){writeReport(path,state);}
async function peer():Promise<void>{
  const path=need('FIXTURE_PEER_REPORT');
  const state:PeerState={ready:false,methods:[],requestCount:0,bearerMatches:true,tlsServername:true,pathMatches:true,
    protocolVersionMatches:true,initializeMatches:true,paginationCursorMatches:true,sessionMatches:true};
  const server=https.createServer({key:readFileSync('/fixture/certs/server.key'),cert:readFileSync('/fixture/certs/server.pem')},(request,response)=>{
    const chunks:Buffer[]=[];let size=0;
    request.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>32768){request.destroy();return;}chunks.push(chunk);});
    request.on('end',()=>{
      state.requestCount++;
      state.bearerMatches&&=request.headers.authorization===`Bearer ${need('FIXTURE_BEARER')}`;
      state.pathMatches&&=request.url==='/mcp?fixture=outside-proof-v1';
      state.protocolVersionMatches&&=request.headers['mcp-protocol-version']==='2025-06-18';
      state.sessionMatches&&=(state.requestCount===1?request.headers['mcp-session-id']===undefined:request.headers['mcp-session-id']==='fixture-session');
      let body:Record<string,unknown>;
      try{body=JSON.parse(Buffer.concat(chunks,size).toString('utf8')) as Record<string,unknown>;}catch{response.writeHead(400).end();return;}
      const method=typeof body.method==='string'?body.method:'';state.methods.push(method);persistPeer(path,state);
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
        state.paginationCursorMatches&&=(state.methods.filter(value=>value==='tools/list').length===1
          ?cursor===undefined:cursor==='fixture-page-2');
        persistPeer(path,state);
        const result=cursor===undefined?{tools:[{name:'lookup_alpha',description:'Neutral lookup A',inputSchema:{type:'object',properties:{}}}],nextCursor:'fixture-page-2'}:
          {tools:[{name:'lookup_beta',description:'Neutral lookup B',inputSchema:{type:'object',properties:{}}}]};
        const rpc={jsonrpc:'2.0',id,result};
        response.writeHead(200,{'content-type':cursor===undefined?'application/json':'text/event-stream'});
        response.end(cursor===undefined?JSON.stringify(rpc):`event: message\ndata: ${JSON.stringify(rpc)}\n\n`);return;
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

function firewallTableProjection(text:string,family:'inet'|'bridge'):{hook:string;rules:string[];packets?:bigint}|undefined{
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
      const normalized=canonicalFirewallRule(line);
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
function canonicalFirewallRule(raw:string):string|undefined{
  const line=raw.trim().replace(/\s+/g,' ');
  const source=line.match(/^(ether type ip )?ip saddr != \{ (.+) \} accept$/);
  if(source){
    const members=source[2]!.split(', ').map(canonicalIPv4Prefix);
    if(members.some(member=>!member)||new Set(members).size!==members.length)return undefined;
    const sortedMembers=(members as string[]).sort();
    return `${source[1]??''}ip saddr != { ${sortedMembers.join(', ')} } accept`;
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
  const generated=firewallTableProjection(stageText,family),live=firewallTableProjection(liveText,family);
  const hook=family==='inet'?'type filter hook forward priority -10; policy accept;':
    'type filter hook forward priority 0; policy accept;';
  if(!generated||!live||generated.hook!==hook||live.hook!==hook||
      !validGeneratedFirewallProjection(family,generated.rules)||
      JSON.stringify(generated.rules)!==JSON.stringify(live.rules)||live.packets===undefined)return undefined;
  const hash=createHash('sha256').update(JSON.stringify({family,hook,rules:generated.rules})).digest('hex');
  return {hash,packets:live.packets};
}
function firewallProjectionDiagnostic(stageText:string,liveText:string,family:'inet'|'bridge'):ProjectionDiagnostic{
  const generated=firewallTableProjection(stageText,family),live=firewallTableProjection(liveText,family);
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

async function runConfigured():Promise<void>{
  const output=need('FIXTURE_WORKER_REPORT');
  const partial:{success:boolean;firewallApplied:boolean;directTargetBlocked:boolean;directPathDiagnostics?:{
    control:SocketObservation|{status:'not-attempted'};before:FirewallCounterReports;direct:SocketObservation|{status:'not-attempted'};
    after:FirewallCounterReports|{status:'not-attempted'};inetCounterIncreased:boolean;bridgeCounterIncreased:boolean};
    routedPathDiagnostics?:{control:SocketObservation|{status:'not-attempted'};before:FirewallCounterReports;
      direct:SocketObservation|{status:'not-attempted'};after:FirewallCounterReports|{status:'not-attempted'};
      inetCounterIncreased:boolean;bridgeCounterIncreased:boolean};checks:string[]}={
    success:false,firewallApplied:false,directTargetBlocked:false,checks:[]};
  let main:Pool|undefined,outside:Pool|undefined,admin:Pool|undefined,proof:Pool|undefined,store:OutsideCustodyStore|undefined,
    key:Buffer|undefined,proofKey:Buffer|undefined,credential:Buffer|undefined;
  let routeBoundaryFailure:(()=>RouteBoundaryFailure|undefined)|undefined;
  let routeAcknowledgementReason:(()=>OutsideRouteAcknowledgementFailure|undefined)|undefined;
  let phase='configuration';
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

    phase='role identities';
    const appIdentity=await main.query('SELECT current_user,session_user');
    const outsideIdentity=await outside.query('SELECT current_user,session_user');
    assert(appIdentity.rows[0]?.current_user==='lares_app'&&appIdentity.rows[0]?.session_user==='lares_app','application pool identity mismatch');
    assert(outsideIdentity.rows[0]?.current_user==='lares_outside_custody'&&outsideIdentity.rows[0]?.session_user==='lares_outside_custody','outside pool identity mismatch');
    partial.checks.push('actual configured lares_app and lares_outside_custody logins');

    phase='neutral authorization fixture';
    const session=need('FIXTURE_SESSION_TOKEN'),editorSession=randomBytes(32).toString('base64url');
    const sessionHash=createHash('sha256').update(session).digest('hex');
    const template=JSON.parse(readFileSync(new URL('../../../packages/agent-kit/templates/chief-of-staff/definition.json',import.meta.url),'utf8')) as Record<string,unknown>;
    const definition=definitionSchema.parse({...template,name:agent,role:'chief-of-staff',channels:[],doors:[],
      grants:[{capability:'outside',scope:'read'}],autonomy:{outside:'gated'},skills:[],
      outsideTools:[{name:'fixture',url:'https://mcp.example.org/mcp?fixture=outside-proof-v1',description:'Neutral bounded CI lookup',token:true,
        tools:{allow:['lookup_alpha','lookup_beta'],read:['lookup_alpha','lookup_beta']}}]});
    const duties='',voice='',definitionHash=hashOf({definition,dutiesMd:duties,voiceMd:voice});
    await proof.query("INSERT INTO orgs(id,display_name) VALUES($1,'Outside proof organization')",[org]);
    await proof.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES($1,'Fixture owner',$3,'owner','active'),($2,'Fixture editor',$3,'member','active')",[owner,editor,org]);
    await proof.query("INSERT INTO org_member_policy(user_id,allowed_capabilities,may_create_agents) VALUES($1,ARRAY['outside'],true),($2,ARRAY['outside'],false)",[owner,editor]);
    await proof.query('INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\')',
      [randomUUID(),owner,sessionHash]);
    await proof.query('INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\')',
      [randomUUID(),editor,createHash('sha256').update(editorSession).digest('hex')]);
    phase='outside custody organisation gate contention';
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

    phase='same-bridge direct-path control';
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
    phase='routed direct-path control';
    const routedControl=await tlsControlEvidence('routed.mcp.example.org',need('FIXTURE_ROUTED_GATEWAY'),
      need('FIXTURE_SOURCE_IP'),Number(need('FIXTURE_ROUTED_PORT')));
    partial.routedPathDiagnostics.control=routedControl;
    assert(routedControl.tlsCompleted&&routedControl.socketClosed&&routedControl.lookupAddress===need('FIXTURE_ROUTED_GATEWAY')&&
      routedControl.assignedSourceAddress===need('FIXTURE_SOURCE_IP')&&routedControl.connectedPeerAddress===need('FIXTURE_ROUTED_GATEWAY'),
      'routed direct-path control did not verify the bound source and published gateway peer');

    phase='generated route admission';
    await withDefinitionNamespace(main,()=>lifecycle.saved(agent,definition));
    partial.firewallApplied=true;
    const route=await lifecycle.reviewOutsideRoute('https://mcp.example.org/mcp?fixture=outside-proof-v1',Date.now()+5000);
    assert(route.sourceAddress===need('FIXTURE_SOURCE_IP')&&route.proxyUrl==='http://lares-egress-proxy:8888/','actual route did not match configured source/proxy');
    partial.checks.push('public saved lifecycle installed and acknowledged generated route without native authority');

    phase='direct-path firewall counter';
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
    assert(bridgeTargetBlocked,'same-bridge direct target attempt did not produce a closed socket and bridge-family drop');

    phase='routed direct-path firewall counter';
    const routed=await directTargetEvidence('routed.mcp.example.org','/',need('FIXTURE_ROUTED_GATEWAY'),
      need('FIXTURE_SOURCE_IP'),Number(need('FIXTURE_ROUTED_PORT')));
    partial.routedPathDiagnostics.direct=routed;
    const routedAfter=await firewallCounters();
    partial.routedPathDiagnostics.after=counterReports(routedAfter);
    const routedInetCounterIncreased=familyCounterIncreased(routedBefore.inet,routedAfter.inet);
    const routedBridgeCounterIncreased=familyCounterIncreased(routedBefore.bridge,routedAfter.bridge);
    partial.routedPathDiagnostics.inetCounterIncreased=routedInetCounterIncreased;
    partial.routedPathDiagnostics.bridgeCounterIncreased=routedBridgeCounterIncreased;
    const routedTargetBlocked=routedBefore.inet.failure==='none'&&routedBefore.bridge.failure==='none'&&
      routedAfter.inet.failure==='none'&&routedAfter.bridge.failure==='none'&&
      !routed.tlsCompleted&&routed.socketClosed&&routed.lookupAddress===need('FIXTURE_ROUTED_GATEWAY')&&
      (!routed.assignedSourceAddress||routed.assignedSourceAddress===need('FIXTURE_SOURCE_IP'))&&
      (!routed.connectedPeerAddress||routed.connectedPeerAddress===need('FIXTURE_ROUTED_GATEWAY'))&&
      routedInetCounterIncreased&&!routedBridgeCounterIncreased;
    partial.directTargetBlocked=bridgeTargetBlocked&&routedTargetBlocked;
    assert(partial.directTargetBlocked,'direct paths did not both close before TLS with their required family counters');
    partial.checks.push('same-bridge direct target closes before TLS and increments the bridge-family drop counter',
      'routed direct target closes before TLS and increments the inet-family drop counter after a verified positive control');

    const deadlineAtMs=Date.now()+7000;
    const capture=await store.previewDiscovery(session,{agentName:agent,connectionName:'fixture'},{deadlineAtMs});
    const endpointHash=createHash('sha256').update(JSON.stringify(['lares-outside-endpoint-v1','https://mcp.example.org/mcp?fixture=outside-proof-v1'])).digest('hex');
    const accountId=randomUUID(),requestId=randomUUID(),claimOperationId=randomUUID();
    credential=Buffer.from(need('FIXTURE_BEARER'),'ascii');
    const document=await store.consentAndDiscover(session,{requestId,operationId:claimOperationId,accountId,agentName:agent,
      connectionName:'fixture',expectedGeneration:0,expectedCandidateRevision:null,
      expectedDefinitionHash:capture.agent.definitionHash,expectedAccessRevision:capture.agent.accessRevision,
      expectedDestinationHash:endpointHash,expectedRoutePolicyHash:route.policyHash,consentGeneration:1,credential},{deadlineAtMs});
    credential.fill(0);credential=undefined;
    assert(document.protocolVersion==='2025-06-18'&&document.serverInfo.name==='local-fixture'&&document.tools.length===2&&
      document.tools[0]?.name==='lookup_alpha'&&document.tools[1]?.name==='lookup_beta','configured discovery projection differs');
    partial.checks.push('normal consentAndDiscover returned bounded two-page JSON and SSE projection');

    phase='outside custody human review and activation';
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
    partial.success=true;
    writeReport(output,partial);
  }catch{
    const safePhases=new Set(['configuration','role identities','neutral authorization fixture','outside custody organisation gate contention',
      'outside custody human review and activation','same-bridge direct-path control',
      'routed direct-path control','generated route admission','direct-path firewall counter',
      'routed direct-path firewall counter','database discovery','durable result verification']);
    const failure:{phase:string;reason:string;routeBoundary?:RouteBoundaryFailure;
      acknowledgementReason?:OutsideRouteAcknowledgementFailure}={
      phase:safePhases.has(phase)?phase:'worker',reason:'configured outside discovery worker failed'};
    if(phase==='generated route admission'){
      const boundary=routeBoundaryFailure?.();
      if(boundary){
        failure.routeBoundary=boundary;
        const acknowledgement=routeAcknowledgementReason?.();
        if(boundary==='route-acknowledgement'&&acknowledgement)failure.acknowledgementReason=acknowledgement;
      }
    }
    writeReport(output,{...partial,failure});
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
      writeReport(output,{...partial,success:false,failure:{phase:'worker',reason:'configured outside discovery worker failed'}});
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
