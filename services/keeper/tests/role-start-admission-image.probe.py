"""CI-only generated-Compose admission proof for one neutral role runtime image."""
from __future__ import annotations

import fcntl
import importlib.util
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

if os.environ.get("CI") != "true" or os.geteuid() != 0:
    raise SystemExit("Role startup admission proof requires the isolated CI root fixture")
if len(sys.argv) != 5:
    raise SystemExit("usage: role-start-admission-image.probe.py <role> <image> <source-sha> <proof.json>")

ROLE, IMAGE, SOURCE_SHA, PROOF_PATH = sys.argv[1:]
if ROLE not in ("chief-of-staff", "creative") or len(SOURCE_SHA) != 40:
    raise SystemExit("invalid role startup admission proof identity")
REPO = pathlib.Path(__file__).resolve().parents[3]
DB_IMAGE = "docker.io/pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b"
spec = importlib.util.spec_from_file_location("maintenance_custody", REPO / "services/box/ops/maintenance-custody.py")
custody = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(custody)

root = pathlib.Path(tempfile.mkdtemp(prefix="lares-role-start-admission-")).resolve()
root.chmod(0o755)
custody_dir = root / "custody"
admission_dir = root / "admission"
agents_dir = root / "agents"
secrets_dir = root / "secrets"
definition_dir = agents_dir / "matrix-agent"
for directory, mode in ((custody_dir, 0o700), (admission_dir, 0o755),
                        (agents_dir, 0o755), (definition_dir, 0o755), (secrets_dir, 0o755)):
    directory.mkdir(mode=mode)
    directory.chmod(mode)
installation_id = str(uuid.uuid4())
epoch = 7
custody.prepare(custody_dir, admission_dir, installation_id, epoch)
project = "lares-role-admission-" + uuid.uuid4().hex[:10]
subnet = f"172.29.{secrets.randbelow(180) + 30}.0/24"
network = project + "-network"
service_name = "lares-matrix-agent"
host = "172.29." + subnet.split(".")[2] + ".10"
known_containers: set[str] = set()
container_id: str | None = None
db_name = project + "-db"
known_containers.add(db_name)
proof = {
    "format": 1, "sourceCommit": SOURCE_SHA, "role": ROLE, "image": IMAGE,
    "databaseImage": DB_IMAGE, "status": "running", "failedStage": None,
    "claims": {
        "actualRendererUsed": False, "effectiveGeneratedComposeMatchesExceptImage": False,
        "bakedGuardAndExplicitDefaultCommand": False, "compiledServerReady": False,
        "cliPid1AndCompiledChildHoldHostGateInode": False,
        "ordinaryImageNodeFd9ClassificationAndThreeStdio": False,
        "exclusiveFlockBlockedLiveAndReleasedAfterStop": False,
        "restartReachedReadyAndRetainedAdmission": False,
        "enteringBlockedAndCommandOverrideRefusedBeforeSecretRead": False,
        "wrongIdentityEpochAndUnsafeIntentRefused": False,
        "missingBindSourceRefused": False,
        "oldRoleImageWithoutBakedGuardRefused": False,
    },
    "stages": {}, "cleanupOkay": False,
}
stage = "fixture-setup"


class ProbeFailure(Exception):
    pass


def run(*args: str, timeout: int = 60, check: bool = True,
        input_data: str | bytes | None = None) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(args, input=input_data, text=isinstance(input_data, str) or input_data is None,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise ProbeFailure("timeout") from None
    if check and result.returncode != 0:
        raise ProbeFailure("command")
    return result


def docker(*args: str, timeout: int = 60, check: bool = True,
           input_data: str | bytes | None = None) -> subprocess.CompletedProcess:
    return run("docker", *args, timeout=timeout, check=check, input_data=input_data)


compose_files = ["-f", str(root / "generated.compose.yml"), "-f", str(root / "image-override.compose.yml")]


def compose(*args: str, timeout: int = 60, check: bool = True) -> subprocess.CompletedProcess:
    return docker("compose", "-p", project, *compose_files, *args, timeout=timeout, check=check)


def db_exec(*args: str, timeout: int = 60, check: bool = True,
            input_data: str | bytes | None = None) -> subprocess.CompletedProcess:
    return docker("exec", "-i", db_name, *args, timeout=timeout, check=check, input_data=input_data)


def refresh_container_id() -> str:
    global container_id
    result = compose("ps", "-aq", service_name, check=False, timeout=8)
    ids = result.stdout.splitlines()
    if result.returncode != 0 or len(ids) != 1 or not ids[0].strip():
        raise ProbeFailure("compose-role-container-id")
    container_id = ids[0].strip()
    known_containers.add(container_id)
    return container_id


def current_container_id() -> str:
    if not container_id:
        raise ProbeFailure("compose-role-container-not-resolved")
    return container_id


def render_generated_compose() -> tuple[pathlib.Path, dict[str, object]]:
    version_result = None
    try:
        version_result = docker("compose", "version", "--short", timeout=8, check=False)
        version_match = re.fullmatch(r"v?(\d{1,3})\.(\d{1,3})\.(\d{1,3})", version_result.stdout.strip())
    except ProbeFailure:
        version_match = None
    if version_result is not None and version_result.returncode == 0 and version_match:
        proof["stages"]["composeVersion"] = {
            "major": int(version_match.group(1)),
            "minor": int(version_match.group(2)),
            "patch": int(version_match.group(3)),
        }
    password = secrets.token_hex(20)
    workflow_password = secrets.token_hex(20)
    for name, value in (("database-password", password), ("workflow-password", workflow_password),
                        ("gateway-key", "disposable-ci-gateway-key")):
        file = secrets_dir / name
        file.write_text(value + "\n", encoding="ascii")
        file.chmod(0o444)
    for name in ("agent.json", "duties.md", "voice.md"):
        source = REPO / "services" / ROLE / ("agent/" + name if name != "agent.json" else name)
        if name == "agent.json":
            definition = json.loads(source.read_text(encoding="utf-8"))
            definition["name"] = "matrix-agent"
            (definition_dir / name).write_text(json.dumps(definition, indent=2) + "\n", encoding="utf-8")
        elif source.is_file():
            shutil.copyfile(source, definition_dir / name)
    if not (definition_dir / "duties.md").exists():
        (definition_dir / "duties.md").write_text("", encoding="utf-8")

    placeholder = "ghcr.io/lares/neutral-role-runtime@sha256:" + "a" * 64
    fixture_agent = {
        "name": "matrix-agent", "role": ROLE, "address": host, "doors": [],
        "runtime": {
            "databaseUrl": "postgresql://lares_app@db:5432/lares_state",
            "workflowUrl": "postgresql://lares_workflow@db:5432/lares_workflow",
            "gatewayUrl": "https://gateway.invalid", "proxyUrl": "http://proxy.invalid:3128",
            "gatewayKeyFile": str(secrets_dir / "gateway-key"),
            "passwordFile": str(secrets_dir / "database-password"),
            "workflowPasswordFile": str(secrets_dir / "workflow-password"),
        },
    }
    fixture_options = {
        "network": network, "imageByRole": {ROLE: placeholder},
        "agentsDir": str(agents_dir), "secretsDir": str(secrets_dir),
        "maintenanceAdmission": {"hostDirectory": str(admission_dir), "installationId": installation_id, "epoch": epoch},
        "modelPrefix": "lares",
    }
    script = root / "render-role-compose.mts"
    compose_source = (REPO / "services/keeper/lib/compose-agents.ts").as_posix()
    script.write_text(
        f'import {{ renderAgentsCompose }} from "{compose_source}";\n'
        'import { writeFileSync } from "node:fs";\n'
        f'const rendered=renderAgentsCompose({json.dumps([fixture_agent])},{json.dumps(fixture_options)});\n'
        f'writeFileSync({json.dumps(str(root / "generated.compose.yml"))},rendered);\n',
        encoding="utf-8")
    tsx = REPO / "node_modules/.bin/tsx"
    if not tsx.is_file():
        raise ProbeFailure("keeper-tsx-not-installed")
    run(str(tsx), str(script), timeout=60)
    proof["claims"]["actualRendererUsed"] = True

    override = root / "image-override.compose.yml"
    override.write_text("services:\n  " + service_name + ":\n    image: " + IMAGE + "\n", encoding="utf-8")
    generated = json.loads(docker("compose", "-p", project, "-f", str(root / "generated.compose.yml"),
                                  "config", "--format", "json").stdout)
    effective = json.loads(docker("compose", "-p", project, *compose_files, "config", "--format", "json").stdout)
    try:
        expected_service = generated["services"][service_name]
        actual_service = effective["services"][service_name]
    except (KeyError, TypeError):
        raise ProbeFailure("generated-service-missing") from None
    expected_copy = json.loads(json.dumps(expected_service))
    actual_copy = json.loads(json.dumps(actual_service))
    expected_copy["image"] = actual_copy["image"]
    if expected_copy != actual_copy:
        raise ProbeFailure("effective-service-drift")
    proof["claims"]["effectiveGeneratedComposeMatchesExceptImage"] = True
    mounts = [item for item in actual_service.get("volumes", []) if item.get("target") == "/run/lares-maintenance/admission"]
    contract = {
        "entrypointMatches": actual_service.get("entrypoint") == ["/usr/local/lib/lares/maintenance-admission-v1",
            "/run/lares-maintenance/admission", installation_id, str(epoch), "--"],
        "commandMatches": actual_service.get("command") == ["/usr/local/bin/lares-start"],
        "userMatches": actual_service.get("user") == "10001:10001",
        "serviceReadOnly": actual_service.get("read_only") is True,
        "admissionMountCountIsOne": len(mounts) == 1,
        "admissionMountSourceMatches": len(mounts) == 1 and mounts[0].get("source") == str(admission_dir),
        "admissionMountTargetMatches": len(mounts) == 1 and mounts[0].get("target") == "/run/lares-maintenance/admission",
        "admissionMountReadOnly": len(mounts) == 1 and mounts[0].get("read_only") is True,
        "admissionBindCreateHostPathFalse": len(mounts) == 1 and mounts[0].get("bind", {}).get("create_host_path") is False,
    }
    proof["stages"]["generatedServiceContract"] = contract
    if actual_service.get("entrypoint") != ["/usr/local/lib/lares/maintenance-admission-v1",
            "/run/lares-maintenance/admission", installation_id, str(epoch), "--"] or \
       actual_service.get("command") != ["/usr/local/bin/lares-start"] or \
       actual_service.get("user") != "10001:10001" or actual_service.get("read_only") is not True or \
       len(mounts) != 1 or mounts[0].get("source") != str(admission_dir) or \
       mounts[0].get("read_only") is not True or mounts[0].get("bind", {}).get("create_host_path") is not False:
        raise ProbeFailure("generated-service-contract")
    image_config = json.loads(docker("image", "inspect", "--format", "{{json .Config}}", IMAGE).stdout)
    if image_config.get("Entrypoint") != ["/usr/local/lib/lares/maintenance-admission-v1"] or \
       image_config.get("Cmd") != ["/usr/local/bin/lares-start"]:
        raise ProbeFailure("baked-image-default")
    proof["claims"]["bakedGuardAndExplicitDefaultCommand"] = True
    return override, actual_service


def start_database() -> None:
    pg_password = secrets.token_hex(20)
    docker("run", "--detach", "--name", db_name, "--network", network, "--network-alias", "db",
           "--env", "POSTGRES_PASSWORD=" + pg_password, "--env", "POSTGRES_DB=lares_state", DB_IMAGE)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        ready = docker("exec", db_name, "pg_isready", "-U", "postgres", "-d", "lares_state", check=False, timeout=8)
        if ready.returncode == 0:
            break
        time.sleep(0.25)
    else:
        raise ProbeFailure("postgres-ready-timeout")
    password = (secrets_dir / "database-password").read_text(encoding="ascii").strip()
    workflow_password = (secrets_dir / "workflow-password").read_text(encoding="ascii").strip()
    setup = ("CREATE ROLE lares_app LOGIN SUPERUSER PASSWORD '" + password + "';\n" +
             "CREATE ROLE lares_workflow LOGIN SUPERUSER PASSWORD '" + workflow_password + "';\n" +
             "CREATE DATABASE lares_workflow OWNER lares_workflow;\n")
    db_exec("psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", input_data=setup)
    db_exec("psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "lares_state",
            input_data=(REPO / "services/box/sql/001_baseline.sql").read_bytes(), timeout=120)
    proof["stages"]["disposableDatabase"] = True


def wait_ready() -> None:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        inspect = docker("inspect", "--format", "{{.State.Running}}", current_container_id(), check=False, timeout=8)
        if inspect.returncode == 0 and inspect.stdout.strip() == "true":
            response = docker("exec", current_container_id(), "node", "-e",
                "fetch('http://127.0.0.1:3000/eve/v1/health').then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(t=>{if(!t)process.exit(2)}).catch(()=>process.exit(3))",
                check=False, timeout=10)
            if response.returncode == 0:
                return
            logs = docker("logs", current_container_id(), check=False, timeout=8)
            if "maintenance admission refused" in logs.stdout:
                raise ProbeFailure("normal-start-refused")
        time.sleep(0.25)
    raise ProbeFailure("compiled-server-not-ready")


def container_process_and_gate() -> None:
    probe = """const fs=require('node:fs');const base='/proc';const pid1=fs.readFileSync(base+'/1/cmdline').toString().split('\\0').filter(Boolean).join(' ');if(!pid1.includes('eve')||!pid1.includes('start'))process.exit(2);let serverPid;for(const entry of fs.readdirSync(base)){if(!/^\\d+$/.test(entry)||entry==='1')continue;try{const s=fs.readFileSync(base+'/'+entry+'/status','utf8');if(!/^PPid:\\s+1$/m.test(s))continue;const args=fs.readFileSync(base+'/'+entry+'/cmdline').toString().split('\\0').filter(Boolean).join(' ');if(args.endsWith('/.output/server/index.mjs')){serverPid=entry;break}}catch{}}if(!serverPid)process.exit(3);const out={pid1,serverPid,pid1Gate:fs.statSync(base+'/1/fd/9'),serverGate:fs.statSync(base+'/'+serverPid+'/fd/9')};process.stdout.write(JSON.stringify({pid1,serverPid,pid1Dev:out.pid1Gate.dev,pid1Ino:out.pid1Gate.ino,serverDev:out.serverGate.dev,serverIno:out.serverGate.ino}))"""
    inside = docker("exec", current_container_id(), "node", "-e", probe)
    try:
        seen = json.loads(inside.stdout)
    except json.JSONDecodeError:
        raise ProbeFailure("role-process-inspect") from None
    gate = (admission_dir / "service-gate.lock").stat()
    expected = (gate.st_dev, gate.st_ino)
    actual_pid1 = (seen.get("pid1Dev"), seen.get("pid1Ino"))
    actual_server = (seen.get("serverDev"), seen.get("serverIno"))
    if actual_pid1 != expected or actual_server != expected:
        raise ProbeFailure("host-gate-inode-mismatch")
    proof["claims"]["cliPid1AndCompiledChildHoldHostGateInode"] = True


def ordinary_image_fd9_classification() -> None:
    # Run the pinned production function using the newly built role image's Node. Only the
    # classifier callsite and process side effects are instrumented; the image supplies its code.
    script = r'''import{createRequire}from"node:module";import{dirname,join}from"node:path";import{readFileSync,writeFileSync,mkdirSync,rmSync,existsSync}from"node:fs";import{pathToFileURL}from"node:url";
const role=__ROLE__,require=createRequire(`/app/services/${role}/package.json`);let eveRoot=dirname(require.resolve("eve"));while(eveRoot!==dirname(eveRoot)){const packagePath=join(eveRoot,"package.json");try{if(JSON.parse(readFileSync(packagePath,"utf8")).name==="eve")break}catch{}eveRoot=dirname(eveRoot)}
const productionPath=join(eveRoot,"dist/src/internal/nitro/host/start-production-server.js"),source0=readFileSync(productionPath,"utf8");for(const marker of ["function validateMaintenanceAdmission(participating=false)","try{gateFd=fstatSync(9)}catch(error){statError=error}","stdio:(checkAdmission()?"])if(!source0.includes(marker))throw Error("pinned Eve production marker missing: "+marker);
for(const key of ["LARES_MAINTENANCE_ADMISSION_DIR","LARES_MAINTENANCE_INSTALLATION_ID","LARES_MAINTENANCE_EPOCH"])delete process.env[key];
const scratch=`/tmp/lares-role-fd9-${process.pid}`,modulePath=join(scratch,"start-production-server.mjs"),appRoot=join(scratch,"app"),inventoryPath=join(scratch,"inventory.json"),stdioPath=join(scratch,"stdio.json");mkdirSync(join(appRoot,".output/server"),{recursive:true});writeFileSync(join(appRoot,".output/server/index.mjs"),"import{createServer}from'node:http';createServer((_q,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');");
let source=source0;source=source.replace('import{loadDevelopmentEnvironmentFiles}from"#cli/dev/environment.js";','const loadDevelopmentEnvironmentFiles=async()=>{};').replace('import{prewarmBuiltAppSandboxes}from"#execution/sandbox/prewarm.js";','const prewarmBuiltAppSandboxes=async()=>{};').replace('import{closeSync,constants,existsSync,fstatSync,lstatSync,openSync,readSync}from"node:fs";','import{closeSync,constants,existsSync,fstatSync,lstatSync,openSync,readSync,writeFileSync}from"node:fs";').replace('import{spawn}from"node:child_process";','import{spawn as realSpawn}from"node:child_process";const spawn=(...args)=>{writeFileSync('+JSON.stringify(stdioPath)+',JSON.stringify(args[2].stdio));return realSpawn(...args)};');
const original='try{gateFd=fstatSync(9)}catch(error){statError=error}',instrumented='try{gateFd=fstatSync(9);writeFileSync('+JSON.stringify(inventoryPath)+',JSON.stringify({fd:9,metadataPresent,isRegular:gateFd.isFile(),isFIFO:gateFd.isFIFO(),isSocket:gateFd.isSocket(),mode:gateFd.mode,dev:gateFd.dev,ino:gateFd.ino}))}catch(error){writeFileSync('+JSON.stringify(inventoryPath)+',JSON.stringify({fd:9,metadataPresent,error:error.code}));statError=error}';if(!source.includes(original))throw Error("fd9 classifier instrumentation point missing");source=source.replace(original,instrumented);writeFileSync(modulePath,source);
const emitEvidence=()=>process.stderr.write("LARES_FD9_EVIDENCE="+JSON.stringify({nodeVersion:process.version,productionPath,inventory:JSON.parse(readFileSync(inventoryPath,"utf8")),stdio:existsSync(stdioPath)?JSON.parse(readFileSync(stdioPath,"utf8")):null})+"\n");process.exit=code=>{throw Object.assign(new Error("captured admission exit"),{code:"LARES_TEST_EXIT",exitCode:code})};
try{const{startProductionServer}=await import(pathToFileURL(modulePath));const server=await startProductionServer(appRoot,{host:"127.0.0.1",port:0});await server.close();await server.wait();emitEvidence();}catch(error){if(error?.code!=="LARES_TEST_EXIT")throw error;emitEvidence();process.exitCode=error.exitCode;}finally{rmSync(scratch,{recursive:true,force:true})}'''
    script = script.replace("__ROLE__", json.dumps(ROLE))
    result = docker("exec", current_container_id(), "node", "--input-type=module", "-e", script, check=False, timeout=30)
    try:
        line = next(line for line in reversed(result.stdout.splitlines()) if line.startswith("LARES_FD9_EVIDENCE="))
        evidence = json.loads(line.removeprefix("LARES_FD9_EVIDENCE="))
    except (StopIteration, json.JSONDecodeError):
        raise ProbeFailure("ordinary-image-node-fd9-evidence") from None
    if not str(evidence.get("nodeVersion", "")).startswith("v24."):
        raise ProbeFailure("ordinary-image-node-version")
    proof["ordinaryImageNodeFd9"] = evidence
    if result.returncode != 0:
        raise ProbeFailure("ordinary-image-node-fd9-classification")
    inventory, stdio = evidence.get("inventory", {}), evidence.get("stdio")
    ordinary = inventory.get("metadataPresent") is False and \
        (inventory.get("error") == "EBADF" or inventory.get("isRegular") is False)
    if not ordinary or stdio != ["ignore", "pipe", "pipe"]:
        raise ProbeFailure("ordinary-image-node-fd9-classification")
    proof["claims"]["ordinaryImageNodeFd9ClassificationAndThreeStdio"] = True


def contender(expected: int) -> None:
    result = docker("run", "--rm", "--network", "none", "--user", "10001:10001",
        "--mount", f"type=bind,src={admission_dir / 'service-gate.lock'},dst=/gate,readonly",
        "--entrypoint", "flock", IMAGE, "--exclusive", "--nonblock", "/gate", "true",
        check=False, timeout=15)
    if result.returncode != expected:
        raise ProbeFailure("exclusive-flock-result")


def refusal(label: str, *, command: list[str] | None = None, timeout: int = 15) -> subprocess.CompletedProcess:
    args = ["run", "--rm", "--no-deps", service_name]
    if command:
        args.extend(command)
    result = compose(*args, check=False, timeout=timeout)
    if result.returncode != 78 or result.stdout.strip().splitlines()[-1:] != ["maintenance admission refused"]:
        raise ProbeFailure("refusal-" + label)
    proof["stages"]["refusal-" + label] = True
    return result


def main() -> None:
    global stage
    stage = "network-and-renderer"
    docker("network", "create", "--driver", "bridge", "--subnet", subnet, network)
    _, service = render_generated_compose()
    start_database()
    stage = "default-compose-start"
    compose("up", "-d", service_name, timeout=120)
    refresh_container_id()
    wait_ready()
    proof["claims"]["compiledServerReady"] = True
    proof["stages"]["defaultCompiledStartup"] = True
    image_id = docker("image", "inspect", "--format", "{{.Id}}", IMAGE).stdout.strip()
    running_image_id = docker("inspect", "--format", "{{.Image}}", current_container_id()).stdout.strip()
    if image_id != running_image_id:
        raise ProbeFailure("actual-role-image-id")
    proof["actualImageId"] = image_id
    container_process_and_gate()
    ordinary_image_fd9_classification()
    contender(1)
    proof["stages"]["exclusiveDeniedWhileLive"] = True

    stage = "restart-normal"
    compose("restart", service_name, timeout=120)
    refresh_container_id()
    wait_ready()
    container_process_and_gate()
    contender(1)
    proof["claims"]["restartReachedReadyAndRetainedAdmission"] = True
    compose("stop", service_name, timeout=30)
    contender(0)
    proof["claims"]["exclusiveFlockBlockedLiveAndReleasedAfterStop"] = True

    stage = "entering-restart-and-secret-tripwire"
    custody.transition(custody_dir, admission_dir, installation_id, epoch, "entering")
    password_file = secrets_dir / "database-password"
    saved_password = secrets_dir / "database-password.saved"
    password_file.rename(saved_password)
    os.mkfifo(password_file, 0o600)
    password_file.chmod(0o444)
    no_restart = root / "restart-no.compose.yml"
    no_restart.write_text("services:\n  " + service_name + ":\n    restart: \"no\"\n", encoding="utf-8")
    docker("compose", "-p", project, *compose_files, "-f", str(no_restart),
        "up", "-d", "--no-deps", service_name, timeout=60)
    refresh_container_id()

    def wait_for_refusal_exit(expected_code: int, timeout: int = 30) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = docker("inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}",
                           current_container_id(), check=False, timeout=8)
            if state.returncode != 0:
                raise ProbeFailure("refusal-container-inspect")
            status, _, exit_code = state.stdout.strip().partition("|")
            if status == "exited":
                if exit_code != str(expected_code):
                    raise ProbeFailure("refusal-container-exit-code")
                logs = docker("logs", current_container_id(), check=False, timeout=8)
                if logs.returncode != 0 or logs.stdout.splitlines()[-1:] != ["maintenance admission refused"]:
                    raise ProbeFailure("refusal-container-logs")
                return
            time.sleep(0.25)
        raise ProbeFailure("refusal-container-exit-timeout")

    wait_for_refusal_exit(78)
    refusal("entering", timeout=15)
    marker = "ROLE_ADMISSION_COMMAND_CANARY"
    command_result = refusal("command-override-entering", command=["/bin/sh", "-ec", "echo " + marker], timeout=15)
    if marker in command_result.stdout:
        raise ProbeFailure("command-override-canary")
    password_file.unlink()
    saved_password.rename(password_file)
    custody.transition(custody_dir, admission_dir, installation_id, epoch, "blocked")
    refusal("blocked")
    proof["claims"]["enteringBlockedAndCommandOverrideRefusedBeforeSecretRead"] = True

    # Each identity/unsafe-file fixture is freshly prepared using the host custody writer; the
    # generated service continues to carry the original receipt-derived ID and epoch.
    stage = "wrong-identity-epoch-unsafe-intent"
    def replace_admission(identity: str, next_epoch: int) -> None:
        shutil.rmtree(admission_dir)
        admission_dir.mkdir(mode=0o755)
        gate = admission_dir / "service-gate.lock"
        gate.write_bytes(b"")
        gate.chmod(0o444)
        intent = admission_dir / "intent.json"
        intent.write_bytes(custody._record(identity, next_epoch, "normal"))
        intent.chmod(0o444)
    replace_admission(str(uuid.uuid4()), epoch)
    refusal("wrong-identity")
    replace_admission(installation_id, epoch + 1)
    refusal("wrong-epoch")
    replace_admission(installation_id, epoch)
    (admission_dir / "intent.json").chmod(0o644)
    refusal("unsafe-intent")
    (admission_dir / "intent.json").chmod(0o444)
    (admission_dir / "intent.json").unlink()
    refusal("missing-intent")
    proof["claims"]["wrongIdentityEpochAndUnsafeIntentRefused"] = True

    stage = "missing-bind-source"
    intent_path = admission_dir / "intent.json"
    intent_path.write_bytes(custody._record(installation_id, epoch, "normal"))
    intent_path.chmod(0o444)
    compose("down", "--remove-orphans", timeout=45)
    saved_admission = root / "admission.saved"
    admission_dir.rename(saved_admission)
    missing = compose("run", "--rm", "--no-deps", service_name, check=False, timeout=20)
    if missing.returncode == 0 or "bind source path does not exist" not in missing.stdout or \
       str(admission_dir) not in missing.stdout or "maintenance admission refused" in missing.stdout:
        raise ProbeFailure("missing-bind-source-outcome")
    if compose("ps", "-aq", service_name).stdout.strip():
        raise ProbeFailure("missing-bind-source-started-service")
    saved_admission.rename(admission_dir)
    restored = compose("run", "--rm", "--no-deps", service_name, "/bin/true", check=False, timeout=20)
    if restored.returncode != 0 or "maintenance admission refused" in restored.stdout:
        raise ProbeFailure("restored-bind-source-control")
    proof["claims"]["missingBindSourceRefused"] = True

    stage = "old-image-without-guard"
    release = json.loads((REPO / "releases/2026-10-21-rc.12.json").read_text(encoding="utf-8"))
    old_image = release["images"][ROLE]
    docker("pull", old_image, timeout=180)
    old_override = root / "old-image.compose.yml"
    old_override.write_text("services:\n  " + service_name + ":\n    image: " + old_image + "\n", encoding="utf-8")
    old_result = docker("compose", "-p", project, "-f", str(root / "generated.compose.yml"),
        "-f", str(old_override), "run", "--rm", "--no-deps", service_name,
        check=False, timeout=30)
    if old_result.returncode == 0 or "maintenance-admission-v1" not in old_result.stdout:
        raise ProbeFailure("old-role-image-guard")
    proof["claims"]["oldRoleImageWithoutBakedGuardRefused"] = True
    proof["stages"]["oldImageGuardMissing"] = True


def cleanup() -> None:
    okay = True
    try:
        down = docker("compose", "-p", project, *compose_files, "down", "--remove-orphans", timeout=45, check=False)
        if down.returncode != 0:
            remaining = docker("compose", "-p", project, *compose_files, "ps", "-aq", check=False, timeout=8)
            if remaining.returncode != 0 or remaining.stdout.strip():
                okay = False
    except Exception:
        okay = False
    for name in sorted(known_containers):
        try:
            removed = docker("rm", "--force", name, timeout=15, check=False)
            if removed.returncode != 0:
                inspect = docker("inspect", name, check=False, timeout=8)
                if inspect.returncode == 0 or "No such object" not in inspect.stdout:
                    okay = False
        except Exception:
            okay = False
    try:
        removed = docker("network", "rm", network, timeout=15, check=False)
        if removed.returncode != 0:
            remaining = docker("network", "ls", "-q", "--filter", "name=^" + network + "$", check=False, timeout=8)
            if remaining.returncode != 0 or remaining.stdout.strip():
                okay = False
    except Exception:
        okay = False
    shutil.rmtree(root, ignore_errors=True)
    if root.exists():
        okay = False
    proof["cleanupOkay"] = okay


try:
    main()
    proof["status"] = "passed"
except Exception as error:
    proof["status"] = "failed"
    proof["failedStage"] = stage
    proof["failureKind"] = error.__class__.__name__
    proof["failureMessage"] = str(error)[:300]
    raise
finally:
    cleanup()
    pathlib.Path(PROOF_PATH).write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
