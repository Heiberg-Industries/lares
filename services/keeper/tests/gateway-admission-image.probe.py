"""CI-only adapter proof in the original digest-pinned LiteLLM image.

The authority below is a disposable HTTPS fixture, never an adapter option. This proves
the wire/client/native-auth integration, not production admission/prices/recovery.
Native-budget diagnostics remain a separate, unchanged experiment.
"""
import concurrent.futures
import base64
import hashlib
import io
import json
import os
import pathlib
import re
import selectors
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from urllib.parse import quote

REPO = pathlib.Path(__file__).resolve().parents[3]
ASSETS = REPO / "images/gateway-runtime"
sys.path.insert(0, str(ASSETS))
from admission_contract import Profile, canonical

STARTUP_PHASES = frozenset(("process-starting", "preflight-passed", "preflight-failed", "native-app-import", "native-app-import-failed", "asgi-server", "asgi-server-failed", "native-lifespan-starting", "native-lifespan-complete", "native-lifespan-failed", "native-lifespan-error", "runtime-validation-failed", "ready"))
STARTUP_STAGES = frozenset(("not-started", "runtime-imports", "runtime-flags", "callback-registry", "callback-types", "callback-native-identity", "callback-native-types", "callback-proxy-hook-types", "callback-native-membership", "callback-native-coverage", "callback-native-cost", "callback-secondary", "callback-identity", "router-aliases", "router-deployment-count", "router-target", "router-retries", "native-auth", "complete"))
CASE_CLASSIFICATIONS = frozenset(("retry", "recoverable", "terminal"))
CASE_PREDICATES = frozenset(("sdkSuccessful", "sdkFailed", "sdkRequestCountOne", "admissionRefused", "notAdmissionRefused", "budgetExceeded", "notBudgetExceeded", "terminalClassification", "physicalExactlyOne", "noPhysicalRequest", "noTrap", "expectedRouteExactlyOne", "otherRoutesUnchanged", "gateExactlyOne", "noGateRequest", "settlementExactlyOne", "noSettlement", "receiptExactlyOne", "observationExactlyOne"))

FIXTURE = r'''
import http.server,ssl,threading,json,time,pathlib,hashlib,uuid,sys,gzip
sys.path.insert(0,'/adapter')
from admission_contract import sign,verify,canonical,ADMIT_PATH,SETTLE_PATH
key=pathlib.Path('/fixture/service-key').read_bytes()
lock=threading.Lock(); release=threading.Event(); release.set()
data={'mode':'normal','upstream':0,'routes':{'chat':0,'messages':0,'other':0},'traps':0,'gates':0,'receipts':[],'observations':[],'allows':[],'seen':set()}
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a): pass
 def respond(self,status,document,signed=False,compress=False):
  raw=canonical(document)
  if compress:raw=gzip.compress(raw)
  self.send_response(status);self.send_header('content-type','application/json');self.send_header('content-length',str(len(raw)))
  if compress:self.send_header('content-encoding','gzip')
  if signed:self.send_header('x-lares-signature',sign(key,'response','POST',self.path,raw))
  self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  if self.path!='/control':self.respond(404,{});return
  with lock: self.respond(200,{k:v for k,v in data.items() if k!='seen'})
 def do_POST(self):
  raw=self.rfile.read(int(self.headers.get('content-length','0')));body=json.loads(raw)
  if self.path=='/control':
   with lock:data.update(body)
   if body.get('hold'):release.clear()
   else:release.set()
   self.respond(200,{});return
  if self.path in (ADMIT_PATH,SETTLE_PATH):
   if not verify(key,self.headers.get('x-lares-signature'),'request','POST',self.path,raw):self.respond(401,{});return
   if self.path==SETTLE_PATH:
    with lock:data['receipts'].append(body)
    self.respond(200,{'version':1,'state':'recorded','receiptHash':body['receiptHash'],'nonce':body['nonce']},True);return
   with lock:
    data['gates']+=1
    data['observations'].append({k:v for k,v in body.items() if k!='ticket'})
    duplicate=body['ticket'] in data['seen'];data['seen'].add(body['ticket'])
    mode=data['mode']
   release.wait(10)
   if mode=='gate_hang':time.sleep(6)
   if mode=='gate_close':self.connection.close();return
   if duplicate or mode=='deny':self.respond(200,{'version':1,'state':'denied'},True);return
   reply={k:v for k,v in body.items() if k!='ticket'}
   reply.update({'state':'allowed','attemptId':str(uuid.uuid4()),'bindingId':str(uuid.uuid4()),'validForMs':3000})
   if mode=='mismatch':reply['requestHash']='f'*64
   with lock:data['allows'].append(reply)
   self.respond(200,reply,mode!='unsigned');return
  with lock:
   data['upstream']+=1
   data['routes']['chat' if self.path=='/v1/chat/completions' else 'messages' if self.path=='/v1/messages' else 'other']+=1
  if self.path=='/trap':
   with lock:data['traps']+=1
   self.respond(500,{});return
  if self.path not in ('/v1/chat/completions','/v1/messages'):self.respond(404,{});return
  with lock:mode=data['mode']
  if mode=='redirect':self.send_response(307);self.send_header('location','https://fixture:8443/trap');self.send_header('content-length','0');self.end_headers();return
  if mode=='disconnect':self.connection.close();return
  if mode=='timeout':time.sleep(35);self.respond(500,{});return
  errors={'429':(429,'rate_limit_error','fixture'), '500':(500,'api_error','fixture'), 'reformat':(400,'invalid_request_error','Conversation roles must alternate user/assistant'), 'signature':(400,'invalid_request_error','Invalid signature in thinking block')}
  if mode in errors:
   status,kind,message=errors[mode];self.respond(status,{'error':{'type':kind,'message':message}});return
  text='FIXTURE_OK';model=body['model']
  if self.path.endswith('chat/completions'):
   usage={'prompt_tokens':12,'completion_tokens':4,'total_tokens':16}
   if mode=='malformed-usage':usage={'prompt_tokens':12}
   if body.get('stream'):
    chunks=[{'id':'chatcmpl_fixture','object':'chat.completion.chunk','created':1,'model':model,'choices':[{'index':0,'delta':{'role':'assistant','content':text},'finish_reason':None}]}, {'id':'chatcmpl_fixture','object':'chat.completion.chunk','created':1,'model':model,'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]}, {'id':'chatcmpl_fixture','object':'chat.completion.chunk','created':1,'model':model,'choices':[],'usage':usage}]
    if mode=='missing-finish':chunks[1]['choices'][0]['finish_reason']=None
    if mode=='late-content':chunks.append(chunks[0])
    if mode=='mixed-id':chunks[-1]['id']='chatcmpl_other'
    wire=''.join('data: '+json.dumps(c)+'\n\n' for c in chunks)+'data: [DONE]\n\n'
   else:self.respond(200,{'id':'chatcmpl_fixture','object':'chat.completion','created':1,'model':model,'choices':[{'index':0,'message':{'role':'assistant','content':text},'finish_reason':None if mode=='missing-finish' else 'stop'}],'usage':usage},compress=mode=='compressed');return
  else:
   message={'id':'msg_fixture','type':'message','role':'assistant','model':model,'content':[{'type':'text','text':text}],'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':12,'output_tokens':4}}
   if mode=='missing-finish':message['stop_reason']=None
   if mode=='malformed-usage':message['usage']={'input_tokens':12}
   if not body.get('stream'):self.respond(200,message,compress=mode=='compressed');return
   start={**message,'content':[],'stop_reason':None,'usage':{'input_tokens':12,'output_tokens':0}}
   events=[('message_start',{'type':'message_start','message':start}),('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':text}}),('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':4}}),('message_stop',{'type':'message_stop'})]
   if mode=='missing-finish':events[-2][1]['delta']['stop_reason']=None
   if mode=='malformed-usage':events[-2][1]['usage']={}
   if mode in ('late-content','mixed-id'):events.append(events[2])
   wire=''.join('event: '+kind+'\ndata: '+json.dumps(d)+'\n\n' for kind,d in events)
  if mode=='partial':wire=wire.split('\n\n',1)[0]+'\n\n'
  if mode=='stall-stream':
   first=wire.split('\n\n',3)[0:3];wire='\n\n'.join(first)+'\n\n'
   self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers();self.wfile.write(wire.encode());self.wfile.flush();time.sleep(5);self.close_connection=True;return
  wire=wire.encode()
  if mode=='compressed':wire=gzip.compress(wire)
  self.send_response(200);self.send_header('content-type','text/event-stream');self.send_header('content-length',str(len(wire)))
  if mode=='compressed':self.send_header('content-encoding','gzip')
  self.end_headers();self.wfile.write(wire);self.wfile.flush()
server=http.server.ThreadingHTTPServer(('0.0.0.0',8443),Handler)
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain('/fixture/ca.pem','/fixture/tls-key.pem');server.socket=context.wrap_socket(server.socket,server_side=True)
threading.Thread(target=server.serve_forever,daemon=True).start()
http.server.ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
'''

CLIENT = r'''
import{readFileSync,writeFileSync}from'node:fs';import{createHash,randomUUID}from'node:crypto';import{createRequire}from'node:module';import{pathToFileURL}from'node:url';
const x=JSON.parse(readFileSync(0,'utf8'));const original=globalThis.fetch;let requests=0,hash;
if(x.kind==='control'){const r=await original('http://fixture:8080/control',{...(x.body?{method:'POST',body:JSON.stringify(x.body),headers:{'content-type':'application/json'}}:{})});console.log(await r.text());}
else if(x.kind==='sdk'){
 globalThis.fetch=async(input,init)=>{requests++;if(typeof init?.body!=='string'||init.body.includes(PROMPT_CACHE_BOUNDARY)||(x.lane==='anthropic'&&!init.body.includes('cache_control')))throw Error('fixture body was not shaped');const headers=new Headers(init?.headers);headers.set('x-lares-budget-intent',x.ticket);const path=new URL(typeof input==='string'?input:input.url).pathname;hash=createHash('sha256').update('lares.gateway.raw-request.v1\0POST\0'+path+'\0').update(init.body).digest('hex');return original(input,{...init,headers});};
 const require=createRequire('/app/services/chief-of-staff/package.json');const{generateText,streamText}=await import(pathToFileURL(require.resolve('ai')).href);
 const{createGatewayProvider}=await import('/app/packages/agent-kit/src/gateway-provider.ts');const{captureModelInvocation,runModelInvocation}=await import('/app/packages/agent-kit/src/model-invocation.ts');
 const{PROMPT_CACHE_BOUNDARY}=await import('/app/packages/agent-kit/src/prompt-cache.ts');
 const{isBudgetAdmissionRefused,isBudgetExceeded,respondToTurnFailed,respondToSessionFailed}=await import('/app/packages/agent-kit/src/gateway-budget.ts');
 const{classifyModelCallError}=await import(pathToFileURL(require.resolve('eve').split('/dist/')[0]+'/dist/src/harness/model-call-error.js').href);
 process.env.GATEWAY_LANE=x.lane;process.env.GATEWAY_URL=x.url;process.env.GATEWAY_KEY_FILE='/tmp/key-'+process.pid;writeFileSync(process.env.GATEWAY_KEY_FILE,x.key,{mode:0o600});
 const{gatewayModel}=createGatewayProvider({defaultKeyFile:process.env.GATEWAY_KEY_FILE});
 const id=randomUUID();const invocation=captureModelInvocation({type:'step.started',data:{turnId:id,sequence:0,stepIndex:0}},{id,auth:{initiator:null,current:null}},'lares-brain');
 try{await runModelInvocation(invocation,async()=>{const args={model:gatewayModel('lares-brain'),system:'stable fixture instructions\n'+PROMPT_CACHE_BOUNDARY+'\nmoving fixture context',prompt:'fixture',maxOutputTokens:8,maxRetries:0,abortSignal:AbortSignal.timeout(x.timeout??10000)};if(x.stream){const result=streamText(args);let text='';for await(const part of result.textStream)text+=part;if(!text.includes('FIXTURE_OK'))throw Error('fixture text missing');}else{const result=await generateText(args);if(!result.text.includes('FIXTURE_OK'))throw Error('fixture text missing');}});console.log(JSON.stringify({ok:true,requests,hash}));}
 catch(error){const options={refusalText:'CAP_EXHAUSTED',dialect:'telegram'};console.log(JSON.stringify({ok:false,requests,hash,admission:isBudgetAdmissionRefused(error),budget:isBudgetExceeded(error),classification:classifyModelCallError(error),turn:respondToTurnFailed(error,options),session:respondToSessionFailed(error,options)}));}
}else{
 const abort=new AbortController();const method=x.method??'POST';const headers=new Headers(method==='GET'?{}:{'content-type':'application/json'});if(x.key)headers.set('authorization','Bearer '+x.key);if(x.ticket)headers.set('x-lares-budget-intent',x.ticket);if(Array.isArray(x.headers)){for(const [name,value] of x.headers)headers.append(name,value);}else for(const [name,value] of Object.entries(x.headers??{}))headers.set(name,value);const response=await original(x.url+x.path,{method,signal:abort.signal,headers,...(method==='GET'?{}:{body:typeof x.raw==='string'?x.raw:JSON.stringify(x.body)})});if(x.cancel){await response.body.getReader().read();abort.abort();console.log(JSON.stringify({status:response.status,cancelled:true}));}else{const raw=await response.text();let body;try{body=JSON.parse(raw)}catch{body={stream:raw.includes('FIXTURE_OK')}}console.log(JSON.stringify({status:response.status,body}));}
}
'''

def command(*args, input=None, timeout=120):
    result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode: raise RuntimeError("Fixture command failed: " + args[0])
    return result.stdout.strip()


def require(condition, message):
    if not condition: raise RuntimeError(message)


def bounded_capture(*args, maximum=16384, seconds=10, binary=False):
    """CI diagnostics only: bound bytes/time before any output enters an artifact."""
    process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    captured=bytearray();truncated=False;deadline=time.monotonic()+seconds
    try:
        with selectors.DefaultSelector() as ready:
            ready.register(process.stdout,selectors.EVENT_READ)
            while time.monotonic()<deadline:
                if not ready.select(max(0,deadline-time.monotonic())):truncated=True;break
                chunk=os.read(process.stdout.fileno(),min(4096,maximum+1-len(captured)))
                if not chunk:break
                captured.extend(chunk)
                if len(captured)>maximum:truncated=True;break
            else:truncated=True
    finally:
        if process.poll() is None:process.kill()
        try:process.wait(timeout=2)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
        process.stdout.close()
    if truncated:
        # Never retain a sliced secret/URL at the end of an overlong line.
        captured=captured[:maximum].rsplit(b"\n",1)[0] if b"\n" in captured[:maximum] else b""
        captured+=b"\n[diagnostic output truncated]"
    return bytes(captured) if binary else captured.decode("utf8",errors="replace")


def sanitize_diagnostic(value, secrets_to_hide):
    for secret in secrets_to_hide:
        representations={secret.hex(),secret.hex().upper(),str(secret),repr(secret),str(list(secret))}
        for encoded in (base64.b64encode(secret).decode(),base64.urlsafe_b64encode(secret).decode()):representations.update((encoded,encoded.rstrip("=")))
        try:
            decoded=secret.decode("utf8")
            representations.update((decoded,quote(decoded,safe=""),json.dumps(decoded)[1:-1]))
        except UnicodeError:pass
        representations.update(json.dumps(candidate)[1:-1] for candidate in list(representations))
        for candidate in sorted(representations,key=len,reverse=True):
            if candidate:value=value.replace(candidate,"[redacted fixture secret]")
    value=re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]","",value)
    value=re.sub(r"(?i)\b(?:https?|postgres(?:ql)?|redis)://[^\s\"'<>]+","[redacted URL]",value)
    value=re.sub(r"(?i)\b(?:bearer\s+[^\s\"'<>]+|sk-[A-Za-z0-9_-]+|(?:authorization|x-api-key|api_key|password|secret|token)[\"']?\s*[:=]\s*[\"']?(?:bearer\s+)?[^\s,}\"']+)","[redacted credential]",value)
    value=re.sub(r"\b[A-Za-z0-9_+/=-]{32,}\b","[redacted token-like value]",value)
    return "".join(char for char in value if char in "\n\t" or ord(char)>=32)[:16384]


def valid_callback_startup_checks(checks):
    roles = ("max_budget_limiter", "parallel_request_limiter", "cache_control_check", "responses_id_security",
             "litellm_skills", "max_iterations_limiter", "max_budget_per_session_limiter", "sensitive_data_routing")
    events = ("input_callback", "_async_input_callback", "success_callback", "failure_callback", "_async_success_callback", "_async_failure_callback", "service_callback", "audit_log_callbacks")
    def fields(value, booleans, counts):
        return (type(value) is dict and set(value) == set(booleans + counts)
                and all(type(value[name]) is bool for name in booleans)
                and all(type(value[name]) is int and 0 <= value[name] <= 31 for name in counts))
    if type(checks) is not dict or set(checks) != {"primary", "native", "proxy_hooks", "events"}: return False
    if not fields(checks["primary"], ("list", "unique_types"), ("gateway_count", "db_count", "unknown_count", "unowned_count", "unknown_mapping_count")): return False
    if type(checks["native"]) is not dict or set(checks["native"]) != {"model_budget", "service"}: return False
    if not all(fields(value, ("owner_type", "owner_present"), ("count",)) for value in checks["native"].values()): return False
    if type(checks["proxy_hooks"]) is not dict or set(checks["proxy_hooks"]) != set(roles): return False
    if not all(fields(value, ("mapped", "mapped_type", "mapped_present"), ("count",)) for value in checks["proxy_hooks"].values()): return False
    if type(checks["events"]) is not dict or set(checks["events"]) != set(events): return False
    return all(fields(value, ("list", "unique_objects"), ("primary_count", "db_count", "shadow_count", "router_count", "unknown_count")) for value in checks["events"].values())


def validated_startup_marker(raw):
    if len(raw)>8192:return "unknown"
    try:
        marker=json.loads(raw)
        if type(marker) is not dict or set(marker) not in ({"phase","stage"}, {"phase","stage","checks"}):return "unknown"
        if marker["phase"] not in STARTUP_PHASES or marker["stage"] not in STARTUP_STAGES:return "unknown"
        if "checks" in marker and not valid_callback_startup_checks(marker["checks"]):return "unknown"
        return marker
    except (ValueError,TypeError):return "unknown"


def startup_marker_from_archive(raw,filename):
    if len(raw)>16384:return "unknown"
    try:
        with tarfile.open(fileobj=io.BytesIO(raw),mode="r:") as archive:
            members=archive.getmembers()
            if len(members)!=1:return "unknown"
            member=members[0]
            if member.name!=filename or not member.isreg() or member.size>8192:return "unknown"
            with archive.extractfile(member) as source:return validated_startup_marker(source.read(8193))
    except (tarfile.TarError,OSError,ValueError,TypeError):return "unknown"


def fixed_startup_log_markers(raw):
    markers=[]
    for stage in sorted(STARTUP_STAGES):
        if "Gateway admission runtime validation failed: "+stage in raw:markers.append("runtime-validation-failed:"+stage)
    if "lares: gateway admission preflight passed" in raw:markers.append("preflight-passed")
    return markers


class Proof:
    def __init__(self, role_image, output):
        require(os.environ.get("CI") == "true", "Image proof runs only in disposable CI")
        self.image, self.output = role_image, pathlib.Path(output)
        self.manifest = json.loads((REPO / "releases/2026-10-21-rc.12.json").read_text())
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="lares-admission-proof-")); self.root.chmod(0o755)
        self.name = "lares-admission-" + uuid.uuid4().hex[:10]
        self.containers = []
        self.artifact = {"scope":"pinned-image adapter compatibility; no production authority or price/recovery acceptance", "cases":[]}
        self.current_case = None
        self.cooldown_idle_seconds = None
        self.master = "sk-" + secrets.token_urlsafe(32)
        self.disposable_secrets=[self.master.encode()]

    def run(self, suffix, image, arguments, command_args):
        name = self.name + "-" + suffix
        self.containers.append(name)
        command("docker", "run", "-d", "--name", name, "--network", self.name, *arguments, image, *command_args)
        return name

    def sql(self, statement):
        return command("docker", "exec", "-i", self.name+"-db", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "proof", "-d", "litellm", "-At", input=statement)

    def client(self, document):
        # The source modules use .js imports that tsx resolves to their .ts sources.
        return json.loads(command("docker", "exec", "-i", self.name+"-client", "node", "--import", "/app/services/chief-of-staff/node_modules/tsx/dist/loader.mjs", "--input-type=module", "-e", CLIENT, input=json.dumps(document), timeout=40))

    def control(self, **changes): return self.client({"kind":"control", **({"body":changes} if changes else {})})

    def wait(self, check, reason, seconds=120):
        deadline = time.monotonic()+seconds
        while time.monotonic()<deadline:
            try:
                if check(): return
            except Exception: pass
            time.sleep(.25)
        raise RuntimeError(reason)

    def config(self, provider):
        # Render with actual committed TypeScript, using the built role's dependencies.
        script = "import{renderGatewayConfig,gatewayAdmissionProfile}from'/app/services/box/lib/gateway-config.ts';import{createRequire}from'node:module';const{parse}=createRequire('/app/services/box/package.json')('yaml');const o="+json.dumps({"alias":"lares-brain","providerModel":provider+"/"+("gpt-4o-mini" if provider=="openai" else "claude-sonnet-4-5"),"providerBaseUrl":"https://fixture:8443"+("/v1" if provider=="openai" else "")})+";console.log(JSON.stringify({config:parse(renderGatewayConfig(o)),profile:gatewayAdmissionProfile(o)}));"
        return json.loads(command("docker", "exec", self.name+"-client", "/app/services/chief-of-staff/node_modules/.bin/tsx", "-e", script))

    def setup(self):
        command("docker","network","create","--internal",self.name)
        self.artifact["internalNetwork"] = command("docker","network","inspect","--format","{{.Internal}}",self.name)=="true"
        require(self.artifact["internalNetwork"], "Proof network permits external egress")
        for role in ("db", "lares-gateway"):
            image=self.manifest["images"][role];require("@sha256:" in image,"Image is not digest pinned");command("docker","pull",image,timeout=300)
        for filename,value in {"master":self.master,"provider":"sk-fixture-provider","password":secrets.token_urlsafe(32)}.items():
            (self.root/filename).write_text(value);(self.root/filename).chmod(0o600)
            self.disposable_secrets.append(value.encode())
        (self.root/"service-key").write_bytes(secrets.token_bytes(32));(self.root/"service-key").chmod(0o600)
        self.disposable_secrets.append((self.root/"service-key").read_bytes())
        self.native_barrier=self.root/"native-probe-barrier"
        self.native_barrier.write_text("idle");self.native_barrier.chmod(0o600)
        self.native_expected=self.root/"native-probe-expected"
        self.native_expected.write_text("");self.native_expected.chmod(0o600)
        command("openssl","req","-x509","-newkey","rsa:2048","-nodes","-keyout",str(self.root/"tls-key.pem"),"-out",str(self.root/"ca.pem"),"-days","1","-subj","/CN=fixture","-addext","subjectAltName=DNS:fixture")
        (self.root/"fixture.py").write_text(FIXTURE)
        mount=["--mount",f"type=bind,src={self.root},dst=/fixture,readonly"]
        assets=["--mount",f"type=bind,src={ASSETS},dst=/adapter,readonly"]
        self.run("db",self.manifest["images"]["db"],[*mount,"--network-alias","db","-e","POSTGRES_USER=proof","-e","POSTGRES_DB=litellm","-e","POSTGRES_PASSWORD_FILE=/fixture/password"],[])
        self.wait(lambda:command("docker","exec",self.name+"-db","pg_isready","-U","proof","-d","litellm").endswith("accepting connections"),"Fixture database failed")
        self.run("fixture",self.manifest["images"]["lares-gateway"],[*mount,*assets,"--network-alias","fixture","--entrypoint","python","-e","PYTHONDONTWRITEBYTECODE=1"],["/fixture/fixture.py"])
        # The client receives only the probe source, protected master-key file, and fixed phase barrier.
        client_mounts=[
            "--mount",f"type=bind,src={REPO}/services/box/lib/gateway-config.ts,dst=/app/services/box/lib/gateway-config.ts,readonly",
            "--mount",f"type=bind,src={REPO}/services/keeper/tests/live/litellm-member-credential.live.mts,dst=/app/services/keeper/tests/live/litellm-member-credential.live.mts,readonly",
            "--mount",f"type=bind,src={REPO}/services/keeper/lib/budget-native-client.ts,dst=/app/services/keeper/lib/budget-native-client.ts,readonly",
            "--mount",f"type=bind,src={self.root/'master'},dst=/tmp/gateway-master-key,readonly",
            "--mount",f"type=bind,src={self.native_barrier},dst=/run/lares-native-probe-barrier",
            "--mount",f"type=bind,src={self.native_expected},dst=/run/lares-native-probe-expected",
            "--user","0:0","--entrypoint","node",
        ]
        self.run("client",self.image,client_mounts,["-e","setInterval(()=>{},60000)"])
        self.wait(lambda:self.control().get("mode")=="normal","HTTPS fixture failed")

    def start_gateway(self, provider, broken=None):
        suffix="gateway-"+provider+("-"+broken if broken else "")
        folder=self.root/suffix;folder.mkdir()
        document=self.config(provider)
        if broken=="hook":document["config"]["litellm_settings"]["callbacks"]=[]
        if broken=="callback":document["config"]["litellm_settings"]["callbacks"].append("prometheus")
        if broken=="duplicate":document["config"]["litellm_settings"]["callbacks"].append("lares_gateway.gateway_hook")
        (folder/"config.yaml").write_bytes(canonical(document["config"]));(folder/"profile.json").write_bytes(canonical(document["profile"]))
        arguments=["--network-alias",suffix,"--mount",f"type=bind,src={self.root},dst=/fixture,readonly","--mount",f"type=bind,src={folder}/config.yaml,dst=/etc/litellm/config.yaml,readonly","--mount",f"type=bind,src={ASSETS},dst=/opt/lares-gateway,readonly","--entrypoint","/bin/sh"]
        env={"MODEL_PROVIDER_KEY_FILE":"/fixture/provider","GATEWAY_MASTER_KEY_FILE":"/fixture/master","DATABASE_PASSWORD_FILE":"/fixture/password","PGHOST":"db","PGPORT":"5432","PGDATABASE":"litellm","PGUSER":"proof","LARES_GATEWAY_PROFILE_FILE":"/fixture/"+suffix+"/profile.json","LARES_GATEWAY_ADMISSION_URL":"https://fixture:8443","LARES_GATEWAY_ENDPOINT_HASH":"a"*64,"LARES_GATEWAY_SERVICE_KEY_FILE":"/fixture/service-key","SSL_CERT_FILE":"/fixture/ca.pem","LITELLM_LOCAL_MODEL_COST_MAP":"True","LITELLM_TELEMETRY":"False","PYTHONDONTWRITEBYTECODE":"1","CI":"true","LARES_GATEWAY_PROBE_DIAGNOSTICS":"1"}
        if broken=="authority":env.pop("LARES_GATEWAY_ADMISSION_URL")
        if broken=="profile":env["LARES_GATEWAY_PROFILE_FILE"]="/fixture/no-profile.json"
        if broken=="service-key":env["LARES_GATEWAY_SERVICE_KEY_FILE"]="/fixture/no-service-key"
        for k,v in env.items():arguments += ["-e",k+"="+v]
        name=self.run(suffix,self.manifest["images"]["lares-gateway"],arguments,["/opt/lares-gateway/start.sh"])
        url="http://"+suffix+":4000"
        try:
            if broken:
                self.wait(lambda:command("docker","inspect","--format","{{.State.Running}}",name)=="false","Broken runtime started",30)
                expected=2 if broken=="authority" else 78
                require(command("docker","inspect","--format","{{.State.ExitCode}}",name)==str(expected),"Broken runtime did not explicitly refuse configuration")
                logs=bounded_capture("docker","logs","--tail","40",name)
                marker="LARES_GATEWAY_ADMISSION_URL required" if broken=="authority" else "lares: gateway admission configuration is missing or invalid"
                require(marker in logs,"Broken runtime failed before configuration validation")
                return None
            self.wait(lambda:self.client({"url":url,"path":"/health/readiness","method":"GET","key":self.master})["status"]==200,"Guarded gateway did not become ready",180)
        except Exception:
            self.startup_diagnostic(name,suffix)
            raise
        meta=json.loads(command("docker","exec",name,"python","-c","import importlib.metadata,json,hashlib,pathlib;from litellm.constants import DEFAULT_COOLDOWN_TIME_SECONDS;print(json.dumps({'versions':{p:importlib.metadata.version(p) for p in ['litellm','openai','httpx','prisma']},'adapterSha256':hashlib.sha256(pathlib.Path('/opt/lares-gateway/lares_gateway.py').read_bytes()).hexdigest(),'cooldownSeconds':DEFAULT_COOLDOWN_TIME_SECONDS}))"))
        self.artifact.setdefault("images",{})[provider]={"upstreamDigest":self.manifest["images"]["lares-gateway"],**meta}
        require(meta["versions"]["litellm"]=="1.101.6","Wrong LiteLLM version")
        require(type(meta["cooldownSeconds"]) is int and meta["cooldownSeconds"]==5,"Unexpected pinned gateway cooldown default")
        self.cooldown_idle_seconds=meta["cooldownSeconds"]+1
        return url

    def start_native_admin(self, provider="openai"):
        """Start LiteLLM itself on the same disposable digest/database/internal network.

        This separate listener proves native admin APIs that Lares intentionally does not
        expose through the guarded gateway's fixed route allowlist.
        """
        suffix="native-admin-contract"
        folder=self.root/suffix;folder.mkdir()
        document=self.config(provider)["config"]
        settings=document.get("litellm_settings",{})
        settings.pop("callbacks",None)
        document["litellm_settings"]=settings
        (folder/"config.yaml").write_text(json.dumps(document)) # JSON is a YAML subset; no secret values are embedded.
        script=self.root/"native-admin-start.sh"
        script.write_text("""#!/bin/sh
set -eu
LARES_MODEL_PROVIDER_KEY=$(cat /fixture/provider); export LARES_MODEL_PROVIDER_KEY
LARES_GATEWAY_MASTER_KEY=$(cat /fixture/master); export LARES_GATEWAY_MASTER_KEY
LARES_DATABASE_PASSWORD=$(cat /fixture/password)
DATABASE_URL="postgresql://${PGUSER}:${LARES_DATABASE_PASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"; export DATABASE_URL
LARES_DATABASE_PASSWORD=
CONFIG_FILE_PATH=/fixture/native-admin-contract/config.yaml; export CONFIG_FILE_PATH
LITELLM_RUST=False; DISABLE_AIOHTTP_TRANSPORT=True; export LITELLM_RUST DISABLE_AIOHTTP_TRANSPORT
litellm --config "$CONFIG_FILE_PATH" --skip_server_startup --enforce_prisma_migration_check
exec litellm --config "$CONFIG_FILE_PATH"
""");script.chmod(0o700)
        arguments=["--network-alias",suffix,"--mount",f"type=bind,src={self.root},dst=/fixture,readonly","--mount",f"type=bind,src={folder}/config.yaml,dst=/etc/litellm/config.yaml,readonly","--entrypoint","/bin/sh"]
        # The entrypoint script is inside the read-only fixture mount; no secrets enter argv.
        env={"PGHOST":"db","PGPORT":"5432","PGDATABASE":"litellm","PGUSER":"proof","LITELLM_LOCAL_MODEL_COST_MAP":"True","LITELLM_TELEMETRY":"False"}
        for k,v in env.items():arguments += ["-e",k+"="+v]
        self.run(suffix,self.manifest["images"]["lares-gateway"],arguments,["/fixture/native-admin-start.sh"])
        url="http://"+suffix+":4000"
        health="fetch('http://native-admin-contract:4000/health/liveliness',{redirect:'manual',signal:AbortSignal.timeout(3000)}).then(r=>console.log(r.status)).catch(()=>console.log('0'))"
        self.wait(lambda:command("docker","exec",self.name+"-client","node","-e",health)=="200","Native contract listener did not become ready",120)
        return url

    def native_membership_db_check(self, team_id, user_id):
        if not re.fullmatch(r"[0-9a-f-]{36}",team_id) or not re.fullmatch(r"probe-[0-9a-f-]{36}",user_id): return None
        names=("member-match-unique","budget-cap-exact","budget-duration-exact","models-exact",
            "team-defaults-exact","team-blocked-false","team-metadata-empty","user-defaults-exact",
            "user-role-exact","member-role-exact")
        statement = f'''SELECT
          ((SELECT count(*)=1 FROM "LiteLLM_TeamMembership" WHERE user_id='{user_id}' AND team_id='{team_id}'))::text || '|' ||
          (EXISTS (SELECT 1 FROM "LiteLLM_TeamMembership" m JOIN "LiteLLM_BudgetTable" b ON b.budget_id=m.budget_id
            WHERE m.user_id='{user_id}' AND m.team_id='{team_id}' AND b.max_budget=2))::text || '|' ||
          (EXISTS (SELECT 1 FROM "LiteLLM_TeamMembership" m JOIN "LiteLLM_BudgetTable" b ON b.budget_id=m.budget_id
            WHERE m.user_id='{user_id}' AND m.team_id='{team_id}' AND b.budget_duration='1d'))::text || '|' ||
          (EXISTS (SELECT 1 FROM "LiteLLM_TeamMembership" m JOIN "LiteLLM_BudgetTable" b ON b.budget_id=m.budget_id
            WHERE m.user_id='{user_id}' AND m.team_id='{team_id}' AND b.allowed_models=ARRAY['lares-brain']::text[]))::text || '|' ||
          (EXISTS (SELECT 1 FROM "LiteLLM_TeamTable" WHERE team_id='{team_id}' AND max_budget=4
            AND models=ARRAY['lares-brain']::text[] AND budget_duration='1d'))::text || '|' ||
          (EXISTS (SELECT 1 FROM "LiteLLM_TeamTable" WHERE team_id='{team_id}' AND blocked IS FALSE))::text || '|' ||
          (EXISTS (SELECT 1 FROM "LiteLLM_TeamTable" WHERE team_id='{team_id}'
            AND COALESCE(metadata::text,'{{}}') IN ('{{}}','null')))::text || '|' ||
          ((SELECT count(*)=1 FROM "LiteLLM_UserTable" WHERE user_id='{user_id}')
            AND EXISTS (SELECT 1 FROM "LiteLLM_UserTable" WHERE user_id='{user_id}' AND max_budget=3
              AND models=ARRAY[]::text[]
              AND COALESCE(metadata::text,'{{}}') IN ('{{}}','null') AND organization_id IS NULL)
            AND (SELECT count(*)=0 FROM "LiteLLM_VerificationToken" WHERE user_id='{user_id}'))::text || '|' ||
          (EXISTS (SELECT 1 FROM "LiteLLM_UserTable" WHERE user_id='{user_id}' AND user_role='internal_user'))::text || '|' ||
          (EXISTS (SELECT 1 FROM "LiteLLM_TeamTable" t WHERE t.team_id='{team_id}' AND
            (SELECT count(*)=1 FROM jsonb_array_elements(COALESCE(t.members_with_roles,'[]')::jsonb) r
              WHERE r->>'user_id'='{user_id}' AND r->>'role'='user')))::text'''
        values=self.sql(statement).split("|")
        if len(values)!=len(names) or any(value not in ("true","false") for value in values): return None
        return dict(zip(names,(value=="true" for value in values),strict=True))

    def native_key_db_check(self, token, team_id, user_id):
        if not re.fullmatch(r"[a-f0-9]{64}",token) or not re.fullmatch(r"[0-9a-f-]{36}",team_id) or not re.fullmatch(r"probe-[0-9a-f-]{36}",user_id): return None
        names=("normal-key-policy-exact","normal-key-blocked-false")
        statement = f'''SELECT ((SELECT count(*)=1 FROM "LiteLLM_VerificationToken" WHERE user_id='{user_id}') AND EXISTS
          (SELECT 1 FROM "LiteLLM_VerificationToken" WHERE token='{token}' AND key_type='llm_api'
          AND key_alias LIKE 'probe-%' AND max_budget=1 AND budget_duration='1d'
          AND models=ARRAY['lares-brain']::text[]
          AND COALESCE(metadata::text,'{{}}') IN ('{{}}','null') AND COALESCE(config::text,'{{}}') IN ('{{}}','null')
          AND team_id='{team_id}' AND user_id='{user_id}' AND budget_id IS NULL AND project_id IS NULL AND organization_id IS NULL)
          AND EXISTS (SELECT 1 FROM "LiteLLM_TeamMembership" m WHERE m.user_id='{user_id}' AND m.team_id='{team_id}'))::text || '|' ||
          (EXISTS (SELECT 1 FROM "LiteLLM_VerificationToken" WHERE token='{token}' AND blocked IS FALSE))::text'''
        values=self.sql(statement).split("|")
        if len(values)!=len(names) or any(value not in ("true","false") for value in values): return None
        return dict(zip(names,(value=="true" for value in values),strict=True))

    def native_contract(self):
        report={"scope":"committed native probe in the exact pinned image; disposable internal-only fixture; no provider calls", "cases":[], "databaseCases":[], "findings":[], "diagnostics":[], "runtimeDiagnostics":[]}
        diagnostic_names={"normal-key-policy-exact","normal-key-blocked-false",
            "member-match-unique","budget-cap-exact","budget-duration-exact","models-exact",
            "team-defaults-exact","team-blocked-false","team-metadata-empty","user-defaults-exact","user-role-exact","member-role-exact",
            "duplicate-inventory-readable","duplicate-inventory-exact","native-db-query-readable"}
        runtime_names={"members-barrier-write-failed","members-expected-write-failed","key-barrier-write-failed",
            "key-expected-write-failed","barrier-ack-timeout","fixture-guard-failed","unexpected-probe-failure"}
        def add_diagnostic(name,outcome):
            if name not in diagnostic_names or outcome not in ("false","unknown"): return
            existing=next((item for item in report["diagnostics"] if item["name"]==name),None)
            if existing is None:report["diagnostics"].append({"name":name,"outcome":outcome})
            elif outcome=="false":existing["outcome"]="false"
        self.artifact["nativeCredentialContract"]=report
        expected=("fixture-guard","member-create-without-key","user-current-identity-global-cap-and-role",
            "user-info-no-auto-key","user-info-absent-is-not-refusal","user-info-refused-is-not-absence",
            "lost-user-create-response-reconciles-original-id","team-membership-and-caps","client-empty-key-inventory",
            "caller-key-exact-and-hash-lookup","client-populated-key-inventory","hash-lookup-absent-is-not-error",
            "hash-lookup-refused-is-not-absence","duplicate-key-create-does-not-overwrite","atomic-blocked-create",
            "blocked-key-readback-and-native-auth","client-blocked-key-policy-readback","unblocked-key-readback-and-native-auth",
            "lost-create-response-reconciles-by-hash","block-unblock-readback-only","delete-by-hash-and-reconcile-lost-response",
            "already-deleted-remains-absent","client-team-duration-and-membership-policy","fixture-cleanup")
        try:
            native_url=self.start_native_admin()
            self.native_barrier.write_text("idle")
            args=["docker","exec","-i","-e","CI=true","-e","LARES_DISPOSABLE_GATEWAY=1","-e","LARES_PROBE_CI_BARRIER=1",
                "-e","GATEWAY_URL="+native_url,"-e","GATEWAY_MASTER_KEY_FILE=/tmp/gateway-master-key","-e","GATEWAY_PROBE_MODEL=lares-brain",
                "-e","GATEWAY_PROBE_CI_BARRIER_FILE=/run/lares-native-probe-barrier","-e","GATEWAY_PROBE_CI_EXPECTED_FILE=/run/lares-native-probe-expected",self.name+"-client","node",
                "--import","/app/services/chief-of-staff/node_modules/tsx/dist/loader.mjs",
                "/app/services/keeper/tests/live/litellm-member-credential.live.mts"]
            process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            deadline=time.monotonic()+180
            checked_members=False;checked_key=False
            while process.poll() is None and time.monotonic()<deadline:
                try:phase=self.native_barrier.read_text()
                except OSError:phase=""
                if phase=="members-ready":
                    try:
                        expected_values=self.native_expected.read_text().splitlines()
                        checks=self.native_membership_db_check(*expected_values) if len(expected_values)==2 else None
                    except Exception:checks=None
                    outcome="unknown" if checks is None else "pass" if all(checks.values()) else "fail"
                    report["databaseCases"].append({"name":"native-db-member-and-no-key-rows","outcome":outcome})
                    if checks is None:add_diagnostic("native-db-query-readable","unknown")
                    else:
                        for name,value in checks.items():add_diagnostic(name,"false" if not value else "pass")
                    self.native_barrier.write_text("members-checked");checked_members=True
                elif phase=="key-ready":
                    try:
                        expected_values=self.native_expected.read_text().splitlines()
                        checks=self.native_key_db_check(*expected_values) if len(expected_values)==3 else None
                    except Exception:checks=None
                    outcome="unknown" if checks is None else "pass" if all(checks.values()) else "fail"
                    report["databaseCases"].append({"name":"native-db-key-hash-and-policy-row","outcome":outcome})
                    if checks is None:add_diagnostic("native-db-query-readable","unknown")
                    else:
                        for name,value in checks.items():add_diagnostic(name,"false" if not value else "pass")
                    self.native_barrier.write_text("key-checked");checked_key=True
                time.sleep(.05)
            if process.poll() is None:process.kill()
            stdout,_stderr=process.communicate(timeout=5)
            parsed=[]
            for line in stdout.splitlines()[:64]:
                match=re.fullmatch(r"(PASS|FAIL|UNKNOWN|UNSUPPORTED) ([a-z][a-z0-9-]+)",line)
                if match and match.group(2) in expected:parsed.append({"name":match.group(2),"outcome":match.group(1).lower()})
                diagnostic=re.fullmatch(r"DIAGNOSTIC ([a-z-]+) (false|unknown)",line)
                if diagnostic:add_diagnostic(diagnostic.group(1),diagnostic.group(2))
                runtime=re.fullmatch(r"DIAGNOSTIC ([a-z-]+)",line)
                if runtime and runtime.group(1) in runtime_names:report["runtimeDiagnostics"].append(runtime.group(1))
            by_name={item["name"]:item["outcome"] for item in parsed}
            report["cases"]=[{"name":name,"outcome":by_name.get(name,"unknown")} for name in expected]
            report["runnerCompleted"]=process.returncode==0 and len(by_name)==len(expected)
            if by_name.get("atomic-blocked-create")=="unsupported":report["findings"].append("atomic-blocked-create-unsupported")
            if not checked_members:report["databaseCases"].append({"name":"native-db-member-and-no-key-rows","outcome":"unknown"})
            if not checked_key:report["databaseCases"].append({"name":"native-db-key-hash-and-policy-row","outcome":"unknown"})
        except Exception:
            report["cases"]=[{"name":name,"outcome":"unknown"} for name in expected]
            report["databaseCases"]=[{"name":"native-db-member-and-no-key-rows","outcome":"unknown"},
                {"name":"native-db-key-hash-and-policy-row","outcome":"unknown"}]
            report["runtimeDiagnostics"].append("fixture-runner-failure")
        report["passed"]=report.get("runnerCompleted") is True and all(case["outcome"]=="pass" for case in report["cases"]+report["databaseCases"])

    def startup_diagnostic(self,name,label):
        record={"case":label}
        # A fixed first-failure file survives arbitrarily long shutdown traces.
        # docker cp also works after the process has exited; never exec or inspect env.
        for field,filename in (("firstFailure","lares-gateway-startup-first-failure.json"),("lastPhase","lares-gateway-startup-state.json")):
            try:
                raw=bounded_capture("docker","cp",name+":/tmp/"+filename,"-",maximum=16384,seconds=5,binary=True)
                record[field]=startup_marker_from_archive(raw,filename)
            except Exception:record[field]="unknown"
        try:
            template='{"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}},"error":{{json .State.Error}},"imageUser":{{json .Config.User}},"workingDirectory":{{json .Config.WorkingDir}}}'
            record["state"]=json.loads(bounded_capture("docker","inspect","--format",template,name,maximum=4096))
            scan=bounded_capture("docker","logs","--tail","400",name,maximum=65536,seconds=5)
            record["fixedLogMarkers"]=fixed_startup_log_markers(scan)
            record["logs"]=bounded_capture("docker","logs","--tail","40",name,maximum=8192,seconds=5)
        except Exception:record["diagnosticUnavailable"]=True
        # Never inspect the container environment or include an unsanitized log/error.
        safe=sanitize_diagnostic(json.dumps(record),self.disposable_secrets)
        self.artifact.setdefault("startupDiagnostics",[]).append(safe)

    def admin(self,url,path,body):
        result=self.client({"url":url,"path":path,"body":body,"key":self.master})
        require(result["status"]==200,"Native fixture provisioning refused")
        return result["body"]

    def provision(self,url,exact=False):
        team="team-"+uuid.uuid4().hex;member="member-"+uuid.uuid4().hex
        self.admin(url,"/team/new",{"team_id":team,"max_budget":100,"models":["lares-brain"],"budget_duration":"1d"})
        user={"user_id":member,"max_budget":100,"auto_create_key":False}
        if exact:user["user_role"]="internal_user"
        self.admin(url,"/user/new",user)
        self.admin(url,"/team/member_add",{"team_id":team,"max_budget_in_team":100,"member":{"role":"user","user_id":member}})
        key_request={"team_id":team,"user_id":member,"max_budget":100,"models":["lares-brain"],"budget_duration":"1d"}
        if exact:key_request.update({"blocked":False,"key_type":"llm_api"})
        result=self.admin(url,"/key/generate",key_request)
        self.disposable_secrets.append(result["key"].encode())
        return result["key"],team,member

    def sdk(self,url,key,lane,**opts):
        return self.client({"kind":"sdk","url":url,"key":key,"lane":lane,"ticket":secrets.token_urlsafe(32),**opts})

    def receipt(self, before, after, result, key, provider):
        fingerprint=hashlib.sha256(key.encode()).hexdigest()
        receipts=[r for r in after["receipts"][len(before["receipts"]):] if r["keyFingerprint"]==fingerprint]
        require(len(receipts)==1,"Terminal usage did not settle exactly once")
        receipt=receipts[0]
        observations=[o for o in after["observations"][len(before["observations"]):] if o["requestHash"]==result["hash"] and o["keyFingerprint"]==fingerprint]
        require(len(observations)==1,"Receipt did not match authenticated shaped request")
        observation=observations[0];allows=[a for a in after["allows"] if a["nonce"]==observation["nonce"]]
        require(len(allows)==1,"Receipt lacks a unique signed allow")
        for field in ("version","nonce","requestHash","profileHash","endpointHash","keyFingerprint","purposeAlias","attemptId","bindingId"):
            require(receipt[field]==allows[0][field],"Receipt binding differs from signed allow")
        require(receipt["kind"]=="terminal-usage" and receipt["format"]==provider and receipt["usage"]=={"inputTokens":12,"outputTokens":4,"cacheReadTokens":0,"cacheWriteTokens":0},"Terminal receipt usage/format differs from actual provider")

    def case(self,name,fn):
        record={"name":name,"passed":False}
        self.artifact["cases"].append(record)
        self.current_case=record
        try:
            fn()
            record["passed"]=True
        finally:
            self.current_case=None

    def idle_after_one_shot(self):
        """Let the pinned router's default deployment cooldown expire between cases."""
        if type(self.cooldown_idle_seconds) is int and 1 <= self.cooldown_idle_seconds <= 10:
            time.sleep(self.cooldown_idle_seconds)

    @staticmethod
    def diagnostic_count(value):
        return value if type(value) is int and 0 <= value <= 1_000_000 else None

    def diagnostic_route_count(self,document,route):
        routes=document.get("routes") if type(document) is dict else None
        return self.diagnostic_count(routes.get(route)) if type(routes) is dict else None

    def diagnostic_delta(self,before,after,key,route=None):
        def value(document):
            if type(document) is not dict:return None
            if route is not None:
                routes=document.get("routes")
                item=routes.get(route) if type(routes) is dict else None
            elif key in ("settlements","observations","allows"):
                rows=document.get({"settlements":"receipts","observations":"observations","allows":"allows"}[key])
                item=len(rows) if type(rows) is list else None
            else:item=document.get(key)
            return self.diagnostic_count(item)
        left,right=value(before),value(after)
        return right-left if left is not None and right is not None else None

    def diagnostic_matching_receipt_delta(self,before,after,fingerprint):
        def value(document):
            rows=document.get("receipts") if type(document) is dict else None
            if type(rows) is not list:return None
            return self.diagnostic_count(sum(type(row) is dict and row.get("keyFingerprint")==fingerprint for row in rows))
        left,right=value(before),value(after)
        return right-left if left is not None and right is not None else None

    def case_evidence(self,before,after,*,result=None,checks=None,started=None,route=None):
        """Store only fixed counters, booleans, enum values and elapsed time."""
        if self.current_case is None:return
        def count(document,key):
            return self.diagnostic_count(document.get(key)) if type(document) is dict else None
        def route_count(document,key):
            return self.diagnostic_route_count(document,key)
        def row_count(document,key):
            rows=document.get(key) if type(document) is dict else None
            return self.diagnostic_count(len(rows)) if type(rows) is list else None
        def settlements(document):
            receipts=document.get("receipts") if type(document) is dict else None
            return self.diagnostic_count(len(receipts)) if type(receipts) is list else None
        evidence={"counts":{
            "upstreamBefore":count(before,"upstream"),"upstreamAfter":count(after,"upstream"),
            "chatBefore":route_count(before,"chat"),"chatAfter":route_count(after,"chat"),
            "messagesBefore":route_count(before,"messages"),"messagesAfter":route_count(after,"messages"),
            "otherBefore":route_count(before,"other"),"otherAfter":route_count(after,"other"),
            "trapsBefore":count(before,"traps"),"trapsAfter":count(after,"traps"),
            "gatesBefore":count(before,"gates"),"gatesAfter":count(after,"gates"),
            "observationsBefore":row_count(before,"observations"),"observationsAfter":row_count(after,"observations"),
            "allowsBefore":row_count(before,"allows"),"allowsAfter":row_count(after,"allows"),
            "settlementsBefore":settlements(before),"settlementsAfter":settlements(after)}}
        if route in ("chat","messages","other"):
            evidence["expectedRoute"]=route
            evidence["counts"]["expectedRouteBefore"]=route_count(before,route)
            evidence["counts"]["expectedRouteAfter"]=route_count(after,route)
        if type(result) is dict:
            classification=result.get("classification")
            evidence["sdk"]={
                "ok":result.get("ok") if type(result.get("ok")) is bool else None,
                "requestCount":self.diagnostic_count(result.get("requests")),
                "admission":result.get("admission") if type(result.get("admission")) is bool else None,
                "budget":result.get("budget") if type(result.get("budget")) is bool else None,
                "classification":classification if type(classification) is str and classification in CASE_CLASSIFICATIONS else "unknown"}
        if type(checks) is dict:
            evidence["predicates"]={key:value for key,value in checks.items() if key in CASE_PREDICATES and type(value) is bool}
        if type(started) in (int,float):
            evidence["elapsedMs"]=min(120_000,max(0,int((time.monotonic()-started)*1000)))
        self.current_case["diagnostics"]=evidence

    def exercise(self,provider,url,key,team,member):
        for lane in ("anthropic","openai-compatible"):
            for stream in (False,True):
                def success():
                    self.control(mode="normal")
                    before=self.control();started=time.monotonic();result=self.sdk(url,key,lane,stream=stream);after=self.control()
                    route="chat" if provider=="openai" else "messages"
                    sdk=result if type(result) is dict else {}
                    checks={
                        "sdkSuccessful":sdk.get("ok") is True,"sdkRequestCountOne":sdk.get("requests")==1,
                        "physicalExactlyOne":self.diagnostic_delta(before,after,"upstream")==1,
                        "expectedRouteExactlyOne":self.diagnostic_delta(before,after,"routes",route)==1,
                        "otherRoutesUnchanged":all(self.diagnostic_delta(before,after,"routes",name)==(0 if name!=route else 1) for name in ("chat","messages","other")) and self.diagnostic_route_count(after,"other")==0,
                        "noTrap":self.diagnostic_count(after.get("traps"))==0,
                        "gateExactlyOne":self.diagnostic_delta(before,after,"gates")==1,
                        "settlementExactlyOne":self.diagnostic_delta(before,after,"settlements")==1,
                        "receiptExactlyOne":self.diagnostic_matching_receipt_delta(before,after,hashlib.sha256(key.encode()).hexdigest())==1,
                        "observationExactlyOne":self.diagnostic_delta(before,after,"observations")==1}
                    self.case_evidence(before,after,result=result,checks=checks,started=started,route=route)
                    require(result["ok"] and result["requests"]==1,"Actual SDK lane did not complete")
                    require(after["upstream"]-before["upstream"]==1,"SDK produced more than one upstream request")
                    require(after["routes"][route]-before["routes"][route]==1 and after["routes"]["other"]==0,"SDK reached unexpected provider route")
                    require(after["observations"][-1]["requestHash"]==result["hash"],"Final shaped raw request hash differs")
                    self.receipt(before,after,result,key,provider)
                self.case(provider+"-"+lane+("-stream" if stream else "-text"),success)
            for mode in ("deny","unsigned","mismatch","gate_hang","gate_close"):
                def refusal():
                    self.control(mode=mode);before=self.control();started=time.monotonic();result=self.sdk(url,key,lane);after=self.control()
                    sdk=result if type(result) is dict else {}
                    checks={"sdkFailed":sdk.get("ok") is False,"sdkRequestCountOne":sdk.get("requests")==1,
                        "admissionRefused":sdk.get("admission") is True,"notAdmissionRefused":sdk.get("admission") is False,
                        "budgetExceeded":sdk.get("budget") is True,"notBudgetExceeded":sdk.get("budget") is False,
                        "terminalClassification":sdk.get("classification")=="terminal",
                        "noPhysicalRequest":self.diagnostic_delta(before,after,"upstream")==0,
                        "noTrap":self.diagnostic_delta(before,after,"traps")==0,
                        "gateExactlyOne":self.diagnostic_delta(before,after,"gates")==1,
                        "noSettlement":self.diagnostic_delta(before,after,"settlements")==0}
                    self.case_evidence(before,after,result=result,checks=checks,started=started)
                    require(not result["ok"] and result["admission"] and not result["budget"] and result["classification"]=="terminal" and result["requests"]==1,"Authored refusal is not terminal/legible in actual SDK")
                    require(result["turn"]["kind"]=="budget-refusal" and result["session"]["kind"]=="silent","Refusal was not emitted once")
                    require(after["upstream"]==before["upstream"],"Gate refusal reached upstream")
                self.case(provider+"-"+lane+"-"+mode,refusal)
            for mode in ("429","500","redirect","disconnect","reformat","signature","timeout"):
                def one_shot():
                    self.control(mode=mode);before=self.control();started=time.monotonic();result=self.sdk(url,key,lane,timeout=35000 if mode=="timeout" else 10000);after=self.control()
                    route="chat" if provider=="openai" else "messages"
                    sdk=result if type(result) is dict else {}
                    checks={"sdkFailed":sdk.get("ok") is False,"physicalExactlyOne":self.diagnostic_delta(before,after,"upstream")==1,
                        "sdkRequestCountOne":sdk.get("requests")==1,
                        "expectedRouteExactlyOne":self.diagnostic_delta(before,after,"routes",route)==1,
                        "otherRoutesUnchanged":all(self.diagnostic_delta(before,after,"routes",name)==(0 if name!=route else 1) for name in ("chat","messages","other")) and self.diagnostic_route_count(after,"other")==0,
                        "noTrap":self.diagnostic_count(after.get("traps"))==0,
                        "gateExactlyOne":self.diagnostic_delta(before,after,"gates")==1,
                        "noSettlement":self.diagnostic_delta(before,after,"settlements")==0}
                    self.case_evidence(before,after,result=result,checks=checks,started=started,route=route)
                    require(not result["ok"],"Error fixture unexpectedly succeeded")
                    require(after["upstream"]-before["upstream"]==1 and after["traps"]==0,"Provider retry/redirect escaped guard")
                    if mode=="timeout":require(29<=time.monotonic()-started<34,"Physical header deadline was not enforced")
                    self.idle_after_one_shot()
                self.case(provider+"-"+lane+"-one-shot-"+mode,one_shot)
            for mode in ("missing-finish","malformed-usage","partial","late-content","mixed-id","compressed"):
                for streaming in (False,True):
                    if not streaming and mode in ("partial","late-content","mixed-id"): continue
                    def uncertain():
                        self.control(mode=mode);before=self.control();started=time.monotonic();result=self.sdk(url,key,lane,stream=streaming);after=self.control()
                        route="chat" if provider=="openai" else "messages"
                        checks={"physicalExactlyOne":self.diagnostic_delta(before,after,"upstream")==1,
                            "sdkRequestCountOne":(result if type(result) is dict else {}).get("requests")==1,
                            "expectedRouteExactlyOne":self.diagnostic_delta(before,after,"routes",route)==1,
                            "noTrap":self.diagnostic_delta(before,after,"traps")==0,
                            "noSettlement":self.diagnostic_delta(before,after,"settlements")==0}
                        self.case_evidence(before,after,result=result,checks=checks,started=started,route=route)
                        require(after["upstream"]-before["upstream"]==1,"Malformed terminal fixture retried")
                        require(len(after["receipts"])==len(before["receipts"]),"Uncertain provider usage reduced reservation")
                    self.case(provider+"-"+lane+"-reserve-"+mode+("-stream" if streaming else "-text"),uncertain)
        self.control(mode="normal")
        body={"model":"lares-brain","messages":[{"role":"user","content":"fixture"}],"max_tokens":8}
        for path,extra in [("/v1/responses",{}),("/health",{}),("/v1/messages?model=other",{}),("/anthropic/v1/messages",{}),("/v1/messages",{"headers":{"x-litellm-timeout":"100000"}}),("/v1/messages",{"body":{**body,"api_base":"https://fixture:8443/trap"}}),("/v1/messages",{"body":{**body,"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://fixture:8443/trap"}}]}]}})]:
            def unsupported():
                before=self.control();r=self.client({"url":url,"path":path,"key":key,"ticket":secrets.token_urlsafe(32),"body":body,**extra});after=self.control()
                require(r["status"]==400 and after["upstream"]==before["upstream"] and after["gates"]==before["gates"],"Unsupported request escaped ingress")
            self.case(provider+"-unsupported-"+str(len(self.artifact["cases"])),unsupported)
        for credential in (self.master,"sk-unknown"):
            before=self.control();r=self.client({"url":url,"path":"/v1/messages","key":credential,"ticket":secrets.token_urlsafe(32),"body":body});after=self.control()
            require(r["status"]>=400 and after["gates"]==before["gates"] and after["upstream"]==before["upstream"],"Master/invalid key reached admission")
        def replay():
            self.control(mode="normal");before=self.control();ticket=secrets.token_urlsafe(32)
            first=self.sdk(url,key,"anthropic",ticket=ticket);second=self.sdk(url,key,"anthropic",ticket=ticket);after=self.control()
            require(first["ok"] and not second["ok"] and second["admission"] and after["upstream"]-before["upstream"]==1,"A spent ticket dispatched again")
        self.case(provider+"-spent-ticket-replay",replay)
        def cancellation():
            self.control(mode="stall-stream");before=self.control()
            result=self.client({"url":url,"path":"/v1/messages","key":key,"ticket":secrets.token_urlsafe(32),"body":{**body,"stream":True},"cancel":True})
            require(result.get("cancelled") and result["status"]==200,"Cancellation did not interrupt actual stream")
            self.sql("SET statement_timeout='1000ms'; UPDATE \"LiteLLM_VerificationToken\" SET blocked=false WHERE token='"+hashlib.sha256(key.encode()).hexdigest()+"'")
            time.sleep(6)
            after=self.control()
            require(after["upstream"]-before["upstream"]==1 and len(after["receipts"])==len(before["receipts"]),"Cancelled stream reduced reservation or retried")
            self.control(mode="normal")
        self.case(provider+"-cancel-retains-reservation-and-releases-policy-locks",cancellation)
        # Native cached authorization is warmed before every gate-held mutation.
        fingerprint=hashlib.sha256(key.encode()).hexdigest()
        membership_where=f'''user_id='{member}' AND team_id='{team}' '''
        membership=self.sql(f'''SELECT row_to_json(m) FROM "LiteLLM_TeamMembership" m WHERE {membership_where}''')
        require(bool(membership),"Cannot snapshot native membership")
        membership_json=membership.replace("'","''")
        restore_membership=f'''BEGIN; DELETE FROM "LiteLLM_TeamMembership" WHERE {membership_where}; INSERT INTO "LiteLLM_TeamMembership" SELECT * FROM json_populate_record(NULL::"LiteLLM_TeamMembership", '{membership_json}'::json); COMMIT;'''
        mutations=[
            ("blocked-key",f'''UPDATE "LiteLLM_VerificationToken" SET blocked=true WHERE token='{fingerprint}' ''',f'''UPDATE "LiteLLM_VerificationToken" SET blocked=false WHERE token='{fingerprint}' '''),
            ("member-models",f'''UPDATE "LiteLLM_BudgetTable" SET allowed_models=ARRAY['another-model'] WHERE budget_id=(SELECT budget_id FROM "LiteLLM_TeamMembership" WHERE {membership_where})''',f'''UPDATE "LiteLLM_BudgetTable" SET allowed_models=ARRAY[]::text[] WHERE budget_id=(SELECT budget_id FROM "LiteLLM_TeamMembership" WHERE {membership_where})'''),
            ("member-cap",f'''UPDATE "LiteLLM_BudgetTable" SET max_budget=0 WHERE budget_id=(SELECT budget_id FROM "LiteLLM_TeamMembership" WHERE {membership_where})''',f'''UPDATE "LiteLLM_BudgetTable" SET max_budget=100 WHERE budget_id=(SELECT budget_id FROM "LiteLLM_TeamMembership" WHERE {membership_where})'''),
            ("removed-membership",f'''DELETE FROM "LiteLLM_TeamMembership" WHERE {membership_where}''',restore_membership),
            ("blocked-team",f'''UPDATE "LiteLLM_TeamTable" SET blocked=true WHERE team_id='{team}' ''',f'''UPDATE "LiteLLM_TeamTable" SET blocked=false WHERE team_id='{team}' '''),
            ("expired-key",f'''UPDATE "LiteLLM_VerificationToken" SET expires=clock_timestamp()-interval '1 second' WHERE token='{fingerprint}' ''',f'''UPDATE "LiteLLM_VerificationToken" SET expires=NULL WHERE token='{fingerprint}' '''),
        ]
        for name,change,restore in mutations:
            def fresh():
                require(self.sdk(url,key,"anthropic")["ok"],"Cannot warm native authentication")
                before=self.control();self.control(hold=True)
                try:
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                        pending=pool.submit(self.sdk,url,key,"anthropic")
                        self.wait(lambda:self.control()["gates"]>before["gates"],"Request never waited in gate",10)
                        self.sql("SET statement_timeout='1000ms';"+change) # proves no native lock crosses RPC
                        if name=="removed-membership":require(self.sql(f'''SELECT count(*) FROM "LiteLLM_TeamMembership" WHERE {membership_where}''')=="0","Membership was not revoked while gate waited")
                        self.control(hold=False)
                        result=pending.result(timeout=10)
                    require(not result["ok"] and self.control()["upstream"]==before["upstream"],"Stale native policy dispatched")
                finally:self.control(hold=False);self.sql(restore)
            self.case(provider+"-fresh-native-policy-"+name,fresh)
        def concurrency():
            second_key,_,_=self.provision(url)
            before=self.control()
            identities=[key,second_key]
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(lambda identity:self.sdk(url,identity,"anthropic"),identities))
            after=self.control();observations=after["observations"][len(before["observations"]):]
            require(all(r["ok"] for r in results) and after["upstream"]-before["upstream"]==2,"Concurrent requests lost isolated rights")
            require(len({o["nonce"] for o in observations})==2,"Concurrent nonce collision")
            require(len({o["keyFingerprint"] for o in observations})==2,"Concurrent members did not retain distinct key identities")
            for result,identity in zip(results,identities):self.receipt(before,after,result,identity,provider)
        self.case(provider+"-concurrent-isolation",concurrency)

    def guarded_native_lookups(self,provider,url):
        key,team,user=self.provision(url,exact=True)
        ordinary_hash=hashlib.sha256(key.encode()).hexdigest()
        role_keys={"ordinary":key};role_hashes={"ordinary":ordinary_hash}
        for role in ("management","read_only"):
            minted=self.admin(url,"/key/generate",{"team_id":team,"user_id":user,"key_alias":"probe-"+role+"-"+uuid.uuid4().hex,
                "key_type":role,"blocked":False,"max_budget":100,"models":["lares-brain"],"budget_duration":"1d"})
            role_keys[role]=minted["key"];role_hashes[role]=hashlib.sha256(minted["key"].encode()).hexdigest()
            self.disposable_secrets.append(minted["key"].encode())
        blocked_key="sk-"+secrets.token_urlsafe(32)
        blocked_hash=hashlib.sha256(blocked_key.encode()).hexdigest()
        blocked_alias="probe-blocked-"+uuid.uuid4().hex
        blocked_reply=self.admin(url,"/key/generate",{"key":blocked_key,"key_alias":blocked_alias,"key_type":"llm_api",
            "team_id":team,"user_id":user,"blocked":True,"max_budget":100,"models":["lares-brain"],"budget_duration":"1d"})
        require(blocked_reply.get("key")==blocked_key,"Atomic blocked fixture key was not returned exactly")
        self.disposable_secrets.append(blocked_key.encode())
        def counters_unchanged(before,after):
            return (before.get("upstream")==after.get("upstream") and before.get("gates")==after.get("gates") and
                before.get("traps")==after.get("traps") and before.get("receipts")==after.get("receipts"))
        def lookup(method,path,*,credential=None,body=None,raw=None,headers=None):
            request={"url":url,"path":path,"method":method}
            if credential is not None:request["key"]=credential
            if body is not None:request["body"]=body
            if raw is not None:request["raw"]=raw
            if headers is not None:request["headers"]=headers
            return self.client(request)

        def authenticated_role_keys():
            before=self.control()
            native_checks=[
                lookup("GET","/v1/model/info",credential=role_keys["ordinary"]),
                lookup("GET","/key/info",credential=role_keys["management"]),
                lookup("GET","/key/info",credential=role_keys["read_only"]),
            ]
            team_reply=lookup("GET","/team/info?team_id="+team,credential=self.master)
            user_reply=lookup("GET","/user/info?user_id="+user,credential=self.master)
            inventory=lookup("GET","/key/list?user_id="+user,credential=self.master)
            exact=lookup("POST","/v2/key/info",credential=self.master,body={"keys":[ordinary_hash]})
            role_readbacks=[lookup("POST","/v2/key/info",credential=self.master,body={"keys":[role_hashes[role]]}) for role in ("management","read_only")]
            blocked_readback=lookup("POST","/v2/key/info",credential=self.master,body={"keys":[blocked_hash]})
            after=self.control()
            team_info=team_reply.get("body",{}).get("team_info",{}) if type(team_reply.get("body")) is dict else {}
            user_info=user_reply.get("body",{}).get("user_info",{}) if type(user_reply.get("body")) is dict else {}
            memberships=team_reply.get("body",{}).get("team_memberships",[]) if type(team_reply.get("body")) is dict else []
            matching_memberships=[item for item in memberships if type(item) is dict and item.get("team_id")==team and item.get("user_id")==user]
            key_rows=exact.get("body",{}).get("info",[]) if type(exact.get("body")) is dict else []
            role_rows=[reply.get("body",{}).get("info",[]) if type(reply.get("body")) is dict else [] for reply in role_readbacks]
            blocked_rows=blocked_readback.get("body",{}).get("info",[]) if type(blocked_readback.get("body")) is dict else []
            require(team_reply.get("status")==200 and team_info.get("team_id")==team and len(matching_memberships)==1,
                "Master team lookup did not return the exact fixture membership")
            require(user_reply.get("status")==200 and user_reply.get("body",{}).get("user_id")==user and
                type(user_info) is dict and user_info.get("user_id")==user and user_info.get("max_budget")==100 and
                user_info.get("user_role")=="internal_user","Master user lookup did not return the exact current fixture policy")
            expected_hashes=sorted([*role_hashes.values(),blocked_hash])
            require(inventory.get("status")==200 and sorted(inventory.get("body",{}).get("keys",[]))==expected_hashes,"Master key inventory differed")
            require(exact.get("status")==200 and exact.get("body",{}).get("key")==[ordinary_hash] and len(key_rows)==1 and
                type(key_rows[0]) is dict and key_rows[0].get("key_type")=="llm_api" and key_rows[0].get("team_id")==team and key_rows[0].get("user_id")==user and
                key_rows[0].get("blocked") is False,"Master hash lookup differed")
            require(all(reply.get("status")==200 and len(rows)==1 and type(rows[0]) is dict and rows[0].get("key_type")==role and rows[0].get("blocked") is False
                for reply,rows,role in zip(role_readbacks,role_rows,("management","read_only"))),"Role-bearing key readback differed")
            require(blocked_readback.get("status")==200 and len(blocked_rows)==1 and type(blocked_rows[0]) is dict and
                blocked_rows[0].get("key_type")=="llm_api" and blocked_rows[0].get("blocked") is True,"Atomic blocked key readback differed")
            require([reply.get("status") for reply in native_checks]==[200,200,200],"Native authentication failed for a valid role-bearing key")
            require(lookup("GET","/v1/model/info",credential=blocked_key).get("status") in (401,403),"Atomic blocked key authenticated on a read route")
            after_reads=self.control()
            require(counters_unchanged(before,after) and counters_unchanged(after,after_reads),"Native lookup or auth check reached model/provider dispatch")
            forbidden=[(method,path) for method,path in (("GET","/team/info?team_id="+team),("GET","/key/list?user_id="+user),("GET","/user/info?user_id="+user),("POST","/v2/key/info"))]
            denied=[]
            for method,path in forbidden:
                body={"keys":[ordinary_hash]} if method=="POST" else None
                for credential in (role_keys["ordinary"],role_keys["management"],role_keys["read_only"],"sk-deliberately-wrong-key-000000",None):
                    denied.append(lookup(method,path,credential=credential,body=body))
            require(all(type(reply) is dict and reply.get("status")==400 for reply in denied),"A non-master or missing credential reached native lookup")
            after_denied=self.control()
            require(counters_unchanged(after_reads,after_denied),"Refused role credential lookup reached model/provider dispatch")
            blocked_denied=[lookup("GET","/team/info?team_id="+team,credential=blocked_key),
                lookup("GET","/user/info?user_id="+user,credential=blocked_key),
                lookup("GET","/key/list?user_id="+user,credential=blocked_key),lookup("POST","/v2/key/info",credential=blocked_key,body={"keys":[ordinary_hash]})]
            require(all(reply.get("status")==400 for reply in blocked_denied),"Blocked virtual key reached a native lookup")
            malformed=[
                lookup("GET","/team/info?team_id="+team+"&team_id="+team,credential=self.master),
                lookup("GET","/team/info?team_id=%74"+team[1:],credential=self.master),
                lookup("GET","/key/list?user_id="+user+"&extra=x",credential=self.master),
                lookup("GET","/team/info?team_id="+team+"&api_key=hidden",credential=self.master),
                lookup("GET","/team/info?team_id="+team,credential=self.master,headers={"x-api-key":self.master}),
                lookup("POST","/v2/key/info?keys=x",credential=self.master,body={"keys":[ordinary_hash]}),
                lookup("POST","/v2/key/info",credential=self.master,raw='{"keys":["'+ordinary_hash+'"],"keys":[]}'),
                lookup("POST","/v2/key/info",credential=self.master,raw='{"keys":["'+ordinary_hash+'"],"extra":true}'),
                lookup("GET","/team/info?team_id="+team,credential=self.master,headers=[["authorization","Bearer "+self.master],["authorization","Bearer "+self.master]]),
                lookup("POST","/team/info?team_id="+team,credential=self.master),
                lookup("GET","/team/info/?team_id="+team,credential=self.master),
                lookup("GET","/user/info?user_id="+user+"&user_id="+user,credential=self.master),
                lookup("GET","/user/info?user_id=%6d"+user[1:],credential=self.master),
                lookup("GET","/user/info?user_id="+user+"&extra=x",credential=self.master),
                lookup("GET","/user/info?team_id="+team,credential=self.master),
                lookup("GET","/user/info?user_id="+user,credential=self.master,headers={"x-api-key":self.master}),
                lookup("GET","/user/info?user_id="+user,credential=self.master,headers=[["authorization","Bearer "+self.master],["authorization","Bearer "+self.master]]),
                lookup("GET","/user/info?user_id="+user,credential=self.master,headers={"content-type":"application/json"}),
                lookup("GET","/user/info",credential=self.master),
                lookup("POST","/user/info?user_id="+user,credential=self.master),
                lookup("GET","/user/info/?user_id="+user,credential=self.master),
            ]
            require(all(type(reply) is dict and reply.get("status")==400 for reply in malformed),"Malformed lookup boundary was accepted")
            after_malformed=self.control()
            require(counters_unchanged(after_denied,after_malformed),"Malformed lookup reached model/provider dispatch")
            hashes=sorted([*role_hashes.values(),blocked_hash])
            deleted=lookup("POST","/key/delete",credential=self.master,body={"keys":hashes})
            absent=[lookup("POST","/v2/key/info",credential=self.master,body={"keys":[item]}) for item in hashes]
            after_delete=self.control()
            require(deleted.get("status")==200 and all(reply.get("status")==200 and reply.get("body",{}).get("key")==[item] and
                reply.get("body",{}).get("info")==[] for item,reply in zip(hashes,absent)),"Deleted fixture key was not strictly absent")
            require(counters_unchanged(after_malformed,after_delete),"Native lookup or deletion reached model/provider dispatch")
        self.case(provider+"-guarded-native-lookups-auth-refusal-and-cleanup",authenticated_role_keys)

        def fresh_user_policy():
            before=self.control()
            def current(cap,role):
                reply=lookup("GET","/user/info?user_id="+user,credential=self.master)
                body=reply.get("body");info=body.get("user_info") if type(body) is dict else None
                require(reply.get("status")==200 and type(body) is dict and body.get("user_id")==user and
                    type(info) is dict and info.get("user_id")==user and info.get("max_budget")==cap and
                    info.get("user_role")==role and body.get("keys")==[],"User lookup did not reflect the current fixture row")
            current(100,"internal_user")
            try:
                # Mutate only this disposable row after creation. A cached create receipt
                # cannot satisfy the independent current-policy readback below.
                self.sql(f'''UPDATE "LiteLLM_UserTable" SET max_budget=99,user_role='internal_user_viewer' WHERE user_id='{user}' ''')
                current(99,"internal_user_viewer")
            finally:
                self.sql(f'''UPDATE "LiteLLM_UserTable" SET max_budget=100,user_role='internal_user' WHERE user_id='{user}' ''')
            current(100,"internal_user")
            require(counters_unchanged(before,self.control()),"Current user policy lookup reached model/provider dispatch")
        self.case(provider+"-guarded-native-user-policy-is-current",fresh_user_policy)

    def execute(self):
        try:
            self.setup()
            self.native_contract()
            # A working native bootstrap must be established before negative cases;
            # a universal import/permission failure cannot count as six good refusals.
            openai_url=self.start_gateway("openai")
            self.artifact["cases"].append({"name":"startup-valid-native-bootstrap","passed":True})
            for broken in ("hook","duplicate","callback","authority","profile","service-key"): self.case("startup-refuses-"+broken,lambda broken=broken:self.start_gateway("openai",broken))
            for provider in ("openai","anthropic"):
                url=openai_url if provider=="openai" else self.start_gateway(provider);key,team,member=self.provision(url)
                self.exercise(provider,url,key,team,member)
                self.guarded_native_lookups(provider,url)
                name=self.name+"-gateway-"+provider;command("docker","restart",name)
                self.wait(lambda:self.client({"url":url,"path":"/health/readiness","method":"GET","key":self.master})["status"]==200,"Restart did not restore native runtime",120)
                self.case(provider+"-restart-persisted-key",lambda:require(self.sdk(url,key,"anthropic")["ok"],"Native key did not survive restart"))
                command("docker","stop",name)
            self.artifact["passed"]=self.artifact["nativeCredentialContract"].get("passed") is True and all(case.get("passed") is True for case in self.artifact["cases"])
            if not self.artifact["passed"]:raise RuntimeError("Pinned image proof did not pass")
        except Exception as error:
            self.artifact["passed"]=False
            self.artifact["failure"]=str(error) # fixed harness messages only, never raw responses/logs
            raise
        finally:
            self.output.parent.mkdir(parents=True,exist_ok=True);self.output.write_text(json.dumps(self.artifact,indent=2)+"\n")
            for name in reversed(self.containers):subprocess.run(["docker","rm","-f",name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            subprocess.run(["docker","network","rm",self.name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            shutil.rmtree(self.root)


if __name__=="__main__": Proof(sys.argv[1],sys.argv[2]).execute()
