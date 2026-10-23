"""CI-only proof of the disposable external-HBA and cooperating lease primitives."""
from __future__ import annotations

import base64
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
import pathlib
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

if os.environ.get("CI") != "true":
    raise SystemExit("Maintenance fence image proof runs only in disposable CI")
if os.geteuid() != 0:
    raise SystemExit("Maintenance fence image proof requires the isolated CI root fixture")
if len(sys.argv) != 4:
    raise SystemExit("usage: maintenance-fence-image.probe.py <keeper-image> <source-sha> <proof.json>")

IMAGE, SOURCE_SHA, PROOF_PATH = sys.argv[1:]
REPO = pathlib.Path(__file__).resolve().parents[3]
PINNED_DB_IMAGE = "docker.io/pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b"
if len(SOURCE_SHA) != 40 or any(char not in "0123456789abcdef" for char in SOURCE_SHA.lower()):
    raise SystemExit("Maintenance proof needs the checked-out source identity")

spec = importlib.util.spec_from_file_location(
    "maintenance_custody", REPO / "services/box/ops/maintenance-custody.py")
custody = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(custody)

root = pathlib.Path(tempfile.mkdtemp(prefix="lares-maintenance-proof-")).resolve()
root.chmod(0o755)
custody_dir = root / "custody"
admission_dir = root / "admission"
db_custody_dir = root / "database-custody"
db_admission_dir = root / "database-admission"
auth_dir = root / "database-auth"
data_dir = root / "database-data"
secrets_dir = root / "compose-secrets"
marker_dir = root / "participant-markers"
for directory, mode in ((custody_dir, 0o700), (admission_dir, 0o755),
                        (db_custody_dir, 0o700), (db_admission_dir, 0o755), (auth_dir, 0o755),
                        (data_dir, 0o700), (secrets_dir, 0o755), (marker_dir, 0o755)):
    directory.mkdir(mode=mode)
    directory.chmod(mode)
marker_dir.chmod(0o777)  # contains only readiness markers written by disposable uid 10001 processes
os.chown(data_dir, 999, 999)

private_root = pathlib.Path(tempfile.mkdtemp(prefix="lares-maintenance-private-")).resolve()
private_root.chmod(0o700)
operator_path = private_root / "operator-password"
operator_password = secrets.token_urlsafe(32)
operator_path.write_text(operator_password + "\n", encoding="ascii")
operator_path.chmod(0o600)
app_private = pathlib.Path(tempfile.mkdtemp(prefix="lares-maintenance-app-")).resolve()
app_private.chmod(0o700)
app_password_path = app_private / "app-password"
app_password = secrets.token_urlsafe(32)
app_password_path.write_text(app_password + "\n", encoding="ascii")
app_password_path.chmod(0o444)

installation_id = str(uuid.uuid4())
epoch = 1
project = "lares-maintenance-" + uuid.uuid4().hex[:12]
network = project + "-network"
subnet = f"172.29.{secrets.randbelow(200) + 20}.0/24"
bootstrap_file = root / "bootstrap-compose.yml"
normal_file = root / "normal-compose.yml"
override_file = root / "auth-override.yml"
compose_files = ["-f", str(normal_file), "-f", str(override_file)]
bootstrap_files = ["-f", str(bootstrap_file), "-f", str(override_file)]
holder_names = [project + "-holder-a", project + "-holder-b"]
known_containers: list[str] = []
active_exclusive_fd: int | None = None
proof = {
    "format": 1,
    "sourceCommit": SOURCE_SHA,
    "databaseImage": PINNED_DB_IMAGE,
    "claims": {
        "actualRenderersUsed": False,
        "actualOperatorDbRunUsed": False,
        "externalHbaIsSelected": False,
        "maintenanceHbaDeniesNewAppAndUnknownLogins": False,
        "existingAppSessionTerminatedExplicitly": False,
        "externalHbaSurvivesPgdataHbaAndRestart": False,
        "twoCooperatingReadOnlyHoldersBlockExclusive": False,
        "durableEnteringDeniesNewAdmissionBeforeExclusive": False,
        "boundedIntentReadRefusesOversize": False,
        "scopeLimitedToExplicitParticipants": True,
    },
    "stages": {},
    "status": "running",
    "failedStage": None,
    "failureKind": None,
    "cleanupOkay": False,
}
stage = "fixture-setup"


class ProbeFailure(Exception):
    def __init__(self, kind: str = "assertion") -> None:
        self.kind = kind


def run(*args: str, check: bool = True, timeout: int = 60,
        input_data: str | bytes | None = None,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(args, input=input_data, text=isinstance(input_data, str) or input_data is None,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                env=({**os.environ, **env} if env else None),
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise ProbeFailure("timeout") from None
    if check and result.returncode != 0:
        raise ProbeFailure("command")
    return result


def docker(*args: str, check: bool = True, timeout: int = 60,
           input_data: str | bytes | None = None) -> subprocess.CompletedProcess:
    return run("docker", *args, check=check, timeout=timeout, input_data=input_data)


def compose(*args: str, bootstrap: bool = False, check: bool = True,
            timeout: int = 90) -> subprocess.CompletedProcess:
    return docker("compose", "-p", project, *(bootstrap_files if bootstrap else compose_files),
                  *args, check=check, timeout=timeout)


def write_hba(content: str) -> None:
    temporary = auth_dir / (".pg_hba-" + secrets.token_hex(8))
    temporary.write_text(content, encoding="ascii")
    temporary.chmod(0o644)
    os.replace(temporary, auth_dir / "pg_hba.conf")
    custody._sync_dir(auth_dir)


NORMAL_HBA = """# disposable fixture; normal authenticated access
local all lares_operator scram-sha-256
host all lares_operator 0.0.0.0/0 scram-sha-256
host all lares_operator ::/0 scram-sha-256
local all all scram-sha-256
host all all 0.0.0.0/0 scram-sha-256
host all all ::/0 scram-sha-256
"""
MAINTENANCE_HBA = """# disposable fixture; exact offline operator only
local all lares_operator scram-sha-256
host all lares_operator 0.0.0.0/0 scram-sha-256
host all lares_operator ::/0 scram-sha-256
local all all reject
host all all 0.0.0.0/0 reject
host all all ::/0 reject
host replication all 0.0.0.0/0 reject
host replication all ::/0 reject
"""


def generate_rendered_compose() -> None:
    source = {
        "secretsDir": str(secrets_dir), "socketDir": str(root / "socket"),
        "tasteDir": str(root / "taste"), "gatewayConfigFile": str(root / "gateway.yml"),
        "gatewayStartScript": str(root / "gateway-start.sh"), "caddyfile": str(root / "Caddyfile"),
        "caddyDataDir": str(root / "caddy-data"), "dbDataDir": str(data_dir),
        "network": network, "subnet": subnet, "domain": "proof.invalid",
        "consoleAllowedEmails": "owner@example.invalid", "ownerId": "proof-owner",
        "ownerHomeTz": "UTC", "modelAlias": "proof-model", "pgDatabase": "proof",
    }
    for path in (root / "socket", root / "taste", root / "caddy-data"):
        path.mkdir(mode=0o755)
    for path in (root / "gateway.yml", root / "gateway-start.sh", root / "gateway-start.sh.admission_contract.py",
                 root / "gateway-start.sh.lares_gateway.py", root / "gateway.yml.profile.json", root / "Caddyfile"):
        path.write_text("fixture-only\n", encoding="ascii")
    for name in ("database-password", "console-session-secret", "eve-route-password", "gateway-key",
                 "gateway-master-key", "model-provider-key", "gateway-database-password", "token-enc-key"):
        (secrets_dir / name).write_text("fixture-only\n", encoding="ascii")
        (secrets_dir / name).chmod(0o600)
    args = {
        "release": "/release.json",
        "bootstrap": str(bootstrap_file), "normal": str(normal_file),
        "operator": str(operator_path), "data": str(data_dir), "network": network, "subnet": subnet,
        "stack": source,
    }
    code = """const fs=require('node:fs');
Promise.all([import('/app/services/box/lib/release-manifest.ts'),import('/app/services/box/lib/stack-compose.ts')]).then(([r,s])=>{
const manifest=r.parseReleaseManifest(fs.readFileSync('__RELEASE__','utf8'));
if(manifest.images.db!=='__DBIMAGE__')throw Error();
const bootstrap=s.renderDatabaseBootstrapCompose(manifest,{operatorPasswordFile:'__OPERATOR__',dbDataDir:'__DATA__',network:'__NETWORK__',subnet:'__SUBNET__'});
const normal=s.renderStackCompose(manifest,__STACK__);
fs.writeFileSync('__BOOTSTRAP__',bootstrap,{mode:0o600});fs.writeFileSync('__NORMAL__',normal,{mode:0o600});
}).catch(()=>process.exitCode=2);"""
    replacements = {
        "__RELEASE__": args["release"], "__DBIMAGE__": PINNED_DB_IMAGE,
        "__OPERATOR__": str(operator_path), "__DATA__": str(data_dir), "__NETWORK__": network,
        "__SUBNET__": subnet, "__BOOTSTRAP__": str(bootstrap_file), "__NORMAL__": str(normal_file),
        "__STACK__": json.dumps(source, separators=(",", ":")),
    }
    for key, value in replacements.items():
        code = code.replace(key, json.dumps(value)[1:-1] if key != "__STACK__" else value)
    docker("run", "--rm", "--network", "none", "--mount", f"type=bind,src={root},dst={root}",
           "--mount", f"type=bind,src={REPO / 'releases/2026-10-21-rc.12.json'},dst=/release.json,readonly",
           "--entrypoint", "/app/services/keeper/node_modules/.bin/tsx", IMAGE, "-e", code, timeout=45)
    override_file.write_text(
        "services:\n  db:\n    command:\n      - postgres\n      - -c\n      - hba_file=/run/lares-auth/pg_hba.conf\n"
        "    volumes:\n      - type: bind\n        source: " + str(auth_dir) +
        "\n        target: /run/lares-auth\n        read_only: true\n        bind:\n          create_host_path: false\n",
        encoding="utf-8")
    override_file.chmod(0o600)


def operator_call(compose_args: list[str], program: list[str], *, input_data: str | None = None,
                  check: bool = True, timeout: int = 60,
                  operator_timeout: int = 30) -> subprocess.CompletedProcess:
    compose_flags = " ".join("-f " + shlex.quote(compose_args[index + 1])
        for index in range(0, len(compose_args), 2) if compose_args[index] == "-f")
    command = " ".join(shlex.quote(value) for value in program)
    source = ". " + shlex.quote(str(REPO / "services/box/ops/engine-run.sh")) + "; operator_db_run -p " + \
        shlex.quote(project) + " " + compose_flags + " -- " + command
    # This is the actual host-side production helper. Password-bearing setup reaches psql over
    # stdin; only the protected file path is present in its environment.
    result = run("bash", "-ec", source, check=False, timeout=timeout, input_data=input_data,
                 env={"LARES_OPERATOR_PASSWORD_FILE": str(operator_path),
                      "OPERATOR_DB_TIMEOUT": str(operator_timeout)})
    if check and result.returncode != 0:
        raise ProbeFailure("operator-client")
    return result


def operator_query(compose_args: list[str], sql: str, *, check: bool = True) -> str:
    result = operator_call(compose_args, ["psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1",
                                         "-U", "lares_operator", "-d", "postgres", "-c", sql], check=check)
    return result.stdout.strip()


def operator_script(compose_args: list[str], script: str) -> subprocess.CompletedProcess:
    return operator_call(compose_args, ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-U",
                                        "lares_operator", "-d", "postgres", "-f", "-"], input_data=script)


def wait_operator_ready(compose_args: list[str], budget_seconds: int = 90) -> None:
    deadline = time.monotonic() + budget_seconds
    while time.monotonic() < deadline:
        remaining = max(1, int(deadline - time.monotonic()))
        call_timeout = min(10, remaining)
        result = operator_call(compose_args, ["psql", "-X", "-A", "-t", "-q", "-v",
            "ON_ERROR_STOP=1", "-U", "lares_operator", "-d", "postgres", "-c", "SELECT 1"],
            check=False, timeout=call_timeout + 2, operator_timeout=max(1, call_timeout - 1))
        if result.returncode == 0 and result.stdout.strip() == "1":
            return
        time.sleep(min(0.5, max(0, deadline - time.monotonic())))
    raise ProbeFailure("database")


def scram_verifier(password: str) -> str:
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 4096)
    client = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored = hashlib.sha256(client).digest()
    server = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda value: base64.b64encode(value).decode("ascii")
    return "SCRAM-SHA-256$4096:" + b64(salt) + "$" + b64(stored) + ":" + b64(server)


def app_client(role: str, *, check: bool) -> subprocess.CompletedProcess:
    js = """const {Client}=require('pg');const fs=require('node:fs');
const c=new Client({host:'db',port:5432,database:'postgres',user:process.argv[1],password:fs.readFileSync('/run/app-password','utf8').trim(),connectionTimeoutMillis:4000});
c.connect().then(()=>c.query('SELECT 1')).then(r=>{if(r.rows[0]?.['?column?']!==1)process.exitCode=2;else process.stdout.write('connected');}).catch(()=>{process.exitCode=1;}).finally(()=>c.end().catch(()=>{}));"""
    result = docker("run", "--rm", "--network", network, "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,mode=1777",
        "--user", "10001:10001", "--workdir", "/app/services/keeper",
        "--mount", f"type=bind,src={app_password_path},dst=/run/app-password,readonly",
        "--entrypoint", "node", IMAGE, "-e", js, role, check=check, timeout=20)
    return result


def wait_file(path: pathlib.Path, timeout: int = 20) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file():
            return path.read_text(encoding="ascii").strip()
        time.sleep(0.1)
    raise ProbeFailure("timeout")


def test_admission_lifetime() -> None:
    custody.prepare(custody_dir, admission_dir, installation_id, epoch)
    oversized_custody = root / "oversized-custody"
    oversized_admission = root / "oversized-admission"
    oversized_custody.mkdir(mode=0o700)
    oversized_custody.chmod(0o700)
    oversized_admission.mkdir(mode=0o755)
    oversized_admission.chmod(0o755)
    custody.prepare(oversized_custody, oversized_admission, installation_id, epoch)
    oversized_intent = oversized_admission / "intent.json"
    oversized_intent.chmod(0o600)
    oversized_intent.write_bytes(b"x" * 257)
    oversized_intent.chmod(0o444)
    rejected = docker("run", "--rm", "--network", "none", "--user", "10001:10001",
        "--mount", f"type=bind,src={oversized_admission},dst=/proof/admission,readonly",
        "--entrypoint", "/bin/sh", IMAGE, "-ec",
        "/bin/sh /app/services/box/ops/maintenance-admission.sh /proof/admission " +
        installation_id + " 1 -- true", check=False)
    if rejected.returncode != 78:
        raise ProbeFailure()
    proof["claims"]["boundedIntentReadRefusesOversize"] = True
    ready_a = marker_dir / "holder-a-ready"
    ready_b = marker_dir / "holder-b-ready"
    for name, ready in zip(holder_names, (ready_a, ready_b)):
        command = ("exec /bin/sh /app/services/box/ops/maintenance-admission.sh /proof/admission " +
                   installation_id + " 1 -- sh -c 'touch /markers/" + ready.name + "; exec sleep 120'")
        # Register the exact generated name before Docker can create it, so an interrupted or
        # partially failing `run` still gives cleanup authority over only this fixture object.
        known_containers.append(name)
        docker("run", "--detach", "--rm", "--name", name, "--network", "none", "--user", "10001:10001",
               "--mount", f"type=bind,src={admission_dir},dst=/proof/admission,readonly",
               "--mount", f"type=bind,src={marker_dir},dst=/markers",
               "--entrypoint", "/bin/sh", IMAGE, "-ec", command)
        wait_file(ready)
    proof["claims"]["twoCooperatingReadOnlyHoldersBlockExclusive"] = True
    contender = docker("run", "--rm", "--network", "none", "--user", "10001:10001",
        "--mount", f"type=bind,src={admission_dir},dst=/proof/admission,readonly",
        "--entrypoint", "flock", IMAGE, "--exclusive", "--nonblock", "--conflict-exit-code", "75",
        "/proof/admission/service-gate.lock", "true", check=False)
    if contender.returncode != 75:
        raise ProbeFailure()
    custody.transition(custody_dir, admission_dir, installation_id, epoch, "entering")
    denied = docker("run", "--rm", "--network", "none", "--user", "10001:10001",
        "--mount", f"type=bind,src={admission_dir},dst=/proof/admission,readonly",
        "--entrypoint", "/bin/sh", IMAGE, "/app/services/box/ops/maintenance-admission.sh",
        "/proof/admission", installation_id, "1", "--", "true", check=False)
    if denied.returncode != 78:
        raise ProbeFailure()
    still_held = docker("run", "--rm", "--network", "none", "--user", "10001:10001",
        "--mount", f"type=bind,src={admission_dir},dst=/proof/admission,readonly",
        "--entrypoint", "flock", IMAGE, "--exclusive", "--nonblock", "--conflict-exit-code", "75",
        "/proof/admission/service-gate.lock", "true", check=False)
    if still_held.returncode != 75:
        raise ProbeFailure()
    proof["claims"]["durableEnteringDeniesNewAdmissionBeforeExclusive"] = True
    for name in holder_names:
        docker("rm", "--force", name)
        if name in known_containers:
            known_containers.remove(name)
    exclusive = docker("run", "--rm", "--network", "none", "--user", "10001:10001",
        "--mount", f"type=bind,src={admission_dir},dst=/proof/admission,readonly",
        "--entrypoint", "flock", IMAGE, "--exclusive", "--nonblock", "--conflict-exit-code", "75",
        "/proof/admission/service-gate.lock", "true", check=False)
    if exclusive.returncode != 0:
        raise ProbeFailure()
    custody.transition(custody_dir, admission_dir, installation_id, epoch, "blocked")
    proof["stages"]["cooperatingAdmission"] = True


def start_holder_session() -> tuple[str, pathlib.Path]:
    control = root / "session-control"
    control.mkdir(mode=0o777)
    control.chmod(0o777)
    script = root / "session-client.cjs"
    script.write_text("""const {Client}=require('pg'),fs=require('node:fs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const c=new Client({host:'db',port:5432,database:'postgres',user:'proof_app',password:fs.readFileSync('/run/app-password','utf8').trim(),connectionTimeoutMillis:4000});
let expectedWindow=false, idleError=false, unexpectedError=false;
c.on('error',()=>{if(expectedWindow)idleError=true;else unexpectedError=true;});
await c.connect();const r=await c.query('SELECT pg_backend_pid() AS pid');fs.writeFileSync('/control/ready',String(r.rows[0].pid));
while(!fs.existsSync('/control/query'))await sleep(50);await c.query('SELECT 1');fs.writeFileSync('/control/still-works','ok');
while(!fs.existsSync('/control/expect-termination'))await sleep(50);expectedWindow=true;fs.writeFileSync('/control/armed','ok');
while(!fs.existsSync('/control/query-terminated'))await sleep(50);
let queryFailed=false;try{await c.query('SELECT 1');}catch{queryFailed=true;}
if(queryFailed&&idleError&&!unexpectedError)fs.writeFileSync('/control/terminated','ok');else process.exitCode=2;
await c.end().catch(()=>{});
})().catch(()=>{process.exitCode=2});""", encoding="utf-8")
    name = project + "-app-session"
    # As above, record the only name this probe is authorized to clean before container create.
    known_containers.append(name)
    docker("run", "--detach", "--rm", "--name", name, "--network", network, "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,mode=1777", "--user", "10001:10001",
        "--workdir", "/app/services/keeper",
        "--mount", f"type=bind,src={app_password_path},dst=/run/app-password,readonly",
        "--mount", f"type=bind,src={script},dst=/app/services/keeper/session-client.cjs,readonly",
        "--mount", f"type=bind,src={control},dst=/control",
        "--entrypoint", "node", IMAGE, "/app/services/keeper/session-client.cjs")
    return name, control


def run_database_proof() -> None:
    global active_exclusive_fd, stage
    stage = "release-identity"
    release = json.loads((REPO / "releases/2026-10-21-rc.12.json").read_text(encoding="utf-8"))
    if release.get("images", {}).get("db") != PINNED_DB_IMAGE:
        raise ProbeFailure()
    write_hba(NORMAL_HBA)
    stage = "renderer"
    generate_rendered_compose()
    proof["claims"]["actualRenderersUsed"] = True
    proof["stages"]["renderers"] = True
    stage = "bootstrap-start"
    compose("up", "-d", "db", bootstrap=True, timeout=180)
    proof["stages"]["bootstrapStarted"] = True
    # Readiness and every SQL action use the actual shipped operator_db_run from engine-run.sh.
    stage = "bootstrap-operator-login"
    wait_operator_ready(bootstrap_files, budget_seconds=90)
    proof["claims"]["actualOperatorDbRunUsed"] = True
    proof["stages"]["bootstrapOperatorAuthentication"] = True
    stage = "replace-bootstrap-with-normal-stack"
    compose("down", bootstrap=True, timeout=90)
    compose("up", "-d", "db", timeout=180)
    stage = "normal-operator-readiness"
    wait_operator_ready(compose_files, budget_seconds=90)
    proof["stages"]["normalDatabaseStarted"] = True
    stage = "normal-container-secret-boundary"
    database_container = compose("ps", "-q", "db").stdout.strip()
    if not re.fullmatch(r"[a-f0-9]{12,64}", database_container):
        raise ProbeFailure("database")
    mounts = docker("inspect", "--format", "{{json .Mounts}}", database_container)
    env = docker("inspect", "--format", "{{json .Config.Env}}", database_container)
    try:
        mount_rows = json.loads(mounts.stdout)
        env_rows = json.loads(env.stdout)
    except json.JSONDecodeError:
        raise ProbeFailure("database") from None
    if any(item.get("Source") == str(operator_path) for item in mount_rows) or any(
        item.split("=", 1)[0] == "POSTGRES_PASSWORD_FILE" for item in env_rows):
        raise ProbeFailure()
    proof["stages"]["normalContainerHasNoOperatorSecret"] = True
    stage = "external-hba-selected"
    proof["claims"]["externalHbaIsSelected"] = operator_query(compose_files,
        "SELECT current_setting('hba_file') || '|' || count(*)::text FROM pg_hba_file_rules WHERE error IS NOT NULL") == "/run/lares-auth/pg_hba.conf|0"
    if not proof["claims"]["externalHbaIsSelected"]:
        raise ProbeFailure("database")
    stage = "normal-role-controls"
    verifier = scram_verifier(app_password)
    operator_script(compose_files, "CREATE ROLE proof_app LOGIN PASSWORD '" + verifier + "';\n"
        "CREATE ROLE proof_unknown LOGIN PASSWORD '" + verifier + "';\n")
    if app_client("proof_app", check=True).stdout.strip() != "connected" or \
       app_client("proof_unknown", check=True).stdout.strip() != "connected":
        raise ProbeFailure("database")
    proof["stages"]["normalLoginControl"] = True
    stage = "existing-app-session"
    session_name, session_control = start_holder_session()
    backend_pid = wait_file(session_control / "ready")
    if not backend_pid.isdigit():
        raise ProbeFailure()

    # This separate fixture generation binds the database HBA steps to a durable entering marker
    # and the same Linux shared/exclusive lock family. It is not wired to installation processes.
    custody.prepare(db_custody_dir, db_admission_dir, installation_id, epoch)
    custody.transition(db_custody_dir, db_admission_dir, installation_id, epoch, "entering")
    active_exclusive_fd = os.open(db_admission_dir / "service-gate.lock", os.O_RDONLY)
    fcntl.flock(active_exclusive_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stage = "maintenance-hba-reload"
    write_hba(MAINTENANCE_HBA)
    if operator_query(compose_files, "SELECT pg_reload_conf()") != "t":
        raise ProbeFailure("database")
    if operator_query(compose_files, "SELECT count(*)::text FROM pg_hba_file_rules WHERE error IS NOT NULL") != "0":
        raise ProbeFailure("database")
    proof["stages"]["maintenanceReloadParsed"] = True
    stage = "reload-existing-and-new-connections"
    (session_control / "query").write_text("go\n", encoding="ascii")
    if wait_file(session_control / "still-works") != "ok":
        raise ProbeFailure("database")
    if app_client("proof_app", check=False).returncode == 0 or \
       app_client("proof_unknown", check=False).returncode == 0:
        raise ProbeFailure("database")
    if operator_query(compose_files, "SELECT current_user") != "lares_operator":
        raise ProbeFailure("database")
    proof["stages"]["existingSessionSurvivesReloadAndNewLoginsRefuse"] = True
    stage = "terminate-existing-session"
    (session_control / "expect-termination").write_text("go\n", encoding="ascii")
    if wait_file(session_control / "armed") != "ok":
        raise ProbeFailure("database")
    if operator_query(compose_files, "SELECT pg_terminate_backend(" + backend_pid + ")") != "t":
        raise ProbeFailure("database")
    (session_control / "query-terminated").write_text("go\n", encoding="ascii")
    if wait_file(session_control / "terminated") != "ok":
        raise ProbeFailure("database")
    proof["claims"]["existingAppSessionTerminatedExplicitly"] = True
    proof["stages"]["existingSessionTerminated"] = True
    # The direct session should now exit; Docker cleanup below is a bounded fallback only.
    for _ in range(40):
        state = docker("inspect", "--format", "{{.State.Running}}", session_name, check=False)
        if state.returncode != 0:
            known_containers.remove(session_name)
            break
        if state.stdout.strip() == "false":
            docker("rm", "--force", session_name, check=False)
            if docker("inspect", session_name, check=False).returncode != 0:
                known_containers.remove(session_name)
            break
        time.sleep(0.1)

    stage = "restart-retained-data"
    # A crafted permissive PGDATA policy must not override the stable external directory mount.
    pgdata_hba = data_dir / "pg_hba.conf"
    if not pgdata_hba.is_file():
        raise ProbeFailure("database")
    pgdata_hba.write_text("host all all 0.0.0.0/0 trust\n", encoding="ascii")
    pgdata_hba.chmod(0o644)
    compose("restart", "db", timeout=120)
    wait_operator_ready(compose_files, budget_seconds=60)
    if operator_query(compose_files, "SELECT current_setting('hba_file')") != "/run/lares-auth/pg_hba.conf":
        raise ProbeFailure("database")
    if app_client("proof_app", check=False).returncode == 0 or \
       app_client("proof_unknown", check=False).returncode == 0:
        raise ProbeFailure("database")
    proof["claims"]["externalHbaSurvivesPgdataHbaAndRestart"] = True
    proof["claims"]["maintenanceHbaDeniesNewAppAndUnknownLogins"] = True
    proof["stages"]["restartPreservesExternalPolicy"] = True


def cleanup() -> bool:
    okay = True
    for name in list(reversed(known_containers)):
        try:
            if docker("rm", "--force", name, check=False, timeout=20).returncode != 0:
                okay = False
        except Exception:
            okay = False
    if (bootstrap_file.exists() or normal_file.exists()) and override_file.exists():
        try:
            result = compose("down", "--remove-orphans", check=False, timeout=45)
            okay = okay and result.returncode == 0
            result = compose("down", "--remove-orphans", bootstrap=True, check=False, timeout=45)
            okay = okay and result.returncode == 0
        except Exception:
            okay = False
    for directory in (root, private_root, app_private):
        try:
            shutil.rmtree(directory)
        except FileNotFoundError:
            pass
        except Exception:
            okay = False
    return okay


exit_code = 0
try:
    stage = "admission-lifetime"
    test_admission_lifetime()
    stage = "external-auth-render"
    run_database_proof()
    proof["status"] = "passed"
except ProbeFailure as error:
    exit_code = 1
    proof["status"] = "failed"
    proof["failedStage"] = stage
    proof["failureKind"] = error.kind
except Exception:
    exit_code = 1
    proof["status"] = "failed"
    proof["failedStage"] = stage
    proof["failureKind"] = "unexpected"
finally:
    proof["cleanupOkay"] = cleanup()
    if not proof["cleanupOkay"]:
        proof["status"] = "failed"
        proof["failedStage"] = proof["failedStage"] or "cleanup"
        proof["failureKind"] = proof["failureKind"] or "cleanup"
        exit_code = 1
    output_path = pathlib.Path(PROOF_PATH)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(proof, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    output_path.chmod(0o644)
sys.exit(exit_code)
