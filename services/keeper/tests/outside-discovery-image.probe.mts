/* CI-only worker and local TLS peer for outside-discovery-image.probe.py. */
import {createHash,randomUUID,createDecipheriv} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import https from 'node:https';
import type {Socket} from 'node:net';
import {Pool} from 'pg';
import {definitionSchema,hashOf} from '../../../packages/agent-kit/src/definition.js';
import {PgGrantStore} from '../../../packages/agent-kit/src/grant-store.js';
import {AgentLifecycle} from '../lib/lifecycle.js';
import {ownedDocker} from '../lib/docker.js';
import {keeperOutsideCustodyPool,keeperPool,loadKeeperConfig} from '../lib/config.js';
import {loadBoundOutsideCustodyKey,OutsideCustodyStore} from '../lib/outside-custody.js';
import {withDefinitionNamespace} from '../lib/definition-namespace.js';

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
function assert(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message);}

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

async function directTargetEvidence(host:string,path:string):Promise<{tlsCompleted:boolean;socketClosed:boolean}>{
  return await new Promise(resolve=>{
    let tlsCompleted=false,socketClosed=false,requestClosed=false,socket:Socket|undefined,settled=false;
    let closeTimeout:ReturnType<typeof setTimeout>|undefined,requestTimer:ReturnType<typeof setTimeout>|undefined;
    const finish=()=>{
      if(settled||!requestClosed)return;
      if(requestTimer)clearTimeout(requestTimer);
      if(socket&&!socketClosed){
        if(!closeTimeout)closeTimeout=setTimeout(()=>{settled=true;resolve({tlsCompleted,socketClosed:false});},1500);
        return;
      }
      settled=true;if(closeTimeout)clearTimeout(closeTimeout);resolve({tlsCompleted,socketClosed:true});
    };
    const request=https.get({hostname:host,port:443,path,agent:false,rejectUnauthorized:true},response=>{
      tlsCompleted=true;response.destroy();request.destroy();
    });
    request.once('socket',value=>{
      socket=value;
      value.once('secureConnect',()=>{tlsCompleted=true;});
      value.once('close',()=>{socketClosed=true;finish();});
    });
    request.once('error',()=>{});
    request.once('close',()=>{requestClosed=true;finish();});
    requestTimer=setTimeout(()=>request.destroy(),1200);
  });
}

async function firewallDropPackets():Promise<number>{
  const owner=need('FIXTURE_OWNER'),name='lares-outside-counter-'+owner.slice(0,10)+'-'+randomUUID().slice(0,6);
  const output=execFileSync('docker',['run','--rm','--name',name,'--label','lares.proof.owner='+owner,
    '--network','host','--read-only','--cap-drop','ALL',
    '--cap-add','NET_ADMIN','--security-opt','no-new-privileges:true','--entrypoint','nft',need('FIXTURE_FIREWALL_IMAGE'),
    'list','table','inet','lares_egress'],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','ignore']});
  const match=output.match(/counter packets (\d+) bytes \d+ drop/);
  assert(match,'generated firewall drop counter is unavailable');
  return Number(match[1]);
}

async function runConfigured():Promise<void>{
  const output=need('FIXTURE_WORKER_REPORT');
  const partial:{success:boolean;firewallApplied:boolean;directTargetBlocked:boolean;checks:string[]}={
    success:false,firewallApplied:false,directTargetBlocked:false,checks:[]};
  let main:Pool|undefined,outside:Pool|undefined,admin:Pool|undefined,proof:Pool|undefined,store:OutsideCustodyStore|undefined,
    key:Buffer|undefined,proofKey:Buffer|undefined,credential:Buffer|undefined;
  let phase='configuration';
  try{
    const root=need('FIXTURE_ROOT'),agent=need('FIXTURE_AGENT'),owner='outside-proof-owner',org='outside-proof-org';
    const incarnation=need('FIXTURE_INCARNATION');
    const config=loadKeeperConfig(root+'/config/keeper.json');
    assert(config.mode==='rendered'&&config.lifecycle&&config.outsideCustody,'actual Keeper config did not load');
    main=keeperPool(config.db,{max:4,connectionTimeoutMillis:3000,query_timeout:12000});
    outside=keeperOutsideCustodyPool(config,{max:4,connectionTimeoutMillis:3000,query_timeout:12000});
    admin=keeperPool(config.lifecycle.adminDb,{max:1,connectionTimeoutMillis:3000,query_timeout:12000});
    assert(outside,'configured outside custody pool was not created');
    key=loadBoundOutsideCustodyKey(config.outsideCustody.keyFile,config.outsideCustody.keyFingerprint);
    const lifecycle=new AgentLifecycle(main,admin,config.lifecycle,{mode:'rendered',agentsDir:config.agentsDir,
      secretsDir:config.secretsDir,outsideCustody:config.outsideCustody},ownedDocker({...config.lifecycle,project:config.project,dir:config.dir}));
    store=new OutsideCustodyStore(outside,key,{mainPool:main,lifecycle});
    key.fill(0);key=undefined;
    proofKey=Buffer.from(need('FIXTURE_KEY_HEX'),'hex');
    delete env.FIXTURE_KEY_HEX;
    proof=new Pool({host:'proof-db',port:5432,database:'proof',user:'proof',password:need('PROOF_ADMIN_PASSWORD'),
      max:1,connectionTimeoutMillis:3000,query_timeout:12000});

    phase='role identities';
    const appIdentity=await main.query('SELECT current_user,session_user');
    const outsideIdentity=await outside.query('SELECT current_user,session_user');
    assert(appIdentity.rows[0]?.current_user==='lares_app'&&appIdentity.rows[0]?.session_user==='lares_app','application pool identity mismatch');
    assert(outsideIdentity.rows[0]?.current_user==='lares_outside_custody'&&outsideIdentity.rows[0]?.session_user==='lares_outside_custody','outside pool identity mismatch');
    partial.checks.push('actual configured lares_app and lares_outside_custody logins');

    phase='neutral authorization fixture';
    const session=need('FIXTURE_SESSION_TOKEN');
    const sessionHash=createHash('sha256').update(session).digest('hex');
    const template=JSON.parse(readFileSync(new URL('../../../packages/agent-kit/templates/chief-of-staff/definition.json',import.meta.url),'utf8')) as Record<string,unknown>;
    const definition=definitionSchema.parse({...template,name:agent,role:'chief-of-staff',channels:[],doors:[],
      grants:[{capability:'outside',scope:'read'}],autonomy:{outside:'gated'},skills:[],
      outsideTools:[{name:'fixture',url:'https://mcp.example.org/mcp?fixture=outside-proof-v1',description:'Neutral bounded CI lookup',token:true,
        tools:{allow:['lookup_alpha','lookup_beta'],read:['lookup_alpha','lookup_beta']}}]});
    const duties='',voice='',definitionHash=hashOf({definition,dutiesMd:duties,voiceMd:voice});
    await proof.query("INSERT INTO orgs(id,display_name) VALUES($1,'Outside proof organization')",[org]);
    await proof.query("INSERT INTO users(id,display_name,org_id,org_role,status) VALUES($1,'Fixture owner',$2,'owner','active')",[owner,org]);
    await proof.query("INSERT INTO org_member_policy(user_id,allowed_capabilities,may_create_agents) VALUES($1,ARRAY['outside'],true)",[owner]);
    await proof.query('INSERT INTO member_sessions(id,member_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\')',
      [randomUUID(),owner,sessionHash]);
    await proof.query("INSERT INTO agent_definitions(name,definition,duties,voice,hash,status) VALUES($1,$2::jsonb,$3,$4,$5,'valid')",
      [agent,JSON.stringify(definition),duties,voice,definitionHash]);
    await proof.query("INSERT INTO agent_resources(name,address,workflow_database,ownership,ownership_token,runtime_control_token,state,applied_definition,pending) VALUES($1,$2::inet,$3,'owned',$4,$4,'ready',$5::jsonb,false)",
      [agent,need('FIXTURE_AGENT_IP'),'lares_'+randomUUID().replaceAll('-',''),incarnation,JSON.stringify(definition)]);
    const grants=new PgGrantStore(main);
    const adopted=await grants.adoptAgent(owner,{agentName:agent,expectedDefinitionHash:definitionHash},{designatedOwnerMemberId:owner});
    const access=await grants.updateAgentAccess(owner,{agentName:agent,expectedRevision:adopted.accessRevision,
      grants:[{principal:{kind:'organisation',id:org},permission:'use',expiresAt:null}]});
    assert(access.accessRevision>adopted.accessRevision,'real grant store did not establish use access');
    partial.checks.push('neutral definition, finite human session and real owner adoption/use grant');

    phase='generated route admission';
    await withDefinitionNamespace(main,()=>lifecycle.saved(agent,definition));
    partial.firewallApplied=true;
    const route=await lifecycle.reviewOutsideRoute('https://mcp.example.org/mcp?fixture=outside-proof-v1',Date.now()+5000);
    assert(route.sourceAddress===need('FIXTURE_SOURCE_IP')&&route.proxyUrl==='http://lares-egress-proxy:8888/','actual route did not match configured source/proxy');
    partial.checks.push('public saved lifecycle installed and acknowledged generated route without native authority');

    phase='direct-path firewall counter';
    const directBefore=await firewallDropPackets();
    const direct=await directTargetEvidence('mcp.example.org','/mcp?fixture=outside-proof-v1');
    const directAfter=await firewallDropPackets();
    partial.directTargetBlocked=!direct.tlsCompleted&&direct.socketClosed&&directAfter>directBefore;
    assert(partial.directTargetBlocked,'direct target attempt did not produce a closed socket and selected-source firewall drop');
    partial.checks.push('direct target traffic increments generated drop counter and closes TCP before TLS');

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

    const head=await proof.query('SELECT generation::text,active_revision::text,candidate_revision::text,consent_generation::text,state FROM outside_custody_accounts WHERE account_id=$1',[accountId]);
    assert(head.rows.length===1&&head.rows[0].generation==='1'&&head.rows[0].active_revision===null&&head.rows[0].candidate_revision===null&&head.rows[0].consent_generation==='1'&&head.rows[0].state==='active','discovery changed executable head/candidate state');
    const operations=await proof.query("SELECT operation_id::text,request_id::text,event_phase,outcome,expected_generation::text,result_generation::text,credential_revision::text,result_nonce,result_ciphertext FROM outside_custody_operations WHERE account_id=$1 ORDER BY event_phase",[accountId]);
    const claim=operations.rows.find(row=>row.event_phase==='claim'),result=operations.rows.find(row=>row.event_phase==='result');
    assert(operations.rows.length===2&&claim?.outcome==='claimed'&&result?.outcome==='completed'&&claim.request_id===requestId&&result.request_id===requestId&&
      claim.expected_generation==='0'&&claim.result_generation==='1'&&result.expected_generation==='0'&&result.result_generation==='1',
      'durable claim/result pair was not recorded at the expected generation');
    const revision=await proof.query('SELECT generation::text,credential_revision::text,consent_generation::text,encode(policy_hash,\'hex\') AS policy_hash FROM outside_custody_revisions WHERE account_id=$1',[accountId]);
    assert(revision.rows.length===1,'discovery credential revision missing');
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
    const safePhases=new Set(['configuration','role identities','neutral authorization fixture','generated route admission',
      'direct-path firewall counter','database discovery','durable result verification']);
    writeReport(output,{...partial,failure:{phase:safePhases.has(phase)?phase:'worker',reason:'configured outside discovery worker failed'}});
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

if(process.argv[2]==='peer')await peer();
else if(process.argv[2]==='run')await runConfigured();
else throw new Error('fixture mode required');
