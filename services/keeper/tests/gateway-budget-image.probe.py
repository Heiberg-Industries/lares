"""CI-only compatibility experiment against the release's real LiteLLM image.

Run through keeper-runtime-images.yml, never on an installation. The only model
server is a synthetic HTTP server on an INTERNAL Docker network. Nothing here
implements production admission or proves deployment/provider-price acceptance.
Each failed safety assumption is retained in the artifact and exits nonzero.
"""
import concurrent.futures
import hashlib
import json
import math
import os
import pathlib
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


REPO = pathlib.Path(__file__).resolve().parents[3]
MODEL = "gpt-4o-mini"
ALIAS = "lares-brain"
TOKENS = 1000
CONCURRENCY = 4

# Runs from the built role image, using only Node's standard library. No
# mock_response: LiteLLM's real OpenAI adapter parses these usage fields.
UPSTREAM = r"""
import http from 'node:http';
let count=0, held=[], mode='normal', streams=0, trapCount=0;
const reply=(r,b)=>{
 const id='chatcmpl-fixture-'+count;
 if(b.stream){
  streams++;
  r.writeHead(200,{'content-type':'text/event-stream'});
  const chunk=(delta,finish_reason=null,usage)=>r.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model:'gpt-4o-mini',choices:usage?[]:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})+'\n\n');
  chunk({role:'assistant',content:'FIXTURE_OK'});
  const finish=()=>{if(!r.destroyed){chunk({},'stop');chunk({},null,{prompt_tokens:1000,completion_tokens:1000,total_tokens:2000});r.end('data: [DONE]\n\n');}};
  if(mode==='partial')held.push(finish);else finish();
 }else{
  const finish=()=>{if(!r.destroyed){r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify({id,object:'chat.completion',created:1,model:'gpt-4o-mini',choices:[{index:0,message:{role:'assistant',content:'FIXTURE_OK'},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:1000,total_tokens:2000}}));}};
  if(mode==='hold')held.push(finish);else finish();
 }
};
http.createServer(async(q,r)=>{
 let raw='';for await(const c of q)raw+=c;
 if(q.url==='/control'){
  const b=raw?JSON.parse(raw):{};
  if(b.mode)mode=b.mode;
  if(b.release){const pending=held;held=[];mode='normal';for(const f of pending)f();}
  r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify({count,held:held.length,streams,trapCount}));return;
 }
 if(q.url!=='/v1/chat/completions'){r.writeHead(404);r.end();return;}
 count++;reply(r,JSON.parse(raw));
}).listen(8080,'0.0.0.0');
http.createServer((q,r)=>{trapCount++;r.writeHead(503);r.end();}).listen(8081,'0.0.0.0');
"""

# Credentials arrive over stdin, never argv or output. The client has no master
# key mount/environment. In external mode only the operator harness administers
# the separate gateway; the role client receives member/agent keys only.
CLIENT = r"""
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const x=JSON.parse(readFileSync(0,'utf8'));
const base='/app/services/chief-of-staff/';
const require=createRequire(base+'package.json');
let requests=0;
const original=globalThis.fetch;
globalThis.fetch=async(...a)=>{requests++;return original(...a);};
if(x.kind==='classify'){
 const {isBudgetExceeded}=await import('/app/packages/agent-kit/src/gateway-budget.ts');
 console.log(JSON.stringify({recognized:isBudgetExceeded({statusCode:x.status,data:x.body,responseBody:JSON.stringify(x.body)})}));
}else if(x.kind!=='sdk'){
 try{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),x.timeout??20000);
  try{
   const r=await fetch(x.url+x.path,{method:x.body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(x.key?{authorization:'Bearer '+x.key,'x-api-key':x.key}:{}),...x.headers},...(x.body===undefined?{}:{body:JSON.stringify(x.body)}),signal:controller.signal});
   if(x.cancel){const reader=r.body.getReader();await reader.read();controller.abort();console.log(JSON.stringify({status:r.status,cancelled:true}));}
   else {const raw=await r.text();let body;try{body=JSON.parse(raw);}catch{body={stream:raw.includes('FIXTURE_OK')};}console.log(JSON.stringify({status:r.status,body}));}
  }finally{clearTimeout(timer);}
 }catch{console.log(JSON.stringify({status:0,transportFailure:true}));}
}else{
 const {generateText}=await import(pathToFileURL(require.resolve('ai')).href);
 const {createGatewayProvider}=await import('/app/packages/agent-kit/src/gateway-provider.ts');
 const {isBudgetExceeded,respondToTurnFailed,respondToSessionFailed}=await import('/app/packages/agent-kit/src/gateway-budget.ts');
 const eveRoot=require.resolve('eve').split('/dist/')[0];
 const {classifyModelCallError}=await import(pathToFileURL(eveRoot+'/dist/src/harness/model-call-error.js').href);
 process.env.GATEWAY_URL=x.url;process.env.GATEWAY_LANE=x.lane;
 process.env.GATEWAY_KEY_FILE='/tmp/budget-key-'+process.pid;writeFileSync(process.env.GATEWAY_KEY_FILE,x.key,{mode:0o600});
 const {gatewayModel}=createGatewayProvider({defaultKeyFile:process.env.GATEWAY_KEY_FILE,defaultGatewayUrl:'http://upstream:8081'});
 let attempts=0;
 const one=async()=>{attempts++;return generateText({model:gatewayModel('lares-brain'),prompt:'fixture',maxOutputTokens:8,maxRetries:0,abortSignal:AbortSignal.timeout(20000)});};
 try{
  if(x.outer){
   // Execute the EXACT installed private outer retry function. This is not a
   // reconstructed loop and not a claim of a full compiled conversation/door.
   const source=readFileSync(eveRoot+'/dist/src/harness/tool-loop.js','utf8');
   const start=source.indexOf('async function runModelCallWithRetries(');
   const end=source.indexOf('export{',start);
   if(start<0||end<0)throw Error('installed outer retry function moved');
   const fn=new Function('classifyModelCallError','setTimeout','log','return ('+source.slice(start,end)+')')(classifyModelCallError,delay,{warn(){}});
   await fn(one,{sessionId:'fixture',turnId:'fixture'},new AbortController().signal);
  }else await one();
  console.log(JSON.stringify({ok:true,requests,attempts}));
 }catch(e){
  if(e.message==='installed outer retry function moved'){
   console.log(JSON.stringify({harnessFailure:'installed-retry-layout-changed'}));
   process.exit(0);
  }
  const options={refusalText:'FIXED_BUDGET_REFUSAL',dialect:'telegram'};
  const first=respondToTurnFailed(e,options),second=respondToSessionFailed(e,options);
  console.log(JSON.stringify({ok:false,requests,attempts,status:e.statusCode??null,recognized:isBudgetExceeded(e),classification:classifyModelCallError(e),visibleRefusals:[first,second].filter(v=>v.kind==='budget-refusal').length,silentSession:second.kind==='silent'}));
 }
}
"""

ADMIN = r"""
import json,sys,urllib.request,urllib.error,pathlib
x=json.load(sys.stdin)
key=pathlib.Path('/fixtures/master').read_text()
r=urllib.request.Request('http://127.0.0.1:4000'+x['path'],data=json.dumps(x['body']).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
try:
 with urllib.request.urlopen(r,timeout=20) as out: print(json.dumps({'status':out.status,'body':json.load(out)}))
except urllib.error.HTTPError as e:
 print(json.dumps({'status':e.code}))
"""


class ProbeError(Exception):
    """Messages are fixed public labels, never container output or HTTP bodies."""


class InfrastructureError(ProbeError):
    """Setup/API failures must not be presented as proven enforcement failures."""


def require(condition, message):
    if not condition:
        raise ProbeError(message)


def shell(*args, input=None, timeout=120, check=True):
    result = subprocess.run(args, input=input, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        # Container/SDK diagnostics may contain full keys, fragments or bodies.
        raise InfrastructureError("disposable command failed (raw diagnostics withheld)")
    return result.stdout.strip()


def eventually(fn, description, timeout=60, retry_on=(), timeout_error=ProbeError):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            value = fn()
            if value:
                return value
        # Only an explicitly identified transient startup command may retry an
        # exception. SQL/schema/API/JSON failures retain their infrastructure
        # classification instead of becoming a misleading assertion timeout.
        except retry_on:
            pass
        time.sleep(.5)
    raise timeout_error(description)


def cap_observation(scope, cap, spend):
    require(all(isinstance(x,(int,float)) and math.isfinite(x) and x>=0 for x in (cap,spend)), "invalid cap/spend measurement")
    overshoot=max(0,spend-cap)
    return {"scope":scope,"capUsd":cap,"persistedUsd":spend,"measuredOvershootUsd":overshoot,"withinConfiguredCap":spend<=cap or math.isclose(spend,cap,rel_tol=1e-5,abs_tol=1e-10)}


def require_configured_caps(observations):
    require(bool(observations), "configured-cap measurements are missing")
    require(all(item["withinConfiguredCap"] for item in observations), "native gateway spend exceeded a configured cap; production admission design remains blocked")


def provisioning_rejected(status):
    if status>=500 or status<200:
        raise InfrastructureError("unknown-member provisioning failed without a verified client rejection")
    return 400<=status<500


def require_auth_refusal(result, upstream_delta):
    if result["status"]>=500:
        raise InfrastructureError("credential request returned a server error; refusal unverified")
    require(result["status"] in (401,403), "credential was not refused as unauthorized or forbidden")
    require(upstream_delta==0, "refused credential reached upstream")


def require_budget_refusal(result, upstream_delta, recognized):
    if result["status"]>=500:
        raise InfrastructureError("budget request returned a server error; refusal unverified")
    require(400<=result["status"]<500 and recognized is True, "response was not recognized by the existing budget-refusal contract")
    require(upstream_delta==0, "budget refusal reached upstream")


def quote(value):
    return "'" + value.replace("'", "''") + "'"


class Topology:
    def __init__(self, role_image, manifest, artifact):
        self.image = role_image
        self.manifest = manifest
        self.artifact = artifact
        self.name = "lares-budget-" + uuid.uuid4().hex[:10]
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="lares-budget-"))
        self.root.chmod(0o755)
        self.containers = []
        self.network_created = False
        self.proof = {"status": "RUNNING", "scope": "isolated actual-gateway compatibility; no production enforcement", "release": manifest["release"], "images": {"gateway": manifest["images"]["lares-gateway"], "db": manifest["images"]["db"]}, "cases": [], "limitations": ["No external installation, paid provider, installer or production admission is exercised", "SDK and exact installed Eve outer retry function; no full compiled conversation or deployed door", "Concurrent bound applies only to this controlled four-call experiment"]}

    def run_container(self, suffix, image, args, command=()):
        name = self.name + "-" + suffix
        self.containers.append(name)  # cleanup even when startup partially fails
        shell("docker", "run", "-d", "--name", name, "--network", self.name,
              *args, image, *command)
        return name

    def node(self, payload):
        return json.loads(shell("docker", "exec", "-i", self.name+"-client", "/app/services/chief-of-staff/node_modules/.bin/tsx", "/proof/client.mjs", input=json.dumps(payload), timeout=100))

    def http(self, host, path, body=None, key=None, **extra):
        return self.node({"url": "http://"+host, "path": path, **({"body":body} if body is not None else {}), "key": key, **extra})

    def control(self, **body):
        r = self.http("upstream:8080", "/control", body)
        require(r["status"] == 200, "synthetic upstream control failed")
        return r["body"]

    def sql(self, mode, statement):
        return shell("docker", "exec", "-i", self.name+"-"+mode+"-db", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "proof", "-d", "litellm", "-At", input=statement)

    def admin(self, mode, path, body, allowed=(200,)):
        r = json.loads(shell("docker", "exec", "-i", self.name+"-"+mode, "python", "-c", ADMIN, input=json.dumps({"path": path, "body": body})))
        if r["status"] not in allowed:
            raise InfrastructureError("gateway administration API incompatible: "+path+" status="+str(r["status"]))
        return r.get("body", {})

    def ready(self, mode):
        # Health is only readiness, never an enforcement assertion.
        return self.http(mode+":4000", "/health/liveliness")["status"] == 200

    def start(self):
        self.proof["roleImageId"] = shell("docker","image","inspect","--format","{{.Id}}",self.image)
        for key in ("lares-gateway", "db"):
            require("@sha256:" in self.manifest["images"][key], "manifest image is not digest pinned")
            shell("docker", "pull", self.manifest["images"][key], timeout=300)
        shell("docker", "network", "create", "--internal", self.name)
        self.network_created = True
        require(shell("docker", "network", "inspect", "--format", "{{.Internal}}", self.name)=="true", "network permits external egress")
        self.proof["internalNetwork"] = True
        (self.root/"upstream.mjs").write_text(UPSTREAM)
        (self.root/"client.mjs").write_text(CLIENT)
        bind = ["--mount", f"type=bind,src={self.root},dst=/proof,readonly"]
        self.run_container("upstream", self.image, [*bind, "--network-alias", "upstream", "--entrypoint", "node"], ["/proof/upstream.mjs"])
        self.run_container("client", self.image, [*bind, "--mount", f"type=bind,src={REPO}/services/box/lib/gateway-config.ts,dst=/app/services/box/lib/gateway-config.ts,readonly", "--entrypoint", "node"], ["-e", "setInterval(()=>{},60000)"])
        eventually(lambda: self.http("upstream:8080","/control",{})["status"]==200, "synthetic upstream did not start", timeout_error=InfrastructureError)
        # Render using the committed production renderer in the built role image.
        # Fixture-only api_base is the sole model-routing change; no mock_response.
        script = "import {renderGatewayConfig} from '/app/services/box/lib/gateway-config.ts';import{createRequire}from'node:module';const{parse}=createRequire('/app/services/box/package.json')('yaml');console.log(JSON.stringify(parse(renderGatewayConfig({alias:'lares-brain',providerModel:'openai/gpt-4o-mini'}))));"
        config = json.loads(shell("docker", "exec", self.name+"-client", "/app/services/chief-of-staff/node_modules/.bin/tsx", "-e", script))
        for model in config["model_list"]:
            model["litellm_params"]["api_base"] = "http://upstream:8080/v1"
        # Shorten persistence interval, not enforcement/cache policy. Production
        # defaults for auth caching/retries/refusal status are deliberately kept.
        config["general_settings"]["proxy_batch_write_at"] = 1
        config_bytes = json.dumps(config, sort_keys=True).encode()
        self.proof["configSha256"] = hashlib.sha256(config_bytes).hexdigest()
        self.proof["fixtureConfigChanges"] = {"providerApiBase":"internal synthetic upstream", "proxyBatchWriteAtSeconds":1, "authCacheRetryAndRefusalPolicy":"generated defaults"}
        self.proof["startupScriptSha256"] = hashlib.sha256((REPO/"images/gateway-runtime/start.sh").read_bytes()).hexdigest()
        for mode in ("included", "external"):
            folder = self.root/mode
            folder.mkdir(mode=0o700)
            for filename, value in {"master":"sk-"+secrets.token_urlsafe(32), "provider":"sk-"+secrets.token_urlsafe(32), "password":secrets.token_urlsafe(32)}.items():
                (folder/filename).write_text(value)
                (folder/filename).chmod(0o600)
            (folder/"config.yaml").write_bytes(config_bytes)  # YAML accepts JSON
            db = self.run_container(mode+"-db", self.manifest["images"]["db"], ["--network-alias", mode+"-db", "--mount", f"type=bind,src={folder},dst=/fixtures,readonly", "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_DB=litellm", "-e", "POSTGRES_PASSWORD_FILE=/fixtures/password"])
            eventually(lambda: shell("docker", "exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "proof", "-d", "litellm")=="127.0.0.1:5432 - accepting connections", "gateway database did not start", retry_on=(InfrastructureError,), timeout_error=InfrastructureError)
            # A distinct application database stays available during gateway DB outages.
            shell("docker", "exec", db, "createdb", "-U", "proof", "application")
            args = ["--network-alias", mode, "--mount", f"type=bind,src={folder},dst=/fixtures,readonly", "--mount", f"type=bind,src={folder}/config.yaml,dst=/etc/litellm/config.yaml,readonly", "--mount", f"type=bind,src={REPO}/images/gateway-runtime/start.sh,dst=/start.sh,readonly", "--entrypoint", "/bin/sh"]
            for k,v in {"MODEL_PROVIDER_KEY_FILE":"/fixtures/provider", "GATEWAY_MASTER_KEY_FILE":"/fixtures/master", "DATABASE_PASSWORD_FILE":"/fixtures/password", "PGHOST":mode+"-db", "PGPORT":"5432", "PGDATABASE":"litellm", "PGUSER":"proof", "LITELLM_LOCAL_MODEL_COST_MAP":"True", "LITELLM_TELEMETRY":"False"}.items():
                args += ["-e", k+"="+v]
            self.run_container(mode, self.manifest["images"]["lares-gateway"], args, ["/start.sh"])
            eventually(lambda: self.ready(mode), "gateway startup failed", timeout=180, timeout_error=InfrastructureError)
        # Read identity/prices FROM the running pinned artifact, not docs/current tag.
        meta = json.loads(shell("docker", "exec", self.name+"-included", "python", "-c", "import importlib.metadata,json,litellm,hashlib,pathlib; m=litellm.model_cost['gpt-4o-mini']; print(json.dumps({'version':importlib.metadata.version('litellm'),'input':m['input_cost_per_token'],'output':m['output_cost_per_token'],'insideConfigSha256':hashlib.sha256(pathlib.Path('/etc/litellm/config.yaml').read_bytes()).hexdigest()}))"))
        require(meta["insideConfigSha256"]==self.proof["configSha256"],"running gateway config differs from generated fixture")
        self.cost = TOKENS*(meta["input"]+meta["output"])
        require(math.isfinite(self.cost) and self.cost>0, "pinned model price is missing or zero")
        self.proof["pricing"] = {**meta, "model":MODEL, "inputTokens":TOKENS, "outputTokens":TOKENS, "expectedUsdPerCall":self.cost}

    def fixture(self, mode, team_multiple=100, member_multiple=100):
        team = "installation-"+uuid.uuid4().hex
        members = ["member-"+uuid.uuid4().hex for _ in range(2)]
        self.admin(mode,"/team/new", {"team_id":team,"team_alias":"disposable installation","max_budget":self.cost*team_multiple,"budget_duration":"1d","models":[ALIAS]})
        keys = {}
        for member in members:
            self.admin(mode,"/user/new", {"user_id":member,"auto_create_key":False})
            self.admin(mode,"/team/member_add", {"team_id":team,"max_budget_in_team":self.cost*member_multiple,"member":{"role":"user","user_id":member}})
            for agent in ("alpha","beta"):
                keys[member,agent] = self.key(mode,team,member,agent)
        return team,members,keys

    def key(self, mode, team, member=None, agent="replacement"):
        body = {"team_id":team,"models":[ALIAS],"key_alias":"fixture-"+agent+"-"+uuid.uuid4().hex,"metadata":{"agent_id":agent}}
        if member is not None:
            body["user_id"] = member
        value = self.admin(mode,"/key/generate",body).get("key")
        require(isinstance(value,str) and value.startswith("sk-"), "gateway did not return a fixture key")
        return value

    def call(self, mode, key, lane="openai-compatible", **extra):
        body = {"model":ALIAS,"messages":[{"role":"user","content":"fixture"}],"max_tokens":8}
        body.update(extra.pop("body", {}))
        path = "/v1/messages" if lane=="anthropic" else "/v1/chat/completions"
        return self.http(mode+":4000", path, body, key, **extra)

    def count(self):
        return self.control()["count"]

    def totals(self, mode, team):
        q = quote(team)
        raw = self.sql(mode, f'''SELECT json_build_object('team',(SELECT spend FROM "LiteLLM_TeamTable" WHERE team_id={q}),'members',(SELECT COALESCE(sum(spend),0) FROM "LiteLLM_TeamMembership" WHERE team_id={q}),'keys',(SELECT COALESCE(sum(spend),0) FROM "LiteLLM_VerificationToken" WHERE team_id={q}),'logs',(SELECT COALESCE(sum(spend),0) FROM "LiteLLM_SpendLogs" WHERE team_id={q}));''')
        return json.loads(raw)

    def settled(self, mode, team, calls):
        expected = calls*self.cost
        def check():
            totals = self.totals(mode,team)
            return totals if all(isinstance(x,(int,float)) and x>0 and math.isclose(x,expected,rel_tol=1e-5,abs_tol=1e-10) for x in totals.values()) else None
        return eventually(check,"nonzero priced spend did not reconcile across key/member/team/logs")

    def budget_contract(self, result):
        return self.node({"kind":"classify","status":result["status"],"body":result.get("body")}).get("recognized")

    def budget_refused(self, mode, key, **extra):
        before = self.count()
        result = self.call(mode,key,**extra)
        require_budget_refusal(result,self.count()-before,self.budget_contract(result))
        return result

    def auth_refused(self, mode, key, **extra):
        before=self.count()
        result=self.call(mode,key,**extra)
        require_auth_refusal(result,self.count()-before)
        return result

    def case(self, mode, name, fn):
        row = {"mode":mode,"name":name}
        self.proof["cases"].append(row)
        print(f"gateway-budget: {mode}/{name}",flush=True)
        try:
            row["evidence"] = fn()
            row["status"] = "PASS"
        except Exception as e:
            row["status"] = "FAIL"
            row["reason"] = str(e) if isinstance(e,ProbeError) else type(e).__name__
            row["failureKind"] = "harness-or-api-compatibility" if isinstance(e,InfrastructureError) or not isinstance(e,ProbeError) else "compatibility-assertion"
        self.save()

    def save(self):
        self.artifact.parent.mkdir(parents=True,exist_ok=True)
        self.artifact.write_text(json.dumps(self.proof,indent=2)+"\n")

    def sdk(self, mode, key, lane, outer=False):
        return self.node({"kind":"sdk","url":"http://"+mode+":4000","key":key,"lane":lane,"outer":outer})

    def serial(self, mode):
        team,members,keys = self.fixture(mode,3.5,1.5)
        count = 0
        observations={"members":[],"installation":None}
        self.proof["cases"][-1]["observations"]=observations
        for member in members:
            for agent,lane in (("alpha","anthropic"),("beta","openai-compatible")):
                result = self.sdk(mode,keys[member,agent],lane)
                require(result.get("ok"), "actual SDK call failed before cap")
                count += 1
                self.settled(mode,team,count)
            spend=float(self.sql(mode,f'''SELECT spend FROM "LiteLLM_TeamMembership" WHERE team_id={quote(team)} AND user_id={quote(member)};'''))
            observations["members"].append(cap_observation("member",1.5*self.cost,spend))
            result = self.budget_refused(mode,keys[member,"alpha"])
        totals=self.totals(mode,team)
        observations["installation"]=cap_observation("installation",3.5*self.cost,totals["team"])
        # A member who has spent nothing still cannot bypass installation spend.
        fresh = "member-"+uuid.uuid4().hex
        self.admin(mode,"/user/new",{"user_id":fresh,"auto_create_key":False})
        self.admin(mode,"/team/member_add",{"team_id":team,"max_budget_in_team":100*self.cost,"member":{"role":"user","user_id":fresh}})
        fresh_key = self.key(mode,team,fresh)
        self.budget_refused(mode,fresh_key)
        require_configured_caps([*observations["members"],observations["installation"]])
        return {"pricedCalls":count,"persistedUsd":totals,"memberAggregatesTwoAgents":True,"installationAggregatesMembers":True,"observedRefusalStatus":result["status"]}

    def sdk_refusal(self, mode):
        team,members,keys = self.fixture(mode,100,.5)
        key = keys[members[0],"alpha"]
        require(self.call(mode,key)["status"]==200,"initial priced call failed")
        self.settled(mode,team,1)
        evidence = {}
        for lane in ("anthropic","openai-compatible"):
            before = self.count()
            result = self.sdk(mode,key,lane,outer=True)
            evidence[lane] = result
            require(self.count()==before,"capped SDK retry reached upstream")
        # Preserve evidence even when the existing matcher/retry policy fails.
        self.proof["cases"][-1]["observations"] = evidence
        for result in evidence.values():
            if result.get("harnessFailure"):
                raise InfrastructureError("installed retry module layout changed; recheck harness")
            require(not result.get("ok") and result.get("recognized"),"actual refusal is not recognized by existing matcher")
            require(result.get("classification")=="terminal" and result.get("requests")==1 and result.get("attempts")==1,"installed Eve retries the actual gateway budget refusal")
            require(result.get("visibleRefusals")==1 and result.get("silentSession"),"refusal does not produce exactly one deterministic answer")
        return evidence

    def identities(self, mode, kind):
        team,members,keys = self.fixture(mode)
        before = self.count()
        if kind=="invalid":
            result = self.call(mode,"sk-"+secrets.token_urlsafe(32))
        elif kind=="absent":
            result = self.call(mode,self.key(mode,team))
        elif kind=="unknown-member":
            # An admin refusal during provisioning is safe; automatic creation of
            # an unbound identity is not proof of valid member authority.
            body={"team_id":team,"user_id":"unknown-"+uuid.uuid4().hex,"models":[ALIAS]}
            r=json.loads(shell("docker","exec","-i",self.name+"-"+mode,"python","-c",ADMIN,input=json.dumps({"path":"/key/generate","body":body})))
            if provisioning_rejected(r["status"]):
                return {"rejectedAtProvisioning":True,"provisioningHttpStatus":r["status"],"upstreamDelta":0}
            if r["status"]!=200:
                raise InfrastructureError("unknown-member provisioning returned an unexpected non-rejection status")
            result=self.call(mode,r["body"]["key"])
        else:
            result=self.call(mode,keys[members[0],"alpha"],body={"user":members[1],"metadata":{"member_id":members[1]}},headers={"x-litellm-user-id":members[1]})
            # `user` may legitimately name an end customer. It is not Lares
            # actor authentication. Refusing this label is optional; redirecting
            # the credential owner's in-team charge to B is never acceptable.
            if result["status"]==200:
                self.settled(mode,team,1)
                rows=json.loads(self.sql(mode,f'''SELECT json_object_agg(user_id,spend) FROM "LiteLLM_TeamMembership" WHERE team_id={quote(team)};'''))
                require(math.isclose(rows[members[0]],self.cost,rel_tol=1e-5) and rows[members[1]]==0,"body/header labels redirected member billing identity")
                return {"ignoredUntrustedActorLabels":True,"chargedCredentialOwner":True,"upstreamDelta":1}
        delta=self.count()-before
        observation={"status":result["status"],"upstreamDelta":delta}
        self.proof["cases"][-1]["observations"]=observation
        require_auth_refusal(result,delta)
        return observation

    def missing_membership(self, mode, policy=False):
        team,members,keys=self.fixture(mode)
        key=keys[members[0],"alpha"]
        require(self.call(mode,key)["status"]==200,"membership warm-cache call failed")
        self.settled(mode,team,1)
        if policy:
            # Fault injection into disposable upstream-owned schema only: lose
            # the referenced cap policy while retaining the credential.
            self.sql(mode,f'''UPDATE "LiteLLM_TeamMembership" SET budget_id=NULL WHERE team_id={quote(team)} AND user_id={quote(members[0])};''')
        else:
            self.admin(mode,"/team/member_delete",{"team_id":team,"user_id":members[0]})
        observations={}
        for cache in ("warm","cold"):
            if cache=="cold":
                shell("docker","restart",self.name+"-"+mode)
                eventually(lambda:self.ready(mode),"gateway did not restart for cold membership test",timeout=180,timeout_error=InfrastructureError)
            before=self.count()
            r=self.call(mode,key)
            observations[cache]={"status":r["status"],"upstreamDelta":self.count()-before}
        self.proof["cases"][-1]["observations"]=observations
        for result in observations.values():
            require_auth_refusal(result,result["upstreamDelta"])
        return observations

    def replace_revoke(self, mode):
        team,members,keys=self.fixture(mode,100,1.5)
        old=keys[members[0],"alpha"]
        require(self.call(mode,old)["status"]==200,"initial credential failed")
        self.settled(mode,team,1)
        replacement=self.key(mode,team,members[0])
        self.admin(mode,"/key/delete",{"keys":[old]})
        self.auth_refused(mode,old)
        require(self.call(mode,replacement)["status"]==200,"replacement credential failed")
        # Deleted key's total is absent from the key table by design; verify the
        # durable member/team/log sums independently, not zero on a new key.
        eventually(lambda: all(math.isclose(v,2*self.cost,rel_tol=1e-5) for k,v in self.totals(mode,team).items() if k!="keys"),"replacement lost accrued member spend")
        self.budget_refused(mode,replacement)
        return {"revokedWarmKeyBlocked":True,"replacementRetainsMemberSpend":True}

    def concurrent(self, mode):
        team,members,keys=self.fixture(mode,100,.5)
        self.control(mode="hold")
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
                work=[pool.submit(self.call,mode,keys[members[0],"alpha"],timeout=60000) for _ in range(CONCURRENCY)]
                try:
                    # A future gateway may reserve before dispatch and admit
                    # fewer than four. That is safer, not a failed experiment.
                    until=time.monotonic()+5
                    while self.control()["held"]<CONCURRENCY and time.monotonic()<until:
                        time.sleep(.1)
                    admitted=self.control()["held"]
                finally:
                    self.control(release=True)
                results=[f.result() for f in work]
            require(sum(r["status"]==200 for r in results)==admitted,"concurrent accounting did not match admitted requests")
            for result in results:
                if result["status"]!=200:
                    require_budget_refusal(result,0,self.budget_contract(result))
            if admitted:
                totals=self.settled(mode,team,admitted)
            else:
                totals=self.totals(mode,team)
                require(all(value==0 for value in totals.values()),"unadmitted concurrent work recorded unexpected spend")
            measurement=cap_observation("member",.5*self.cost,totals["members"])
            observations={"offeredConcurrency":CONCURRENCY,"inFlight":admitted,"settledUsd":totals,"cap":measurement,"maxPricedWorkOfferedInExperimentUsd":CONCURRENCY*self.cost}
            self.proof["cases"][-1]["observations"]=observations
            self.budget_refused(mode,keys[members[0],"beta"])
            # Recording a finite overshoot is useful evidence, but does not
            # satisfy strict configured-cap enforcement. No production allowance
            # is invented from this deliberately bounded experiment.
            require_configured_caps([measurement])
            return observations
        finally:
            self.control(release=True)

    def stream(self, mode, cancel=False):
        team,members,keys=self.fixture(mode,100,.5)
        self.control(mode="partial" if cancel else "normal")
        before=self.count()
        try:
            r=self.call(mode,keys[members[0],"alpha"],body={"stream":True,"stream_options":{"include_usage":True}},cancel=cancel)
            require(r["status"]==200 and self.count()==before+1,"stream did not reach actual provider adapter")
        finally:
            self.control(release=True)
        # A cancelled stream whose usage never arrives is an uncertain charge,
        # not permission to conclude that zero cost means budget enforcement.
        totals=self.settled(mode,team,1)
        self.budget_refused(mode,keys[members[0],"beta"])
        return {"cancelled":cancel,"nonzeroReconciledUsd":totals}

    def outage(self, mode):
        team,members,keys=self.fixture(mode)
        key=keys[members[0],"alpha"]
        require(self.call(mode,key)["status"]==200,"warm-cache call failed")
        self.settled(mode,team,1)
        db=self.name+"-"+mode+"-db"
        gateway=self.name+"-"+mode
        observations={}
        try:
            # Disconnect ONLY the gateway process from its DB using a separate
            # Docker network. The application database remains on the original
            # network: disconnecting the DB container would invalidate that claim.
            shell("docker","network","disconnect",self.name,gateway)
            isolated=self.name+"-outage"
            shell("docker","network","create","--internal",isolated)
            shell("docker","network","connect","--alias",mode,isolated,gateway)
            shell("docker","network","connect",isolated,self.name+"-client")
            shell("docker","network","connect","--alias","upstream",isolated,self.name+"-upstream")
            before=self.count()
            warm=self.call(mode,key,timeout=10000)
            observations["warm"]={"status":warm["status"],"upstreamDelta":self.count()-before}
            shell("docker","restart",gateway)
            time.sleep(3)
            before=self.count()
            cold=self.call(mode,key,timeout=10000)
            observations["cold"]={"status":cold["status"],"upstreamDelta":self.count()-before}
            observations["applicationDbAvailable"]=shell("docker","exec",db,"psql","-X","-U","proof","-d","application","-Atc","SELECT 1")=="1"
        finally:
            for container in (gateway,self.name+"-client",self.name+"-upstream"):
                shell("docker","network","disconnect",self.name+"-outage",container,check=False)
            shell("docker","network","rm",self.name+"-outage",check=False)
            shell("docker","network","connect","--alias",mode,self.name,gateway,check=False)
            shell("docker","restart",gateway)
            eventually(lambda:self.ready(mode),"gateway did not recover after database outage",timeout=180,timeout_error=InfrastructureError)
        self.proof["cases"][-1]["observations"]=observations
        require(observations["applicationDbAvailable"],"application database was unavailable during outage")
        for entry in (observations["warm"],observations["cold"]):
            require(entry["status"]==0 or entry["status"]>=400,"gateway failed open during database outage")
            require(entry["upstreamDelta"]==0,"unavailable budget authority reached upstream")
        self.settled(mode,team,1)
        return observations

    def restore(self, mode):
        team,members,keys=self.fixture(mode,100,.5)
        key=keys[members[0],"alpha"]
        require(self.call(mode,key)["status"]==200,"pre-restore priced call failed")
        self.settled(mode,team,1)
        db=self.name+"-"+mode+"-db"
        gateway=self.name+"-"+mode
        # Logical backup/restore of the gateway's OWN schema only. No engine SQL.
        dump=shell("docker","exec",db,"pg_dump","-U","proof","--no-owner","litellm")
        shell("docker","stop",gateway)
        shell("docker","exec",db,"dropdb","-U","proof","litellm")
        shell("docker","exec",db,"createdb","-U","proof","litellm")
        shell("docker","exec","-i",db,"psql","-X","-v","ON_ERROR_STOP=1","-U","proof","-d","litellm",input=dump)
        shell("docker","start",gateway)
        eventually(lambda:self.ready(mode),"gateway did not recover after restore",timeout=180,timeout_error=InfrastructureError)
        self.settled(mode,team,1)
        self.budget_refused(mode,key)
        return {"gatewaySpendSurvivesLogicalRestore":True,"coldRestoredKeyRemainsCapped":True}

    def cleanup(self):
        ok=True
        for name in reversed(self.containers):
            shell("docker","rm","-f",name,check=False)
            if shell("docker","ps","-aq","--filter","name=^/"+name+"$"):
                ok=False
        for suffix in ("-outage", ""):
            shell("docker","network","rm",self.name+suffix,check=False)
        if self.network_created and shell("docker","network","ls","-q","--filter","name=^"+self.name+"$"):
            ok=False
        shutil.rmtree(self.root)
        self.proof["cleanup"]={"containersAndNetworksRemoved":ok,"fixtureFilesRemoved":not self.root.exists()}
        return ok


def main():
    require(len(sys.argv)==4,"usage: probe ROLE_IMAGE MANIFEST EVIDENCE_JSON")
    manifest=json.loads(pathlib.Path(sys.argv[2]).read_text())
    topology=Topology(sys.argv[1],manifest,pathlib.Path(sys.argv[3]))
    try:
        topology.start()
        for mode in ("included","external"):
            if mode=="external":
                unused_before=topology.sql("included",'SELECT count(*) FROM "LiteLLM_SpendLogs";')
            topology.case(mode,"nonzero-serial-member-and-installation-caps",lambda:topology.serial(mode))
            topology.case(mode,"actual-sdk-and-installed-eve-refusal",lambda:topology.sdk_refusal(mode))
            for identity in ("invalid","absent","unknown-member","mismatched"):
                topology.case(mode,"identity-"+identity,lambda identity=identity:topology.identities(mode,identity))
            topology.case(mode,"revoked-membership-warm-and-cold",lambda:topology.missing_membership(mode))
            topology.case(mode,"missing-cap-policy-warm-and-cold",lambda:topology.missing_membership(mode,policy=True))
            topology.case(mode,"replace-and-revoke",lambda:topology.replace_revoke(mode))
            topology.case(mode,"concurrent-overshoot",lambda:topology.concurrent(mode))
            topology.case(mode,"stream-charge",lambda:topology.stream(mode))
            topology.case(mode,"cancelled-stream-uncertain-charge",lambda:topology.stream(mode,cancel=True))
            topology.case(mode,"warm-and-cold-db-outage",lambda:topology.outage(mode))
            topology.case(mode,"restore-spend",lambda:topology.restore(mode))
            if mode=="external":
                def unused():
                    unchanged=topology.sql("included",'SELECT count(*) FROM "LiteLLM_SpendLogs";')==unused_before
                    trap=topology.control()["trapCount"]
                    require(unchanged and trap==0,"external selection reached unused included/default endpoint")
                    return {"includedSpendLogsUnchanged":True,"unusedDefaultEndpointRequests":trap}
                topology.case(mode,"unused-included-endpoint-trap",unused)
    except Exception as e:
        topology.proof["setupFailure"]=str(e) if isinstance(e,ProbeError) else type(e).__name__
    finally:
        cleaned=topology.cleanup()
        topology.proof["status"]="PASS" if cleaned and "setupFailure" not in topology.proof and all(c["status"]=="PASS" for c in topology.proof["cases"]) else "FAIL"
        topology.save()
        print(json.dumps(topology.proof,indent=2))
    return 0 if topology.proof["status"]=="PASS" else 1


if __name__=="__main__":
    sys.exit(main())
